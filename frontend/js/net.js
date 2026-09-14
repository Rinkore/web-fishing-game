/*
 * 网页钓鱼小游戏 - 网络层（瘦客户端）
 * 处理逻辑全部在服务器：钓鱼循环/掷骰/资产结算/钓竿配置。
 * 本文件只做三件事：发指令（/api/*）、收 SSE 广播、把权威状态写进 Engine 供 UI 渲染。
 * 零第三方依赖。
 */
window.Net = (function () {
  'use strict';
  // 惰性获取：本文件可能先于 engine.js 加载，不能在执行期直接读 window.Engine
  function state() { return window.Engine.state; }
  let me = null;
  let es = null;
  let errTimer = null;   // SSE 断线确认定时器（见 connectStream 的 onerror）

  // ---- API 基地址（前后端分离）----
  // config.js 的 API_BASE：'auto'（默认）/ '' 同源 / 显式地址。
  // 'auto' 探测：先按同源尝试（集成模式下后端用任意端口托管前端都成立），
  //   若同源 /shop 未返回商店数据 → 退回同主机的默认后端端口（9000）。
  let API_BASE = '';
  let baseDetected = null;
  function candidateBase() {
    return (location.hostname ? location.protocol + '//' + location.hostname : 'http://localhost') + ':9000';
  }
  function detectBase() {
    if (baseDetected) return baseDetected;
    const cfg = window.APP_CONFIG && window.APP_CONFIG.API_BASE;
    if (typeof cfg === 'string' && cfg !== 'auto') { API_BASE = cfg.replace(/\/+$/, ''); baseDetected = Promise.resolve(); return baseDetected; }
    if (location.protocol === 'file:') { API_BASE = 'http://localhost:9000'; baseDetected = Promise.resolve(); return baseDetected; }
    API_BASE = '';
    baseDetected = fetch('/shop', { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!(j && j.crucian && j.crucian.base != null)) API_BASE = candidateBase(); })
      .catch(function () { API_BASE = candidateBase(); });
    return baseDetected;
  }

  function apiFetch(method, u, body) {
    return detectBase().then(function () {
      return new Promise(function (resolve) {
        const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        fetch(API_BASE + u, opts)
          .then(function (r) {
            return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j }; })
              .catch(function () { return { ok: false, status: r.status, data: {} }; });
          })
          .catch(function () { return { ok: false, status: 0, data: { error: '网络错误' } }; })
          .then(resolve);
      });
    });
  }

  function register(username, password, name, qq, confirmPassword) {
    return apiFetch('POST', '/api/register', { username: username, password: password, name: name, qq: qq, confirmPassword: confirmPassword });
  }
  function login(username, password) { return apiFetch('POST', '/api/login', { username: username, password: password }); }
  function logout() { return authed('/api/logout', {}); }
  function fetchMe(token) { return apiFetch('GET', '/api/me?token=' + encodeURIComponent(token)); }

  // ---- 版本守卫 / 热更新 ----
  // 服务器升级 = 换代码 + 重启：页面里的旧前端会遇到不兼容的新接口。这里用三条路径发现版本变化，
  // 发现后带 cache-bust 参数强刷一次（拿到新前端），实现「服务器更新后客户端自动跟上」：
  //   ① 启动时 guardVersion()
  //   ② SSE 收到 init——重启必然断开 SSE，浏览器几秒内自动重连，init 会把新版本号带回来（最快的一条）
  //   ③ 兜底轮询（5 分钟一次）＋ 标签页回到前台时补一次（后台标签页的定时器会被浏览器节流）
  // sessionStorage 记录「已为哪个服务器版本刷过」，同一版本只刷一次，避免异常时无限刷新。
  const RELOAD_FLAG = 'fishing_version_reload';
  function localVersion() { return (window.GameData && window.GameData.VERSION) || ''; }
  function reloadForVersion(serverVersion) {
    if (!serverVersion || serverVersion === localVersion()) return false;
    let already = false;
    try { already = sessionStorage.getItem(RELOAD_FLAG) === serverVersion; } catch (e) {}
    if (already) return false; // 本次会话已为该版本刷过，避免死循环
    try { sessionStorage.setItem(RELOAD_FLAG, serverVersion); } catch (e) {}
    // 用带时间戳的 URL 重新加载，绕过 HTML/JS 缓存
    const loc = window.location;
    const bust = (loc.search.indexOf('?') >= 0 ? loc.search + '&' : '?') + 'v=' + encodeURIComponent(serverVersion) + '&t=' + Date.now();
    loc.replace(loc.pathname + bust + loc.hash);
    return true; // 已触发刷新
  }
  // 会话失效（顶号 / 过期 / 服务器侧被清）：清理本地状态并回到登录界面。
  // 不做这一步的话，页面看起来还在，实际所有操作都会失败（僵尸页面）。
  function dropSession(msg) {
    const ui = window.UI;
    if (ui && ui.addLog) ui.addLog('system', '⚠ ' + msg);
    try { localStorage.removeItem('fishing_token'); } catch (e) {}
    if (es) { try { es.close(); } catch (e) {} es = null; }
    me = null;
    state().me = null;
    if (ui && ui.forceLogout) ui.forceLogout(msg);
  }

  // 顺带同步服务器的组件生成配置 / 抛竿间隔与全服钓速（展示与本地 roll 保持一致）
  function applyServerCfg(d) {
    if (!d) return;
    if (d.componentCfg && window.GameData.setComponentCfg) window.GameData.setComponentCfg(d.componentCfg);
    if (d.castCfg) state().castCfg = d.castCfg;
  }
  function guardVersion() {
    if (!localVersion()) return Promise.resolve(false);
    return apiFetch('GET', '/api/version').then(function (r) {
      if (!r || !r.ok || !r.data || !r.data.version) return false;
      applyServerCfg(r.data);
      return reloadForVersion(r.data.version);
    }).catch(function () { return false; });
  }

  // ---- 连接健康 + 兜底版本轮询 ----
  // 断线本身不刷新页面：EventSource 会自己重连，而服务器没起来时刷新只会更糟（可能反复刷成白屏）。
  // 只有「版本变了」才强刷；断线只作为界面提示，重连成功后自动消失。
  const VERSION_POLL_MS = 5 * 60 * 1000;
  const CONN_FAILS_TO_OFFLINE = 2;  // 连续失败几次才算断线（避开偶发抖动）
  let verTimer = null;
  let probeFails = 0;
  let connOk = true;
  function setConn(ok) {
    if (connOk === ok) return;
    connOk = ok;
    if (window.UI && window.UI.onConnChange) window.UI.onConnChange(ok);
  }
  function connState() { return connOk; }
  function probeServer() {
    return apiFetch('GET', '/api/version').then(function (r) {
      if (!r || !r.ok) throw new Error('probe failed');
      probeFails = 0;
      setConn(true);
      applyServerCfg(r.data);
      if (reloadForVersion(r.data.version)) return true; // 版本不同 → 强刷（刷新后自然重建连接）
      // 顺带确认登录态还有效：会话过期（默认 30 天）或服务器侧被清理时，把玩家送回登录页
      if (me && me.token) {
        return apiFetch('GET', '/api/me?token=' + encodeURIComponent(me.token)).then(function (mr) {
          if (mr && mr.status === 401) dropSession('登录状态已失效，请重新登录');
          return false;
        }).catch(function () { return false; });
      }
      return false;
    }).catch(function () {
      probeFails++;
      if (probeFails >= CONN_FAILS_TO_OFFLINE) setConn(false);
      return false;
    });
  }
  function startVersionWatch() {
    if (verTimer) return;
    verTimer = setInterval(function () { probeServer(); }, VERSION_POLL_MS);
    // 后台标签页里定时器会被节流到分钟级甚至更久，切回前台时补一次，让「回到页面」即时可用
    document.addEventListener('visibilitychange', function () { if (!document.hidden) probeServer(); });
  }

  // ---- 业务指令（自动带 token；结果一律以服务器响应/SSE 推送为准） ----
  function authed(path, body) {
    if (!me) return Promise.resolve({ ok: false, status: 401, data: { error: '未登录' } });
    return apiFetch('POST', path, Object.assign({ token: me.token }, body || {}));
  }
  const fishingStart = (groundId, spotId) => authed('/api/fishing/start', { groundId: groundId, spotId: spotId });
  const fishingStop = () => authed('/api/fishing/stop', {});
  const bdSet = (part, compId) => authed('/api/bd/set', { part: part, compId: compId });
  // 自动售出规则（玩家自助，仅渔获）：scope='all' 全部鱼；scope=鱼id 单鱼（优先于全部鱼）
  const autoSellGet = () => apiFetch('GET', '/api/autosell?token=' + encodeURIComponent(me ? me.token : ''));
  const autoSellSet = (scope, minPct, minPrice, slackPct, slackPrice) => authed('/api/autosell', { scope: scope, minPct: minPct, minPrice: minPrice, slackPct: slackPct, slackPrice: slackPrice });
  // 公开只读：商品价格历史采样 + 交易量
  const shopHistory = (id) => apiFetch('GET', '/api/shop/history?id=' + encodeURIComponent(id));
  // 我的历史订单（市集成交：买入 + 卖出）
  const marketHistory = () => apiFetch('GET', '/api/market/history?token=' + encodeURIComponent(me ? me.token : ''));
  // 某种鱼的全服前十大捕获记录（公开只读）
  const recordsTop = (id, kind) => apiFetch('GET', '/api/records/top?id=' + encodeURIComponent(id) + (kind ? '&kind=' + encodeURIComponent(kind) : ''));
  // 横幅队列（公开只读；服务器管理后台发布）
  const fetchBanners = () => apiFetch('GET', '/api/banner').then(function (r) {
    if (r && r.ok) {
      state().banners = r.data.banners || [];
      state().bannerCfg = r.data.cfg || {};
      // 进入游戏时把当前待播公告入队播放（此前只更新状态，导致登录后不播既有公告）
      if (window.UI && window.UI.onBanners) window.UI.onBanners();
      if (window.UI) window.UI.refreshAll('banner');
    }
    return r;
  });
  // 钓场目录（公开只读）：进入游戏时主动拉取一次，作为 SSE init 的兜底，
  // 确保后进入或刷新过的玩家也能拿到含增益/掉落池覆盖的最新目录（钓点 ⚡ 标记等）。
  const fetchGrounds = () => apiFetch('GET', '/api/grounds').then(function (r) {
    if (r && r.ok && r.data && r.data.grounds) {
      applyGroundCfg(r.data.grounds);
      if (window.UI) window.UI.refreshAll('groundcfg');
    }
    return r;
  });

  // ---- 按需拉取：进入对应页面时才请求该页数据（不在的页面零请求） ----
  const fetchShop = () => apiFetch('GET', '/shop').then(function (r) {
    if (r && r.ok) { state().shop = r.data; if (window.UI) window.UI.refreshAll('shop'); }
    return r;
  });
  const fetchMarket = () => apiFetch('GET', '/api/market').then(function (r) {
    if (r && r.ok) { state().market = r.data.listings || []; if (window.UI) window.UI.refreshAll('market'); }
    return r;
  });
  const fetchCodex = () => apiFetch('GET', '/api/codex?token=' + encodeURIComponent(me ? me.token : '')).then(function (r) {
    if (r && r.ok) { state().codex = r.data.codex || {}; state().catchCount = r.data.catchCount || 0; if (window.UI) window.UI.refreshAll('codex'); }
    return r;
  });
  const fetchRecords = () => apiFetch('GET', '/api/records').then(function (r) {
    if (r && r.ok) { state().records = r.data.records || {}; state().smallRecords = r.data.small || {}; if (window.UI) window.UI.refreshAll('records'); }
    return r;
  });
  const fetchFeedback = () => apiFetch('GET', '/api/feedback?token=' + encodeURIComponent(me ? me.token : '')).then(function (r) {
    if (r && r.ok) {
      state().feedback = { status: r.data.status, mine: r.data.mine || [] };
      if (r.data.coins != null) state().player.coins = r.data.coins;
      if (window.UI) window.UI.refreshAll('feedback');
    }
    return r;
  });
  const sell = (id, qty) => authed('/api/sell', { id: id, qty: qty });
  const marketList = (id, qty, price, hours) => authed('/api/market/list', hours ? { id: id, qty: qty, price: price, hours: hours } : { id: id, qty: qty, price: price });
  // qty 可选：不传 = 整单买走；传入 = 部分购买
  const marketBuy = (lid, qty) => authed('/api/market/buy', qty ? { lid: lid, qty: qty } : { lid: lid });
  const marketCancel = (lid) => authed('/api/market/cancel', { lid: lid });
  const feedbackStatus = () => apiFetch('GET', '/api/feedback?token=' + encodeURIComponent(me ? me.token : ''));
  const feedbackSubmit = (text, kind) => authed('/api/feedback/submit', { text: text, kind: kind });
  const feedbackSkip = () => authed('/api/feedback/skip', {});
  const tradeInvite = (target) => authed('/api/trade/invite', { target: target });
  const tradeRespond = (tradeId, accept) => authed('/api/trade/respond', { tradeId: tradeId, accept: accept });
  const tradeSet = (tradeId, items) => authed('/api/trade/set', { tradeId: tradeId, items: items });
  const tradeConfirm = (tradeId) => authed('/api/trade/confirm', { tradeId: tradeId });
  const tradeCancel = (tradeId) => authed('/api/trade/cancel', { tradeId: tradeId });
  // 钓竿存档 / 槽位
  const rodBuySlot = () => authed('/api/rod/slot/buy', {});
  const rodSave = (slot, name, force) => authed('/api/rod/save', { slot: slot, name: name, force: !!force });
  const rodName = (name) => authed('/api/rod/name', { name: name });
  const rodRename = (slot, name) => authed('/api/rod/rename', { slot: slot, name: name });
  const rodUse = (slot) => authed('/api/rod/use', { slot: slot });
  const rodDelete = (slot) => authed('/api/rod/delete', { slot: slot });
  const rodStow = () => authed('/api/rod/stow', {});
  // 整根钓竿上架（走同一挂单接口，带 rodSlot）
  const marketListRod = (slot, price, hours) => authed('/api/market/list', { rodSlot: slot, price: price, hours: hours });
  // 组件订阅提醒（玩家级配置：筛选条件 + 提醒方式）
  const fetchSubscribe = () => apiFetch('GET', '/api/subscribe?token=' + encodeURIComponent(me ? me.token : ''));
  const subscribeSave = (cfg) => authed('/api/subscribe', cfg || {});
  // 横幅滚播上报（后台「当前滚播」用于统计观看人数；失败静默）
  const bannerPlaying = (id) => authed('/api/banner/playing', { id: id }).catch(function () { return null; });

  function setAuth(token, profile) {
    // 服务器内部一律使用小写账号 key 作为身份（players/trade/market/history 均是），
    // me.id 必须与之对齐，否则含大写字母的账号所有"是不是我"的判断都会失效
    me = { id: (profile.username || '').toLowerCase(), username: profile.username, name: profile.name, token: token, admin: !!profile.admin };
    state().me = me;
    connectStream();
    startVersionWatch();
  }

  // 把服务器 presence 同步到本地展示状态（顶栏/渔场实况/状态条都以服务器为准）
  function syncSelfFromPresence(list) {
    const mine = (list || []).find(function (p) { return me && p.id === me.id; });
    if (!mine) return;
    const S = state();
    S.player.status = mine.status || 'idle';
    S.player.groundId = mine.groundId || null;
    S.player.spotId = mine.spotId || null;
    S.player.recent = mine.recent || null;
    S.fishing.active = mine.status === 'fishing';
    if (S.fishing.active) { S.selected = { groundId: mine.groundId, spotId: mine.spotId }; }
  }

  function connectStream() {
    const u = API_BASE + '/events?token=' + encodeURIComponent(me.token);
    const seenLogBanners = {}; // 本连接内已入日志的公告 id（重连后重播不重复记录）
    try {
      es = new EventSource(u);
      es.onmessage = function (ev) {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        const S = state();
        const ui = window.UI;
        if (m.type === 'init') {
          // 服务器重启换版本后 SSE 会自动重连并带回新版本号：这是「热更新」最快的一条路径
          // （通常几秒内），比定时轮询快得多。刷新后本条连接自然被替换，无需额外处理。
          if (reloadForVersion(m.version)) return;
          if (errTimer) { clearTimeout(errTimer); errTimer = null; }
          setConn(true);
          S.players = m.players || [];
          syncSelfFromPresence(S.players);
          S.feed = m.feed || [];
          S.shop = m.shop || {};
          S.market = m.market || [];
          S.records = m.records || {};
          if (m.small) S.smallRecords = m.small;
          S.groundCounts = m.grounds || {};
          // 钓场目录（含管理后台的掉落池/增益/锁定覆盖）：原位替换 data.js 的默认值，
          // 保证图鉴产地与渔场页展示与实际掉落一致
          if (m.groundCfg) applyGroundCfg(m.groundCfg);
          S.trade = m.trade || null;
          if (m.codex) S.codex = m.codex;
          if (m.catchCount != null) S.catchCount = m.catchCount;
          if (ui) ui.refreshAll('all');
        } else if (m.type === 'players') {
          S.players = m.players || [];
          syncSelfFromPresence(S.players);
          if (ui) ui.refreshAll('players');
        } else if (m.type === 'grounds') {
          S.groundCounts = m.counts || {};
          S.onlineTotal = m.total || 0;
          if (ui) ui.refreshAll('grounds');
        } else if (m.type === 'shop') {
          S.shop = m.shop || {};
          if (ui) ui.refreshAll('shop');
        } else if (m.type === 'market') {
          S.market = m.listings || [];
          if (ui) ui.refreshAll('market');
        } else if (m.type === 'records') {
          S.records = m.records || {};
          if (m.small) S.smallRecords = m.small;
          if (ui) ui.refreshAll('records');
        } else if (m.type === 'globalRecord') {
          if (ui && ui.showRecordBanner && m.record) ui.showRecordBanner(m.record);
          if (ui && ui.addLog && m.record) ui.addLog('record', m.record.text || ('🎉 全场最大纪录被破：' + m.record.who + ' 钓到 ' + m.record.name + ' ' + m.record.size + 'cm'));
        } else if (m.type === 'banner') {
          S.banners = m.banners || [];
          S.bannerCfg = m.cfg || {};
          if (ui && ui.onBanners) ui.onBanners();
          // 公告横幅入日志（同一 id 只记一次，避免重连重播刷屏）
          if (ui && ui.addLog && Array.isArray(m.banners)) {
            m.banners.forEach(function (bn) {
              if (!bn || !bn.id || seenLogBanners[bn.id]) return;
              seenLogBanners[bn.id] = true;
              ui.addLog('system', '📢 公告：' + bn.content);
            });
          }
        } else if (m.type === 'bannerStop') {
          if (ui && ui.onBannerStop) ui.onBannerStop(m.id);
        } else if (m.type === 'bitecfg') {
          // 后台改了上钩公式：正在钓鱼时重新拉取明细（含新上鱼率），否则直接重绘
          if (S.fishing && S.fishing.active && S.selected && S.selected.groundId) {
            window.Net.fishingStart(S.selected.groundId, S.selected.spotId);
          } else if (ui && ui.refreshAll) {
            ui.refreshAll('castcfg');
          }
        } else if (m.type === 'castcfg') {
          // 管理员调整抛竿间隔/全服钓速：先记住新配置，再让服务器重算实际间隔（会即刻重绘钓鱼页）
          S.castCfg = { baseMs: m.baseMs, minMs: m.minMs, speedBonus: m.speedBonus, speedCap: m.speedCap };
          // 清掉旧的 castInfo：界面立刻按新配置 + 本地词缀/增益重算（随后服务器回传的精确值覆盖）
          S.castInfo = null;
          if (S.fishing && S.fishing.active && S.selected && S.selected.groundId) {
            window.Net.fishingStart(S.selected.groundId, S.selected.spotId);
          } else if (ui && ui.refreshAll) {
            ui.refreshAll('castcfg');
          }
          if (ui && ui.toast) ui.toast('管理员已调整抛竿间隔：基础 ' + (m.baseMs / 1000).toFixed(2) + 's / 最短 ' + (m.minMs / 1000).toFixed(2) + 's' + (m.speedBonus ? ' / 全服钓速 ' + m.speedBonus + '%' : ''));
        } else if (m.type === 'subalert') {
          if (ui && ui.onSubAlert) ui.onSubAlert(m.item || {});
        } else if (m.type === 'assets') {
          // 服务器权威资产：金币/库存/图鉴整体替换，前端不持账本
          if (m.coins != null) S.player.coins = m.coins;
          if (m.inventory) S.inventory = m.inventory;
          if (m.codex) S.codex = m.codex;
          if (m.catchCount != null) S.catchCount = m.catchCount;
          if (ui) ui.refreshAll('assets');
        } else if (m.type === 'codex') {
          S.codex = m.codex || {};
          if (m.catchCount != null) S.catchCount = m.catchCount;
          if (ui) ui.refreshAll('codex');
        } else if (m.type === 'catch') {
          // 服务器钓到鱼：只更新本地日志展示（入库已在服务端完成）
          if (m.entry && me && m.entry.who === me.name) {
            S.log.unshift(m.entry);
            if (S.log.length > 60) S.log.pop();
            // 渔获同时记入「📜 日志 · 🐟 渔获」分列（本地按账号保留）
            if (ui && ui.addLog) {
              const it = m.entry.item || {};
              ui.addLog('catch', '钓到 ' + (it.name || '?') + (it.size ? ' ' + it.size + 'cm' : '') +
                (it.rarity === 'big' ? ' 🐟大鱼' : it.rarity === 'rare' ? ' ✨稀有' : '') +
                (m.entry.ground ? '（' + m.entry.ground + (m.entry.spot ? '·' + m.entry.spot : '') + '）' : ''));
            }
          }
          if (ui) ui.refreshAll('catch');
        } else if (m.type === 'kicked') {
          dropSession(m.msg || '账号已在其他窗口登录');
        } else if (m.type === 'notice') {
          if (ui && ui.toast) ui.toast(m.msg || '');
          if (ui && ui.addLog) ui.addLog('system', m.msg || '');
        } else if (m.type === 'trade') {
          S.trade = (m.trade && !m.trade.done && !m.trade.cancelled) ? m.trade : null;
          S.tradeLastEvent = m.trade;
          if (ui) ui.refreshAll('trade');
        } else if (m.type === 'tradeDone') {
          const pl = S.player;
          const myKey = me ? String(me.id).toLowerCase() : null;
          if (m.a && myKey && String(m.a.key).toLowerCase() === myKey) { pl.coins = m.a.coins; S.inventory = m.a.inventory || S.inventory; }
          if (m.b && myKey && String(m.b.key).toLowerCase() === myKey) { pl.coins = m.b.coins; S.inventory = m.b.inventory || S.inventory; }
          S.trade = null;
          S.tradeFlash = '交易完成，物品已互换';
          if (ui && ui.addLog) ui.addLog('trade', '✅ 交易完成，物品已互换');
          if (ui) ui.refreshAll('trade');
        } else if (m.type === 'feed') {
          S.feed.unshift(m.entry);
          if (S.feed.length > 60) S.feed.pop();
          if (ui) ui.refreshAll('feed');
        } else if (m.type === 'groundcfg') {
          // 管理后台修改了钓场/钓点配置：原位替换 GROUNDS 内容（保持数组引用），
          // 渔场页/图鉴产地/钓场锁定状态随即与服务器一致
          applyGroundCfg(m.grounds);
          // 钓点增益可能变了：正在钓鱼时顺带刷新实际钓速明细（服务器已按新增益重启循环）
          if (S.fishing && S.fishing.active && S.selected && S.selected.groundId) {
            window.Net.fishingStart(S.selected.groundId, S.selected.spotId);
          }
          if (ui) ui.refreshAll('groundcfg');
        }
      };
      // 断线静默：EventSource 会自动重连。延迟几秒再置为「断开」，
      // 避免重连过程中的瞬时抖动把提示闪出来；收到 init 会立刻恢复为「已连接」。
      es.onerror = function () {
        if (errTimer) clearTimeout(errTimer);
        errTimer = setTimeout(function () { setConn(false); }, 4000);
      };
    } catch (e) { /* EventSource 不可用 */ }
  }
  // 用服务器下发的钓场目录原位替换本地 GROUNDS（保持数组引用，spotsOf 等按引用读取即刻生效）
  function applyGroundCfg(list) {
    const G = window.GameData.GROUNDS;
    if (!G || !Array.isArray(list)) return;
    G.length = 0;
    list.forEach(function (g) { G.push(g); });
  }

  return {
    register: register, login: login, logout: logout, fetchMe: fetchMe, setAuth: setAuth,
    guardVersion: guardVersion, startVersionWatch: startVersionWatch,
    probeServer: probeServer, connState: connState, reloadForVersion: reloadForVersion,
    fishingStart: fishingStart, fishingStop: fishingStop, bdSet: bdSet,
    autoSellGet: autoSellGet, autoSellSet: autoSellSet,
    shopHistory: shopHistory, marketHistory: marketHistory, recordsTop: recordsTop,
    fetchShop: fetchShop, fetchMarket: fetchMarket, fetchCodex: fetchCodex, fetchRecords: fetchRecords,
    fetchFeedback: fetchFeedback,
    fetchBanners: fetchBanners, fetchGrounds: fetchGrounds,
    bannerPlaying: bannerPlaying,
    feedbackStatus: feedbackStatus, feedbackSubmit: feedbackSubmit, feedbackSkip: feedbackSkip,
    fetchSubscribe: fetchSubscribe, subscribeSave: subscribeSave,
    sell: sell, marketList: marketList, marketBuy: marketBuy, marketCancel: marketCancel,
    tradeInvite: tradeInvite, tradeRespond: tradeRespond, tradeSet: tradeSet,
    rodBuySlot: rodBuySlot, rodSave: rodSave, rodName: rodName, rodRename: rodRename,
    rodUse: rodUse, rodDelete: rodDelete, rodStow: rodStow, marketListRod: marketListRod,
    tradeConfirm: tradeConfirm, tradeCancel: tradeCancel,
    getMe: function () { return me; },
  };
})();
