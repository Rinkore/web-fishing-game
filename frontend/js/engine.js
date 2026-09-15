/*
 * 网页钓鱼小游戏 - 客户端状态层（瘦客户端）
 * 钓鱼循环/掷骰/资产结算/钓竿配置全部在服务器；本文件只维护展示状态、
 * 发送指令、保存本地界面偏好。金币/库存/图鉴/BD 以服务器推送为唯一权威。
 */
window.Engine = (function () {
  'use strict';
  const D = window.GameData;

  const SAVE_KEY = 'fishing_game_state_v03'; // v3：仅保存界面偏好，不再保存资产

  const state = {
    me: null,                   // 本机玩家连接身份（由 Net 赋值）
    player: { name: '你', status: 'idle', groundId: null, spotId: null, coins: 500, recent: null },
    fishing: { active: false },
    fishingInterval: 3000,      // 服务器返回的实际钓速（展示用）
    castInfo: null,             // 钓速明细：后台基础值 + 词缀/钓点增益/全服加成 + 实际间隔
    castCfg: null,              // 后台抛竿间隔/全服钓速配置（/api/version 与 castcfg 广播同步）
    priceCfg: null,             // 后台经济参数（价格模型；/api/version 与 pricecfg 广播同步）
    dropCfg: null,              // 后台产出倍率（全局+分类；同上）
    rodName: '',                // 当前钓竿命名
    rodSlots: [],               // 钓竿槽位（含已保存钓竿：name/parts/affixes）
    rodSlotsCount: 1,           // 已购买槽位数（首个免费）
    rodSlotsMax: 8,
    nextRodSlotPrice: null,     // 下一个槽位价格
    rodActiveSlot: -1,          // 当前使用的槽位（-1 = 用的是散件装配）
    rodLocked: {},              // 被钓竿占用的组件实例件数（背包/交易显示锁定标记）
    inventory: {},              // 服务器权威，SSE assets 整体同步
    bd: buildDefaultBD(),       // 服务器权威，登录/装备时同步
    bdEffects: { speed: 0, big: 0, rare: 0, material: 0, size: 0, double: 0 },
    log: [],                    // 我的渔获日志（服务器 catch 推送，最新在前）
    feed: [],                   // 全服动态（服务器广播）
    players: [],                // 在线玩家（服务器广播）
    shop: {},                   // 系统商店价格（服务器）
    market: [],                 // 市集挂单（服务器）
    records: {},                // 全服大鱼榜（服务器）
    smallRecords: {},           // 全服小鱼纪录（服务器）
    groundCounts: {},           // 各渔场人数（服务器）
    onlineTotal: 0,
    trade: null, tradeLastEvent: null, tradeFlash: null,
    codex: {},                  // 个人图鉴（服务器）
    catchCount: 0,
    feedback: null,             // 反馈意见：{ status:{nextAt,ready,remainingMs,skipCost}, mine:[] }
    chest: null,                // 宝匣：{ chests:[{id,name,mode,costRelic,costCoins,have,pityNow,pityNeed}], relicHave, pityN }
    mall: null,                 // 商城（每日限购）：{ refreshTime, cycleKey, nextRefreshAt, coins, items:[…] }
    workshop: null,             // 工坊：{ cfg, materials:[{id,name,affix,affixName}], pearl }
    smeltCfg: null,             // 熔炼参数（/api/version 与 smeltcfg 广播同步：本地预览与服务器同一套系数）
    update: null,               // 服务端版本更新通知：null 或 { phase, bat, endAt, fireAt, … }
    banners: [],                // 横幅队列（服务器）
    bannerCfg: {},              // 横幅配置（图标闪烁等）
    selected: { groundId: null, spotId: null },
  };

  function buildDefaultBD() {
    const bd = {};
    D.ROD_PARTS.forEach(function (part) {
      bd[part.key] = { compId: null, name: part.default.name, affixes: [], rare: null, isCharm: !!part.isCharm };
    });
    return bd;
  }

  // ---- 本地偏好持久化（仅界面状态；资产/配置一律以服务器为准） ----
  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ selected: state.selected })); } catch (e) { /* 忽略 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const snap = JSON.parse(raw);
      if (snap && snap.selected) state.selected = snap.selected;
    } catch (e) { /* 忽略 */ }
  }

  function applyProfile(profile) {
    // 钓竿存档字段：只在 profile 真的带这些字段时覆盖（局部 profile 不应清空运行时状态）
    if (profile) {
      if (profile.rodName !== undefined) state.rodName = profile.rodName || '';
      if (profile.rodSlots !== undefined) state.rodSlots = profile.rodSlots || [];
      if (profile.rodSlotsCount !== undefined) state.rodSlotsCount = profile.rodSlotsCount;
      if (profile.rodActiveSlot !== undefined) state.rodActiveSlot = profile.rodActiveSlot;
      if (profile.rodSlotsMax !== undefined) state.rodSlotsMax = profile.rodSlotsMax;
      if (profile.nextRodSlotPrice !== undefined) state.nextRodSlotPrice = profile.nextRodSlotPrice;
      if (profile.rodLocked !== undefined) state.rodLocked = profile.rodLocked || {};
    }
    if (!profile) return;
    // 切换账号：清空上一个账号的渔获日志与全服动态，避免串号残留
    const prevUser = state.me && state.me.username;
    const nextUser = profile.username;
    if (prevUser && nextUser && prevUser !== nextUser) resetTransient();
    state.player.name = profile.name || state.player.name;
    if (profile.coins != null) state.player.coins = profile.coins;
    state.inventory = profile.inventory || {};
    state.bd = (profile.bd && Object.keys(profile.bd).length) ? profile.bd : buildDefaultBD();
    state.codex = profile.codex || {};
    state.catchCount = profile.catchCount || 0;
    refreshEffects();
  }
  // 清空与账号绑定的临时展示状态（渔获日志等）
  function resetTransient() {
    state.log = [];
    state.fishing = { active: false };
    state.player.status = 'idle';
    state.player.groundId = null;
    state.player.spotId = null;
    state.player.recent = null;
    state.trade = null;
    state.tradeLastEvent = null;
    state.tradeFlash = null;
    state.selected = { groundId: null, spotId: null };
  }

  // 词缀汇总（展示用：与服务器共用同一份组件目录计算；权威值在服务器）
  function refreshEffects() {
    const eff = { speed: 0, big: 0, rare: 0, material: 0, size: 0, double: 0 };
    D.ROD_PARTS.forEach(function (part) {
      const comp = D.componentOf(state.bd[part.key] && state.bd[part.key].compId);
      if (!comp) return;
      comp.affixes.forEach(function (a) { if (eff[a.type] != null) eff[a.type] += a.value; });
    });
    state.bdEffects = eff;
    return eff;
  }

  function revertLocalFishing() {
    state.player.status = 'idle';
    state.fishing.active = false;
    state.player.groundId = null;
    state.player.spotId = null;
    state.player.recent = null;
    state.selected = { groundId: null, spotId: null };
  }

  // ---- 钓鱼：只发指令。循环与渔获由服务器驱动，经 SSE 'catch'/'assets' 推送 ----
  function startFishing(groundId, spotId) {
    if (!resolveSpot(groundId, spotId)) return Promise.resolve({ ok: false, msg: '请先选择有效的钓鱼点与垂钓点。' });
    // 乐观更新 UI，服务器拒绝时回滚
    state.selected = { groundId: groundId, spotId: spotId };
    state.player.groundId = groundId;
    state.player.spotId = spotId;
    state.player.status = 'fishing';
    state.fishing.active = true;
    if (!window.Net) return Promise.resolve({ ok: false, msg: '网络层未就绪' });
    return window.Net.fishingStart(groundId, spotId).then(function (r) {
      if (r && r.ok) {
        // 注意：网络层返回 { ok, status, data }，业务字段都在 data 里
        const d = r.data || {};
        state.fishingInterval = d.interval || state.fishingInterval;
        state.castInfo = d.castInfo || state.castInfo || null; // 钓速明细（基础值/词缀/钓点增益/全服加成/实际间隔）
        save();
        return { ok: true };
      }
      revertLocalFishing();
      return { ok: false, msg: (r && r.data && r.data.error) || '开始钓鱼失败' };
    });
  }

  function stopFishing() {
    revertLocalFishing();
    if (window.Net) window.Net.fishingStop();
    if (window.UI) window.UI.refreshAll();
    save();
  }

  function resolveSpot(groundId, spotId) {
    const g = D.GROUNDS.find(function (x) { return x.id === groundId; });
    if (!g) return null;
    return g.spots.find(function (x) { return x.id === spotId; }) || null;
  }

  // 同一钓点的在线玩家（含自己）：钓场与钓点都相同才算「同钓点」。
  // 旧版只按钓场过滤，同钓场不同钓点的人也会被列进「同钓点」面板。
  function playersAtSpot(groundId, spotId) {
    return state.players.filter(function (b) { return b.groundId === groundId && b.spotId === spotId; });
  }

  function init() {
    load();
  }

  return {
    state: state, init: init, save: save, applyProfile: applyProfile,
    refreshEffects: refreshEffects, bdEffects: function () { return state.bdEffects; },
    startFishing: startFishing, stopFishing: stopFishing, resetTransient: resetTransient,
    resolveSpot: resolveSpot, playersAtSpot: playersAtSpot,
    buildDefaultBD: buildDefaultBD,
  };
})();
