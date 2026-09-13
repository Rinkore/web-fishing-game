/*
 * 网页钓鱼小游戏 - 网络层（真实联机 + 账号）
 * 职责：
 *   - 注册 / 登录 / 取资料 / 存资料（经 /api/*）
 *   - SSE 接收服务器广播（在线玩家 / 全服动态），用 token 鉴权
 *   - fetch POST 上报自身状态与渔获（token 鉴权，服务端解析账号名）
 * 零第三方依赖。
 */
window.Net = (function () {
  'use strict';
  // 惰性获取：本文件可能先于 engine.js 加载，不能在执行期直接读 window.Engine
  function state() { return window.Engine.state; }
  let me = null;
  let es = null;
  let syncTimer = null;

  function apiFetch(method, u, body) {
    return new Promise(function (resolve) {
      const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      fetch(u, opts)
        .then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j }; })
            .catch(function () { return { ok: false, status: r.status, data: {} }; });
        })
        .catch(function () { return { ok: false, status: 0, data: { error: '网络错误' } }; })
        .then(resolve);
    });
  }

  function register(username, password, name) { return apiFetch('POST', '/api/register', { username: username, password: password, name: name }); }
  function login(username, password) { return apiFetch('POST', '/api/login', { username: username, password: password }); }
  function fetchMe(token) { return apiFetch('GET', '/api/me?token=' + encodeURIComponent(token)); }
  function saveProfile(profile) { if (!me) return Promise.resolve({ ok: false }); return apiFetch('POST', '/api/profile', Object.assign({ token: me.token }, profile)); }

  // ---- 业务接口（自动带 token） ----
  function authed(path, body) {
    if (!me) return Promise.resolve({ ok: false, status: 401, data: { error: '未登录' } });
    return apiFetch('POST', path, Object.assign({ token: me.token }, body || {}));
  }
  const sell = (id, qty) => authed('/api/sell', { id: id, qty: qty });
  const marketList = (id, qty, price) => authed('/api/market/list', { id: id, qty: qty, price: price });
  // qty 可选：不传 = 整单买走；传入 = 部分购买
  const marketBuy = (lid, qty) => authed('/api/market/buy', qty ? { lid: lid, qty: qty } : { lid: lid });
  const marketCancel = (lid) => authed('/api/market/cancel', { lid: lid });
  const tradeInvite = (target) => authed('/api/trade/invite', { target: target });
  const tradeRespond = (tradeId, accept) => authed('/api/trade/respond', { tradeId: tradeId, accept: accept });
  const tradeSet = (tradeId, items) => authed('/api/trade/set', { tradeId: tradeId, items: items });
  const tradeConfirm = (tradeId) => authed('/api/trade/confirm', { tradeId: tradeId });
  const tradeCancel = (tradeId) => authed('/api/trade/cancel', { tradeId: tradeId });
  function setAuth(token, profile) {
    me = { id: profile.username, username: profile.username, name: profile.name, token: token };
    state().me = me;
    connectStream();
    startSync();
  }

  function connectStream() {
    const u = '/events?token=' + encodeURIComponent(me.token);
    try {
      es = new EventSource(u);
      es.onmessage = function (ev) {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        const S = state();
        const ui = window.UI;
        if (m.type === 'init') {
          S.players = m.players || [];
          S.feed = m.feed || [];
          S.shop = m.shop || {};
          S.market = m.market || [];
          S.records = m.records || {};
          S.groundCounts = m.grounds || {};
          S.trade = m.trade || null;
          if (m.codex) S.codex = m.codex;
          if (m.catchCount != null) S.catchCount = m.catchCount;
          if (ui) ui.refreshAll('all');
        } else if (m.type === 'players') {
          S.players = m.players || [];
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
          if (ui) ui.refreshAll('records');
        } else if (m.type === 'assets') {
          // 服务器权威资产：金币与库存
          if (m.coins != null) S.player.coins = m.coins;
          if (m.inventory) {
            // 以服务器库存为准，再补回尚未被服务器确认的本地渔获
            const seq = Number(m.seq) || 0;
            if (seq > 0) S.localGains = S.localGains.filter(function (g) { return g.seq > seq; });
            else S.localGains = [];
            const inv = Object.assign({}, m.inventory);
            S.localGains.forEach(function (g) { inv[g.id] = (inv[g.id] || 0) + 1; });
            S.inventory = inv;
          }
          if (ui) ui.refreshAll('assets');
        } else if (m.type === 'codex') {
          S.codex = m.codex || {};
          if (m.catchCount != null) S.catchCount = m.catchCount;
          if (ui) ui.refreshAll('codex');
        } else if (m.type === 'notice') {
          if (ui && ui.toast) ui.toast(m.msg || '');
        } else if (m.type === 'trade') {
          const wasOpen = S.trade && !S.trade.done && !S.trade.cancelled;
          S.trade = (m.trade && !m.trade.done && !m.trade.cancelled) ? m.trade : null;
          S.tradeLastEvent = m.trade;
          if (ui) ui.refreshAll('trade');
          void wasOpen;
        } else if (m.type === 'tradeDone') {
          const pl = S.player;
          if (m.a && m.a.key === (me && me.id)) { pl.coins = m.a.coins; S.inventory = m.a.inventory || S.inventory; }
          if (m.b && m.b.key === (me && me.id)) { pl.coins = m.b.coins; S.inventory = m.b.inventory || S.inventory; }
          S.trade = null;
          S.tradeFlash = '交易完成，物品已互换';
          if (ui) ui.refreshAll('trade');
        } else if (m.type === 'feed') {
          S.feed.unshift(m.entry);
          if (S.feed.length > 60) S.feed.pop();
          if (ui) ui.refreshAll('feed');
        }
      };
      es.onerror = function () { /* 断线静默 */ };
    } catch (e) { /* EventSource 不可用 */ }
  }

  function startSync() {
    if (syncTimer) clearInterval(syncTimer);
    // 注意：只同步「仅属于客户端」的数据（BD / 显示名）。
    // coins 与 inventory 由服务器权威维护（出售 / 市集 / 交易 / 渔获入库），
    // 客户端若把它们回传会把并发的收入覆盖掉（曾经导致市集卖出收不到钱）。
    syncTimer = setInterval(function () {
      if (!me) return;
      const S = state();
      saveProfile({ bd: S.bd, name: S.player.name });
    }, 15000);
    window.addEventListener('beforeunload', function () {
      if (!me) return;
      const S = state();
      saveProfile({ bd: S.bd, name: S.player.name });
    });
  }

  function sendPresence(opts) {
    if (!me) return;
    const pl = state().player;
    const payload = { token: me.token, status: pl.status, groundId: pl.groundId, spotId: pl.spotId };
    // 传 recentClear=true 表示「离开钓点，请清空记录」
    // 传 recent=xxx 表示「刚钓到xxx，请更新」
    // 都不传则服务器保持原值（避免普通状态上报把大鱼记录抹掉）
    if (opts && opts.recentClear) payload.recentClear = true;
    else if (pl.recent) payload.recent = pl.recent;
    post('/presence', payload);
  }

  function announceCatch(entry) {
    if (!me) return;
    const it = entry.item || {};
    // 必须带上 size：服务器据此更新全服大鱼榜（此前漏传导致榜单永远为空）
    post('/catch', {
      token: me.token, item: it, ground: entry.ground, spot: entry.spot,
      size: it.size != null ? it.size : null,
      seq: entry.seq || 0,
    });
  }

  function post(u, obj) {
    try {
      if (typeof fetch !== 'function') return;
      fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }).catch(function () {});
    } catch (e) {}
  }

  return {
    register: register, login: login, fetchMe: fetchMe, saveProfile: saveProfile,
    setAuth: setAuth, sendPresence: sendPresence, announceCatch: announceCatch,
    sell: sell, marketList: marketList, marketBuy: marketBuy, marketCancel: marketCancel,
    tradeInvite: tradeInvite, tradeRespond: tradeRespond, tradeSet: tradeSet,
    tradeConfirm: tradeConfirm, tradeCancel: tradeCancel,
    getMe: function () { return me; },
  };
})();
