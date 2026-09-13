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

  function register(username, password, name) { return apiFetch('POST', '/api/register', { username: username, password: password, name: name }); }
  function login(username, password) { return apiFetch('POST', '/api/login', { username: username, password: password }); }
  function fetchMe(token) { return apiFetch('GET', '/api/me?token=' + encodeURIComponent(token)); }

  // ---- 业务指令（自动带 token；结果一律以服务器响应/SSE 推送为准） ----
  function authed(path, body) {
    if (!me) return Promise.resolve({ ok: false, status: 401, data: { error: '未登录' } });
    return apiFetch('POST', path, Object.assign({ token: me.token }, body || {}));
  }
  const fishingStart = (groundId, spotId) => authed('/api/fishing/start', { groundId: groundId, spotId: spotId });
  const fishingStop = () => authed('/api/fishing/stop', {});
  const bdSet = (part, compId) => authed('/api/bd/set', { part: part, compId: compId });
  // 公开只读：商品价格历史采样 + 交易量
  const shopHistory = (id) => apiFetch('GET', '/api/shop/history?id=' + encodeURIComponent(id));
  // 我的历史订单（市集成交：买入 + 卖出）
  const marketHistory = () => apiFetch('GET', '/api/market/history?token=' + encodeURIComponent(me ? me.token : ''));
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
    // 服务器内部一律使用小写账号 key 作为身份（players/trade/market/history 均是），
    // me.id 必须与之对齐，否则含大写字母的账号所有"是不是我"的判断都会失效
    me = { id: (profile.username || '').toLowerCase(), username: profile.username, name: profile.name, token: token };
    state().me = me;
    connectStream();
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
    try {
      es = new EventSource(u);
      es.onmessage = function (ev) {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        const S = state();
        const ui = window.UI;
        if (m.type === 'init') {
          S.players = m.players || [];
          syncSelfFromPresence(S.players);
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
          if (ui) ui.refreshAll('records');
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
          }
          if (ui) ui.refreshAll('catch');
        } else if (m.type === 'notice') {
          if (ui && ui.toast) ui.toast(m.msg || '');
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
          if (ui) ui.refreshAll('trade');
        } else if (m.type === 'feed') {
          S.feed.unshift(m.entry);
          if (S.feed.length > 60) S.feed.pop();
          if (ui) ui.refreshAll('feed');
        }
      };
      es.onerror = function () { /* 断线静默，EventSource 自动重连 */ };
    } catch (e) { /* EventSource 不可用 */ }
  }

  return {
    register: register, login: login, fetchMe: fetchMe, setAuth: setAuth,
    fishingStart: fishingStart, fishingStop: fishingStop, bdSet: bdSet,
    shopHistory: shopHistory, marketHistory: marketHistory,
    sell: sell, marketList: marketList, marketBuy: marketBuy, marketCancel: marketCancel,
    tradeInvite: tradeInvite, tradeRespond: tradeRespond, tradeSet: tradeSet,
    tradeConfirm: tradeConfirm, tradeCancel: tradeCancel,
    getMe: function () { return me; },
  };
})();
