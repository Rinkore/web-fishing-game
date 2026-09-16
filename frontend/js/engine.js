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
    bigfish: {},                // v0.13.6：大型/巨型鱼预留计数（服务器权威，背包标签行/筛选项用）
    bd: buildDefaultBD(),       // 服务器权威，登录/装备时同步
    bdEffects: { speed: 0, skill: 0, rare: 0, material: 0, size: 0, double: 0 },
    log: [],                    // 我的渔获日志（服务器 catch 推送，最新在前）
    feed: [],                   // 全服动态（服务器广播）
    players: [],                // 在线玩家（服务器广播）
    peepsPage: { page: 1, pages: 1, total: 0, list: [] },  // 同钓点玩家（按当前钓点分页拉取）
    peepsLoading: false,        // 同钓点列表正在拉取（切钓点后本地先清空，不等 5s 轮询）
    peepsGround: '',            // 列表当前对应的钓点 key（变了才重建）
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
    recordsCfg: null,           // 渔获记录贴图：{ scale, x, y }（/api/version 与 recordscfg 广播同步）
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
    if (profile.bigfish !== undefined) state.bigfish = profile.bigfish || {};
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
  // 键集 = 组件词缀全集（speed/skill/rare/material/size/double），与 backend 的 affixTotals 对齐：
  // 旧版这里写的是已废弃的 big 而没有 skill，导致**「技巧」词缀的加成整条不显示**（其余词缀正常）。
  function refreshEffects() {
    const eff = {};
    (D.AFFIX_TYPES || ['speed', 'skill', 'rare', 'material', 'size', 'double']).forEach(function (t) { eff[t] = 0; });
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
    state.peepsPage = { page: 1, pages: 1, total: 0, list: [] };
    state.peepsLoading = false;
    state.peepsGround = '';
  }

  // 切钓点时「同钓点」列表本地即时重建：旧列表是上一个钓点的人，只等 5s 轮询的话，
  // 会一直挂在新钓点下面（「所在」已经变了，「同钓点 N 人」和卡片还是旧的）。
  // 这里立刻清空并标成「同步中」——服务器推送节奏不变，只是本地不再等它。
  function resetPeepsFor(groundId, spotId) {
    state.peepsGround = (groundId ? groundId + '/' + (spotId || '') : '');
    state.peepsPage = { page: 1, pages: 1, total: 0, list: [] };
    state.peepView = { size: 20, q: '', page: 1 };
    state.peepsLoading = true;
  }
  // 立刻按该钓点拉一次分页（切点成功之后调；拉到了 net.js 会撤掉「同步中」）
  function loadPeepsFor(groundId, spotId) {
    if (window.Net && window.Net.fetchPlayersPage) {
      window.Net.fetchPlayersPage({ target: 'peepsPage', page: 1, size: 20, q: '', ground: groundId, spot: spotId });
    }
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
    const key = groundId + '/' + (spotId || '');
    if (state.peepsGround !== key) resetPeepsFor(groundId, spotId);   // 换钓点（或首次开始）才重建列表
    return window.Net.fishingStart(groundId, spotId).then(function (r) {
      if (r && r.ok) {
        // 注意：网络层返回 { ok, status, data }，业务字段都在 data 里
        const d = r.data || {};
        state.fishingInterval = d.interval || state.fishingInterval;
        state.castInfo = d.castInfo || state.castInfo || null; // 钓速明细（基础值/词缀/钓点增益/全服加成/实际间隔）
        // 名单必须在「开始成功」之后再拉：抢先拉会拿到切点前的旧名单（新钓点 0 人），
        // 界面要空等下一次 5s 轮询才出现人。
        if (state.peepsGround === key) loadPeepsFor(groundId, spotId);
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
    resetPeeps: resetPeepsFor,   // 重连续钓等场景：按当前钓点即时重建「同钓点」列表
    loadPeeps: loadPeepsFor,     // 按当前钓点立刻拉一次分页（推送节奏不变）
    resolveSpot: resolveSpot, playersAtSpot: playersAtSpot,
    buildDefaultBD: buildDefaultBD,
  };
})();
