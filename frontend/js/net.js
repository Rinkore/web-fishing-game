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
  let lastMsgAt = 0;     // 最近一次收到服务器消息的时刻（含心跳 ping）：判断连接是否「假活着」
  let hbTimer = null;    // 心跳看门狗（可见时每 10s 检查一次）
  let reconnecting = false;

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

  // 请求超时：偶发请求悬挂时页面会停在旧状态（按钮点了没反应），超时后中断并当网络错误报出，
  // GET 再自动重试一次；写操作不重试，避免重复提交。
  const API_TIMEOUT_MS = 8000;
  function apiOnce(method, u, body) {
    return new Promise(function (resolve) {
      // Keep legacy call sites' state marker out of URLs and JSON; only HttpOnly cookies authenticate.
      const requestUrl = new URL(u, location.href);
      requestUrl.searchParams.delete('token');
      u = requestUrl.pathname + requestUrl.search;
      if (body) { body = Object.assign({}, body); delete body.token; }
      const opts = { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' } };
      if (body) opts.body = JSON.stringify(body);
      let ctrl = null, timer = null;
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        opts.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, API_TIMEOUT_MS);
      }
      const done = function () { if (timer) { clearTimeout(timer); timer = null; } };
      fetch(API_BASE + u, opts)
        .then(function (r) {
          done();
          return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j }; })
            .catch(function () { return { ok: false, status: r.status, data: {} }; });
        })
        .catch(function () { done(); resolve({ ok: false, status: 0, data: { error: '网络错误' }, timedOut: true }); })
        .then(resolve);
    });
  }
  function apiFetch(method, u, body) {
    const F = window.GameFeatures, feature = F && F.route(method, u);
    // 与 ui.js 的 featureBlocked 同口径：管理员穿透开启时，管理员本人的请求不再被本地拦下
    const st0 = state();
    const bypass = (st0.features && st0.features.adminBypass === true) && !!(st0.me && st0.me.admin);
    if (F && !bypass && F.blocked(state().features, feature)) {
      const error = F.message(state().features, feature);
      if (window.UI) window.UI.toast(error);
      return Promise.resolve({ ok: false, status: 423, data: { error: error, code: 'FEATURE_LOCKED' } });
    }
    return detectBase().then(function () {
      return apiOnce(method, u, body).then(function (r) {
        if (r && r.timedOut && method === 'GET') return apiOnce(method, u, body);
        return r;
      });
    });
  }

  function register(username, password, name, qq, confirmPassword) {
    const body = { username: username, password: password, name: name, qq: qq, confirmPassword: confirmPassword };
    return apiFetch('POST', '/api/register', body).then(function (r) {
      if (!r || !r.data || r.data.code !== 'REGISTRATION_CHALLENGE') return r;
      if (window.UI) window.UI.toast('正在验证注册请求，请稍候…');
      return apiFetch('GET', '/api/register/challenge').then(function (challenge) {
        if (!challenge.ok) return challenge;
        return new Promise(function (resolve) {
          let worker, timer;
          function finish(value) { clearTimeout(timer); if (worker) worker.terminate(); resolve(value); }
          try {
            worker = new Worker('js/registration-proof.js');
            timer = setTimeout(function () { finish({ ok: false, data: { error: '注册验证超时，请稍后再试' } }); }, 95000);
            worker.onerror = function () { finish({ ok: false, data: { error: '浏览器无法完成注册验证，请使用 HTTPS 或稍后重试' } }); };
            worker.onmessage = function (e) {
              if (e.data.error) return finish({ ok: false, data: e.data });
              worker.terminate(); clearTimeout(timer);
              apiFetch('POST', '/api/register', Object.assign({}, body, { proof: e.data })).then(resolve);
            };
            worker.postMessage(challenge.data);
          } catch (e) { finish({ ok: false, data: { error: '浏览器不支持注册验证' } }); }
        });
      });
    });
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

  // 顺带同步服务器的组件生成配置 / 抛竿间隔与全服钓速 / 经济参数 / 熔炼参数
  // （展示与本地预览保持一致：例如工坊的成功率与花费预览必须和服务器算的同一套系数）
  function applyServerCfg(d) {
    if (!d) return;
    if (d.features) state().features = d.features;
    if (d.featureOrder) state().featureOrder = d.featureOrder;
    if (d.componentCfg && window.GameData.setComponentCfg) window.GameData.setComponentCfg(d.componentCfg);
    if (d.castCfg) state().castCfg = d.castCfg;
    if (d.priceCfg) state().priceCfg = d.priceCfg;
    if (d.dropCfg) state().dropCfg = d.dropCfg;
    if (d.autoSellCfg) state().autoSellCfg = d.autoSellCfg;
    if (d.smeltCfg && window.GameData.setSmeltCfg) {
      window.GameData.setSmeltCfg(d.smeltCfg);
      state().smeltCfg = window.GameData.getSmeltCfg();
    }
    if (d.recordsCfg) state().recordsCfg = d.recordsCfg;
  }
  function guardVersion() {
    if (!localVersion()) return Promise.resolve(false);
    return apiFetch('GET', '/api/version').then(function (r) {
      if (!r || !r.ok || !r.data || !r.data.version) { setConn(false); return false; }
      setConn(true);
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
  let updateTimer = null;
  let updateProbePending = false;
  function showUpdatePage(version) {
    let panel = document.getElementById('server-update-page');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'server-update-page';
      panel.setAttribute('role', 'alert');
      panel.innerHTML = '<div class="server-update-card"><h1>服务器正在更新中</h1>' +
        '<p class="server-update-version"></p><p>请稍候，恢复连接后将自动进入游戏。</p></div>';
      document.body.appendChild(panel);
    }
    panel.querySelector('.server-update-version').textContent = '当前版本：' + (version || localVersion());
    if (!updateTimer) updateTimer = setInterval(function () {
      if (updateProbePending) return;
      updateProbePending = true;
      probeServer().finally(function () { updateProbePending = false; });
    }, 3000);
  }
  function hideUpdatePage() {
    const panel = document.getElementById('server-update-page');
    if (panel) panel.remove();
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  }
  function setConn(ok) {
    if (ok) hideUpdatePage(); else showUpdatePage();
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
    // 后台标签页里定时器会被节流到分钟级甚至更久，切回前台时补一次，让「回到页面」即时可用。
    // v0.16.0 起：回到前台 / 重建页面（bfcache）/ 网络恢复 / 窗口聚焦时，除了探测还要**主动重建 SSE**——
    // 手机切后台、PC 长时间切走后，浏览器常把 SSE 连接留成「半死」状态（readyState 还是 OPEN，
    // 却再也收不到任何数据），只靠 EventSource 自己重连会一直等到下一次 onerror，表现为「挂在后台回来就掉线」。
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      probeServer();
      resumeStreamIfStale();
    });
    window.addEventListener('pageshow', function () { probeServer(); resumeStreamIfStale(); });
    window.addEventListener('online', function () { probeServer(); resumeStreamIfStale(true); });
    window.addEventListener('focus', function () { if (!connOk) resumeStreamIfStale(true); });
    if (!hbTimer) hbTimer = setInterval(checkStreamHealth, 10000);
  }
  // SSE 是否「还活着」：超过 2.5 个心跳周期（服务器 25s 一次 ping）没收到任何消息 = 假死
  const STREAM_STALE_MS = 70000;
  function streamStale() {
    if (!es) return true;
    if (es.readyState !== 1) return true;          // 0=CONNECTING / 2=CLOSED
    if (!lastMsgAt) return false;                  // 刚建立、还没收到任何消息：给一点时间
    return (Date.now() - lastMsgAt) > STREAM_STALE_MS;
  }
  function checkStreamHealth() {
    if (!me || !me.token) return;
    if (document.hidden) return;                   // 页面不可见时不动它（省流量、也避免和浏览器节流打架）
    if (streamStale()) { setConn(false); resumeStreamIfStale(true); }
  }
  // 重建 SSE：先断开旧连接再重连（避免出现两条连接互相顶号）。
  // force=false 时只在「确实掉线 / 假死」才重建。
  function resumeStreamIfStale(force) {
    if (!me || !me.token || reconnecting) return false;
    if (!force && !streamStale()) return false;
    reconnecting = true;
    try { if (es) es.close(); } catch (e) {}
    es = null;
    if (errTimer) { clearTimeout(errTimer); errTimer = null; }
    setTimeout(function () {
      reconnecting = false;
      connectStream();
    }, 120);
    return true;
  }

  // ---- 业务指令（自动带 token；结果一律以服务器响应/SSE 推送为准） ----
  function authed(path, body) {
    if (!me) return Promise.resolve({ ok: false, status: 401, data: { error: '未登录' } });
    return apiFetch('POST', path, Object.assign({ token: me.token }, body || {}));
  }
  const fishingStart = (groundId, spotId) => authed('/api/fishing/start', { groundId: groundId, spotId: spotId });
  const fishingStop = () => authed('/api/fishing/stop', {});
  const bdSet = (part, compId) => authed('/api/bd/set', { part: part, compId: compId });
  // 远洋（出海）：船 / 海图 / 临时海域（v0.19.0）
  const seaGet = () => apiFetch('GET', '/api/sea?token=' + encodeURIComponent(me ? me.token : ''));
  const seaShipUp = () => authed('/api/sea/ship/up', {});
  const seaChart = () => authed('/api/sea/chart', {});
  const seaVoyage = () => authed('/api/sea/voyage', {});
  // v0.21.0：悬赏领取 / 锚地下锚 / 编队
  const seaQuestClaim = (id) => authed('/api/sea/quest/claim', { id: id });
  const seaAnchor = (zoneId) => authed('/api/sea/anchor', { zoneId: zoneId });
  const partyFetch = () => apiFetch('GET', '/api/party?token=' + encodeURIComponent(me ? me.token : ''));
  const partyAction = (action, target) => authed('/api/party', { action: action, target: target });
  // 自动售出规则（玩家自助）：单件 { id, ... } / 批量 { bulk:'fish'|'material'|'all', ... }；
  // 只传 { id, on } = 就地开关（不动阈值）；remove:true 删除规则
  const autoSellGet = () => apiFetch('GET', '/api/autosell?token=' + encodeURIComponent(me ? me.token : ''));
  const autoSellSet = (payload) => authed('/api/autosell', payload || {});
  // 公开只读：商品价格历史采样 + 交易量
  const shopHistory = (id) => apiFetch('GET', '/api/shop/history?id=' + encodeURIComponent(id));
  // 我的历史订单（市集成交：买入 + 卖出）
  const marketHistory = () => apiFetch('GET', '/api/market/history?token=' + encodeURIComponent(me ? me.token : ''));
  // 某种鱼的全服前十大捕获记录（公开只读）
  const recordsTop = (id, kind, range) => apiFetch('GET', '/api/records/top?id=' + encodeURIComponent(id) +
    (kind ? '&kind=' + encodeURIComponent(kind) : '') + (range ? '&range=' + encodeURIComponent(range) : ''));
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
  let marketRequest = 0, mineRequest = 0;
  function fetchMarket(options) {
    const query = Object.assign({ scope: 'others', page: 1, size: 30 }, options || {});
    const sequence = ++marketRequest;
    return apiFetch('GET', '/api/market?' + new URLSearchParams(query)).then(function (r) {
      if (r && r.ok && sequence === marketRequest) {
        state().market = r.data.listings || []; state().marketPage = r.data;
        state().marketQuery = r.data.revision < (state().marketRevision || 0) ? null : JSON.stringify(query);
      }
      return r;
    });
  }
  function fetchMyMarket(page) {
    const sequence = ++mineRequest;
    return apiFetch('GET', '/api/market?' + new URLSearchParams({ scope: 'mine', page: page || 1, size: 30 })).then(function (r) {
      if (r && r.ok && sequence === mineRequest) {
        state().marketMine = r.data.listings || []; state().marketMinePage = r.data;
        if (window.UI) window.UI.refreshAll('market');
      }
      return r;
    });
  }
  const fetchCodex = () => apiFetch('GET', '/api/codex?token=' + encodeURIComponent(me ? me.token : '')).then(function (r) {
    if (r && r.ok) { state().codex = r.data.codex || {}; state().catchCount = r.data.catchCount || 0; if (window.UI) window.UI.refreshAll('codex'); }
    return r;
  });
  const fetchRecords = () => apiFetch('GET', '/api/records').then(function (r) {
    if (r && r.ok) {
      state().records = r.data.records || {};
      state().smallRecords = r.data.small || {};
      state().recordsLast = r.data.last || null;                  // 顶部「最新播报的鱼」
      state().recordsRankLabel = r.data.rankLabel || null;        // 日/周/总榜的文案
      if (window.UI) window.UI.refreshAll('records');
    }
    return r;
  });
  // perf-9：玩家列表分页 / 搜索（服务端分页）。target 区分存储槽：'playersPage'=渔场页玩家列表，'peepsPage'=同钓点列表
  const fetchPlayersPage = (opts) => {
    const o = opts || {};
    const t = me ? me.token : '';
    return apiFetch('GET', '/api/players/page?token=' + encodeURIComponent(t) +
      '&page=' + (o.page || 1) + '&size=' + (o.size || 30) +
      '&q=' + encodeURIComponent(o.q || '') +
      (o.ground ? '&ground=' + encodeURIComponent(o.ground) : '') +
      (o.spot ? '&spot=' + encodeURIComponent(o.spot) : '')).then(function (r) {
      if (r && r.ok) {
        const d = r.data;
        state()[o.target || 'playersPage'] = { page: d.page, pages: d.pages, total: d.total, list: d.players || [] };
        if (o.target === 'peepsPage') state().peepsLoading = false;   // 拉到了就撤掉「同步中」
        if (d.totalOnline != null) state().onlineTotal = d.totalOnline;
        if (window.UI) window.UI.refreshAll(o.target === 'peepsPage' ? 'fishing' : 'players');
      }
      return r;
    });
  };
  // 视口登记：告诉服务器当前正在看哪一页（之后每秒只推该页玩家状态）；clear=true 取消登记
  const fetchFriends = (q, page) => apiFetch('GET', '/api/friends?q=' + encodeURIComponent(q || '') + '&page=' + (page || 1));
  const friendUpdate = (target, action) => authed('/api/friends', { target: target, action: action });
  // v0.21.2：只取关系（好友 / 收到 / 发出三组 id），供在线卡片上的「加好友」按钮判定显示什么
  const friendRelations = () => apiFetch('GET', '/api/friends/relations');
  const setPlayersView = (opts) => {
    const o = opts || {};
    return authed('/api/players/view', { page: o.page || 1, size: o.size || 30, q: o.q || '',
      ground: o.ground || null, spot: o.spot || null, clear: !!o.clear });
  };
  const fetchFeedback = () => apiFetch('GET', '/api/feedback?token=' + encodeURIComponent(me ? me.token : '')).then(function (r) {
    if (r && r.ok) {
      state().feedback = { status: r.data.status, mine: r.data.mine || [] };
      if (r.data.coins != null) state().player.coins = r.data.coins;
      if (window.UI) window.UI.refreshAll('feedback');
    }
    return r;
  });
  // 宝匣（沉船打捞）：拉取档位与保底进度 / 合成 / 开箱
  const fetchChest = () => apiFetch('GET', '/api/chest?token=' + encodeURIComponent(me ? me.token : '')).then(function (r) {
    if (r && r.ok) {
      state().chest = r.data;
      if (r.data.coins != null) state().player.coins = r.data.coins;
      if (window.UI) window.UI.refreshAll('chest');
    }
    return r;
  });
  const chestCraft = (chestId, qty) => authed('/api/chest/craft', { chestId: chestId, qty: qty === undefined ? 1 : qty });
  // sel：自选目标（mode='part' 传 {part}；mode='base' 传 {baseId}；mode='random' 不传）
  const chestOpen = (chestId, sel) => authed('/api/chest/open', Object.assign({ chestId: chestId }, sel || {}));
  // 商城（每日限购）：拉取当前周期商品与限购余额 / 购买
  const fetchMall = () => apiFetch('GET', '/api/mall?token=' + encodeURIComponent(me ? me.token : '')).then(function (r) {
    if (r && r.ok) {
      state().mall = r.data;
      if (r.data.coins != null) state().player.coins = r.data.coins;
      if (window.UI) window.UI.refreshAll('mall');
    }
    return r;
  });
  const mallBuy = (id, qty) => authed('/api/mall/buy', { id: id, qty: qty === undefined ? 1 : qty });
  // 工坊：熔炼参数（材料→词缀对照 / 成功率与花费系数）
  const fetchWorkshop = () => apiFetch('GET', '/api/workshop?token=' + encodeURIComponent(me ? me.token : '')).then(function (r) {
    if (r && r.ok) {
      state().workshop = r.data;
      if (r.data.coins != null) state().player.coins = r.data.coins;
      if (window.UI) window.UI.refreshAll('workshop');
    }
    return r;
  });
  // 熔炼：payload = { mainId, subId, mainAffix, subAffix, materials:[{id,qty}], pearl }
  const smelt = (payload) => authed('/api/workshop/smelt', payload || {});
  // 重铸：用残片重 roll 宝匣神话件的全部词条数值
  // affixIndex 可选：指定只重铸第几条词条（0 基下标）；不传 = 重 roll 全部词条
  const recast = (id, affixIndex) => authed('/api/workshop/recast',
    (affixIndex == null || affixIndex < 0) ? { id: id } : { id: id, affixIndex: affixIndex });
  const forge = (id, materialId, pearl) => authed('/api/workshop/forge', { id: id, materialId: materialId, pearl: !!pearl });
  // v0.13.6：tier='L'|'G' → 按大型/巨型通道出售（额外金币加成）
  const sell = (id, qty, tier) => authed('/api/sell', tier ? { id: id, qty: qty, tier: tier } : { id: id, qty: qty });
  const marketList = (id, qty, price, hours) => authed('/api/market/list', { id: id, qty: qty, price: price, hours: hours });
  // qty 可选：不传 = 整单买走；传入 = 部分购买
  const marketBuy = (lid, qty) => authed('/api/market/buy', { lid: lid, qty: qty });
  const marketCancel = (lid) => authed('/api/market/cancel', { lid: lid });
  const feedbackStatus = () => apiFetch('GET', '/api/feedback?token=' + encodeURIComponent(me ? me.token : ''));
  const feedbackSubmit = (text, kind) => authed('/api/feedback/submit', { text: text, kind: kind });
  const feedbackSkip = () => authed('/api/feedback/skip', {});
  const tradeInvite = (target) => authed('/api/trade/invite', { target: target });
  // 查看其他玩家当前装备的钓竿组件构成（渔场动态玩家卡片「查看」按钮）
  const fetchPlayerRod = (target) => authed('/api/players/rod', { target: target });
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
    me = { id: (profile.username || '').toLowerCase(), username: profile.username, name: profile.name, token: token, admin: !!profile.admin, listingCap: profile.listingCap == null ? null : profile.listingCap };
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

  // feed 去重：同一条渔获可能既在 init 快照（feed 数组）里、又在那 1 秒社交批量窗口里到达
  // （连接恰好在窗口内建立时）——不去重的话动态流会重复一行。key 与 ui.js 的 feedKey 同构。
  function feedKeyOf(e) {
    const it = (e && e.item) || {};
    return [e && e.t, e && e.who, e && e.ground, e && e.spot, it.id, e && e.size].join('|');
  }
  function feedDup(e) {
    if (!e) return true;
    const k = feedKeyOf(e);
    const arr = state().feed || [];
    for (let i = 0; i < arr.length; i++) { if (feedKeyOf(arr[i]) === k) return true; }
    return false;
  }

  function connectStream() {
    const u = API_BASE + '/events';
    const seenLogBanners = {}; // 本连接内已入日志的公告 id（重连后重播不重复记录）
    try {
      es = new EventSource(u, { withCredentials: true });
      lastMsgAt = Date.now();
      es.onopen = function () { lastMsgAt = Date.now(); setConn(true); };
      // 性能修复(perf-5) 前端侧：服务器把同一时间窗内的多条事件合并成
      // { type:'batch', list:[...] } 单条推送，这里解包后逐条走原有分发逻辑；
      // 非 batch 消息保持原样，向后兼容。
      es.onmessage = function (ev) {
        lastMsgAt = Date.now();   // 心跳看门狗据此判断连接是否假死
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.type === 'batch' && Array.isArray(m.list)) {
          for (let bi = 0; bi < m.list.length; bi++) handleServerEvent(m.list[bi]);
          return;
        }
        handleServerEvent(m);
      };
      function handleServerEvent(m) {
        const S = state();
        const ui = window.UI;
        if (m.type === 'maintenance') {
          setConn(false);
          showUpdatePage(m.version);
        } else if (m.type === 'features') {
          S.features = m.features || {};
          S.featureOrder = m.featureOrder || {};
          if (ui && ui.onFeatures) ui.onFeatures();
        } else if (m.type === 'ping') {
          // v0.16.0：服务器每 25 秒推一条**真消息**心跳（原先是 `: ping` 注释，前端看不到）。
          // 只用于「连接是否假死」的判定（见 checkStreamHealth），不触发任何界面重绘。
        } else if (m.type === 'init') {
          S.features = m.features || {};
          S.featureOrder = m.featureOrder || {};
          // 服务器重启换版本后 SSE 会自动重连并带回新版本号：这是「热更新」最快的一条路径
          // （通常几秒内），比定时轮询快得多。刷新后本条连接自然被替换，无需额外处理。
          if (reloadForVersion(m.version)) return;
          if (errTimer) { clearTimeout(errTimer); errTimer = null; }
          setConn(true);
          // perf-9：init 不再携带全量 players / records——玩家列表走分页 API，榜单走拉取制
          S.players = [];
          S.playersPage = { page: 1, pages: 1, total: 0, list: [] };
          S.peepsPage = { page: 1, pages: 1, total: 0, list: [] };
          S.onlineTotal = m.playersTotal || 0;
          S.recordsVersion = m.recordsVersion || 0;
          S.feed = m.feed || [];
          S.shop = m.shop || {};
          S.market = []; S.marketQuery = null;
          S.marketRevision = m.marketRevision || 0;
          if (ui && ui.onMarketChanged) ui.onMarketChanged();
          fetchRecords();
          S.groundCounts = m.grounds || {};
          S.spotCounts = m.spotCounts || {};
          // 服务器重连自动续钓（上次没主动收竿）：直接带回钓速明细与钓点，
          // 前端不必再发一次 start 请求。钓点必须在这里就地写回展示状态：
          // perf-9 起 presence 只推给登记过列表视口的连接，钓鱼页不登记视口，
          // 等 players/playersPage 会让界面一直停在「不在任何钓点」
          // （渔获照进日志 → 「在钓，但不知道在哪钓」）。
          if (m.resumedFishing) {
            S.castInfo = m.resumedFishing.castInfo || S.castInfo || null;
            if (m.resumedFishing.interval) S.fishingInterval = m.resumedFishing.interval;
            if (m.resumedFishing.groundId) {
              S.player.status = 'fishing';
              S.player.groundId = m.resumedFishing.groundId;
              S.player.spotId = m.resumedFishing.spotId || null;
              S.fishing.active = true;
              // selected 同步：bitecfg / castcfg / groundcfg 广播靠它重新拉取钓速明细
              S.selected = { groundId: m.resumedFishing.groundId, spotId: m.resumedFishing.spotId || null };
              // 同钓点列表直接按这个钓点拉一次（本地即时，不等 5s 轮询；推送节奏不变）
              if (window.Engine && window.Engine.resetPeeps) {
                window.Engine.resetPeeps();
                window.Engine.loadPeeps(m.resumedFishing.groundId, m.resumedFishing.spotId || null);
              }
            }
          }
          // 钓场目录（含管理后台的掉落池/增益/锁定覆盖）：原位替换 data.js 的默认值，
          // 保证图鉴产地与渔场页展示与实际掉落一致
          if (m.groundCfg) applyGroundCfg(m.groundCfg);
          S.trade = m.trade || null;
          if (m.codex) S.codex = m.codex;
          if (m.catchCount != null) S.catchCount = m.catchCount;
          if (m.bigfish !== undefined) S.bigfish = m.bigfish || {};   // v0.13.6：大型/巨型预留计数
          if (ui) ui.refreshAll('all');
        } else if (m.type === 'players') {
          S.players = m.players || [];
          syncSelfFromPresence(S.players);
          if (ui) ui.refreshAll('players');
        } else if (m.type === 'playersDelta') {
          // 性能修复(perf-7) 前端侧：服务器改为增量推送在线玩家状态。
          // full=true 为周期性全量纠偏；否则 upserts 覆盖/追加、removed 剔除。
          if (m.full) {
            S.players = m.upserts || [];
          } else if (S.players && S.players.length) {
            if (m.removed && m.removed.length) {
              const rmSet = {};
              (m.removed || []).forEach(function (id) { rmSet[id] = 1; });
              S.players = S.players.filter(function (p) { return !rmSet[p.id]; });
            }
            (m.upserts || []).forEach(function (p) {
              let found = false;
              for (let pi = 0; pi < S.players.length; pi++) {
                if (S.players[pi].id === p.id) { S.players[pi] = p; found = true; break; }
              }
              if (!found) S.players.push(p);
            });
          } else {
            S.players = m.upserts || [];
          }
          syncSelfFromPresence(S.players);
          if (ui) ui.refreshAll('players');
        } else if (m.type === 'grounds') {
          S.groundCounts = m.counts || {};
          if (m.spotCounts != null) S.spotCounts = m.spotCounts;
          S.onlineTotal = m.total || 0;
          if (ui) ui.refreshAll('grounds');
        } else if (m.type === 'playersPage') {
          // perf-9：当前视口页的玩家状态推送（≤页大小条；未登记视口的连接收不到）
          S.playersPage = { page: m.page, pages: m.pages, total: m.total, list: m.players || [] };
          syncSelfFromPresence(m.players || []);
          if (ui) ui.refreshAll('players');
        } else if (m.type === 'recordsDirty') {
          // perf-9：榜单拉取制——只收 20 字节版本号，限频 5s 拉取
          if (m.v != null) S.recordsVersion = m.v;
          const rfNow = Date.now();
          if (!S._recordsFetchAt || rfNow - S._recordsFetchAt > 5000) { S._recordsFetchAt = rfNow; fetchRecords(); }
        } else if (m.type === 'shop') {
          S.shop = m.shop || {};
          if (ui) ui.refreshAll('shop');
        } else if (m.type === 'marketDelta') {
          if (m.revision > (S.marketRevision || 0)) {
            S.marketRevision = m.revision; S.marketQuery = null;
            if (ui && ui.onMarketChanged) ui.onMarketChanged();
          }
        } else if (m.type === 'records') {
          S.records = m.records || {};
          if (m.small) S.smallRecords = m.small;
          if (m.last !== undefined) S.recordsLast = m.last || null;
          if (ui) ui.refreshAll('records');
        } else if (m.type === 'globalRecord') {
          if (ui && ui.showRecordBanner && m.record) ui.showRecordBanner(m.record);
          // v0.16.0：榜单横幅是**全服**播报，但「日志 · 纪录」只记自己产生的记录——
          // 之前别人破纪录也会写进我的日志，翻起来全是别人的成绩。
          if (ui && ui.addLog && m.record) {
            const meKey = S.me && S.me.id != null ? String(S.me.id).toLowerCase() : null;
            const mine = m.record.key != null
              ? String(m.record.key).toLowerCase() === meKey
              : (!!S.me && !!m.record.who && m.record.who === S.me.name);
            if (mine) ui.addLog('record', m.record.text || ('🎉 全场最大纪录被破：' + m.record.who + ' 钓到 ' + m.record.name + ' ' + m.record.size + 'cm'));
          }
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
        } else if (m.type === 'chestcfg') {
          // 后台改了宝匣保底次数 / 合成成本：就地更新（宝匣页显示成本与保底进度，不用重新进页面）
          S.chest = Object.assign({}, S.chest || {}, {
            pityN: (m.chestCfg || {}).pityN || 0,
            costs: (m.chestCfg || {}).costs || {},
          });
          if (ui) ui.refreshAll('chestcfg');
        } else if (m.type === 'mallcfg') {
          // 后台改了商城商品/限购刷新时间：重新拉取当前周期视图
          window.Net.fetchMall();
        } else if (m.type === 'smeltcfg') {
          // 后台改了熔炼参数：更新预览用的系数
          if (m.smeltCfg) {
            S.smeltCfg = m.smeltCfg;
            if (window.GameData.setSmeltCfg) window.GameData.setSmeltCfg(m.smeltCfg);
          }
          if (ui) ui.refreshAll('smeltcfg');
        } else if (m.type === 'componentcfg') {
          // 后台改了组件生成配置（含池外/突破词缀数值区间）：工坊补缀与宝匣突破件的预览区间都要跟着变
          if (m.componentCfg && window.GameData.setComponentCfg) window.GameData.setComponentCfg(m.componentCfg);
          if (ui) ui.refreshAll('componentcfg');
        } else if (m.type === 'recordscfg') {
          // 后台改了「全场最大鱼」贴图的缩放/偏移：就地更新并重绘纪录页
          if (m.recordsCfg) S.recordsCfg = m.recordsCfg;
          if (ui) ui.refreshAll('records');
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
        } else if (m.type === 'pricecfg') {
          // 管理员调整经济参数（价格模型/产出倍率）：记住新值，商店文案与容量提示随重绘更新
          if (m.priceCfg) S.priceCfg = m.priceCfg;
          if (m.dropCfg) S.dropCfg = m.dropCfg;
          if (ui && ui.refreshAll) ui.refreshAll('pricecfg');
        } else if (m.type === 'autosellcfg') {
          // 管理员调整自动售出打包阈值：商店右栏的说明与保留量提示随重绘更新
          if (m.autoSellCfg) S.autoSellCfg = m.autoSellCfg;
          if (ui && ui.refreshAll) ui.refreshAll('autosellcfg');
        } else if (m.type === 'subalert') {
          if (ui && ui.onSubAlert) ui.onSubAlert(m.item || {});
        } else if (m.type === 'assets') {
          // 服务器权威资产：金币/库存/图鉴整体替换，前端不持账本
          if (m.coins != null) S.player.coins = m.coins;
          // v0.13.9：库存快照带 invRev（单调版本号），**旧快照必须丢弃**——HTTP 响应是当场序列化的
          // 旧快照，SSE assets 是入队时刻定版（150ms 后发出）的新快照，两条通道到达顺序不保证；
          // 直接赋值会让旧快照盖掉刚开箱得到的配件（用户报的「连开宝匣丢配件」就是这个）。
          if (m.inventory) window.Engine.applyInv(m.inventory, m.invRev);
          // perf-8c：钓鱼热路径增量——只合并背包增量，避免每竿全量传输。
          // 增量与 bigAdd 同属一次状态推进：只判一次（判过就把 rev 抬到该值），
          // 已包含在刚应用的快照里的增量其 rev 不会更大 → 整体跳过（否则同一件东西被计两次）
          const deltaOk = window.Engine.acceptDelta(m.invRev);
          if (m.invAdd && deltaOk) {
            const inv = S.inventory = S.inventory || {};
            for (const k in m.invAdd) { inv[k] = (inv[k] || 0) + m.invAdd[k]; if (inv[k] <= 0) delete inv[k]; }
          }
          // v0.13.6：大型/巨型预留计数（背包全量 / 钓鱼热路径增量两种拍子都处理）
          if (m.bigfish !== undefined) S.bigfish = m.bigfish || {};
          if (m.bigAdd && deltaOk) {
            const bf = S.bigfish = S.bigfish || {};
            for (const k in m.bigAdd) {
              const e = bf[k] = bf[k] || { L: 0, G: 0 };
              if (m.bigAdd[k].L) e.L = (e.L || 0) + m.bigAdd[k].L;
              if (m.bigAdd[k].G) e.G = (e.G || 0) + m.bigAdd[k].G;
            }
          }
          if (m.codex) S.codex = m.codex;
          if (m.catchCount != null) S.catchCount = m.catchCount;
          // v0.16.3：管理员改钓竿装配时也走这条路 —— 带上 bd 就同步装配与词缀加成
          if (m.bd) { S.bd = m.bd; window.Engine.refreshEffects(); }
          if (m.rodLocked) S.rodLocked = m.rodLocked;
          if (ui) ui.refreshAll('assets');
        } else if (m.type === 'codexAdd') {
          // perf-8c：图鉴热路径增量——只合并新条目（原 codex 事件每竿全量发整个图鉴）
          S.codex = S.codex || {};
          const cur = S.codex[m.id] || {};
          const nx = { count: (cur.count || 0) + (m.add || 1), first: cur.first || Date.now() };
          if (m.mx != null) nx.max = m.mx; else if (cur.max != null) nx.max = cur.max;
          if (m.mn != null) nx.min = m.mn; else if (cur.min != null) nx.min = cur.min;
          // v0.13.6：图鉴最高体型档（G > L，只升不降；服务器侧已保证不降，这里同样兜底）
          if (m.tier) { if (m.tier === 'G' || cur.tier !== 'G') nx.tier = m.tier; else nx.tier = cur.tier; }
          else if (cur.tier) nx.tier = cur.tier;
          S.codex[m.id] = nx;
          if (m.catchCount != null) S.catchCount = m.catchCount;
          // v0.13.8：上鱼走就地补丁（只改这张卡的文字与档位框），**不重建整页**——
          // 整页重建会让图鉴里所有鱼的游动动画（px-swim）从头播放，看起来就是「一上鱼整页闪一下」。
          // 新收录的物种（卡片还不存在）才回落到整页重建。
          if (ui) { if (!ui.patchCodexCell || !ui.patchCodexCell(m.id)) ui.refreshAll('codex'); }
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
              (it.tier === 'G' ? ' 🥇巨型' : it.tier === 'L' ? ' 🥈大型' : '') +
              (it.rarity === 'rare' ? ' ✨稀有' : it.rarity === 'epic' ? ' 💎史诗' : '') +
                (m.entry.ground ? '（' + m.entry.ground + (m.entry.spot ? '·' + m.entry.spot : '') + '）' : ''));
            }
          }
          if (ui) ui.refreshAll('catch');
        } else if (m.type === 'kicked') {
          dropSession(m.msg || '账号已在其他窗口登录');
        } else if (m.type === 'notice') {
          if (ui && ui.toast) ui.toast(m.msg || '');
          if (ui && ui.addLog) ui.addLog('system', m.msg || '');
        } else if (m.type === 'seaEvict') {
          // v0.21.3：编队解散/离队/被踢 → 服务器已收回临时海域并停竿。
          // 单独一条消息（不走 notice）：这个必须弹窗，不能只闪一条 toast 就没了。
          if (ui && ui.onSeaEvict) ui.onSeaEvict(m.msg || '');
          else if (ui && ui.toast) ui.toast(m.msg || '');
        } else if (m.type === 'friends') {
          // v0.21.2：对端发起/同意/拒绝/撤回/移除 → 关系速查与好友面板立刻刷新（不必等 5 秒轮询）
          if (ui && ui.friendPush) ui.friendPush();
        } else if (m.type === 'mktTrade') {
          // 市集成交：落进「📜 日志 · ✅ 交易」（原来只发 notice，会混进「系统」分类）。
          // 买家侧不 toast：发起购买的响应里已经有「购买成功」提示；卖家不在页面上也要能看到入账。
          if (ui && ui.addLog) {
            const isSell = m.role === 'sell';
            const qtyTxt = m.qty > 1 ? ' ×' + m.qty : '';
            ui.addLog('trade',
              (isSell ? '💱 市集售出给 ' : '🛒 市集买入自 ') + (m.other || '') + '：' + (m.name || '') + qtyTxt +
              (isSell ? '，到账 💰' + m.sellerGain + '（已扣 10% 税 ' + m.tax + '）' : '，支出 💰' + m.total),
              [{ id: m.id, qty: m.qty, dir: isSell ? 'gave' : 'got' }]);
            if (isSell && ui.toast) ui.toast('市集售出：' + (m.name || '') + qtyTxt + '，入账 💰' + m.sellerGain);
          }
          if (ui) ui.refreshAll('assets');
        } else if (m.type === 'trade') {
          S.trade = (m.trade && !m.trade.done && !m.trade.cancelled) ? m.trade : null;
          S.tradeLastEvent = m.trade;
          if (ui) ui.refreshAll('trade');
        } else if (m.type === 'tradeDone') {
          const pl = S.player;
          const myKey = me ? String(me.id).toLowerCase() : null;
          const iAmA = !!(myKey && m.a && String(m.a.key).toLowerCase() === myKey);
          const iAmB = !!(myKey && m.b && String(m.b.key).toLowerCase() === myKey);
          // 兼容旧服务器的全服广播：无关结算不能写日志或清除自己的交易。
          if (!iAmA && !iAmB) return;
          // v0.13.9：交易结算也是库存快照，同样按 invRev 判新（旧包不覆盖新状态）
          if (m.a && myKey && String(m.a.key).toLowerCase() === myKey) { pl.coins = m.a.coins; window.Engine.applyInv(m.a.inventory, m.a.invRev); }
          if (m.b && myKey && String(m.b.key).toLowerCase() === myKey) { pl.coins = m.b.coins; window.Engine.applyInv(m.b.inventory, m.b.invRev); }
          S.trade = null;
          S.tradeFlash = '交易完成，物品已互换';
          if (ui && ui.addLog) {
            // 交易日志带双方物品：词条数值由 UI 按物品 id（实例签名）解析，这里只存 id 与数量
            const other = iAmA ? (m.bName || '对方') : (m.aName || '对方');
            const gave = (iAmA ? m.aItems : m.bItems) || [];
            const got = (iAmA ? m.bItems : m.aItems) || [];
            ui.addLog('trade', '✅ 与 ' + other + ' 交易完成',
              gave.map(function (it) { return { id: it.id, qty: it.qty, dir: 'gave' }; })
                .concat(got.map(function (it) { return { id: it.id, qty: it.qty, dir: 'got' }; })));
          }
          if (ui) ui.refreshAll('trade');
        } else if (m.type === 'feed') {
          if (!feedDup(m.entry)) {
            S.feed.unshift(m.entry);
            if (S.feed.length > 60) S.feed.pop();
            if (ui) ui.refreshAll('feed');
          }
        } else if (m.type === 'feedBatch') {
          // perf-8：服务器同窗口合并的多条 feed（list 按旧→新排序，逐条 unshift 后最新在最前）
          const fb = m.list || [];
          let added = 0;
          for (let i = 0; i < fb.length; i++) { if (!feedDup(fb[i])) { S.feed.unshift(fb[i]); added++; } }
          if (S.feed.length > 60) S.feed.length = 60;
          if (added && ui) ui.refreshAll('feed');
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
      }
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

  // perf-9：同钓点玩家列表——钓鱼中每 5s 拉取当前钓点的分页数据（拉取制，不占推送带宽）
  setInterval(function () {
    const S = state();
    if (!(S.fishing && S.fishing.active && S.player && S.player.groundId)) return;
    const pv = S.peepView = S.peepView || { page: 1, size: 100, q: '' };
    if (pv.size < 100) pv.size = 100;
    fetchPlayersPage({ target: 'peepsPage', page: pv.page, size: pv.size, q: pv.q,
      ground: S.player.groundId, spot: S.player.spotId });
  }, 5000);

  return {
    register: register, login: login, logout: logout, fetchMe: fetchMe, setAuth: setAuth,
    guardVersion: guardVersion, startVersionWatch: startVersionWatch,
    probeServer: probeServer, connState: connState, reloadForVersion: reloadForVersion,
    fishingStart: fishingStart, fishingStop: fishingStop, bdSet: bdSet,
    seaGet: seaGet, seaShipUp: seaShipUp, seaChart: seaChart, seaVoyage: seaVoyage,
    seaQuestClaim: seaQuestClaim, seaAnchor: seaAnchor, partyFetch: partyFetch, partyAction: partyAction,
    autoSellGet: autoSellGet, autoSellSet: autoSellSet,
    shopHistory: shopHistory, marketHistory: marketHistory, recordsTop: recordsTop,
    fetchShop: fetchShop, fetchMarket: fetchMarket, fetchCodex: fetchCodex, fetchRecords: fetchRecords,
    fetchPlayersPage: fetchPlayersPage, setPlayersView: setPlayersView,
    fetchFriends: fetchFriends, friendUpdate: friendUpdate, friendRelations: friendRelations,
    fetchFeedback: fetchFeedback,
    fetchChest: fetchChest, chestCraft: chestCraft, chestOpen: chestOpen,
    fetchMall: fetchMall, mallBuy: mallBuy, fetchWorkshop: fetchWorkshop, smelt: smelt, recast: recast, forge: forge,
    fetchBanners: fetchBanners, fetchGrounds: fetchGrounds,
    bannerPlaying: bannerPlaying,
    feedbackStatus: feedbackStatus, feedbackSubmit: feedbackSubmit, feedbackSkip: feedbackSkip,
    fetchSubscribe: fetchSubscribe, subscribeSave: subscribeSave,
    sell: sell, marketList: marketList, marketBuy: marketBuy, marketCancel: marketCancel, fetchMyMarket: fetchMyMarket,
    tradeInvite: tradeInvite, tradeRespond: tradeRespond, tradeSet: tradeSet,
    fetchPlayerRod: fetchPlayerRod,
    rodBuySlot: rodBuySlot, rodSave: rodSave, rodName: rodName, rodRename: rodRename,
    rodUse: rodUse, rodDelete: rodDelete, rodStow: rodStow, marketListRod: marketListRod,
    tradeConfirm: tradeConfirm, tradeCancel: tradeCancel,
    getMe: function () { return me; },
  };
})();
