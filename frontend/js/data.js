/*
 * 网页钓鱼小游戏 - 静态数据（前后端共享，单一来源）
 * 浏览器经 <script> 加载挂到 window.GameData；后端 require 得到同一对象（UMD）。
 * 钓场 / 钓点 / 渔获 / 组件底材与词缀池 / 品质定义只有这一份，服务器掷骰与前端展示共用。
 *
 * 组件模型（v0.8 大改）：
 *   底材（base）—— 组件模板，定义部位、基准价与「可拥有词缀池」（每条词缀含数值区间）。
 *   品质（quality）—— common/rare/epic，决定一件组件最多能带几条词缀（1/2/3），并给基准价倍率。
 *   实例（instance）—— 钓鱼等途径产出时从底材词缀池中抽取 1 至全部词缀并逐条 roll 数值生成。
 *   实例身份 = 内容签名：baseId#quality#code+value,code+value（词条按底材池顺序规范化）。
 *     词缀组合与数值完全相同的组件天然堆叠，背包仍是 {实例签名: 数量}。
 *   修饰词 —— 由词缀组合推导，如「完美的 竹制短竿」（见 adjectiveOf）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameData = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

  // ---- 版本标识（前后端唯一来源）----
  // 前端页面内置此版本号，启动时与服务器 /api/version 比对：不一致即带缓存参数强制刷新，
  // 修复「版本更新后，浏览器缓存旧前端无法进入新版页面」的问题。
  const VERSION = 'v0.11.4';
  const BUILD = '2026-09-15';

  // ---- 渔获定义 ----
  // price = 系统商店基准收购价；size = [min, max] 体型范围（cm），用于渔获纪录。
  // 三个数组是**掉落档**（决定掉落池分组与产出倍率），rarity 才是**品质**：
  //   品质只有 普通 common / 稀有 rare / 史诗 epic / 神话 mythic 四种（见 QUALITY）。
  //   「大鱼」曾经被误当成第四种品质（金色 + 👑），v0.11 起修正：
  //   大型鱼按价值分别归入 稀有（120~180）与 史诗（210+），不再有独立配色与皇冠标记。
  const FISH = {
    common: [
      { id: 'crucian', name: '鲫鱼', rarity: 'common', price: 8, size: [10, 35] },
      { id: 'carp', name: '鲤鱼', rarity: 'common', price: 12, size: [20, 70] },
      { id: 'grass', name: '草鱼', rarity: 'common', price: 15, size: [30, 90] },
      { id: 'white', name: '白条', rarity: 'common', price: 6, size: [8, 25] },
      { id: 'tilapia', name: '罗非鱼', rarity: 'common', price: 10, size: [15, 45] },
      { id: 'minnow', name: '麦穗鱼', rarity: 'common', price: 5, size: [4, 12] },
      { id: 'loach', name: '泥鳅', rarity: 'common', price: 9, size: [10, 25] },
      { id: 'sardine', name: '沙丁鱼', rarity: 'common', price: 6, size: [8, 18] },
      { id: 'croaker', name: '小黄鱼', rarity: 'common', price: 11, size: [10, 25] },
      { id: 'yellowcat', name: '黄辣丁', rarity: 'common', price: 13, size: [12, 30] },
      { id: 'bream', name: '鳊鱼', rarity: 'common', price: 14, size: [20, 50] },
      { id: 'silvercarp', name: '鲢鱼', rarity: 'common', price: 15, size: [30, 75] },
      { id: 'bighead', name: '鳙鱼', rarity: 'common', price: 17, size: [35, 90] },
      { id: 'riverperch', name: '河鲈', rarity: 'common', price: 12, size: [15, 40] },
      { id: 'culter', name: '翘嘴鲌', rarity: 'common', price: 18, size: [25, 60] },
      { id: 'blackcarp', name: '青鱼', rarity: 'common', price: 20, size: [40, 100] },
    ],
    big: [
      { id: 'catfish', name: '巨型鲶鱼', rarity: 'rare', price: 120, size: [80, 220] },
      { id: 'bass', name: '湖王鲈鱼', rarity: 'rare', price: 150, size: [60, 180] },
      { id: 'tuna', name: '黄金枪鱼', rarity: 'epic', price: 260, size: [120, 320] },
      { id: 'sturgeon', name: '远古巨鲟', rarity: 'epic', price: 320, size: [150, 400] },
      { id: 'mandarin', name: '鳜鱼', rarity: 'rare', price: 140, size: [35, 90] },
      { id: 'blackbass', name: '大口黑鲈', rarity: 'rare', price: 160, size: [45, 130] },
      { id: 'seabass', name: '海鲈', rarity: 'rare', price: 170, size: [55, 140] },
      { id: 'yellowcheek', name: '鳡鱼', rarity: 'rare', price: 180, size: [70, 170] },
      { id: 'mackerel', name: '马鲛鱼', rarity: 'epic', price: 210, size: [55, 160] },
      { id: 'grouper', name: '石斑鱼', rarity: 'epic', price: 230, size: [45, 150] },
      { id: 'cobia', name: '军曹鱼', rarity: 'epic', price: 250, size: [90, 200] },
      { id: 'rubysnapper', name: '金目鲷', rarity: 'epic', price: 280, size: [55, 140] },
      { id: 'sunfish', name: '翻车鱼', rarity: 'epic', price: 300, size: [150, 300] },
      { id: 'arapaima', name: '巨骨舌鱼', rarity: 'epic', price: 350, size: [180, 330] },
    ],
    rare: [
      { id: 'koi', name: '黄金锦鲤', rarity: 'rare', price: 400, size: [40, 110] },
      { id: 'pearl', name: '深海珍珠贝', rarity: 'rare', price: 300, size: [10, 40] },
      { id: 'amberlobster', name: '琥珀龙虾', rarity: 'rare', price: 340, size: [20, 60] },
      { id: 'voltaiceel', name: '电光鳗', rarity: 'rare', price: 380, size: [60, 140] },
      { id: 'ghostray', name: '幽灵魟', rarity: 'rare', price: 420, size: [90, 220] },
      { id: 'arowana', name: '金龙鱼', rarity: 'rare', price: 450, size: [45, 95] },
      { id: 'moonkoi', name: '月光鲤', rarity: 'rare', price: 480, size: [40, 110] },
      { id: 'dragonfish', name: '深海龙鱼', rarity: 'rare', price: 500, size: [50, 120] },
      { id: 'swordfish', name: '剑鱼', rarity: 'rare', price: 520, size: [180, 380] },
      { id: 'bluefin', name: '蓝鳍金枪鱼', rarity: 'rare', price: 560, size: [130, 300] },
    ],
  };

  // 材料：既是钓获掉落物，也是工坊熔炼的消耗品（见 SMELT_MATERIALS）。
  // 龙宫宝珠 v0.11 起归入材料（此前被错误地登记成鱼）：它是熔炼与宝匣体系里的催化剂，
  // 不作为渔获进图鉴/纪录/自动售出，也不会被「钓到鱼」类统计计入。
  const MATERIALS = [
    { id: 'bait_pack', name: '诱饵包', rarity: 'common', price: 5, size: null },
    { id: 'rope', name: '耐磨绳', rarity: 'common', price: 4, size: null },
    { id: 'lure', name: '反光假饵', rarity: 'common', price: 7, size: null },
    { id: 'relic', name: '沉船宝匣残片', rarity: 'rare', price: 380, size: null },
    { id: 'tide_sand', name: '潮汐砂', rarity: 'rare', price: 260, size: null },
    { id: 'dragon_scale', name: '龙鳞碎屑', rarity: 'epic', price: 720, size: null },
    { id: 'dragonpearl', name: '龙宫宝珠', rarity: 'epic', price: 600, size: null },
  ];

  // 稀有度基准价倍率（无独立 price 时兜底；仅用于渔获/材料）
  const RARITY_PRICE = { common: 10, rare: 350, epic: 600, mythic: 1200 };

  // ---- 钓竿部位框架（含饰品栏位） ----
  // 每个部位默认安装一个“标准”组件，默认无词缀、无效果。
  const ROD_PARTS = [
    { key: 'rod', name: '竿身', default: { name: '标准竿身' } },
    { key: 'line', name: '线组', default: { name: '标准线组' } },
    { key: 'hook', name: '钩', default: { name: '标准钩' } },
    { key: 'bait', name: '饵', default: { name: '标准饵' } },
    { key: 'reel', name: '卷线器', default: { name: '标准卷线器' } },
    { key: 'accessory', name: '配件', default: { name: '标准配件' } },
    { key: 'charm', name: '饰品栏位', isCharm: true, default: { name: '（空）' } },
  ];

  // ---- 词缀类型（engine 计算效果、UI 展示共用） ----
  // 组件词缀共 6 类；其中「技巧」曾叫「大鱼概率」（v0.11 改名并改语义）：
  //   旧「大鱼概率」词缀直接提高大型鱼掉落权重，与钓点增益/产出倍率重复且无法表达钓技；
  //   新「技巧」是**上钩率公式的一个变量**（skill），钩率由后台公式决定，代码里不写死任何提示。
  const AFFIX_LABEL = {
    speed: '钓速', skill: '技巧', rare: '稀有概率',
    material: '材料概率', size: '体型', double: '双钓概率',
  };
  // 钓点增益比组件词缀**多一类**「大鱼概率」：增益是钓场/钓点级别的产出倍率，
  // 不参与组件池（避免再次与技巧语义混淆），但后台仍可给钓点加「大鱼概率 +30%」。
  const BUFF_LABEL = Object.assign({}, AFFIX_LABEL, { big: '大鱼概率' });
  // 效果代码（实例签名里用的短码）；legacy 别名让旧存档（code=big）仍可解析
  const AFFIX_CODES = {
    speed: 'spd', skill: 'skl', rare: 'rare', material: 'mat', size: 'size', double: 'dbl',
  };
  const LEGACY_CODE_ALIAS = { big: 'skill' }; // 旧「大鱼概率」词缀 → 「技巧」
  const CODE_TO_TYPE = {};
  Object.keys(AFFIX_CODES).forEach(function (t) { CODE_TO_TYPE[AFFIX_CODES[t]] = t; });
  Object.keys(LEGACY_CODE_ALIAS).forEach(function (c) { CODE_TO_TYPE[c] = LEGACY_CODE_ALIAS[c]; });
  // 实例签名里可出现的全部短码（新码 + 旧别名），供解析用
  const AFFIX_CODE_RE = new RegExp('^(' + Object.keys(CODE_TO_TYPE).join('|') + ')([+-]?\\d+)$');
  // 组件词缀类型全集（固定顺序；池外补足时按此顺序取候选，保证签名跨端一致）
  // 刻意用显式数组而不是 Object.keys：顺序稳定，且不会因为给 BUFF_LABEL 加键而混进组件池。
  const AFFIX_TYPES = ['speed', 'skill', 'rare', 'material', 'size', 'double'];

  // ---- 池外词缀默认数值区间 ----
  // 「海王遗匣」的突破件会在底材词缀池之外补足词缀（见 genBreakthrough）。
  // 这些区间刻意明显弱于同类型的池内区间（如钓速 4~10 对照池内 8~38），
  // 让池外词缀是「白给的加成」而不是顶替主力词缀——否则 2 条池的弱底材
  // 补上 2 条强池外后，会反超 4 条池的海王徽记，出现强度倒挂。
  // 且全部为正值：终局宝匣产出减益词缀的体感太差。
  // 可被管理后台覆盖（componentCfg.extraAffixRanges）。
  const DEFAULT_EXTRA_AFFIX_RANGES = {
    speed:    [4, 10],
    skill:    [2, 6],
    rare:     [1, 4],
    material: [8, 16],
    size:     [4, 10],
    double:   [3, 8],
  };

  // ---- 品质（== 组件的“稀有度”概念，统一称为品质） ----
  // 全站只有这四种品质：普通 / 稀有 / 史诗 / 神话（渔获与组件共用同一套命名与配色）。
  // cap = 该品质最多可拥有的词缀条数；mult = 实例基准价倍率；cls = 展示配色。
  // 配色规范（前后端同一套 CSS 类，定义在 style.css）：普通=灰蓝 #cbd5e1 / 稀有=黄 / 史诗=紫 / 神话=彩虹。
  // v0.11 修正：此前把渔获的「大鱼」档位当成第五种品质（金色 + 👑），现已移除——
  // 大型鱼按价值归入 稀有/史诗，全站品质只剩这四种。
  // 组件实例的「满词条」金色强调只出现在背包/市集/装备弹窗，图鉴按品质正常显示。
  // 神话 = 宝匣专属品质（只能由「海王遗匣」产出）：cap 4 使「池内优先 + 池外补足到 4 条」成为可能，
  // 也使唯一 4 条池底材（海王徽记）第一次能真正抽满。配色用彩虹渐变，与已占用的灰蓝/黄/紫/金区分。
  const QUALITY = {
    common: { key: 'common', name: '普通', cap: 1, mult: 1,   cls: 'q-common' },
    rare:   { key: 'rare',   name: '稀有', cap: 2, mult: 1.5, cls: 'q-rare' },
    epic:   { key: 'epic',   name: '史诗', cap: 3, mult: 2.4, cls: 'q-epic' },
    mythic: { key: 'mythic', name: '神话', cap: 4, mult: 3.6, cls: 'q-mythic' },
  };
  const QUALITY_ORDER = { common: 1, rare: 2, epic: 3, mythic: 4 };

  // ---- 宝匣（沉船打捞）----
  // 四个档位，每一档消除一层随机：
  //   Ⅰ 沉船宝匣  基底随机          → 消除「1 词条垃圾」（保底 2 条）
  //   Ⅱ 深潜宝匣  自选部位          → 消除「基底范围」（基底在该部位内随机）
  //   Ⅲ 深渊宝匣  自选底材 + 满词条 → 消除「品质与词条数随机」
  //   Ⅳ 海王遗匣  自选底材 + 神话   → 消除「词缀池边界」（可补池外词缀）
  // 合成消耗「残片 × costRelic + 金币 costCoins」产出宝匣物品（进背包、可市集交易、不可卖给系统商店）；
  // 开箱由服务器权威掷骰（见 server.js 的 /api/chest/*）。
  //   mode:           random = 基底随机；part = 自选部位；base = 自选底材
  //   qualityWeights: 该档位品质权重（按权重归一，不必为 1）
  //   minAffixes:     词条数下限（再受品质上限与底材池长约束）
  //   forceMax:       true = 词条填满该底材池（min(池长, 品质上限)）
  //   extra:          true = 允许池外补足（突破件，见 genBreakthrough）
  // 配方数值（costRelic/costCoins/chance/hitCount…）是**出厂默认**；管理后台改过的成本
  // 落在 world.chestCfg.costs，启动/保存时经 applyChestCosts() 覆盖到这份目录上（前后端同一份）。
  const CHESTS = [
    { id: 'chest_wreck', name: '沉船宝匣', rarity: 'rare',
      desc: '沉船里的随机打捞件，至少 2 条词缀。',
      costRelic: 8, costCoins: 8000, mode: 'random',
      qualityWeights: { rare: 65, epic: 35 }, minAffixes: 2 },
    { id: 'chest_deep', name: '深潜宝匣', rarity: 'rare',
      desc: '自选部位，沉得更深、捞得更准，至少 2 条词缀。',
      costRelic: 20, costCoins: 30000, mode: 'part',
      qualityWeights: { rare: 50, epic: 50 }, minAffixes: 2 },
    { id: 'chest_abyss', name: '深渊宝匣', rarity: 'epic',
      desc: '自选底材，必定史诗，且词条填满该底材的全部词缀池。',
      costRelic: 45, costCoins: 90000, mode: 'base',
      qualityWeights: { epic: 100 }, forceMax: true },
    { id: 'chest_king', name: '海王遗匣', rarity: 'mythic',
      desc: '自选底材，必定神话：50% 概率突破词缀池边界，多出一条该部位本没有的词缀。',
      costRelic: 100, costCoins: 300000, mode: 'base',
      qualityWeights: { mythic: 100 }, extra: true,
      hitCount: 4, missCount: 3, chance: 0.5 },
  ];
  // 宝匣基准价 = 金币成本 + 残片机会成本（仅用于展示与市集参考；宝匣不可卖给系统商店）
  const RELIC_PRICE = (MATERIALS.find(function (m) { return m.id === 'relic'; }) || {}).price || 380;
  const CHEST_MAP = {};
  function chestPrice(c) { return c.costCoins + c.costRelic * RELIC_PRICE; }
  CHESTS.forEach(function (c) { c.price = chestPrice(c); CHEST_MAP[c.id] = c; });
  function chestOf(id) { return CHEST_MAP[id] || null; }
  function isChest(id) { return !!(id && CHEST_MAP[id]); }
  // 出厂配方快照：后台改成本时以它为基准重算，避免「改两次把默认值也覆盖掉」
  const CHEST_BASE_COSTS = {};
  CHESTS.forEach(function (c) { CHEST_BASE_COSTS[c.id] = { costRelic: c.costRelic, costCoins: c.costCoins }; });
  // 套用管理后台的宝匣成本覆盖（原地改 CHESTS，保证前后端读到的都是同一份有效配方）
  // costs: { [chestId]: { costRelic?, costCoins? } }；非法/缺省项回退出厂值。
  function applyChestCosts(costs) {
    const src = costs && typeof costs === 'object' ? costs : {};
    CHESTS.forEach(function (c) {
      const base = CHEST_BASE_COSTS[c.id];
      const ov = src[c.id] || {};
      const relic = Number(ov.costRelic);
      const coins = Number(ov.costCoins);
      c.costRelic = (isFinite(relic) && relic >= 0) ? Math.floor(relic) : base.costRelic;
      c.costCoins = (isFinite(coins) && coins >= 0) ? Math.floor(coins) : base.costCoins;
      c.price = chestPrice(c);
    });
    return CHESTS;
  }
  // 当前生效的宝匣成本（后台表单回显用；只列被覆盖过的档位）
  function chestCostOverrides() {
    const out = {};
    CHESTS.forEach(function (c) {
      const base = CHEST_BASE_COSTS[c.id];
      if (c.costRelic !== base.costRelic || c.costCoins !== base.costCoins) {
        out[c.id] = { costRelic: c.costRelic, costCoins: c.costCoins };
      }
    });
    return out;
  }

  // ---- 组件底材目录（钓竿配置核心） ----
  // pool：底材可拥有的全部词缀（type + 数值区间 [min,max]）；实例从中抽取并 roll 数值。
  // price：底材基准价（实例价 = 底材价 × 品质倍率）。
  // 每个底材池至少 2 条词缀，使「满词条」（抽满全部词缀）成为可追求的稀有结果。
  const COMPONENT_BASES = [
    // 竿身
    { id: 'rod_bamboo', name: '竹制短竿', part: 'rod', price: 55, pool: [
      { type: 'speed', min: 8, max: 14 }, { type: 'size', min: -6, max: 4 } ] },
    { id: 'rod_fiberglass', name: '玻璃钢竿', part: 'rod', price: 85, pool: [
      { type: 'speed', min: 10, max: 18 }, { type: 'size', min: -8, max: -1 } ] },
    { id: 'rod_carbon', name: '碳素长竿', part: 'rod', price: 150, pool: [
      { type: 'speed', min: 14, max: 22 }, { type: 'material', min: -14, max: -4 }, { type: 'size', min: -6, max: 6 } ] },
    { id: 'rod_dragonbone', name: '龙骨巨竿', part: 'rod', price: 260, pool: [
      { type: 'skill', min: 8, max: 14 }, { type: 'size', min: 4, max: 12 }, { type: 'speed', min: -18, max: -8 } ] },
    // 线组
    { id: 'line_nylon', name: '尼龙线组', part: 'line', price: 45, pool: [
      { type: 'material', min: 15, max: 28 }, { type: 'size', min: -6, max: 4 } ] },
    { id: 'line_stealth', name: '隐形鱼线', part: 'line', price: 140, pool: [
      { type: 'rare', min: 3, max: 7 }, { type: 'size', min: -14, max: -5 } ] },
    { id: 'line_titan', name: '钛芯线', part: 'line', price: 170, pool: [
      { type: 'size', min: 10, max: 18 }, { type: 'speed', min: -9, max: -2 } ] },
    { id: 'line_dragon', name: '龙筋线', part: 'line', price: 250, pool: [
      { type: 'skill', min: 4, max: 8 }, { type: 'rare', min: 3, max: 6 }, { type: 'speed', min: -14, max: -6 } ] },
    // 钩
    { id: 'hook_barb', name: '倒刺钩', part: 'hook', price: 50, pool: [
      { type: 'skill', min: 3, max: 6 }, { type: 'size', min: -4, max: 3 } ] },
    { id: 'hook_swallow', name: '血燕钩', part: 'hook', price: 70, pool: [
      { type: 'speed', min: 8, max: 15 }, { type: 'size', min: -12, max: -4 } ] },
    { id: 'hook_steel', name: '精钢鱼钩', part: 'hook', price: 150, pool: [
      { type: 'skill', min: 6, max: 10 }, { type: 'speed', min: -8, max: -2 } ] },
    { id: 'hook_ghost', name: '千钩·鬼牙', part: 'hook', price: 245, pool: [
      { type: 'skill', min: 8, max: 12 }, { type: 'rare', min: -9, max: -3 }, { type: 'size', min: 3, max: 9 } ] },
    // 饵
    { id: 'bait_corn', name: '浓香饵料', part: 'bait', price: 40, pool: [
      { type: 'rare', min: 1, max: 3 }, { type: 'speed', min: 4, max: 9 } ] },
    { id: 'bait_rice', name: '酒米窝料', part: 'bait', price: 42, pool: [
      { type: 'material', min: 22, max: 34 }, { type: 'speed', min: -8, max: -2 } ] },
    { id: 'bait_secret', name: '秘制香饵', part: 'bait', price: 165, pool: [
      { type: 'rare', min: 4, max: 8 }, { type: 'material', min: -14, max: -5 } ] },
    { id: 'bait_bionic', name: '仿生拟饵', part: 'bait', price: 175, pool: [
      { type: 'skill', min: 4, max: 8 }, { type: 'rare', min: 2, max: 5 }, { type: 'material', min: -18, max: -9 } ] },
    // 卷线器
    { id: 'reel_smooth', name: '顺滑卷线器', part: 'reel', price: 55, pool: [
      { type: 'speed', min: 8, max: 13 }, { type: 'material', min: -5, max: 3 } ] },
    { id: 'reel_magnetic', name: '磁力刹车卷线器', part: 'reel', price: 160, pool: [
      { type: 'speed', min: 12, max: 18 }, { type: 'material', min: -14, max: -5 } ] },
    { id: 'reel_electric', name: '电动卷线器', part: 'reel', price: 240, pool: [
      { type: 'speed', min: 20, max: 28 }, { type: 'skill', min: -6, max: 2 } ] },
    { id: 'reel_turbo', name: '涡轮卷线器', part: 'reel', price: 270, pool: [
      { type: 'speed', min: 28, max: 38 }, { type: 'skill', min: -12, max: -4 } ] },
    // 配件
    { id: 'acc_net', name: '鱼护网袋', part: 'accessory', price: 60, pool: [
      { type: 'double', min: 7, max: 12 }, { type: 'speed', min: -4, max: 3 } ] },
    { id: 'acc_float', name: '夜光浮漂', part: 'accessory', price: 52, pool: [
      { type: 'rare', min: 2, max: 5 }, { type: 'size', min: -10, max: -3 } ] },
    { id: 'acc_scoop', name: '自动抄网', part: 'accessory', price: 165, pool: [
      { type: 'double', min: 12, max: 18 }, { type: 'material', min: -8, max: -2 } ] },
    { id: 'acc_sonar', name: '智能探鱼器', part: 'accessory', price: 255, pool: [
      { type: 'skill', min: 5, max: 9 }, { type: 'rare', min: 3, max: 6 }, { type: 'speed', min: -10, max: -3 } ] },
    { id: 'acc_radar', name: '深海声呐雷达', part: 'accessory', price: 300, pool: [
      { type: 'rare', min: 5, max: 9 }, { type: 'size', min: 8, max: 14 }, { type: 'speed', min: -14, max: -6 } ] },
    // 饰品
    { id: 'charm_coin', name: '幸运硬币', part: 'charm', price: 145, pool: [
      { type: 'rare', min: 2, max: 5 }, { type: 'size', min: 6, max: 12 } ] },
    { id: 'charm_jade', name: '翡翠鲤玉', part: 'charm', price: 155, pool: [
      { type: 'size', min: 15, max: 24 }, { type: 'speed', min: -12, max: -4 } ] },
    { id: 'charm_gold', name: '金鳞坠饰', part: 'charm', price: 250, pool: [
      { type: 'skill', min: 3, max: 6 }, { type: 'rare', min: 2, max: 5 }, { type: 'speed', min: 6, max: 12 } ] },
    { id: 'charm_trident', name: '海王徽记', part: 'charm', price: 290, pool: [
      { type: 'skill', min: 6, max: 10 }, { type: 'rare', min: 4, max: 8 }, { type: 'double', min: 8, max: 14 }, { type: 'speed', min: -16, max: -8 } ] },
  ];
  const BASE_MAP = {};
  COMPONENT_BASES.forEach(function (b) { b.pool = b.pool.map(function (a) { return { type: a.type, min: a.min, max: a.max }; }); BASE_MAP[b.id] = b; });
  function componentBase(id) { return BASE_MAP[id] || null; }

  // ---- 实例签名 ----
  // 格式：baseId#quality#code+value,code+value…（无词缀时第三段为空）
  const INSTANCE_SEP = '#';
  // 词缀类型 → 短码。旧类型名（如已改名的 big）也映射到当前短码，
  // 保证任何调用方构造出的实例签名都是**规范形**，不会写出非标准的 id。
  function codeOf(type) {
    if (AFFIX_CODES[type]) return AFFIX_CODES[type];
    const alias = LEGACY_CODE_ALIAS[type];
    return (alias && AFFIX_CODES[alias]) || type;
  }
  function typeOfCode(code) { return CODE_TO_TYPE[code] || code; }
  function affixToken(a) { return codeOf(a.type) + (a.value >= 0 ? '+' : '') + a.value; }
  // 按底材池顺序规范化词缀，保证同内容 → 同签名
  function orderAffixes(base, affixes) {
    const idx = {};
    (base ? base.pool : []).forEach(function (a, i) { idx[a.type] = i; });
    return affixes.slice().sort(function (x, y) {
      const ix = idx[x.type] == null ? 99 : idx[x.type], iy = idx[y.type] == null ? 99 : idx[y.type];
      return ix - iy || (x.type < y.type ? -1 : 1);
    });
  }
  function instanceId(baseId, quality, affixes) {
    const base = BASE_MAP[baseId];
    const ordered = orderAffixes(base, affixes || []);
    return baseId + INSTANCE_SEP + quality + INSTANCE_SEP + ordered.map(affixToken).join(',');
  }
  function instanceOf(id) {
    const s = String(id);
    const i = s.indexOf(INSTANCE_SEP);
    if (i <= 0) return null;
    const parts = s.split(INSTANCE_SEP);
    if (parts.length !== 3) return null;
    const base = BASE_MAP[parts[0]];
    if (!base || !QUALITY[parts[1]]) return null;
    const affixes = [];
    if (parts[2]) {
      for (const tok of parts[2].split(',')) {
        // 短码表含旧别名 big（→ skill）：v0.10 及更早的存档仍可解析，见 normalizeItemId 的规范化
        const m = AFFIX_CODE_RE.exec(tok);
        if (!m) return null;
        affixes.push({ type: typeOfCode(m[1]), value: parseInt(m[2], 10) });
      }
    }
    return { baseId: base.id, quality: parts[1], affixes: affixes };
  }
  function isInstance(id) { return instanceOf(id) !== null; }

  // ---- 修饰词：由词缀组合推导（如「完美的 竹制短竿」）----
  // 规则可被管理后台覆盖：按顺序取第一条命中的规则。
  // 规则字段：name 修饰词；full 是否必须满词条；noNeg 是否必须无负词条；
  //          netMin/netMax 词条净收益区间；minAffixes/maxAffixes 词条数区间。
  const DEFAULT_ADJECTIVE_RULES = [
    { name: '完美的', full: true, noNeg: true },
    { name: '饱满的', full: true },
    { name: '精良的', noNeg: true },
    { name: '平衡的', netMin: 1 },
    { name: '粗糙的' },
  ];
  function ruleMatches(rule, ctx) {
    if (rule.full != null && !!rule.full !== ctx.full) return false;
    if (rule.noNeg != null && !!rule.noNeg !== ctx.noNeg) return false;
    if (rule.netMin != null && ctx.net < rule.netMin) return false;
    if (rule.netMax != null && ctx.net > rule.netMax) return false;
    if (rule.minAffixes != null && ctx.n < rule.minAffixes) return false;
    if (rule.maxAffixes != null && ctx.n > rule.maxAffixes) return false;
    return true;
  }
  function adjectiveOf(affixes, base, quality) {
    const cap = (QUALITY[quality] || QUALITY.common).cap;
    const poolLen = base ? base.pool.length : (affixes ? affixes.length : 0);
    const maxN = Math.min(cap, poolLen);
    const list = affixes || [];
    const ctx = {
      n: list.length,
      full: !!(list.length >= poolLen && poolLen > 0 && poolLen <= cap && maxN > 0),
      noNeg: !list.some(function (a) { return a.value < 0; }),
      net: list.reduce(function (s, a) { return s + a.value; }, 0),
    };
    const rules = (componentCfg && componentCfg.adjectiveRules && componentCfg.adjectiveRules.length)
      ? componentCfg.adjectiveRules : DEFAULT_ADJECTIVE_RULES;
    for (const r of rules) { if (ruleMatches(r, ctx)) return r.name; }
    return '';
  }

  // 组件实例的完整展示元数据（名称/品质/价格/词条/是否满词条）
  function instanceMeta(id) {
    const inst = instanceOf(id);
    if (!inst) return null;
    const base = BASE_MAP[inst.baseId];
    const q = QUALITY[inst.quality];
    const poolLen = base.pool.length;
    // 词缀条数上限：正常件 = min(品质上限, 池长)；突破件（池外补足）会超出该值，
    // 取实际条数与上限的较大者，否则会出现「4/2 词条」这种自相矛盾的显示。
    const maxN = Math.max(inst.affixes.length, Math.min(q.cap, poolLen));
    // full = 池内全满（沿用旧语义）；突破件同样满足（它的池内部分是全满的）
    const full = inst.affixes.length >= poolLen && poolLen <= q.cap;
    // 词缀对象附带 extra 标记：该词缀不在底材词缀池内（只可能来自宝匣的池外补足）
    const poolTypes = {};
    base.pool.forEach(function (p) { poolTypes[p.type] = 1; });
    const affixes = inst.affixes.map(function (a) {
      return { type: a.type, value: a.value, extra: !poolTypes[a.type] };
    });
    // hasExtra = 含池外词缀（2 条池底材即使「未中」也必然含 1 条，占比很高，只用于逐条标注）
    // breakthrough = 词条数突破史诗的 3 条上限，即真正抽到 4 条（突破件识别的唯一判据）。
    //   两者刻意分开：若用 hasExtra 判定，82% 的海王遗匣产出都会挂上「突破」标签而失去意义。
    const hasExtra = affixes.some(function (a) { return a.extra; });
    const breakthrough = affixes.length > QUALITY.epic.cap;
    const adjective = adjectiveOf(affixes, base, inst.quality);
    return {
      id: id, kind: 'component', baseId: base.id, baseName: base.name, part: base.part,
      quality: inst.quality, qualityName: q.name, qualityCls: q.cls,
      rarity: inst.quality, rarityName: q.name,
      affixes: affixes, pool: base.pool, maxAffixes: maxN,
      full: full, isFull: full, hasExtra: hasExtra, breakthrough: breakthrough,
      adjective: adjective,
      name: adjective + ' ' + base.name,
      price: Math.round(base.price * q.mult),
      size: null,
    };
  }

  // ---- 组件生成：先定品质，再抽词条，最后 roll 数值 ----
  // 生成参数可被管理后台覆盖（品质概率 / 词条数量概率 / 数值 roll 模型 / 底材词缀数值范围）。
  // roll 模型：linear 均匀 / normal 正态 / skew 偏态；组件数值与鱼类体型共用。
  const ROLL_MODELS = ['linear', 'normal', 'skew'];
  const DEFAULT_QUALITY_WEIGHTS = { common: 0.62, rare: 0.30, epic: 0.08 };
  const DEFAULT_COUNT_WEIGHTS = {
    common: [1],                 // 词条数 1..cap 的权重
    rare: [0.5, 0.5],
    epic: [1 / 3, 1 / 3, 1 / 3],
  };
  // affixRanges: { baseId: { type: [min, max] } }，覆盖底材池中对应词缀的数值区间
  // extraAffixRanges: { type: [min, max] }，覆盖「池外词缀」的数值区间（突破件用）
  let componentCfg = {
    qualityWeights: Object.assign({}, DEFAULT_QUALITY_WEIGHTS),
    countWeights: JSON.parse(JSON.stringify(DEFAULT_COUNT_WEIGHTS)),
    rollModel: 'linear',         // linear | normal | skew
    affixRanges: {},
    extraAffixRanges: {},
    adjectiveRules: DEFAULT_ADJECTIVE_RULES.map(function (r) { return Object.assign({}, r); }),
  };
  function defaultComponentCfg() {
    return {
      qualityWeights: Object.assign({}, DEFAULT_QUALITY_WEIGHTS),
      countWeights: JSON.parse(JSON.stringify(DEFAULT_COUNT_WEIGHTS)),
      rollModel: 'linear',
      affixRanges: {},
      extraAffixRanges: {},
      adjectiveRules: DEFAULT_ADJECTIVE_RULES.map(function (r) { return Object.assign({}, r); }),
    };
  }
  // 覆盖生成配置（服务器下发或管理后台保存）；空字段回退默认
  function setComponentCfg(cfg) {
    const d = defaultComponentCfg();
    if (!cfg || typeof cfg !== 'object') { componentCfg = d; return componentCfg; }
    componentCfg = {
      qualityWeights: Object.assign(d.qualityWeights, cfg.qualityWeights || {}),
      countWeights: Object.assign(d.countWeights, cfg.countWeights || {}),
      rollModel: (ROLL_MODELS.indexOf(cfg.rollModel) >= 0) ? cfg.rollModel : d.rollModel,
      affixRanges: cfg.affixRanges || {},
      extraAffixRanges: cfg.extraAffixRanges || {},
      adjectiveRules: (Array.isArray(cfg.adjectiveRules) && cfg.adjectiveRules.length) ? cfg.adjectiveRules : d.adjectiveRules,
    };
    return componentCfg;
  }
  // 池外词缀的实际数值区间（后台可覆盖；非法值回退默认表，再回退 ±0 保护）
  function extraAffixRangeOf(type) {
    const ov = componentCfg.extraAffixRanges && componentCfg.extraAffixRanges[type];
    if (Array.isArray(ov) && ov.length === 2 && isFinite(ov[0]) && isFinite(ov[1]) && ov[1] >= ov[0]) return ov;
    const dft = DEFAULT_EXTRA_AFFIX_RANGES[type];
    return dft || [1, 3];
  }
  function getComponentCfg() { return componentCfg; }

  // ---- 鱼类体型 roll 模型（管理后台可改）----
  // 默认正态：大多数鱼落在基准区间的中段，越大/越小越罕见。
  const SIZE_MODEL_DEFAULT = 'normal';
  let fishCfg = { sizeModel: SIZE_MODEL_DEFAULT };
  function defaultFishCfg() { return { sizeModel: SIZE_MODEL_DEFAULT }; }
  function setFishCfg(cfg) {
    const d = defaultFishCfg();
    fishCfg = { sizeModel: (cfg && ROLL_MODELS.indexOf(cfg.sizeModel) >= 0) ? cfg.sizeModel : d.sizeModel };
    return fishCfg;
  }
  function getFishCfg() { return fishCfg; }
  // 加权随机取 key
  function weightedKey(weights, fallback) {
    const keys = Object.keys(weights || {});
    let total = 0;
    keys.forEach(function (k) { total += Math.max(0, Number(weights[k]) || 0); });
    if (!(total > 0)) return fallback;
    let r = Math.random() * total;
    for (const k of keys) { r -= Math.max(0, Number(weights[k]) || 0); if (r <= 0) return k; }
    return keys[keys.length - 1];
  }
  function rollComponentQuality() {
    return weightedKey(componentCfg.qualityWeights, 'common');
  }
  // 数值 roll 模型：取出 [0,1] 上的随机位置，供词缀数值与鱼类体型共用
  function rollRatio(model) {
    if (model === 'normal') {
      // 正态：均值居中、标准差取 1/6，截断在 [0,1]
      const u1 = Math.random() || 1e-9, u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.max(0, Math.min(1, 0.5 + z / 6));
    }
    if (model === 'skew') return Math.pow(Math.random(), 2); // 偏态：偏向低值（平方分布）
    return Math.random();
  }
  // 数值 roll：在 [min,max] 内按模型取值（整数）
  // 0 值词条无意义（+0% 加成）：roll 到 0 会被拒绝并重 roll 一次；
  // 若两次都为 0（区间跨越 0 时仍可能），落到区间内最近的 ±1，保证不产生 0 值词条。
  function rollAffixValue(min, max, model) {
    if (max <= min) return min;
    const span = max - min;
    function draw() {
      return min + Math.round(rollRatio(model) * span);
    }
    let v = draw();
    if (v === 0) v = draw();
    if (v === 0) v = max > 0 ? 1 : (min < 0 ? -1 : 0);
    return v;
  }
  // 某底材某词缀的实际数值区间（管理后台可覆盖）
  function affixRangeOf(baseId, affix) {
    const ov = componentCfg.affixRanges && componentCfg.affixRanges[baseId];
    const r = ov && ov[affix.type];
    if (Array.isArray(r) && r.length === 2 && isFinite(r[0]) && isFinite(r[1]) && r[1] >= r[0]) return r;
    return [affix.min, affix.max];
  }
  // 按品质的词条数量权重取 n（1..min(池长, cap)）；wOverride 供宝匣档位覆盖全局权重
  function rollAffixCount(quality, poolLen, cap, wOverride) {
    const upper = Math.min(poolLen, cap);
    const w = wOverride || (componentCfg.countWeights && componentCfg.countWeights[quality]) || null;
    if (!w || !w.length) return 1 + Math.floor(Math.random() * Math.max(1, upper));
    let total = 0;
    for (let i = 0; i < upper; i++) total += Math.max(0, Number(w[i]) || 0);
    if (!(total > 0)) return 1 + Math.floor(Math.random() * Math.max(1, upper));
    let r = Math.random() * total;
    for (let i = 0; i < upper; i++) { r -= Math.max(0, Number(w[i]) || 0); if (r <= 0) return i + 1; }
    return upper;
  }
  // 生成一件组件实例（底材 → 品质 → 抽 1..min(池长, 上限) 条词缀 → roll 数值）
  // opt 供宝匣档位覆盖（不传则与钓鱼掉落路径完全一致，行为不变）：
  //   countWeights 覆盖词条数量权重；minAffixes 为词条数下限；forceMax 取满池。
  function genComponent(baseId, quality, opt) {
    const base = BASE_MAP[baseId];
    if (!base) return null;
    const o = opt || {};
    const q = QUALITY[quality] || QUALITY.common;
    const upper = Math.min(base.pool.length, q.cap);
    let n = o.forceMax ? upper : rollAffixCount(q.key, base.pool.length, q.cap, o.countWeights || null);
    const floor = Math.max(1, Math.min(Number(o.minAffixes) || 0, upper));
    if (n < floor) n = floor;
    if (n > upper) n = upper;
    // 无放回抽取 n 条（洗牌池）
    const idxs = base.pool.map(function (_, i) { return i; });
    for (let i = idxs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = idxs[i]; idxs[i] = idxs[j]; idxs[j] = t; }
    const picked = idxs.slice(0, n).sort(function (a, b) { return a - b; }).map(function (i) {
      const a = base.pool[i];
      const rng = affixRangeOf(base.id, a);
      return { type: a.type, value: rollAffixValue(rng[0], rng[1], componentCfg.rollModel) };
    });
    return instanceMeta(instanceId(base.id, q.key, picked));
  }
  // ---- 边界偏向 roll（「海王遗匣」与工坊熔炼共用）----
  // 每个词条 roll 两次，取**离区间边界更近**的那次，例如区间 [-1, 8]：
  //   roll 出 -1 与 6 → 取 -1（|−1−(−1)|=0 ＜ |6−8|=2）；roll 出 4 与 8 → 取 8（0 ＜ 4）。
  // 效果是「极值更容易出现」，即词缀更容易 roll 到两端的高价值/高代价位置；
  // 区间跨越 0 时边界仍是两端（-1 一侧与 8 一侧），不会因为「绝对值大」而偏向某一侧。
  function nearerBoundaryOf(a, b, min, max) {
    const da = Math.min(Math.abs(a - min), Math.abs(a - max));
    const db = Math.min(Math.abs(b - min), Math.abs(b - max));
    return db < da ? b : a; // 并列时取第一次（保持可复现的确定性）
  }
  function rollAffixValueBoundary(min, max, model) {
    if (max <= min) return min;
    const a = rollAffixValue(min, max, model);
    const b = rollAffixValue(min, max, model);
    return nearerBoundaryOf(a, b, min, max);
  }

  // 宝匣突破件（「海王遗匣」专属）：品质锁定神话，词缀可越过底材池边界。
  // 规则：掷一次 chance（默认 50%）——中则目标 hitCount（默认 4 条），未中则 missCount（默认 3 条）；
  //       池内词缀全取，不足目标的部分从「池外词缀」补足（不重复、不与池内类型重复、数值恒为正）。
  // 数值：每个词条 roll 两次取靠近区间边界的那次（见 rollAffixValueBoundary）。
  // 特例：池长已够最高目标的底材（全游戏只有 4 条池的海王徽记）直接满池、不掷骰也不补池外——
  //       否则「未中」分支会把它 4 条池里弃掉 1 条，让最贵的宝匣产出降级件。
  function genBreakthrough(baseId, opt) {
    const base = BASE_MAP[baseId];
    if (!base) return null;
    const o = opt || {};
    const hitN = o.hitCount != null ? o.hitCount : 4;
    const missN = o.missCount != null ? o.missCount : 3;
    const freePass = base.pool.length >= hitN;
    const hit = freePass || Math.random() < (o.chance != null ? o.chance : 0.5);
    const target = Math.max(base.pool.length, Math.min(QUALITY.mythic.cap, hit ? hitN : missN));
    const picked = base.pool.map(function (a) {
      const rng = affixRangeOf(base.id, a);
      return { type: a.type, value: rollAffixValueBoundary(rng[0], rng[1], componentCfg.rollModel) };
    });
    let need = target - picked.length;
    if (need > 0) {
      const used = {};
      picked.forEach(function (a) { used[a.type] = 1; });
      const cands = AFFIX_TYPES.filter(function (t) { return !used[t]; });
      for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = cands[i]; cands[i] = cands[j]; cands[j] = t; }
      cands.slice(0, need).forEach(function (t) {
        const rng = extraAffixRangeOf(t);
        picked.push({ type: t, value: rollAffixValueBoundary(rng[0], rng[1], componentCfg.rollModel) });
      });
    }
    return instanceMeta(instanceId(base.id, QUALITY.mythic.key, picked));
  }
  // 按档位权重定品质（宝匣用；权重为空则回退全局品质权重）
  function rollChestQuality(chest) {
    const w = (chest && chest.qualityWeights) || null;
    if (!w || !Object.keys(w).length) return rollComponentQuality();
    const k = weightedKey(w, null);
    return QUALITY[k] ? k : 'rare';
  }
  // 从整份底材目录均匀抽一个底材，再定品质生成
  function rollComponent() {
    const base = COMPONENT_BASES[Math.floor(Math.random() * COMPONENT_BASES.length)];
    return genComponent(base.id, rollComponentQuality());
  }

  // ---- 工坊 · 熔炼 ----
  // 玩家放两件组件（主 / 副），各选一条词条，熔炼后**主件的词条就是选中的那两条**（重新 roll 数值）：
  //   主件选中的那条 → 在原底材区间内重 roll；副件选中的那条 → 该词缀若在主件词缀池内按主件区间 roll，
  //   若不在池内（把副件独有的词缀熔到主件上）则按「池外词缀区间」roll，与宝匣突破件同一套规则。
  // 投料（可选）：从**主件自己的词缀池**里再补一条主件尚未拥有的词缀并 roll 值；投料越多，补缀成功率越高。
  // 龙宫宝珠（可选）：roll 值改为掷两次取靠近区间边界的那次（与海王遗匣同一规则，见 rollAffixValueBoundary）。
  // 残片保留（可选，v0.11.3 新增，只对海王遗匣产出的神话主件）：投入至多 10 片沉船宝匣残片，
  //   成功时按概率把主件的池外（突破）词缀原值保留到结果上，见 smeltExtraAffixesOf / smeltRetainChance。
  // 失败（v0.11.3 起）：副件与投料熔毁、残片烧掉、金币花掉，**主件被熔掉选中的那条词条**（其余词条与品质保留）。
  // 熔炼花费金币：材料越多越贵。全部参数由管理后台「⚒ 工坊配置」覆盖（world.smeltCfg）。
  //
  // 材料即「词缀定向器」：每种材料只对应一个词缀类型，投料量最大的那种材料决定要补的词缀
  // （并列时按本表顺序取先出现的）。龙宫宝珠不是定向材料，而是催化剂，单列。
  const SMELT_MATERIAL_AFFIX = {
    lure: 'skill',        // 反光假饵   → 技巧
    bait_pack: 'rare',    // 诱饵包     → 稀有概率
    rope: 'size',         // 耐磨绳     → 体型
    relic: 'material',    // 沉船宝匣残片 → 材料概率
    tide_sand: 'speed',   // 潮汐砂     → 钓速（新材料）
    dragon_scale: 'double', // 龙鳞碎屑 → 双钓（新材料）
  };
  const SMELT_PEARL = 'dragonpearl'; // 龙宫宝珠：催化剂（roll 两次取边界值）
  // 只投料想补的词缀：主件池里必须还有该词缀、且主件当前没有它，否则该材料对这次熔炼无意义。
  function smeltMaterialAffix(id) { return SMELT_MATERIAL_AFFIX[id] || null; }
  function smeltMaterialIds() { return Object.keys(SMELT_MATERIAL_AFFIX); }

  const SMELT_DEFAULTS = {
    baseRate: 50,              // 熔炼基础成功率（%）：失败 = 副件/材料被熔毁、主件失去选中的那条词条
    failPerMaterial: -2,       // 每份材料对**失败率**的加成（%点）：负数 = 投料越多越不易失败
    extraRatePerMaterial: 8,   // 每份材料对「新增词缀」成功率的加成（%点）
    extraRatePearl: 0,         // 龙宫宝珠对「新增词缀」成功率的加成（%点）
    extraRateMax: 95,          // 新增词缀成功率上限（%）
    rateMin: 5,                // 熔炼成功率下限（%）
    rateMax: 99,               // 熔炼成功率上限（%）
    goldBase: 5000,            // 基础金币花费
    goldPerMaterial: 900,      // 每份材料追加金币
    goldPearl: 20000,          // 龙宫宝珠追加金币
    maxMaterials: 20,          // 单次最多投料份数
    maxTypes: 4,               // 单次最多投料种类
    pearlRollTwice: true,      // 龙宫宝珠是否启用「掷两次取边界值」
    // ---- 重铸（用沉船宝匣残片给宝匣产出的神话件重 roll 全部词条数值）----
    recastRelic: 10,           // 每次重铸消耗的沉船宝匣残片
    recastGold: 0,             // 每次重铸消耗的金币（0 = 只收残片）
    recastMinValue: 0,         // 重铸是否强制「至少不比原来差」：0 = 完全重 roll，1 = 每条取更高值
    // ---- 残片保留（海王遗匣产出的神话主件专用）----
    retainPerRelic: 10,        // 每片沉船宝匣残片提供的「保留池外词缀」概率（%）：10 片 = 100%
    retainMaxRelic: 10,        // 单次熔炼最多可投入的残片数
  };
  let smeltCfg = Object.assign({}, SMELT_DEFAULTS);
  function defaultSmeltCfg() { return Object.assign({}, SMELT_DEFAULTS); }
  function setSmeltCfg(cfg) {
    const d = defaultSmeltCfg();
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    Object.keys(d).forEach(function (k) {
      if (c[k] === undefined || c[k] === null || c[k] === '') return;
      const v = (typeof d[k] === 'boolean') ? !!c[k] : Number(c[k]);
      if (typeof d[k] === 'boolean' ? true : isFinite(v)) d[k] = v;
    });
    d.maxMaterials = Math.max(0, Math.min(99, Math.floor(d.maxMaterials)));
    d.maxTypes = Math.max(0, Math.min(8, Math.floor(d.maxTypes)));
    d.retainPerRelic = Math.max(0, Math.min(100, d.retainPerRelic));
    d.retainMaxRelic = Math.max(0, Math.min(99, Math.floor(d.retainMaxRelic)));
    smeltCfg = d;
    return smeltCfg;
  }
  function getSmeltCfg() { return smeltCfg; }

  // 投料清单 [{ id, qty }] → 汇总（总份数 / 各词缀份数 / 主词缀 = 投料量最大的那个）
  function smeltLoadOf(list) {
    const byAffix = {};
    let total = 0, pearl = 0;
    const order = smeltMaterialIds();
    (Array.isArray(list) ? list : []).forEach(function (e) {
      const id = String((e && e.id) || '');
      const qty = Math.max(0, Math.floor(Number(e && e.qty) || 0));
      if (!qty) return;
      if (id === SMELT_PEARL) { pearl += qty; return; }
      const affix = SMELT_MATERIAL_AFFIX[id];
      if (!affix) return;
      byAffix[affix] = (byAffix[affix] || 0) + qty;
      total += qty;
    });
    let dominant = null, best = 0;
    order.forEach(function (id) {
      const affix = SMELT_MATERIAL_AFFIX[id];
      const n = byAffix[affix] || 0;
      if (n > best) { best = n; dominant = affix; }
    });
    return { total: total, pearl: pearl, byAffix: byAffix, dominant: dominant, types: Object.keys(byAffix).length };
  }
  // 成功率：熔炼成功率受投料影响（默认投料越多越不易失败）；补缀成功率随投料单调上升
  function smeltRatesOf(load, hasPearl) {
    const c = smeltCfg;
    const total = Math.max(0, Number(load && load.total) || 0);
    const pearl = hasPearl != null ? !!hasPearl : !!(load && load.pearl > 0);
    const raw = c.baseRate + c.failPerMaterial * total;
    const rate = Math.max(c.rateMin, Math.min(c.rateMax, raw));
    const extraRaw = c.extraRatePerMaterial * total + (pearl ? c.extraRatePearl : 0);
    const extraRate = Math.max(0, Math.min(c.extraRateMax, extraRaw));
    return {
      rate: Math.round(rate * 10) / 10,
      extraRate: Math.round(extraRate * 10) / 10,
      failRate: Math.round((100 - rate) * 10) / 10,
    };
  }
  function smeltGoldOf(load, hasPearl) {
    const c = smeltCfg;
    const total = Math.max(0, Number(load && load.total) || 0);
    const pearl = hasPearl != null ? !!hasPearl : !!(load && load.pearl > 0);
    return Math.max(0, Math.round(c.goldBase + c.goldPerMaterial * total + (pearl ? c.goldPearl : 0)));
  }
  // 某件主件本次熔炼可补的词缀候选（主件池内、且主件当前没有的词缀）
  function smeltAddableAffixes(baseId, currentTypes) {
    const base = BASE_MAP[baseId];
    if (!base) return [];
    const have = {};
    (currentTypes || []).forEach(function (t) { have[t] = 1; });
    return base.pool.filter(function (p) { return !have[p.type]; }).map(function (p) { return p.type; });
  }

  // ---- 熔炼 · 残片保留（只对海王遗匣产出的神话主件开放）----
  // 熔炼成功后主件的词条会被改写成「主件选中 + 副件搬入」（+ 可选补缀），主件原有的**池外词缀**
  // （宝匣突破件补足的、底材词缀池里本来没有的那些）会随之消失。投入沉船宝匣残片后，
  // 成功时按概率把这些池外词缀**按原值**追加回熔炼结果：
  //   概率 = 投入片数 × retainPerRelic%（默认每片 10%，10 片即 100%），上限 100%。
  //   残片不参与投料计算 —— 既不影响熔炼成功率/补缀成功率，也不改变金币花费（只消耗残片本身）。
  //   只有主件确实带池外词缀时才有意义（没有可保留的词条时服务器会直接拒绝，避免白烧残片）。
  function smeltExtraAffixesOf(baseId, affixes) {
    const base = BASE_MAP[baseId];
    if (!base) return [];
    const poolTypes = {};
    base.pool.forEach(function (p) { poolTypes[p.type] = 1; });
    return (affixes || []).filter(function (a) { return !poolTypes[a.type]; })
      .map(function (a) { return { type: a.type, value: a.value }; });
  }
  // 投入 n 片残片时的保留概率（%）：夹在 [0, 100]，保留一位小数
  function smeltRetainChance(relics) {
    const n = Math.max(0, Math.min(smeltCfg.retainMaxRelic, Math.floor(Number(relics) || 0)));
    const per = Number(smeltCfg.retainPerRelic) || 0;
    return Math.max(0, Math.min(100, Math.round(n * per * 10) / 10));
  }

  // ---- 重铸（海王遗匣产出的神话件）----
  // 允许重铸的品质：全游戏只有「海王遗匣」产出神话件（后台掉落权重刻意不含 mythic），
  // 所以神话品质就是「宝匣产出的组件」这一身份标识；工坊熔炼保留主件品质，熔出来的神话件同样可重铸。
  const RECAST_QUALITY = 'mythic';
  function canRecast(meta) { return !!(meta && meta.kind === 'component' && meta.quality === RECAST_QUALITY); }
  // 重铸取值：保持词缀**类型与条数不变**，按当前 roll 模型重新取值
  // （池内词缀用底材区间，池外词缀用「池外词缀区间」——与突破件生成同一套区间）
  function recastAffixes(baseId, affixes) {
    const base = BASE_MAP[baseId];
    if (!base) return null;
    const poolTypes = {};
    base.pool.forEach(function (p) { poolTypes[p.type] = 1; });
    const keepBetter = !!smeltCfg.recastMinValue; // 开启后「至少不比原来差」：取重 roll 与原值里更好的那个
    return (affixes || []).map(function (a) {
      const slot = poolTypes[a.type] ? base.pool.find(function (p) { return p.type === a.type; }) : null;
      const rng = slot ? affixRangeOf(baseId, slot) : extraAffixRangeOf(a.type);
      const v = rollAffixValue(rng[0], rng[1], componentCfg.rollModel);
      // 数值越大越好（负词缀同理：-5 优于 -12），所以「更好」= Math.max
      return { type: a.type, value: keepBetter ? Math.max(v, a.value) : v };
    });
  }

  // ---- 商城（每日限购）----
  // 金币直购官方商品，每件商品有「每日限购」；限购按**刷新时间**（服务器本地时区的 HH:MM）
  // 划分周期，跨过刷新点即重置。刷新时间与商品（物品 / 金币价 / 限购数）都由管理后台配置。
  const MALL_DEFAULTS = {
    refreshTime: '04:00',
    items: [
      { id: 'bait_pack', price: 40, limit: 20 },
      { id: 'lure', price: 60, limit: 20 },
      { id: 'rope', price: 35, limit: 20 },
      { id: 'tide_sand', price: 2600, limit: 3 },
      { id: 'dragon_scale', price: 7200, limit: 1 },
      { id: 'relic', price: 3800, limit: 3 },
    ],
  };
  function defaultMallCfg() {
    return { refreshTime: MALL_DEFAULTS.refreshTime, items: MALL_DEFAULTS.items.map(function (e) { return Object.assign({}, e); }) };
  }
  // 「HH:MM」→ { h, min }；非法返回 null
  function parseRefreshTime(s) {
    const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(s == null ? '' : s));
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
    return { h: h, min: min };
  }
  // 当前限购周期：key = 本周期开始那天的日期串；nextAt = 下次刷新时间戳
  function mallCycleOf(refreshTime, now) {
    const t = parseRefreshTime(refreshTime) || parseRefreshTime(MALL_DEFAULTS.refreshTime);
    const at = isFinite(now) ? Number(now) : Date.now();
    const d = new Date(at);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.min, 0, 0);
    if (start.getTime() > at) start.setDate(start.getDate() - 1);
    const next = new Date(start.getTime());
    next.setDate(next.getDate() + 1);
    function p(n) { return ('0' + n).slice(-2); }
    return {
      key: start.getFullYear() + '-' + p(start.getMonth() + 1) + '-' + p(start.getDate()),
      startAt: start.getTime(), nextAt: next.getTime(), refreshTime: t.h + ':' + p(t.min),
    };
  }

  // ---- 整根钓竿（rodset：part=compId;part=compId…）----
  // 钓竿槽位里保存的整根钓竿在市集上作为「一件」交易；此标识可被前后端共同解析。
  const ROD_SET_PREFIX = 'rodset:';
  function isRodSet(id) { return typeof id === 'string' && id.indexOf(ROD_SET_PREFIX) === 0; }
  function rodPartsOf(id) {
    if (!isRodSet(id)) return null;
    const out = {};
    String(id).slice(ROD_SET_PREFIX.length).split(';').forEach(function (seg) {
      const i = seg.indexOf('=');
      if (i <= 0) return;
      out[seg.slice(0, i)] = seg.slice(i + 1);
    });
    return Object.keys(out).length ? out : null;
  }
  // 由 { 部位: 组件实例id } 生成整竿标识（按部位固定顺序，保证同内容同签名）
  function rodSetId(parts) {
    const segs = [];
    ROD_PARTS.forEach(function (p) { if (parts && parts[p.key]) segs.push(p.key + '=' + parts[p.key]); });
    return segs.length ? (ROD_SET_PREFIX + segs.join(';')) : null;
  }
  // 整竿展示元数据：名称/最高品质/汇总词条（同类型累加）/基准价（各件之和）/逐件明细
  function rodMeta(id) {
    const parts = rodPartsOf(id);
    if (!parts) return null;
    const comps = [];
    ROD_PARTS.forEach(function (p) {
      const c = instanceMeta(parts[p.key]);
      if (c) comps.push({ part: p.key, partName: p.name, comp: c });
    });
    if (!comps.length) return null;
    const agg = {};
    comps.forEach(function (it) { it.comp.affixes.forEach(function (a) { agg[a.type] = (agg[a.type] || 0) + a.value; }); });
    const affixes = Object.keys(agg).map(function (t) { return { type: t, value: agg[t] }; });
    let price = 0, best = 'common';
    comps.forEach(function (it) {
      price += it.comp.price;
      if ((QUALITY_ORDER[it.comp.quality] || 0) > (QUALITY_ORDER[best] || 0)) best = it.comp.quality;
    });
    const q = QUALITY[best];
    return {
      id: id, kind: 'rod', name: '整根钓竿（' + comps.length + ' 件）', parts: comps,
      quality: best, qualityName: q.name, qualityCls: q.cls,
      rarity: best, rarityName: q.name, rarity: best,
      affixes: affixes, pool: [], maxAffixes: comps.length * 3, isFull: false,
      price: price, size: null,
    };
  }

  // 旧存档兼容：框架版掉落的通用组件（无效果、不可装备、可出售）
  const LEGACY_COMPONENT = { id: 'comp_generic', name: '钓竿组件（默认）', part: null, rarity: 'common', price: 40, affixes: [] };

  // ---- 旧组件 id（v0.7 编码格式 `部位_code值_…` 及更早别名）→ 新实例签名 ----
  // 迁移只需产出合法实例：词缀取自旧 id，部位取自前缀，底材选同部位中词缀类型覆盖最多的那个。
  const LEGACY_SEG_RE = /^(spd|speed|big|rare|mat|material|size|dbl|double)(-?\d+)$/i;
  const LEGACY_ALIAS = {
    rod_bamboo: 'rod_spd10', rod_carbon: 'rod_spd20_mat-10',
    line_strong: 'line_mat25_rare-5', line_ghost: 'line_rare5_size-10',
    hook_barb: 'hook_big4', hook_steel: 'hook_big8_spd-5',
    bait_rich: 'bait_rare2', bait_secret: 'bait_rare6_mat-10',
    reel_smooth: 'reel_spd10', reel_electric: 'reel_spd25',
    acc_net: 'acc_dbl10', acc_sonar: 'acc_big6_rare4',
    charm_coin: 'charm_rare3_size10', charm_gold: 'charm_big4_rare3_spd10',
  };
  const LEGACY_PART_PREFIX = { rod: 'rod', line: 'line', hook: 'hook', bait: 'bait', reel: 'reel', acc: 'accessory', charm: 'charm' };
  function legacyAffixesOf(coded) {
    const out = [];
    String(coded).split('_').slice(1).forEach(function (seg) {
      const m = LEGACY_SEG_RE.exec(seg);
      if (m) out.push({ type: typeOfCode(m[1].toLowerCase()), value: parseInt(m[2], 10) });
    });
    return out;
  }
  function pickBaseForLegacy(part, affixes) {
    const cands = COMPONENT_BASES.filter(function (b) { return b.part === part; });
    if (!cands.length) return null;
    let best = cands[0], bestScore = -1;
    cands.forEach(function (b) {
      let score = 0;
      affixes.forEach(function (a) {
        const slot = b.pool.find(function (p) { return p.type === a.type; });
        if (!slot) return;
        score += 2;                                        // 类型命中
        if (a.value >= slot.min && a.value <= slot.max) score += 1; // 数值落在区间内
      });
      if (score > bestScore) { bestScore = score; best = b; }
    });
    return best;
  }
  function legacyToInstance(oldId) {
    const coded = LEGACY_ALIAS[oldId] || oldId;
    if (BASE_MAP[coded]) return null;
    const prefix = String(coded).split('_')[0].toLowerCase();
    const part = LEGACY_PART_PREFIX[prefix];
    if (!part) return null;
    const affixes = legacyAffixesOf(coded);
    if (!affixes.length) return null;
    const base = pickBaseForLegacy(part, affixes);
    if (!base) return null;
    const quality = affixes.length >= 3 ? 'epic' : (affixes.length === 2 ? 'rare' : 'common');
    return instanceId(base.id, quality, affixes);
  }
  // 整竿标识规范化：把每个部位的组件实例 id 也换成规范签名。
  // 少了这一步，存档里「钓竿槽位 / 市集上的整竿」会带着旧短码（如 big-5）继续流传：
  // 拆回背包时写进去的是旧键，之后装备（用规范键查背包）就会查不到，表现为「背包里明明有却装不上」。
  function normalizeRodSetId(id) {
    const parts = rodPartsOf(id);
    if (!parts) return id;
    const next = {};
    Object.keys(parts).forEach(function (k) { next[k] = normalizeItemId(parts[k]); });
    return rodSetId(next) || id;
  }
  // 任意 id 规范化：实例签名 / 整竿标识 → 规范形（词缀顺序与短码统一，含 v0.11 的 big→skl 改名）；
  // 旧组件 id 升级为实例签名；其余（鱼/材料/宝匣）不变。
  function normalizeItemId(id) {
    if (id == null) return id;
    const s = String(id);
    if (isRodSet(s)) return normalizeRodSetId(s);
    const inst = instanceOf(s);
    if (inst) {
      // 规范化：旧短码（big）与乱序词缀都会被改写成当前的标准签名，因此旧存档在启动迁移时自动升级
      const canon = instanceId(inst.baseId, inst.quality, inst.affixes);
      return canon === s ? s : canon;
    }
    if (s === 'comp_generic') return s;
    const up = legacyToInstance(s);
    return up || s;
  }

  // ---- 组件识别：既接受实例签名，也接受旧组件 id ----
  function componentOf(id) {
    if (id == null) return null;
    const s = String(id);
    // 实例签名先规范化（旧短码 / 乱序词条 → 标准签名），返回的 comp.id 因此永远是规范形：
    // 服务端用它做背包键与槽位存档，客户端传来的非标准 id 不会造成「背包里明明有却查不到」。
    if (instanceOf(s)) return instanceMeta(normalizeItemId(s));
    const up = normalizeItemId(s);
    if (up !== s) return instanceMeta(up);
    return null;
  }

  function fishTierOf(id) {
    for (const tier of ['common', 'big', 'rare']) {
      if (FISH[tier].some(function (f) { return f.id === id; })) return tier;
    }
    return null;
  }

  // ---- 钓场 ----
  // 普通钓场常驻；活动钓场为 locked 占位。
  // pool 条目：{ pick: 'fish:<id>' | 'material:<id>' | 'component', weight }
  function p(type, id, weight) { return { pick: type + ':' + id, weight: weight }; }

  const GROUNDS = [
    {
      id: 'stillwater', name: '静水湖', type: 'normal',
      desc: '风平浪静的淡水湖，适合日常稳定产出。',
      spots: [
        { id: 'dock', name: '老旧码头', pos: [69, 30], pool: [
          p('fish', 'crucian', 30), p('fish', 'white', 16), p('fish', 'carp', 18),
          p('fish', 'minnow', 12), p('fish', 'bream', 8),
          p('fish', 'catfish', 4), p('fish', 'bass', 3), p('fish', 'koi', 1),
          p('material', 'bait_pack', 10), p('component', '', 6),
        ] },
        { id: 'reed', name: '芦苇浅滩', pos: [68, 60], pool: [
          p('fish', 'grass', 24), p('fish', 'white', 18), p('fish', 'crucian', 12),
          p('fish', 'minnow', 12), p('fish', 'loach', 10), p('fish', 'yellowcat', 8),
          p('material', 'rope', 12), p('component', '', 7),
        ] },
        { id: 'deep', name: '深水区', pos: [74, 48], pool: [
          p('fish', 'carp', 22), p('fish', 'bighead', 14), p('fish', 'silvercarp', 12),
          p('fish', 'blackcarp', 8), p('fish', 'catfish', 6), p('fish', 'bass', 6),
          p('fish', 'sturgeon', 2), p('fish', 'arapaima', 2),
          p('fish', 'voltaiceel', 1), p('fish', 'moonkoi', 1),
          p('material', 'lure', 10), p('component', '', 6),
        ] },
      ],
    },
    {
      id: 'rapids', name: '急流河', type: 'normal',
      desc: '水流湍急的河流，大鱼概率略高。',
      spots: [
        { id: 'shoal', name: '石滩', pos: [77, 34], pool: [
          p('fish', 'white', 24), p('fish', 'riverperch', 18), p('fish', 'culter', 14),
          p('fish', 'crucian', 10), p('fish', 'blackbass', 5),
          p('material', 'rope', 12), p('component', '', 7),
        ] },
        { id: 'eddy', name: '回水湾', pos: [58, 42], pool: [
          p('fish', 'carp', 24), p('fish', 'crucian', 20), p('fish', 'yellowcat', 12),
          p('fish', 'grass', 10), p('fish', 'culter', 6), p('fish', 'mandarin', 5),
          p('fish', 'arowana', 1),
          p('material', 'bait_pack', 11), p('component', '', 6),
        ] },
        { id: 'fall', name: '瀑布潭', pos: [83, 20], pool: [
          p('fish', 'carp', 12), p('fish', 'bass', 8), p('fish', 'yellowcheek', 6),
          p('fish', 'catfish', 4), p('fish', 'mandarin', 3), p('fish', 'sturgeon', 2),
          p('fish', 'ghostray', 1),
          p('material', 'lure', 10), p('component', '', 7),
        ] },
      ],
    },
    {
      id: 'sunset', name: '落日海湾', type: 'normal',
      desc: '咸淡水交界的海湾，稀有渔获倾向更高。',
      spots: [
        { id: 'beach', name: '沙滩', pos: [42, 71], pool: [
          p('fish', 'tilapia', 22), p('fish', 'sardine', 18), p('fish', 'croaker', 14),
          p('fish', 'sunfish', 5), p('fish', 'pearl', 2),
          p('material', 'bait_pack', 12), p('component', '', 7),
        ] },
        { id: 'pier', name: '防波堤', pos: [35, 30], pool: [
          p('fish', 'seabass', 10), p('fish', 'tuna', 8), p('fish', 'mackerel', 8),
          p('fish', 'cobia', 6), p('fish', 'bluefin', 3), p('fish', 'swordfish', 2),
          p('fish', 'pearl', 2),
          p('material', 'lure', 11), p('component', '', 7),
        ] },
        { id: 'reef', name: '礁石区', pos: [18, 78], pool: [
          p('fish', 'tuna', 10), p('fish', 'grouper', 9), p('fish', 'rubysnapper', 7),
          p('fish', 'seabass', 4), p('fish', 'sturgeon', 3), p('fish', 'pearl', 3),
          p('fish', 'dragonfish', 2), p('fish', 'amberlobster', 2),
          p('material', 'relic', 1), p('material', 'dragonpearl', 1),
          p('material', 'rope', 10), p('component', '', 7),
        ] },
      ],
    },
    {
      id: 'frostmoon', name: '霜月冰湖', type: 'event', locked: true,
      desc: '限时活动钓场，提供特殊产出（即将开放）。',
      spots: [],
    },
  ];

  // 物品产出地点索引：id -> ['钓场·钓点', ...]（图鉴展示用）
  // 鱼类/材料按各自掉落池匹配；组件来自通用组件掉落点（'component:' 条目）
  function spotsOf(id) {
    const item = itemOf(id);
    const type = item.kind === 'fish' ? 'fish' : item.kind === 'material' ? 'material' : 'component';
    const pick = type + ':' + (type === 'component' ? '' : id);
    const out = [];
    GROUNDS.forEach(function (g) {
      g.spots.forEach(function (sp) {
        sp.pool.forEach(function (e) {
          if (e.pick === pick) out.push(g.name + '·' + sp.name);
        });
      });
    });
    return out;
  }

  // ---- 导航配置 ----
  // implemented=false 的入口为占位符，点击不可跳转。
  // 侧栏导航：全部入口**平铺常驻**（不再有「更多」折叠组），顺序即展示顺序；
  // 菜单项多到一屏放不下时，导航区自己滚动（样式见 style.css 的 .nav）。
  const NAV = [
    { id: 'fishing', name: '钓鱼', icon: '🎣', implemented: true },
    { id: 'bd', name: '钓竿配置', icon: '🎯', implemented: true },
    { id: 'ground', name: '渔场动态', icon: '🌊', implemented: true },
    { id: 'inventory', name: '背包', icon: '🎒', implemented: true },
    { id: 'chest', name: '宝匣合成', icon: '🎁', implemented: true },
    { id: 'workshop', name: '工坊', icon: '⚒', implemented: true },
    { id: 'shop', name: '系统商店', icon: '🏪', implemented: true },
    { id: 'market', name: '开放市集', icon: '💱', implemented: true },
    { id: 'trade', name: '在线交易', icon: '🤝', implemented: true },
    { id: 'mall', name: '商城', icon: '🛒', implemented: true },
    { id: 'codex', name: '鱼类图鉴', icon: '📖', implemented: true },
    { id: 'records', name: '渔获记录', icon: '🏆', implemented: true },
    { id: 'feedback', name: '反馈意见', icon: '📮', implemented: true },
    { id: 'logs', name: '日志', icon: '📜', implemented: true },
  ];

  // ---- 物品索引（供 UI / 引擎统一查询） ----
  // 静态物品：渔获 / 材料 / 组件底材（图鉴按底材展示词缀池与数值范围）。
  function allItems() {
    const out = [];
    ['common', 'big', 'rare'].forEach(function (tier) {
      FISH[tier].forEach(function (f) {
        out.push({ id: f.id, name: f.name, rarity: f.rarity, price: f.price, size: f.size || null, kind: 'fish' });
      });
    });
    MATERIALS.forEach(function (m) {
      out.push({ id: m.id, name: m.name, rarity: m.rarity, price: m.price, size: null, kind: 'material' });
    });
    CHESTS.forEach(function (c) {
      out.push({ id: c.id, name: c.name, rarity: c.rarity, price: c.price, size: null, kind: 'chest', chest: c });
    });
    COMPONENT_BASES.forEach(function (b) {
      out.push({ id: b.id, name: b.name, rarity: 'common', price: b.price, size: null, kind: 'component', part: b.part, pool: b.pool });
    });
    out.push({ id: LEGACY_COMPONENT.id, name: LEGACY_COMPONENT.name, rarity: LEGACY_COMPONENT.rarity, price: LEGACY_COMPONENT.price, size: null, kind: 'component', part: null, pool: [] });
    return out;
  }
  const ITEM_MAP = {};
  allItems().forEach(function (it) { ITEM_MAP[it.id] = it; });
  function itemOf(id) {
    if (id == null) return { id: id, name: String(id), rarity: 'common', price: RARITY_PRICE.common, size: null, kind: 'unknown' };
    const s = String(id);
    const rod = rodMeta(s);
    if (rod) return rod;
    const inst = instanceMeta(s);
    if (inst) return inst;
    const nid = normalizeItemId(s);
    if (ITEM_MAP[nid]) return ITEM_MAP[nid];
    return { id: nid, name: nid, rarity: 'common', price: RARITY_PRICE.common, size: null, kind: 'unknown' };
  }
  function itemName(id) { return itemOf(id).name; }
  // 可出售/可上架：渔获、材料、已生成的组件实例、宝匣；组件底材（模板）与未知物不可交易
  function isSellable(id) {
    const it = itemOf(id);
    if (it.kind === 'fish' || it.kind === 'material') return true;
    if (it.kind === 'rod') return true;  // 整根钓竿：仅市集出售（服务端拒绝系统商店收购）
    if (it.kind === 'chest') return true; // 宝匣：仅市集交易（同上，服务端拒绝系统商店收购）
    if (it.kind === 'component') return isInstance(String(id)) || String(id) === 'comp_generic';
    return false;
  }

  return {
    VERSION: VERSION, BUILD: BUILD,
    FISH: FISH, MATERIALS: MATERIALS, RARITY_PRICE: RARITY_PRICE,
    ROD_PARTS: ROD_PARTS,
    AFFIX_LABEL: AFFIX_LABEL, BUFF_LABEL: BUFF_LABEL, AFFIX_CODES: AFFIX_CODES, AFFIX_TYPES: AFFIX_TYPES,
    QUALITY: QUALITY, QUALITY_ORDER: QUALITY_ORDER,
    CHESTS: CHESTS, chestOf: chestOf, isChest: isChest, rollChestQuality: rollChestQuality,
    genBreakthrough: genBreakthrough, RELIC_PRICE: RELIC_PRICE,
    CHEST_BASE_COSTS: CHEST_BASE_COSTS, applyChestCosts: applyChestCosts, chestCostOverrides: chestCostOverrides,
    rollAffixValueBoundary: rollAffixValueBoundary, nearerBoundaryOf: nearerBoundaryOf,
    SMELT_MATERIAL_AFFIX: SMELT_MATERIAL_AFFIX, SMELT_PEARL: SMELT_PEARL,
    SMELT_DEFAULTS: SMELT_DEFAULTS, defaultSmeltCfg: defaultSmeltCfg, setSmeltCfg: setSmeltCfg, getSmeltCfg: getSmeltCfg,
    smeltMaterialAffix: smeltMaterialAffix, smeltMaterialIds: smeltMaterialIds,
    smeltLoadOf: smeltLoadOf, smeltRatesOf: smeltRatesOf, smeltGoldOf: smeltGoldOf, smeltAddableAffixes: smeltAddableAffixes,
    smeltExtraAffixesOf: smeltExtraAffixesOf, smeltRetainChance: smeltRetainChance,
    RECAST_QUALITY: RECAST_QUALITY, canRecast: canRecast, recastAffixes: recastAffixes,
    MALL_DEFAULTS: MALL_DEFAULTS, defaultMallCfg: defaultMallCfg,
    parseRefreshTime: parseRefreshTime, mallCycleOf: mallCycleOf,
    DEFAULT_EXTRA_AFFIX_RANGES: DEFAULT_EXTRA_AFFIX_RANGES, extraAffixRangeOf: extraAffixRangeOf,
    COMPONENT_BASES: COMPONENT_BASES, componentBase: componentBase,
    instanceId: instanceId, instanceOf: instanceOf, isInstance: isInstance,
    codeOf: codeOf, typeOfCode: typeOfCode,
    genComponent: genComponent, rollComponent: rollComponent, rollComponentQuality: rollComponentQuality,
    setComponentCfg: setComponentCfg, getComponentCfg: getComponentCfg, defaultComponentCfg: defaultComponentCfg,
    setFishCfg: setFishCfg, getFishCfg: getFishCfg, defaultFishCfg: defaultFishCfg,
    ROLL_MODELS: ROLL_MODELS, rollRatio: rollRatio,
    affixRangeOf: affixRangeOf, rollAffixValue: rollAffixValue, weightedKey: weightedKey,
    adjectiveOf: adjectiveOf, instanceMeta: instanceMeta, componentOf: componentOf,
    legacyToInstance: legacyToInstance, normalizeItemId: normalizeItemId,
    ROD_SET_PREFIX: ROD_SET_PREFIX, isRodSet: isRodSet, rodPartsOf: rodPartsOf, rodSetId: rodSetId, rodMeta: rodMeta,
    normalizeRodSetId: normalizeRodSetId,
    fishTierOf: fishTierOf, spotsOf: spotsOf,
    GROUNDS: GROUNDS, NAV: NAV,
    allItems: allItems, itemOf: itemOf, itemName: itemName, isSellable: isSellable,
  };
});
