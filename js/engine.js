/*
 * 网页钓鱼小游戏 - 引擎（真实联机版）
 * 移除模拟玩家：在线玩家来自服务器，渔获动态通过服务器广播。
 */
window.Engine = (function () {
  'use strict';
  const D = window.GameData;

  const SAVE_KEY = 'fishing_game_state_v02';
  const FISH_INTERVAL = 3000;   // 玩家自动钓鱼节奏（ms）

  const state = {
    me: null,                   // 本机玩家连接身份（由 Net 赋值）
    player: { name: '你', status: 'idle', groundId: null, spotId: null, coins: 500, recent: null },
    fishing: { active: false, timer: null },
    inventory: {},              // { itemId: count }
    bd: buildDefaultBD(),       // 钓竿 BD：全部默认组件
    log: [],                    // 玩家渔获日志（最新在前）
    feed: [],                   // 全服动态（来自服务器广播）
    players: [],                // 在线玩家（来自服务器）
    shop: {},                   // 系统商店价格（服务器）
    market: [],                 // 市集挂单（服务器）
    records: {},                // 全服大鱼榜（服务器）
    groundCounts: {},           // 各渔场人数（服务器）
    onlineTotal: 0,
    trade: null,                // 当前交易会话（服务器）
    tradeLastEvent: null,
    tradeFlash: null,
    codex: {},                  // 个人图鉴（服务器 + 本地乐观）
    catchCount: 0,
    // 本地乐观账本：已本地入包但尚未收到服务器 assets 回执的渔获
    // 服务器回推时带 seq，客户端可丢弃 <= seq 的账目，实现精确对账
    catchSeq: 0,
    localGains: [],
    selected: { groundId: null, spotId: null },
  };

  function buildDefaultBD() {
    const bd = {};
    D.ROD_PARTS.forEach(function (part) {
      bd[part.key] = { name: part.default.name, affixes: [], rare: null, isCharm: !!part.isCharm };
    });
    return bd;
  }

  // ---- 持久化 ----
  function save() {
    try {
      const snap = { player: state.player, inventory: state.inventory, bd: state.bd };
      localStorage.setItem(SAVE_KEY, JSON.stringify(snap));
    } catch (e) { /* 忽略 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const snap = JSON.parse(raw);
      if (snap.player) state.player = Object.assign(state.player, snap.player);
      if (snap.inventory) state.inventory = snap.inventory;
      if (snap.bd) state.bd = snap.bd;
    } catch (e) { /* 忽略 */ }
  }

  function applyProfile(profile) {
    if (!profile) return;
    state.player.name = profile.name || state.player.name;
    if (profile.coins != null) state.player.coins = profile.coins;
    state.inventory = (profile.inventory && Object.keys(profile.inventory).length) ? profile.inventory : state.inventory;
    state.bd = (profile.bd && Object.keys(profile.bd).length) ? profile.bd : buildDefaultBD();
    // 登录时服务器库存为权威值，清空本地未对账账本
    state.codex = profile.codex || {};
    state.catchCount = profile.catchCount || 0;
    state.localGains = [];
  }

  // ---- 渔获解析 ----
  function resolveItem(pick) {
    const idx = pick.indexOf(':');
    const type = pick.slice(0, idx);
    const id = pick.slice(idx + 1);
    if (type === 'fish') {
      for (const tier of ['common', 'big', 'rare']) {
        const f = D.FISH[tier].find(function (x) { return x.id === id; });
        if (f) return { kind: 'fish', rarity: f.rarity, id: f.id, name: f.name, size: rollSize(f.size) };
      }
    }
    if (type === 'material') {
      const m = D.MATERIALS.find(function (x) { return x.id === id; });
      if (m) return { kind: 'material', rarity: m.rarity, id: m.id, name: m.name, size: null };
    }
    if (type === 'component') {
      return { kind: 'component', rarity: D.COMPONENT_DROP.rarity, id: D.COMPONENT_DROP.id, name: D.COMPONENT_DROP.name, size: null };
    }
    return null;
  }

  // 体型随机：偏向小值（越级越罕见），保留 1 位小数
  function rollSize(range) {
    if (!range) return null;
    const r = Math.pow(Math.random(), 1.6);
    return Math.round((range[0] + (range[1] - range[0]) * r) * 10) / 10;
  }

  function weightedPick(pool) {
    let total = 0;
    pool.forEach(function (e) { total += e.weight; });
    let r = Math.random() * total;
    for (const e of pool) {
      r -= e.weight;
      if (r <= 0) return e.pick;
    }
    return pool[pool.length - 1].pick;
  }

  function resolveSpot(groundId, spotId) {
    const g = D.GROUNDS.find(function (x) { return x.id === groundId; });
    if (!g) return null;
    return g.spots.find(function (x) { return x.id === spotId; }) || null;
  }

  // ---- 钓鱼 ----
  function addToInventory(item) {
    state.inventory[item.id] = (state.inventory[item.id] || 0) + 1;
  }

  function recordCatch(item, who, groundName, spotName) {
    const entry = { t: Date.now(), who: who, item: item, ground: groundName, spot: spotName };
    const isMine = who === state.player.name;
    const noteworthy = item.rarity === 'big' || item.rarity === 'rare' || item.kind === 'component';
    if (isMine) {
      state.log.unshift(entry);
      if (state.log.length > 60) state.log.pop();
      addToInventory(item);
      // 本地乐观图鉴：不必等服务器回推，先解锁
      state.catchCount = (state.catchCount || 0) + 1;
      const cx = state.codex[item.id] || { count: 0, first: Date.now() };
      cx.count += 1;
      state.codex[item.id] = cx;
      // 账本登记：服务器 assets 回执带 seq，可精确丢弃已入账部分
      entry.seq = ++state.catchSeq;
      state.localGains.push({ seq: entry.seq, id: item.id });
      if (state.localGains.length > 400) state.localGains.shift();
      if (noteworthy) {
        state.player.recent = item.size ? (item.name + ' ' + item.size + 'cm') : item.name;
        // 必须同步上报，否则服务器玩家列表里的 recent 永远是旧值/空
        if (window.Net) window.Net.sendPresence();
      }
    }
    // 所有渔获都上报服务器（服务器侧入库 + 图鉴 + 大鱼榜 + 动态）
    if (window.Net) window.Net.announceCatch(entry);
    save();
    return entry;
  }

  function doCatch(groundId, spotId, who) {
    const spot = resolveSpot(groundId, spotId);
    if (!spot) return null;
    const g = D.GROUNDS.find(function (x) { return x.id === groundId; });
    const item = resolveItem(weightedPick(spot.pool));
    if (!item) return null;
    return recordCatch(item, who, g.name, spot.name);
  }

  function startFishing(groundId, spotId) {
    const spot = resolveSpot(groundId, spotId);
    if (!spot) return { ok: false, msg: '请先选择有效的钓鱼点与垂钓点。' };
    state.selected = { groundId: groundId, spotId: spotId };
    state.player.groundId = groundId;
    state.player.spotId = spotId;
    state.player.status = 'fishing';
    state.fishing.active = true;
    if (window.Net) window.Net.sendPresence();
    doCatch(groundId, spotId, state.player.name);
    if (state.fishing.timer) clearInterval(state.fishing.timer);
    state.fishing.timer = setInterval(function () {
      if (!state.fishing.active) return;
      doCatch(groundId, spotId, state.player.name);
      if (window.UI) window.UI.refreshAll();
    }, FISH_INTERVAL);
    save();
    return { ok: true };
  }

  function stopFishing() {
    state.fishing.active = false;
    state.player.status = 'idle';
    // 离开钓点：清空位置与近期渔获，避免残留展示
    state.player.groundId = null;
    state.player.spotId = null;
    state.player.recent = null;
    if (state.fishing.timer) { clearInterval(state.fishing.timer); state.fishing.timer = null; }
    if (window.Net) window.Net.sendPresence({ recentClear: true });
    if (window.UI) window.UI.refreshAll();
    save();
  }

  function playersAtGround(groundId) {
    return state.players.filter(function (b) { return b.groundId === groundId; });
  }

  function init() {
    load();
  }

  return {
    state: state, init: init, save: save, applyProfile: applyProfile,
    startFishing: startFishing, stopFishing: stopFishing,
    resolveSpot: resolveSpot, doCatch: doCatch,
    playersAtGround: playersAtGround,
    buildDefaultBD: buildDefaultBD,
  };
})();
