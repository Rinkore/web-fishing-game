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
  const VERSION = 'v0.17.0';
  const BUILD = '2026-09-18';   // 构建日期（仅 /api/version 暴露，界面不展示）

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
  // 注：`rare` 曾叫「稀有概率」（放大稀有档渔获权重），v0.13 改名「稀有度」并改成
  // 「压低普通品质物品权重」——生成战利品时普通品质条目的权重乘以 K/(K+R)（R = 稀有度，K 后台可配）。
  const AFFIX_LABEL = {
    speed: '钓速', skill: '技巧', rare: '稀有度',
    material: '材料概率', size: '体型', double: '双钓概率',
  };
  // 钓点增益的类别 = 组件词缀**同一套**（speed/skill/rare/material/size/double）。
  // v0.13.3 删掉了这里曾经多出来的一类「大鱼概率」（big）：它只放大「大鱼」档掉落权重，
  // 与产出倍率（后台「大鱼季」的 dc.big）和「技巧」的语义都重叠，实际没人用，
  // 还让「大鱼」一词同时指鱼档位和增益类别。旧配置里残留的 { type:'big' } 由服务端载入时剔除。
  const AFFIX_CODES = {
    speed: 'spd', skill: 'skl', rare: 'rare', material: 'mat', size: 'size', double: 'dbl',
  };
  // 旧存档兼容：组件实例签名里出现过的大鱼概率短码仍按「技巧」解析（v0.11 起组件不再产出该词缀）
  const LEGACY_CODE_ALIAS = { big: 'skill' };
  const CODE_TO_TYPE = {};
  Object.keys(AFFIX_CODES).forEach(function (t) { CODE_TO_TYPE[AFFIX_CODES[t]] = t; });
  Object.keys(LEGACY_CODE_ALIAS).forEach(function (c) { CODE_TO_TYPE[c] = LEGACY_CODE_ALIAS[c]; });
  // 实例签名里可出现的全部短码（新码 + 旧别名），供解析用。
  // v0.12.2 起词缀 token 允许带「范围来源」后缀 @src（src = 底材id / 'bt' 突破 / 'ct' 催化），
  // 记录这条词缀的数值当初是按哪个范围 roll 的——熔炼/重铸重 roll 时按它自己的范围，而不是底材池的区间。
  const AFFIX_CODE_RE = new RegExp('^(' + Object.keys(CODE_TO_TYPE).join('|') + ')([+-]?\\d+)(?:@([A-Za-z0-9_]+))?$');
  // 组件词缀类型全集（固定顺序；池外补足时按此顺序取候选，保证签名跨端一致）
  // 刻意用显式数组而不是 Object.keys：顺序稳定，也不受 AFFIX_LABEL 将来加键影响。
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
  // 配色规范（前后端同一套 CSS 类，定义在 style.css）：普通=灰蓝 #cbd5e1 / 稀有=蓝 #38bdf8 / 史诗=金 #ffd24a / 神话=彩虹。
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
      desc: '自选底材，必定神话：50% 概率突破词缀池边界，获得一条<b>突破词缀</b>（该部位本没有的词缀）。',
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
  // 词缀 token：code+value，范围来源不是底材本身时追加 @src（src = 底材id / 'bt' / 'ct'）。
  // 池内词缀省略 @（默认来源 = 所属底材），保证普通组件签名与旧版完全一致、无需迁移。
  // srcExplicit === false 表示 src 是**解析时推断**出来的（旧 token 没有 @）：推断结果只用于
  // 「按谁的区间 roll 值」，绝不写回签名 —— 否则「数值超出本底材区间」的旧件会被改写成带 @src 的
  // 另一个字符串，破坏「规范签名是稳定的（instanceOf→instanceId 幂等）」这一前提，
  // 导致按字符串比较 id 的地方（自动配装、槽位、市集挂单）认不出同一件组件。
  function affixToken(a, baseId) {
    let t = codeOf(a.type) + (a.value >= 0 ? '+' : '') + a.value;
    if (a.src && a.src !== baseId && a.srcExplicit !== false) t += '@' + a.src;
    return t;
  }
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
    return baseId + INSTANCE_SEP + quality + INSTANCE_SEP + ordered.map(function (a) { return affixToken(a, baseId); }).join(',');
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
        const type = typeOfCode(m[1]);
        const value = parseInt(m[2], 10);
        // 范围来源：token 显式携带 @src 时直接用（srcExplicit = true，参与签名）；
        // 旧 token（无 @）按底材池 + 数值**推断**（srcExplicit = false）——推断结果只影响取值区间，
        // 不会被写回签名，见 affixToken 的注释。
        if (m[3]) affixes.push({ type: type, value: value, src: m[3], srcExplicit: true });
        else affixes.push({ type: type, value: value, src: inferAffixSrc(base, type, value), srcExplicit: false });
      }
    }
    return { baseId: base.id, quality: parts[1], affixes: affixes };
  }
  // 旧词缀（无 @src token）的范围来源推断。v0.13 起把**数值**也纳入判据，修复「熔炼把副件词缀
  // 搬进主件、但存档里没记来源」的旧件：这类词缀的数值往往落在主件底材区间之外，而旧版只看
  // 「词缀类型是否在池内」就判定为底材，导致它后续重铸/重 roll 时仍按主件的区间取值。
  //   类型不在池内            → 'bt'（池外，突破区间）
  //   数值落在底材区间内      → 底材本身（正常池内词缀，行为不变）
  //   数值在底材区间之外      → 找同部位里区间能容纳它的底材（即当初搬来它的附件），命中就用那个
  //                              底材的区间；找不到容得下它的底材时维持底材本身，避免把一条本来
  //                              合法的数值改判到更差的区间上。
  function inferAffixSrc(base, type, value) {
    if (!base) return 'bt';
    const slot = base.pool.find(function (p) { return p.type === type; });
    if (!slot) return 'bt';
    if (value == null) return base.id;
    const v = Number(value);
    if (!isFinite(v)) return base.id;
    const own = affixRangeOf(base.id, slot);
    if (v >= own[0] && v <= own[1]) return base.id;
    for (const b of COMPONENT_BASES) {
      if (b.part !== base.part || b.id === base.id) continue;
      const s = b.pool.find(function (p) { return p.type === type; });
      if (!s) continue;
      const r = affixRangeOf(b.id, s);
      if (v >= r[0] && v <= r[1]) return b.id;
    }
    return base.id;
  }
  function isInstance(id) { return instanceOf(id) !== null; }

  // ---- 修饰词：由词缀组合推导（如「完美的 竹制短竿」）----
  // 规则可被管理后台覆盖：**自上而下取第一条命中**，顺序有意义（后台可上下移动调整优先级）。
  // 规则字段：name 修饰词；full 是否必须满词条；noNeg 是否必须无负词条；
  //          netMin/netMax 词条净收益区间；minAffixes/maxAffixes 词条数区间。
  // 「满词条」口径（v0.13.5 修正）：**该底材的词缀池全中**（n ≥ 池长）。
  //   与界面显示的「n/池长 词条」是同一根轴：分子达到分母 = 满词条；池外补出来的多余词条
  //   （工坊补缀 / 宝匣突破件）会让分子超过分母，正好就是「越过词缀池边界」的突破语义。
  //   旧版本界面的分母写的是**品质词条上限**（普通 1 / 稀有 2 / 史诗 3 / 神话 4），于是池长 2 的
  //   底材（电动卷线器等）在史诗下抽满池时显示「2/3」、却挂着「饱满的 + 满词条」——玩家反馈
  //   「饱满的词缀，可词条数不是满词条」；本版把分母统一成池长，前缀与计数不再打架。
  //   （没有改成「按品质上限」判定满词条：普通品质上限 1，而普通件占掉落六成，那样六成组件
  //     都会变成金色满词条，「满词条」这个稀有标记就没意义了。）
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
  // 词条数的三个上限（供界面/后台解释「满词条」到底按哪个算）：
  //   poolLen     底材词缀池长 —— 满词条 / 界面分母用的就是它
  //   cap         品质词条上限（普通 1 / 稀有 2 / 史诗 3 / 神话 4）—— 自然抽条数的上限
  //   naturalMax  min(池长, 品质上限) —— 自然掉落的实际上限（补缀/突破可越过）
  function affixCeilingOf(baseId, quality) {
    const base = BASE_MAP[baseId];
    const cap = (QUALITY[quality] || QUALITY.common).cap;
    const poolLen = base ? base.pool.length : 0;
    return { poolLen: poolLen, cap: cap, naturalMax: Math.min(poolLen, cap) };
  }
  function adjectiveOf(affixes, base, quality) {
    const cap = (QUALITY[quality] || QUALITY.common).cap;
    const poolLen = base ? base.pool.length : (affixes ? affixes.length : 0);
    const list = affixes || [];
    const ctx = {
      n: list.length,
      // 满词条 = 池内全中（池长为 0 时无从谈起，恒 false）；池外词条让它超过池长，仍算满
      full: !!(poolLen > 0 && list.length >= poolLen),
      // 附带上限信息，后台试算/摘要里可直接展示口径
      poolLen: poolLen, cap: cap, naturalMax: Math.min(cap, poolLen),
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
    // 词条数**分母 = 该底材的词缀池长**（v0.13.5 起，与「满词条」判据同一根轴）：
    //   界面显示「n/池长 词条」，分子达到分母就是满词条；池外补出的多余词条（工坊补缀 /
    //   宝匣突破件）会让分子超过分母，读作「越过词缀池边界」，与「突破」标签语义一致。
    //   旧版分母用的是品质上限（普通 1 / 稀有 2 / 史诗 3 / 神话 4），与满词条判据（池长）打架：
    //   池长 2 的底材在史诗下抽满池显示「2/3」却挂着「饱满的 / 满词条」，玩家反馈过这个矛盾。
    const maxN = poolLen;
    // full = 满词条 = 池内全中（池外词条照算满）；池长为 0 的旧版/聚合条目恒 false
    const full = poolLen > 0 && inst.affixes.length >= poolLen;
    // qualityCap 另存一份：后台/提示里要说明「自然掉落上限 = min(池长, 品质上限)，补缀可越过」
    const qualityCap = q.cap;
    // 词缀对象附带 extra 标记：该词缀不在底材词缀池内（池外词缀）；
    // src = 范围来源（底材id / 'bt' 突破 / 'ct' 催化），供重 roll 取区间与识别「池外词缀的来源」用；
    // srcExplicit = 该来源是**签名字面记录的**（@src）还是解析时按数值推断的 ——
    //   只有前者能证明它出自宝匣，后者不能，见 affixKindOf。
    const poolTypes = {};
    base.pool.forEach(function (p) { poolTypes[p.type] = 1; });
    const affixes = inst.affixes.map(function (a) {
      return {
        type: a.type, value: a.value, extra: !poolTypes[a.type], src: a.src || null,
        srcExplicit: a.srcExplicit !== false && !!a.src,
      };
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
      affixes: affixes, pool: base.pool, maxAffixes: maxN, qualityCap: qualityCap,
      full: full, isFull: full, hasExtra: hasExtra, breakthrough: breakthrough,
      adjective: adjective,
      name: adjective + ' ' + base.name,
      price: Math.round(base.price * q.mult),
      size: null,
    };
  }

  // ---- 池外词缀的「来源类型」识别 ----
  // 池外词缀（extra）= 该类型词缀不在所属底材的词缀池内。它按**真实来源**再分三类：
  //   breakthrough 突破词缀：只有「海王遗匣」在词缀池外补足时才会产生（src = 'bt'）
  //   catalyst     催化词缀：工坊熔炼投入催化剂（材料）补缀产生（src = 'ct'）
  //   extra        普通池外词缀：熔炼从附件（副件）搬来的词缀（src = 附件底材 id），
  //                             以及后台定制件 / 旧存档等**来源无法证实**的池外词缀
  // 判据要点：**不能仅凭「不在词缀池内」就断言是突破词缀** —— 熔炼搬词搬来的同样在池外，
  // 但它只是普通池外词缀。因此这里以「词缀自带且经签名字面记录（srcExplicit）的来源」为准：
  // 只有显式记着 @bt 的才叫突破词缀；解析时推断出来的来源无法证明它出自宝匣，一律按普通池外处理。
  function affixKindOf(a) {
    if (!a || !a.extra) return 'pool';
    if (!a.srcExplicit) return 'extra';
    if (a.src === 'ct') return 'catalyst';
    if (a.src === 'bt') return 'breakthrough';
    return 'extra';
  }
  const EXTRA_KIND_NAME = { breakthrough: '突破词缀', catalyst: '催化词缀', extra: '池外词缀' };
  const EXTRA_KIND_DESC = {
    breakthrough: '突破词缀（海王遗匣在词缀池外补足产生）',
    catalyst: '催化词缀（工坊熔炼投入催化剂补缀产生）',
    extra: '池外词缀（熔炼从附件搬来，或来源无法证实的池外词缀）',
  };
  function extraKindName(a) { return EXTRA_KIND_NAME[affixKindOf(a)] || '池外词缀'; }
  function extraKindDesc(a) { return EXTRA_KIND_DESC[affixKindOf(a)] || EXTRA_KIND_DESC.extra; }

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
  // 数值 roll 模型：取出 [0,1] 上的随机位置，供词缀数值与鱼类体型共用。
  // rng 可注入：正式服务端默认仍用 Math.random；Wiki 批量模拟用带种子随机数保证可复现。
  function rollRatioWithRng(model, rng) {
    const rand = typeof rng === 'function' ? rng : Math.random;
    if (model === 'normal') {
      // 正态：均值居中、标准差取 1/6，截断在 [0,1]
      const u1 = rand() || 1e-9, u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.max(0, Math.min(1, 0.5 + z / 6));
    }
    if (model === 'skew') return Math.pow(rand(), 2); // 偏态：偏向低值（平方分布）
    return rand();
  }
  function rollRatio(model) { return rollRatioWithRng(model, Math.random); }
  // 数值 roll：在 [min,max] 内按模型取值（整数）
  // 0 值词条无意义（+0% 加成）：roll 到 0 会被拒绝并重 roll 一次；
  // 若两次都为 0（区间跨越 0 时仍可能），落到区间内最近的 ±1，保证不产生 0 值词条。
  function rollAffixValueWithRng(min, max, model, rng) {
    if (max <= min) return min;
    const span = max - min;
    function draw() {
      return min + Math.round(rollRatioWithRng(model, rng) * span);
    }
    let v = draw();
    if (v === 0) v = draw();
    if (v === 0) v = max > 0 ? 1 : (min < 0 ? -1 : 0);
    return v;
  }
  function rollAffixValue(min, max, model) { return rollAffixValueWithRng(min, max, model, Math.random); }
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
  function rollAffixValueBoundaryWithRng(min, max, model, rng) {
    if (max <= min) return min;
    const a = rollAffixValueWithRng(min, max, model, rng);
    const b = rollAffixValueWithRng(min, max, model, rng);
    return nearerBoundaryOf(a, b, min, max);
  }
  function rollAffixValueBoundary(min, max, model) {
    return rollAffixValueBoundaryWithRng(min, max, model, Math.random);
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
        // 池外补足的词缀记录范围来源 = 'bt'（突破）：熔炼/重铸重 roll 时仍按突破区间取值
        picked.push({ type: t, value: rollAffixValueBoundary(rng[0], rng[1], componentCfg.rollModel), src: 'bt' });
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

  // ---- 通用公式求值器（前后端共用；递归下降解析，不使用 eval）----
  // 支持 + - * / % 、括号、一元正负号、数字字面量、变量与函数调用。
  // varNames 给出允许出现的变量名（其余标识符一律编译报错），函数固定为下面这一组。
  // 返回 { ok: true, fn(vars) } 或 { error }；fn 只做纯算术，调用方负责夹紧取值范围。
  const EXPR_FUNCS = {
    min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
    clamp: function (x, lo, hi) { return Math.min(hi, Math.max(lo, x)); },
  };
  function compileExpr(src, varNames) {
    const s = String(src == null ? '' : src).trim();
    const vars = Array.isArray(varNames) ? varNames : [];
    if (!s) return { error: '公式不能为空' };
    let i = 0;
    function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
    function parseExpr() {
      let f = parseTerm();
      for (;;) {
        ws();
        if (s[i] === '+') { i++; const a = f, b = parseTerm(); f = function (v) { return a(v) + b(v); }; }
        else if (s[i] === '-') { i++; const a = f, b = parseTerm(); f = function (v) { return a(v) - b(v); }; }
        else return f;
      }
    }
    function parseTerm() {
      let f = parseFactor();
      for (;;) {
        ws();
        if (s[i] === '*') { i++; const a = f, b = parseFactor(); f = function (v) { return a(v) * b(v); }; }
        else if (s[i] === '/') { i++; const a = f, b = parseFactor(); f = function (v) { return a(v) / b(v); }; }
        else if (s[i] === '%') { i++; const a = f, b = parseFactor(); f = function (v) { return a(v) % b(v); }; }
        else return f;
      }
    }
    function parseFactor() {
      ws();
      if (s[i] === '-') { i++; const a = parseFactor(); return function (v) { return -a(v); }; }
      if (s[i] === '+') { i++; return parseFactor(); }
      if (s[i] === '(') {
        i++;
        const a = parseExpr();
        ws();
        if (s[i] !== ')') throw new Error('缺少右括号');
        i++;
        return a;
      }
      const num = /^[0-9]*\.?[0-9]+/.exec(s.slice(i));
      if (num) { i += num[0].length; const n = parseFloat(num[0]); return function () { return n; }; }
      const idm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (!idm) throw new Error('第 ' + (i + 1) + ' 个字符无法识别');
      const name = idm[0];
      i += name.length;
      ws();
      if (s[i] === '(') {
        const fn = EXPR_FUNCS[name];
        if (!fn) throw new Error('未知函数：' + name);
        i++;
        const args = [];
        ws();
        if (s[i] !== ')') {
          for (;;) {
            args.push(parseExpr());
            ws();
            if (s[i] === ',') { i++; ws(); continue; }
            break;
          }
        }
        if (s[i] !== ')') throw new Error('函数 ' + name + ' 缺少右括号');
        i++;
        return function (v) { return fn.apply(null, args.map(function (a) { return a(v); })); };
      }
      if (vars.indexOf(name) < 0) throw new Error('未知变量：' + name);
      return function (v) { return Number(v[name]) || 0; };
    }
    try {
      const f = parseExpr();
      ws();
      if (i < s.length) throw new Error('第 ' + (i + 1) + ' 个字符起有多余内容');
      const probe = {};
      vars.forEach(function (n) { probe[n] = 1; });
      if (!isFinite(f(probe))) throw new Error('公式结果不是有限数');
      return { ok: true, fn: f };
    } catch (e) { return { error: e.message || '公式无效' }; }
  }

  // ---- 抛竿 / 上鱼 / 双钓共享计算（服务端正式路径与 Wiki 模拟器共用） ----
  // rules = { cast: {baseMs,minMs,speedBonus,speedCap}, biteFormula, doubleBase }
  const SIM_VAR_NAMES = ['speed', 'skill', 'big', 'rare', 'material', 'size', 'double', 'interval'];
  function simulationRulesOf(rules) {
    const r = rules || {};
    const c = r.cast || {};
    const num = function (v, def, min, max) {
      const n = Number(v);
      return (isFinite(n) && n >= min && n <= max) ? n : def;
    };
    return {
      cast: {
        baseMs: num(c.baseMs, 3000, 200, 3600000),
        minMs: num(c.minMs, 800, 100, 3600000),
        speedBonus: num(c.speedBonus, 0, -100, 500),
        speedCap: num(c.speedCap, 80, 0, 100),
      },
      biteFormula: r.biteFormula == null ? 'clamp(90 + skill, 0, 100)' : String(r.biteFormula),
      doubleBase: num(r.doubleBase, 0, 0, 1),
    };
  }
  function rodEffectsOf(bd) {
    const eff = { speed: 0, skill: 0, rare: 0, material: 0, size: 0, double: 0 };
    ROD_PARTS.forEach(function (part) {
      const comp = componentOf(bd && bd[part.key] && bd[part.key].compId);
      if (!comp) return;
      comp.affixes.forEach(function (a) { if (eff[a.type] != null) eff[a.type] += a.value; });
    });
    return eff;
  }
  function spotSpeedOf(spot) {
    let v = 0;
    ((spot && spot.buffs) || []).forEach(function (b) { if (b && b.type === 'speed') v += Number(b.value) || 0; });
    return v;
  }
  function spotBiteRateOf(spot) {
    const v = spot && spot.biteRate;
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  function effectiveSpeedOf(eff, cast) {
    const raw = (Number(eff && eff.speed) || 0) + (Number(cast && cast.speedBonus) || 0);
    const cap = Number(cast && cast.speedCap) || 80;
    return Math.max(0, Math.min(cap, raw));
  }
  function castIntervalOf(bd, spot, rules) {
    const r = simulationRulesOf(rules);
    const fixed = spot && spot.intervalMs;
    if (fixed != null && fixed !== '') {
      const n = Number(fixed);
      if (isFinite(n) && n >= 100) return Math.round(n);
    }
    const bdEff = rodEffectsOf(bd);
    const rodMs = r.cast.baseMs * (1 - effectiveSpeedOf({ speed: bdEff.speed }, r.cast) / 100);
    const spotPct = Math.max(-100, Math.min(95, spotSpeedOf(spot)));
    const ms = rodMs * (1 - spotPct / 100);
    return Math.max(r.cast.minMs, Math.round(ms));
  }
  function mergedEffectsOf(bd, spot) {
    const eff = rodEffectsOf(bd);
    ((spot && spot.buffs) || []).forEach(function (b) {
      if (b && eff[b.type] != null) eff[b.type] += Number(b.value) || 0;
    });
    return eff;
  }
  function biteProbabilityOf(eff, interval, spot, formula) {
    const override = spotBiteRateOf(spot);
    if (override != null) return override;
    const src = String(formula == null ? '' : formula).trim();
    if (!src) return 100;
    const c = compileExpr(src, SIM_VAR_NAMES);
    if (!c.ok) return 100; // 与服务端历史保底行为一致；正常保存路径已校验。
    let p;
    try {
      p = c.fn({ speed: eff.speed || 0, skill: eff.skill || 0, big: 0, rare: eff.rare || 0,
        material: eff.material || 0, size: eff.size || 0, double: eff.double || 0, interval: interval || 0 });
    } catch (e) { return 100; }
    if (!isFinite(p)) p = p > 0 ? 100 : 0;
    return Math.min(100, Math.max(0, p));
  }
  function castInfoOf(bd, spot, rules) {
    const r = simulationRulesOf(rules);
    const bdEff = rodEffectsOf(bd);
    const eff = mergedEffectsOf(bd, spot);
    const spotPct = spotSpeedOf(spot);
    const rodEff = effectiveSpeedOf({ speed: bdEff.speed }, r.cast);
    const interval = castIntervalOf(bd, spot, r);
    const override = spotBiteRateOf(spot);
    const biteRate = override != null ? override : Math.round(biteProbabilityOf(eff, interval, spot, r.biteFormula) * 10) / 10;
    return {
      baseMs: r.cast.baseMs, minMs: r.cast.minMs, globalBonus: r.cast.speedBonus, cap: r.cast.speedCap,
      affixSpeed: bdEff.speed, buffSpeed: spotPct, rawSpeed: Math.round(rodEff * 10) / 10,
      effSpeed: Math.round(rodEff * 10) / 10,
      spotMult: Math.round((1 - Math.max(-100, Math.min(95, spotPct)) / 100) * 1000) / 1000,
      intervalMs: spot && spot.intervalMs != null && spot.intervalMs !== '' ? Math.round(Number(spot.intervalMs)) : null,
      interval: interval, biteRate: biteRate, biteOverride: override != null,
    };
  }
  function doubleProbOf(A, doubleBase) {
    const a = Math.max(0, Number(A) || 0);
    let p = a / (a + 100);
    const b = Math.max(0, Math.min(1, Number(doubleBase) || 0));
    if (b > 0) p = 1 - (1 - b) * (1 - p);
    return Math.max(0, Math.min(1, p));
  }
  function simulateRodPlan(bd, spot, rules) {
    const r = simulationRulesOf(rules);
    const info = castInfoOf(bd, spot, r);
    const eff = mergedEffectsOf(bd, spot);
    const interval = info.interval;
    const bite = info.biteRate;
    const A = Math.max(0, Number(eff.double) || 0);
    const pDouble = A / (A + 100);
    const P = 1 - (1 - r.doubleBase) * (1 - pDouble);
    const perCast = 1 + P + P * P;
    const castsPerHour = interval > 0 ? 3600000 / interval : 0;
    const fishPerHour = castsPerHour * (bite / 100) * perCast;
    return { info: info, eff: eff, interval: interval, bite: bite, doubleP: P * 100,
      perCast: perCast, castsPerHour: castsPerHour, fishPerHour: fishPerHour };
  }

  // ---- 工坊 · 熔炼 ----
  // 玩家放两件组件（主 / 副），各选一条词条，熔炼后**主件的词条就是选中的那两条**（重新 roll 数值）：
  //   主件选中的那条 → 在原底材区间内重 roll（突破件的池外词缀则按「池外词缀区间」）。
  //   副件选中的那条（v0.11.5 改）：**副件一并提供它的取值区间** —— 该词缀在副件底材池内就按副件区间 roll，
  //     不在副件池内（副件本身是突破件）才回退「池外词缀区间」；后台关掉「副件区间」开关则回退旧行为
  //     （在主件池内按主件区间，否则池外区间）。
  // 投料（可选）：从**全部词缀类型**里再补一条熔炼结果尚未拥有的词缀并 roll 值；投料越多，补缀成功率越高。
  //   不受主件底材词缀池限制（后台开关 addAnyAffix），补缀后词条数上限默认 3（后台可调 addAffixCap，
  //   即普通/稀有底材也能被补到 3 条）；补缀词缀默认按**池外（突破）区间**取值（与宝匣突破件同一套区间，
  //   后台改「池外词缀数值区间」即时生效；开关 addAffixExtraRange 可切回旧行为）。
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
    bait_pack: 'rare',    // 诱饵包     → 稀有度
    rope: 'size',         // 耐磨绳     → 体型
    relic: 'material',    // 沉船宝匣残片 → 材料概率
    tide_sand: 'speed',   // 潮汐砂     → 钓速（新材料）
    dragon_scale: 'double', // 龙鳞碎屑 → 双钓（新材料）
  };
  const SMELT_PEARL = 'dragonpearl'; // 龙宫宝珠：催化剂（roll 两次取边界值）
  // 补缀（投料新增词缀）的候选：默认 = **全部 6 类词缀**里熔炼结果尚未拥有的那些（不再受主件底材词缀池限制）。
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
    // ---- 重铸（v0.16.0 改版：材料改为龙宫宝珠，并支持「指定单条词条」）----
    // 基础消耗 recastPearl 颗宝珠 = 重 roll 全部词条；
    // 额外投入宝珠可把重铸目标指定为某一条词条，第 n 条额外消耗 n 颗（见 recastPearlExtra）。
    recastPearl: 1,            // 每次重铸的基础宝珠消耗（重 roll 全部词条）
    recastGold: 0,             // 重铸**每颗宝珠**的金币（v0.16.3：不再是每次的固定价；0 = 只收宝珠）
                               //   总手续费 = 消耗的宝珠数 × 这个值，见 recastGoldFor()
    recastMinValue: 0,         // 重铸是否强制「至少不比原来差」：0 = 完全重 roll，1 = 每条取更高值
    // ---- 残片保留（海王遗匣产出的神话主件专用）----
    // v0.13：每片残片的保留概率改为**公式控制**（后台「⚒ 工坊配置」可改），而不是固定 10%。
    // 公式变量 breakthrough = 主组件身上的突破词缀条数；默认 10 - breakthrough * 0.5，
    // 即突破词缀越多、每片能保留的概率越低（保底仍随片数线性累加到 100%）。
    retainFormula: '10 - breakthrough * 0.5',
    retainMaxRelic: 10,        // 单次熔炼最多可投入的残片数
    // ---- 词缀搬移与补缀（v0.11.5 新增，均可在后台「⚒ 工坊配置」里改）----
    subRangeFromSub: true,     // 副件搬来的词缀按**副件自己的区间**取值（关闭 = 旧行为：主件池内按主件区间，否则池外区间）
    addAnyAffix: true,         // 补缀不再受主件底材词缀池限制：可取任意尚未拥有的词缀
    addAffixCap: 3,            // 补缀后主件允许的词条数上限（默认 3 = 主 + 副 + 补缀，可越过品质上限与池长）
    addAffixExtraRange: true,  // 补缀词缀按**池外（突破）区间**取值，与宝匣突破件同一套区间（随后台改动即时生效）
    // ---- 材料催化词缀范围（v0.12.2 新增，后台「⚒ 工坊配置 → 材料 → 词缀对照」按部位设置）----
    // { [部位]: { [词缀类型]: [min, max] } }：材料催化成功赋予的词条按主件部位 + 词缀类型取该范围；
    // 未配置的组合回退突破区间。催化产生的词缀范围来源记为 'ct'（显示为「催化词缀」）。
    catalystRanges: {},
  };
  let smeltCfg = Object.assign({}, SMELT_DEFAULTS);
  // 保留概率公式可用的变量（当前只有突破词缀条数）
  const RETAIN_VAR_NAMES = ['breakthrough'];
  function defaultSmeltCfg() { return Object.assign({}, SMELT_DEFAULTS); }
  function setSmeltCfg(cfg) {
    const d = defaultSmeltCfg();
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    Object.keys(d).forEach(function (k) {
      if (c[k] === undefined || c[k] === null || c[k] === '') return;
      // 字符串型配置（保留概率公式）单独处理：数值化会把公式吃掉
      if (typeof d[k] === 'string') { d[k] = String(c[k]); return; }
      const v = (typeof d[k] === 'boolean') ? !!c[k] : Number(c[k]);
      if (typeof d[k] === 'boolean' ? true : isFinite(v)) d[k] = v;
    });
    d.maxMaterials = Math.max(0, Math.min(99, Math.floor(d.maxMaterials)));
    d.maxTypes = Math.max(0, Math.min(8, Math.floor(d.maxTypes)));
    d.retainMaxRelic = Math.max(0, Math.min(99, Math.floor(d.retainMaxRelic)));
    // 保留概率公式：无法编译时回退出厂默认（服务器保存路径已先做严格校验，这里只是兜底）
    if (!compileExpr(d.retainFormula, RETAIN_VAR_NAMES).ok) d.retainFormula = SMELT_DEFAULTS.retainFormula;
    // 补缀词条数上限：1 条（等于禁止补缀）~ 6 条（词缀类型全集）；非数字回退出厂默认 3
    d.addAffixCap = Math.max(1, Math.min(AFFIX_TYPES.length, Math.floor(Number(d.addAffixCap) || SMELT_DEFAULTS.addAffixCap)));
    // 材料催化词缀范围：{ [part]: { [type]: [min, max] } }，逐项校验（非法/缺省条目剔除，全部清空 = 回退突破区间）。
    // 同时把区间夹进该部位的包络：催化上限不得高于该部位最高值、下限不得低于最低值
    // （越界条目按包络截断，保证运行时永远拿不到比该部位自然产出更强的催化区间）。
    const crIn = c.catalystRanges;
    const crOut = {};
    if (crIn && typeof crIn === 'object') {
      Object.keys(crIn).forEach(function (part) {
        const row = crIn[part];
        if (!row || typeof row !== 'object') return;
        const okRow = {};
        AFFIX_TYPES.forEach(function (t) {
          const r = row[t];
          const mn = Array.isArray(r) ? Number(r[0]) : NaN, mx = Array.isArray(r) ? Number(r[1]) : NaN;
          if (!isFinite(mn) || !isFinite(mx) || mx < mn) return;
          const env = catalystEnvelopeOf(part, t);
          let lo = mn, hi = mx;
          if (env) { lo = Math.max(env[0], Math.min(env[1], mn)); hi = Math.max(env[0], Math.min(env[1], mx)); }
          if (hi < lo) hi = lo;
          okRow[t] = [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10];
        });
        if (Object.keys(okRow).length) crOut[part] = okRow;
      });
    }
    d.catalystRanges = crOut;
    smeltCfg = d;
    return smeltCfg;
  }
  function getSmeltCfg() { return smeltCfg; }

  // ---- 玩家存档快照（后台可配：多久存一份、保留最近几份）----
  // 服务端按 intervalMin 定时给每个账号留一份存档副本，超出 keep 份就丢最旧的；
  // 后台「账号管理」可把某个账号回档到其中任意一份。
  const SNAPSHOT_DEFAULTS = { enabled: true, intervalMin: 30, keep: 5 };
  let snapshotCfg = Object.assign({}, SNAPSHOT_DEFAULTS);
  function defaultSnapshotCfg() { return Object.assign({}, SNAPSHOT_DEFAULTS); }
  function setSnapshotCfg(cfg) {
    const d = defaultSnapshotCfg();
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    if (c.enabled !== undefined && c.enabled !== null) d.enabled = !!c.enabled;
    const iv = Math.floor(Number(c.intervalMin));
    if (isFinite(iv)) d.intervalMin = Math.max(1, Math.min(1440, iv));
    const kp = Math.floor(Number(c.keep));
    if (isFinite(kp)) d.keep = Math.max(1, Math.min(50, kp));
    snapshotCfg = d;
    return snapshotCfg;
  }
  function getSnapshotCfg() { return snapshotCfg; }

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
  // 熔炼里每一条词缀的「落成概率」：保留 / 副件搬入 只需熔炼成功；补缀新增还要补缀掷骰命中
  // （服务端两次掷骰相互独立，都在熔炼成功之后）。完全成功 = 词缀全部落成，界面要单独高亮。
  function smeltSuccessProbs(rates, hasExtra) {
    const clamp = function (v) { return Math.max(0, Math.min(100, Number(v) || 0)); };
    const round1 = function (v) { return Math.round(v * 10) / 10; };
    const rate = clamp(rates && rates.rate);
    const extra = clamp(rates && rates.extraRate);
    const keep = round1(rate);
    const add = round1(rate * extra / 100);
    return { keep: keep, add: add, full: hasExtra ? add : keep };
  }
  function smeltGoldOf(load, hasPearl) {
    const c = smeltCfg;
    const total = Math.max(0, Number(load && load.total) || 0);
    const pearl = hasPearl != null ? !!hasPearl : !!(load && load.pearl > 0);
    return Math.max(0, Math.round(c.goldBase + c.goldPerMaterial * total + (pearl ? c.goldPearl : 0)));
  }
  // 本次熔炼可补的词缀候选（服务器校验与前端预览共用同一份，保证两端口径一致）：
  //   addAnyAffix 开启（默认）→ 全部 6 类词缀里熔炼结果还没有的那些（可越过底材词缀池边界）
  //   关闭 → 旧行为：只列主件底材池内、且结果还没有的词缀
  function smeltAddableAffixes(baseId, currentTypes) {
    const base = BASE_MAP[baseId];
    const have = {};
    (currentTypes || []).forEach(function (t) { have[t] = 1; });
    const anyAffix = smeltCfg.addAnyAffix !== false;
    if (anyAffix) return AFFIX_TYPES.filter(function (t) { return !have[t]; });
    if (!base) return [];
    return base.pool.filter(function (p) { return !have[p.type]; }).map(function (p) { return p.type; });
  }
  // 补缀（投料新增词缀）后允许的词条数上限：默认 3（主 + 副 + 补缀），可越过品质上限与底材池长
  function smeltAddAffixCap() { return smeltCfg.addAffixCap; }

  // 熔炼取值区间（服务器掷骰与前端展示共用）。v0.12.2 重构：词缀自带「范围来源」（见 affixToken），
  // roll 一律按**词缀带来的范围**取值，而不是「结果底材的池区间」——修复熔炼/重铸把范围错变成底材区间的 bug：
  //   kind = 'main' → 主件选中的那条：按它自己的 src（解析时已按池内/池外推断，见 instanceOf）
  //   kind = 'sub'  → 副件搬来的那条：默认按它自己的 src（副件连区间一起提供）；
  //                   subRangeFromSub 关闭时回退旧行为（主件池内 → 主件区间；否则突破区间）
  //   kind = 'add'  → 投料补缀的那条：主件部位配置了「材料催化词缀范围」→ 催化区间（src='ct'）；
  //                   否则 addAffixExtraRange 开启 → 突破区间（src='bt'）；关闭回退旧行为
  // 返回 { range, src }；smeltRangeOf 保留为只取区间的兼容入口。
  function poolRangeOf(baseId, type) {
    const b = BASE_MAP[baseId];
    if (!b) return null;
    const slot = b.pool.find(function (p) { return p.type === type; });
    return slot ? affixRangeOf(b.id, slot) : null;
  }
  // 范围来源 → 取值区间：
  //   src = 底材id → 该底材池内该词缀的区间（含后台 affixRanges 覆盖）
  //   src = 'bt'   → 突破区间（宝匣池外词缀，后台「池外词缀数值区间」）
  //   src = 'ct'   → 催化区间（工坊投料补缀，后台「材料催化词缀范围」按部位配置；未配置回退突破区间）
  function affixSrcRangeOf(src, type, part) {
    if (src === 'ct') return catalystRangeOf(part, type) || extraAffixRangeOf(type);
    if (src && src !== 'bt' && BASE_MAP[src]) {
      const r = poolRangeOf(src, type);
      if (r) return r;
    }
    return extraAffixRangeOf(type);
  }
  // 材料催化词缀范围（工坊投料补缀用）：{ [部位]: { [词缀类型]: [min, max] } }，后台「⚒ 工坊配置」可配；
  // 该部位该词缀未配置时返回 null（调用方回退突破区间）。
  function catalystRangeOf(part, type) {
    const tbl = smeltCfg.catalystRanges && smeltCfg.catalystRanges[part];
    const r = tbl && tbl[type];
    if (Array.isArray(r) && r.length === 2 && isFinite(r[0]) && isFinite(r[1]) && r[1] >= r[0]) return r;
    return null;
  }
  // 某部位某词缀的「催化区间包络」= 该部位所有底材里含有该词缀的那些区间的并集 [min, max]。
  // 后台配置催化区间时用它做硬约束：催化区间不得超出该部位的上下限
  // （上限不得高于该部位任一底材的最高值，下限不得低于最低值），否则催化词缀会比
  // 该部位的自然产出还强，破坏「催化 = 定向但不越界」的设定。
  // 该部位没有任何底材含此词缀（该词缀对本部位本就是池外/突破词缀）时返回 null。
  function catalystEnvelopeOf(part, type) {
    let lo = null, hi = null;
    COMPONENT_BASES.forEach(function (b) {
      if (b.part !== part) return;
      const slot = b.pool.find(function (p) { return p.type === type; });
      if (!slot) return;
      const r = affixRangeOf(b.id, slot);
      lo = (lo == null) ? r[0] : Math.min(lo, r[0]);
      hi = (hi == null) ? r[1] : Math.max(hi, r[1]);
    });
    return lo == null ? null : [lo, hi];
  }
  // 一键预设：每个部位 × 词缀类型给出一份「等于该部位包络」的推荐催化区间。
  // 取包络本身 = 催化词缀数值与「该部位最好的那件底材」同区间，是能配出的最强仍不越界的值；
  // 无包络（该词缀对本部位是池外）的组合不出现，交由后台留空 → 运行时回退突破区间。
  function catalystPreset() {
    const out = {};
    const parts = [];
    COMPONENT_BASES.forEach(function (b) { if (parts.indexOf(b.part) < 0) parts.push(b.part); });
    parts.forEach(function (part) {
      const row = {};
      AFFIX_TYPES.forEach(function (t) {
        const env = catalystEnvelopeOf(part, t);
        if (env) row[t] = [env[0], env[1]];
      });
      if (Object.keys(row).length) out[part] = row;
    });
    return out;
  }
  // 返回 { range, src, explicit }：
  //   explicit = 该来源是否**可证并可写回签名**。可证有两种情形：
  //     (a) 词缀所属组件的签名里字面记录了来源（o.srcExplicit === true，如 @bt / @ct / @附件底材）；
  //     (b) 该词缀类型就在**提供它的那件组件自己的词缀池内** —— 此时它的区间按定义就是那件底材的
  //         池区间，来源为该底材是确定事实，不需要推断。
  //   反之（不在池内、签名也没记来源）只能靠数值猜测，explicit = false：调用方不得把该 src
  //   写进新签名，否则会把「猜出来的来源」固化成「突破词缀」这种身份断言。
  function smeltRangeEx(mainBaseId, subBaseId, kind, type, opts) {
    const o = opts || {};
    const mainBase = BASE_MAP[mainBaseId] || null;
    const subBase = BASE_MAP[subBaseId] || null;
    const part = o.part || (mainBase && mainBase.part) || null;
    const mainHas = !!(mainBase && mainBase.pool.some(function (p) { return p.type === type; }));
    const subHas = !!(subBase && subBase.pool.some(function (p) { return p.type === type; }));
    // 未显式传 src 时的缺省推断（兼容旧调用 / 防御）：main 按主件池、sub 按副件池、池外 → 突破
    const fallbackSrc = kind === 'sub' ? (subHas ? subBaseId : 'bt') : (mainHas ? mainBaseId : 'bt');
    const src = o.src || fallbackSrc;
    // 来源可证性：签名显式记录，或该类型就在对应底材的词缀池内（池内 ⇒ 区间按定义来自该底材）
    const provable = (o.src == null)
      ? true
      : (o.srcExplicit === true || (kind === 'sub' ? (subHas && src === subBaseId) : (mainHas && src === mainBaseId)));
    if (kind === 'main' || kind === 'sub') {
      if (kind === 'sub' && smeltCfg.subRangeFromSub === false) {
        // 旧行为（后台显式关闭「副件区间」时才走）：主件池内按主件区间，否则按池外区间。
        // 池外这一支的**取值范围**保持旧行为，但身份上不能宣称突破 —— 这条词缀是副件搬来的，
        // 不是海王遗匣产出，所以 explicit = false（不写回签名，识别为「普通池外词缀」）。
        return mainHas
          ? { range: poolRangeOf(mainBaseId, type), src: mainBaseId, explicit: true }
          : { range: extraAffixRangeOf(type), src: 'bt', explicit: false };
      }
      return { range: affixSrcRangeOf(src, type, part), src: src, explicit: provable };
    }
    if (kind === 'add') {
      // 投料补缀 = **催化剂产生的词缀**：来源一律记 'ct'（催化词缀），与是否给该部位/该词缀
      // 配置了「材料催化词缀范围」无关 —— 有配置就按催化区间取值，没配置时
      // affixSrcRangeOf('ct', …) 会自动回退到池外（突破）区间，取值范围与旧版完全一致，
      // 区别只在「词缀身份」不再被误认成突破词缀。
      const cr = catalystRangeOf(part, type);
      if (cr) return { range: cr, src: 'ct', explicit: true };
      if (smeltCfg.addAffixExtraRange !== false) return { range: extraAffixRangeOf(type), src: 'ct', explicit: true };
      return mainHas
        ? { range: poolRangeOf(mainBaseId, type), src: mainBaseId, explicit: true }
        : { range: extraAffixRangeOf(type), src: 'ct', explicit: true };
    }
    // 防御性兜底（未知 kind，生产代码不会走到）：取值保持池外区间，但不敢断言是突破词缀
    return mainHas
      ? { range: poolRangeOf(mainBaseId, type), src: mainBaseId, explicit: true }
      : { range: extraAffixRangeOf(type), src: 'bt', explicit: false };
  }
  function smeltRangeOf(mainBaseId, subBaseId, kind, type, opts) {
    return smeltRangeEx(mainBaseId, subBaseId, kind, type, opts).range;
  }

  // ---- 熔炼 · 残片保留（只对海王遗匣产出的神话主件开放）----
  // 熔炼成功后主件的词条会被改写成「主件选中 + 副件搬入」（+ 可选补缀），主件原有的**池外词缀**
  // （底材词缀池里本来没有的那些）会随之消失。投入沉船宝匣残片后，成功时按概率把这些池外词缀
  // **按原值**追加回熔炼结果：
  //   概率 = 投入片数 × 每片概率（默认每片 10 - breakthrough×0.5%，见 retainChancePerRelic），上限 100%。
  //   残片不参与投料计算 —— 既不影响熔炼成功率/补缀成功率，也不改变金币花费（只消耗残片本身）。
  //   只有主件确实带池外词缀时才有意义（没有可保留的词条时服务器会直接拒绝，避免白烧残片）。
  //   「每片概率」公式的 breakthrough 变量取**突破词缀（src='bt'）条数**：一件组件身上往往还有
  //   附件搬来的普通池外词缀与催化词缀，它们不算「突破」，不该把保留概率拉低（见 affixKindOf）。
  function smeltExtraAffixesOf(baseId, affixes) {
    const base = BASE_MAP[baseId];
    if (!base) return [];
    const poolTypes = {};
    base.pool.forEach(function (p) { poolTypes[p.type] = 1; });
    // 保留时连范围来源（src）一起带回：残片保留是「按原值追加」，来源不变。
    // srcExplicit 一并保留：保留下来的词缀要保持原本的身份（突破/催化/普通池外）。
    return (affixes || []).filter(function (a) { return !poolTypes[a.type]; })
      .map(function (a) { return { type: a.type, value: a.value, src: a.src || null, srcExplicit: a.srcExplicit }; });
  }
  // 主件身上「突破词缀」的条数（残片保留概率公式的 breakthrough 变量）
  function breakthroughCountOf(affixes) {
    return (affixes || []).filter(function (a) { return affixKindOf(a) === 'breakthrough'; }).length;
  }
  // 投入 n 片残片时的总保留概率（%）：夹在 [0, 100]，保留一位小数。
  // 总概率 = 片数 × 每片概率（每片概率由公式给出，见 retainChancePerRelic）。
  //   breakthrough = 主组件身上的突破词缀条数（默认公式里唯一的变量）。
  // 第二参数省略时按 0 计算（兼容只传片数的旧调用），但服务器与前端都会显式传突破词缀数。
  function smeltRetainChance(relics, breakthrough) {
    const n = Math.max(0, Math.min(smeltCfg.retainMaxRelic, Math.floor(Number(relics) || 0)));
    const per = retainChancePerRelic(breakthrough);
    return Math.max(0, Math.min(100, Math.round(n * per * 10) / 10));
  }
  // 每片残片的保留概率（%）：由后台公式给出（默认 10 - breakthrough * 0.5），夹在 [0, 100] 并保留一位小数。
  // 公式不可用时回退出厂公式，保证任何存档/配置下都有确定的概率。
  function retainChancePerRelic(breakthrough) {
    const bt = Math.max(0, Math.floor(Number(breakthrough) || 0));
    const src = String(smeltCfg.retainFormula || SMELT_DEFAULTS.retainFormula);
    const c = compileExpr(src, RETAIN_VAR_NAMES);
    const fn = c.ok ? c.fn : (compileExpr(SMELT_DEFAULTS.retainFormula, RETAIN_VAR_NAMES).fn);
    let v;
    try { v = Number(fn({ breakthrough: bt })); } catch (e) { v = 0; }
    if (!isFinite(v)) v = 0;
    return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
  }


  // ---- 熔炼方案与结果模拟（服务端正式路径与 Wiki 模拟器共用） ----
  // d = { mainId, subId, mainAffix, subAffix, materials, relics }
  // 这里只做纯规则校验与预览，不检查背包、金币或装备锁定；调用方负责资产校验与结算。
  function smeltPlanOf(d) {
    const cfg = getSmeltCfg();
    const mainRaw = String((d && d.mainId) || '');
    const subRaw = String((d && d.subId) || '');
    const mainMeta = componentOf(mainRaw);
    const subMeta = componentOf(subRaw);
    const partName = function (key) {
      const p = ROD_PARTS.find(function (x) { return x.key === key; });
      return p ? p.name : String(key || '?');
    };
    const materialName = function (id) {
      const m = MATERIALS.find(function (x) { return x.id === id; });
      return m ? m.name : id;
    };
    if (!mainMeta || !isInstance(mainRaw)) return { error: '主组件必须是已生成的组件实例' };
    if (!subMeta || !isInstance(subRaw)) return { error: '副组件必须是已生成的组件实例' };
    if (mainMeta.part !== subMeta.part) {
      return { error: '主件与副件必须是同一部位的组件（当前：' + partName(mainMeta.part) + ' / ' + partName(subMeta.part) + '）' };
    }
    const mainAffix = mainMeta.affixes.find(function (a) { return a.type === d.mainAffix; });
    const subAffix = subMeta.affixes.find(function (a) { return a.type === d.subAffix; });
    if (!mainAffix) return { error: '请选择主组件上的一条词条' };
    if (!subAffix) return { error: '请选择副组件上的一条词条' };
    if (mainAffix.type === subAffix.type) return { error: '主副选中的词条类型不能相同（熔炼后两条词条会合成同一条）' };

    const maxM = Math.max(0, Math.floor(Number(cfg.maxMaterials) || 0));
    const list = Array.isArray(d.materials) ? d.materials : [];
    const matList = [];
    let pearl = !!(d && d.pearl);
    let pearlQty = 0;
    let total = 0;
    const types = {};
    for (const e of list) {
      const id = String((e && e.id) || '');
      const qty = e && e.qty;
      if (matList.some(function (x) { return x.id === id; })) return { error: '投料物品重复' };
      if (id === SMELT_PEARL) { pearl = true; pearlQty += qty; continue; }
      if (!smeltMaterialAffix(id)) return { error: '「' + materialName(id) + '」不是熔炼材料' };
      matList.push({ id: id, qty: qty });
      types[smeltMaterialAffix(id)] = 1;
      total += Math.max(0, Math.floor(Number(qty) || 0));
    }
    if (pearlQty > 1) return { error: '龙宫宝珠一次最多投入 1 个' };
    if (total > maxM) return { error: '投料最多 ' + maxM + ' 份（当前 ' + total + ' 份）' };
    if (Object.keys(types).length > cfg.maxTypes) return { error: '投料最多 ' + cfg.maxTypes + ' 种（当前 ' + Object.keys(types).length + ' 种）' };

    const consume = matList.slice();
    if (pearl) consume.push({ id: SMELT_PEARL, qty: 1 });
    const relicId = 'relic';
    const relicMax = Math.max(0, Math.min(99, Math.floor(Number(cfg.retainMaxRelic) || 0)));
    const relicQty = d && d.relics === undefined ? 0 : d.relics;
    if (!isFinite(Number(relicQty)) || Number(relicQty) < 0 || Math.floor(Number(relicQty)) !== Number(relicQty)) {
      return { error: '残片数量需为不小于 0 的整数' };
    }
    if (relicQty > relicMax) return { error: '残片超过单次投入上限' };
    const extraAffixes = smeltExtraAffixesOf(mainMeta.baseId, mainMeta.affixes);
    if (relicQty > 0) {
      if (!canRecast(mainMeta)) {
        return { error: '只有海王遗匣产出的神话主件才能加入' + materialName(relicId) + '（当前：' + mainMeta.qualityName + '品质）' };
      }
      if (!extraAffixes.length) return { error: '该主件没有池外词缀，投入' + materialName(relicId) + '没有可保留的词条' };
      consume.push({ id: relicId, qty: relicQty });
    }

    const load = smeltLoadOf(matList);
    const afterTypes = [mainAffix.type, subAffix.type];
    let extraType = null;
    if (load.total > 0) {
      extraType = load.dominant;
      const addable = smeltAddableAffixes(mainMeta.baseId, afterTypes);
      if (!extraType || addable.indexOf(extraType) < 0) {
        const already = extraType ? afterTypes.indexOf(extraType) >= 0 : false;
        return { error: '投料对应的词缀「' + (AFFIX_LABEL[extraType] || extraType || '?') + '」无法补进该主件（' + (already ? '熔炼结果里已经有这条词缀了' : '主件词缀池里已经没有可补的该类词缀') + '）' };
      }
      if (afterTypes.length + 1 > smeltAddAffixCap()) {
        return { error: '补缀后词条数会超过上限（当前 ' + afterTypes.length + ' 条 +1 > 上限 ' + smeltAddAffixCap() + ' 条，可在后台「⚒ 工坊配置」调整）' };
      }
    }
    const rates = smeltRatesOf(load, pearl);
    const gold = smeltGoldOf(load, pearl);
    const rrMain = smeltRangeEx(mainMeta.baseId, subMeta.baseId, 'main', mainAffix.type, { part: mainMeta.part, src: mainAffix.src, srcExplicit: mainAffix.srcExplicit });
    const rrSub = smeltRangeEx(mainMeta.baseId, subMeta.baseId, 'sub', subAffix.type, { part: mainMeta.part, src: subAffix.src, srcExplicit: subAffix.srcExplicit });
    const rrAdd = extraType ? smeltRangeEx(mainMeta.baseId, subMeta.baseId, 'add', extraType, { part: mainMeta.part }) : null;
    const breakthrough = breakthroughCountOf(mainMeta.affixes);
    return {
      ok: true, cfg: cfg, mainId: mainMeta.id, subId: subMeta.id,
      mainMeta: mainMeta, subMeta: subMeta, mainAffix: mainAffix, subAffix: subAffix,
      materials: matList, consume: consume, load: load, pearl: pearl,
      extraType: extraType, rates: rates, gold: gold,
      rollBoundary: !!(pearl && cfg.pearlRollTwice),
      relicId: relicId, relics: relicQty, extraAffixes: extraAffixes,
      protectAffix: relicQty > 0, breakthrough: breakthrough,
      retainChance: smeltRetainChance(relicQty, breakthrough),
      perRelic: retainChancePerRelic(breakthrough),
      retainFormula: String(cfg.retainFormula || ''),
      ranges: {
        main: rrMain.range, sub: rrSub.range, add: rrAdd ? rrAdd.range : null,
        mainSrc: rrMain.src, subSrc: rrSub.src, addSrc: rrAdd ? rrAdd.src : null,
        mainExplicit: rrMain.explicit, subExplicit: rrSub.explicit, addExplicit: rrAdd ? rrAdd.explicit : false,
      },
    };
  }

  function smeltRollWithRng(range, useBoundary, rng) {
    const model = (getComponentCfg() || {}).rollModel || 'linear';
    return useBoundary
      ? rollAffixValueBoundaryWithRng(range[0], range[1], model, rng)
      : rollAffixValueWithRng(range[0], range[1], model, rng);
  }

  // 模拟一次熔炼。不修改任何资产；服务端正式接口与 Wiki 模拟器都调用本函数。
  // rng 可注入，默认 Math.random；Wiki 批量模拟使用带种子的随机数保证可复现。
  function simulateSmeltPlan(plan, rng) {
    const rand = typeof rng === 'function' ? rng : Math.random;
    const p = plan || {};
    const success = rand() * 100 < p.rates.rate;
    let extraOk = false, retainOk = false;
    const retained = [];
    let resultId = null, result = null, mainAfterId = null, mainAfter = null;
    if (success) {
      const rr = p.ranges || {};
      const affixes = [];
      affixes.push({ type: p.mainAffix.type, value: smeltRollWithRng(rr.main, p.rollBoundary, rand), src: rr.mainSrc, srcExplicit: rr.mainExplicit });
      affixes.push({ type: p.subAffix.type, value: smeltRollWithRng(rr.sub, p.rollBoundary, rand), src: rr.subSrc, srcExplicit: rr.subExplicit });
      if (p.extraType) {
        extraOk = rand() * 100 < p.rates.extraRate;
        if (extraOk) affixes.push({ type: p.extraType, value: smeltRollWithRng(rr.add, p.rollBoundary, rand), src: rr.addSrc, srcExplicit: rr.addExplicit });
      }
      if (p.relics > 0) {
        retainOk = rand() * 100 < p.retainChance;
        if (retainOk) {
          const have = {};
          affixes.forEach(function (a) { have[a.type] = 1; });
          (p.extraAffixes || []).forEach(function (a) {
            if (have[a.type]) return;
            have[a.type] = 1;
            affixes.push({ type: a.type, value: a.value, src: a.src || null, srcExplicit: a.srcExplicit });
            retained.push({ type: a.type, value: a.value, src: a.src || null, srcExplicit: a.srcExplicit });
          });
        }
      }
      resultId = instanceId(p.mainMeta.baseId, p.mainMeta.quality, affixes);
      result = componentOf(resultId);
    } else {
      const left = (p.mainMeta && p.mainMeta.affixes || [])
        .filter(function (a) { return p.protectAffix || a.type !== p.mainAffix.type; })
        .map(function (a) { return { type: a.type, value: a.value, src: a.src || null, srcExplicit: a.srcExplicit }; });
      mainAfterId = instanceId(p.mainMeta.baseId, p.mainMeta.quality, left);
      mainAfter = componentOf(mainAfterId);
    }
    return {
      success: success, extraOk: extraOk, retainOk: retainOk, retained: retained,
      protectAffix: !success && !!p.protectAffix,
      removedAffix: (success || p.protectAffix) ? null : p.mainAffix.type,
      resultId: resultId, result: result, mainAfterId: mainAfterId, mainAfter: mainAfter,
    };
  }

  // ---- 重铸（海王遗匣产出的神话件）----
  // 允许重铸的品质：全游戏只有「海王遗匣」产出神话件（后台掉落权重刻意不含 mythic），
  // 所以神话品质就是「宝匣产出的组件」这一身份标识；工坊熔炼保留主件品质，熔出来的神话件同样可重铸。
  const RECAST_QUALITY = 'mythic';
  function canRecast(meta) { return !!(meta && meta.kind === 'component' && meta.quality === RECAST_QUALITY); }
  // 重铸·指定词条的额外宝珠数量：第 1 条额外 1 颗、第 2 条额外 2 颗……（1-based = 索引 + 1）。
  // 传 null / undefined / 负数 = 不指定（重 roll 全部词条），额外消耗为 0。
  function recastPearlExtra(idx) {
    const i = Math.floor(Number(idx));
    return (isFinite(i) && i >= 0) ? i + 1 : 0;
  }
  // 重铸总消耗 = 后台配置的基础消耗 + 指定词条的额外消耗
  function recastPearlNeed(idx, base) {
    const b = Math.max(0, Math.floor(Number(base) || 0));
    return b + recastPearlExtra(idx);
  }
  // 重铸手续费（v0.16.3）：**按消耗的宝珠数计**，每颗 recastGold 金币 —— 不再是每次一个固定价。
  // 指定第 n 条词条会多花 n 颗宝珠，手续费也就跟着涨（0 = 只收宝珠）。
  function recastGoldFor(pearls) {
    const n = Math.max(0, Math.floor(Number(pearls) || 0));
    return Math.max(0, Math.round((smeltCfg.recastGold || 0) * n));
  }
  // 重铸取值：保持词缀**类型与条数不变**，按当前 roll 模型重新取值。
  // v0.12.2 修复：每条词条按**它自己的范围来源**（a.src：底材区间 / 突破区间 / 催化区间）重 roll，
  // 不再「词缀类型在底材池里就按底材区间」——修复重铸把范围错变成该底材范围的 bug。
  // v0.16.0：targetIdx 传入词条下标时**只重 roll 那一条**（其余原样保留），即「重铸目标指定为某一条词条」。
  function recastAffixes(baseId, affixes, targetIdx) {
    const base = BASE_MAP[baseId];
    if (!base) return null;
    const keepBetter = !!smeltCfg.recastMinValue; // 开启后「至少不比原来差」：取重 roll 与原值里更好的那个
    const only = Math.floor(Number(targetIdx));
    const hasTarget = isFinite(only) && only >= 0;
    return (affixes || []).map(function (a, i) {
      if (hasTarget && i !== only) return { type: a.type, value: a.value, src: a.src || null, srcExplicit: a.srcExplicit };
      const rng = affixSrcRangeOf(a.src, a.type, base.part);
      const v = rollAffixValue(rng[0], rng[1], componentCfg.rollModel);
      // 数值越大越好（负词缀同理：-5 优于 -12），所以「更好」= Math.max
      // srcExplicit 一并带过：重铸只改数值、不改词缀身份（突破/催化/普通池外）。
      // 丢了它会把「解析时推断出来的来源」当成事实写回签名，导致同一件组件重铸后签名变化。
      return { type: a.type, value: keepBetter ? Math.max(v, a.value) : v, src: a.src || null, srcExplicit: a.srcExplicit };
    });
  }

  // ---- 稀有度（rare 词缀）----
  // v0.13 起 `rare` 的语义从「放大稀有档渔获权重」改为「压低普通品质物品权重」：
  // 生成战利品时，普通品质（quality=common）的掉落条目权重乘以 K / (K + R)，
  //   R = 玩家的稀有度合计（钓竿各部位 rare 词缀 + 钓点增益），K = 后台可配的常数（默认 2）。
  // R = 0 时系数为 1（无影响）；R 越大普通物品越少，稀有产出占比自然上升。
  // 注：只作用于「普通品质」条目的权重，不直接放大稀有/史诗条目，因此不会与产出倍率重复。
  const RARE_K_DEFAULT = 2;
  function rareKOf(rareCfg) {
    const k = Number(rareCfg && rareCfg.k != null ? rareCfg.k : rareCfg);
    return (isFinite(k) && k > 0) ? k : RARE_K_DEFAULT;
  }
  // 稀有度对普通品质权重的系数：K / (K + R)。R ≤ 0 时恒为 1；下限 0（R 极大时普通物品近乎消失）。
  function rareCommonMult(rareValue, k) {
    const K = rareKOf(k);
    const R = Number(rareValue);
    if (!isFinite(R) || R <= 0) return 1;
    return Math.max(0, K / (K + R));
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

  // ---- 自动配装：从候选件里求「总属性最优」的组合 ----
  // 总属性 = 各部位词条的**逐项求和**，而每个部位彼此独立（一件组件只能装在自己的部位），
  // 所以「每部位挑 1 件」可以逐部位做 DP，每步只留一个帕累托前沿：
  //   X 支配 Y ⇔ X 每个属性都 ≥ Y —— 补上同样的剩余部位后仍逐项 ≥，字典序也必然 ≥，
  //   因此剪掉 Y 不会丢掉任何最优解（只有前沿超过上限时的截断是启发式近似）。
  // 目标 = 按 order（优先级，前 = 优先）的字典序最大；min/max 是各属性的硬性目标区间，
  // 配不出来时依次放宽「上限 → 下限」，并在返回值里如实标出放宽了什么 / 差多少。
  const AUTO_BUILD_STATES = 160;   // 每步前沿上限（防止极端背包把组合数打爆）
  const AUTO_BUILD_CANDS = 24;     // 单部位候选上限（先帕累托剪枝，再按字典序截断）
  function autoBuildZero() {
    const v = {};
    AFFIX_TYPES.forEach(function (t) { v[t] = 0; });
    return v;
  }
  // 组件（instanceMeta / 存档里的 { affixes }）→ 属性向量
  function autoBuildVec(comp) {
    const v = autoBuildZero();
    if (comp && comp.affixes) comp.affixes.forEach(function (a) { if (v[a.type] != null) v[a.type] += Number(a.value) || 0; });
    return v;
  }
  function autoBuildAdd(a, b) {
    const v = {};
    AFFIX_TYPES.forEach(function (t) { v[t] = (a[t] || 0) + (b[t] || 0); });
    return v;
  }
  function autoBuildDom(x, y) {          // y 是否被 x 逐项压制（含相等）
    for (let i = 0; i < AFFIX_TYPES.length; i++) { const t = AFFIX_TYPES[i]; if (x[t] < y[t]) return false; }
    return true;
  }
  // cfg: { parts?:[部位…], candidates:{ 部位:[组件id…] }, order:[词条…], enabled:{词条:bool},
  //        min:{词条:数值}, max:{词条:数值}, dir:{词条:'min'|'max'}, maxStates? }
  // → { vec, picks:{部位:组件id|null}, order, relaxed:null|'max'|'all', miss:{词条:实际值} }
  function autoBuildPlan(cfg) {
    cfg = cfg || {};
    const enabled = cfg.enabled || null;   // null = 全部属性参与
    let prio = (cfg.order && cfg.order.length ? cfg.order : AFFIX_TYPES).filter(function (t) {
      return AFFIX_TYPES.indexOf(t) >= 0 && (!enabled || enabled[t]);
    });
    if (!prio.length) prio = AFFIX_TYPES.slice();   // 一个属性都没启用 → 退回全属性，避免没有优化目标
    const mins = cfg.min || {}, maxs = cfg.max || {};
    const dirs = cfg.dir || {};            // 该词条按「越小越好」排序（求可达下限的探针用）
    const maxStates = Math.max(1, Number(cfg.maxStates) || AUTO_BUILD_STATES);
    const bound = function (src, t) { return src[t] != null && src[t] !== '' && isFinite(Number(src[t])); };
    const minKeys = AFFIX_TYPES.filter(function (t) { return bound(mins, t); });
    const maxKeys = AFFIX_TYPES.filter(function (t) { return bound(maxs, t); });

    function lexOrd(order, a, b) {
      for (let i = 0; i < order.length; i++) {
        const t = order[i], d = dirs[t] === 'min' ? (b[t] - a[t]) : (a[t] - b[t]);
        if (d) return d;
      }
      let s = 0;   // 优先级全平：比词条净收益，避免挑出「净负收益」或结果不稳定
      for (let i = 0; i < AFFIX_TYPES.length; i++) { const t = AFFIX_TYPES[i]; s += (a[t] || 0) - (b[t] || 0); }
      return s;
    }
    function lex(a, b) { return lexOrd(prio, a, b); }

    const cand = {};
    (cfg.parts && cfg.parts.length ? cfg.parts : ROD_PARTS.map(function (p) { return p.key; })).forEach(function (key) {
      const list = [], seen = {};
      ((cfg.candidates && cfg.candidates[key]) || []).forEach(function (id) {
        const c = componentOf(id);
        if (!c || c.part !== key) return;      // 部位不符 / 旧格式件：不参与配装
        const vec = autoBuildVec(c);
        const sig = AFFIX_TYPES.map(function (t) { return vec[t]; }).join(',');
        if (seen[sig]) return;                 // 属性完全一样的两件等价，留一件即可
        seen[sig] = 1;
        list.push({ id: c.id, vec: vec });
      });
      list.sort(function (a, b) { return lex(b.vec, a.vec) || (a.id < b.id ? -1 : 1); });
      const keep = [];
      list.forEach(function (it) {              // 单部位内被逐项压制的件永远不可能被选
        for (let i = 0; i < keep.length; i++) if (autoBuildDom(keep[i].vec, it.vec)) return;
        keep.push(it);
      });
      cand[key] = keep.slice(0, AUTO_BUILD_CANDS);
    });

    let frontier = [{ vec: autoBuildZero(), picks: {} }];
    Object.keys(cand).forEach(function (key) {
      const list = cand[key];
      if (!list.length) { frontier.forEach(function (s) { s.picks[key] = null; }); return; }   // 该部位没得挑：保持原样
      const next = [];
      frontier.forEach(function (s) {
        list.forEach(function (c) {
          const picks = {};
          for (const k in s.picks) picks[k] = s.picks[k];
          picks[key] = c.id;
          next.push({ vec: autoBuildAdd(s.vec, c.vec), picks: picks });
        });
      });
      // 截断排序：**已越过目标上限的状态排在后面**（同组内仍按优先级字典序）。
      // 上游部位只会把属性继续推高，越了上限基本回不来；若按优先级截断，尾巴上被截掉的
      // 恰恰是「上限以内的最优解」，solve 就只能在「放弃上限取最大」或「退到极值」之间二选一。
      // 先把上限以内的状态排前面，截断才截得住「上限以内的最优解」。
      const overCap = function (v) {
        for (let i = 0; i < maxKeys.length; i++) { const t = maxKeys[i]; if (v[t] > Number(maxs[t])) return true; }
        return false;
      };
      next.sort(function (a, b) {
        const fa = overCap(a.vec) ? 1 : 0, fb = overCap(b.vec) ? 1 : 0;
        return fa - fb || lex(b.vec, a.vec);
      });
      // 字典序前缀 + **每个属性的最小/最大状态各留一个**。
      // 只留前缀是不够的：前缀按优先级从高到低截，被截掉的尾巴恰好是「目标属性很低、
      // 其余属性上代价大」的那批状态 —— 而目标上限（钓速 ≤ 82）只能靠它们满足。
      // 截断丢掉它们时，solve 会退回「放弃上限取最大」，面板上就表现为
      // 「上面设了上限，下面还是按最高钓速显示」。逐属性留极值可以保证：
      // 归纳到最后一层，每个属性的全局最小/最大都一定还在前沿里，上限/下限就不会被悄悄吃掉。
      const slot = Math.max(1, maxStates - AFFIX_TYPES.length * 2);
      const keep = [];
      for (let i = 0; i < next.length && keep.length < slot; i++) {
        let dom = false;
        for (let j = 0; j < keep.length; j++) if (autoBuildDom(keep[j].vec, next[i].vec)) { dom = true; break; }
        if (!dom) keep.push(next[i]);
      }
      AFFIX_TYPES.forEach(function (t) {
        let lo = null, hi = null;
        for (let i = 0; i < next.length; i++) {
          const s = next[i];
          if (!lo || s.vec[t] < lo.vec[t]) lo = s;
          if (!hi || s.vec[t] > hi.vec[t]) hi = s;
        }
        if (lo && keep.indexOf(lo) < 0) keep.push(lo);
        if (hi && hi !== lo && keep.indexOf(hi) < 0) keep.push(hi);
      });
      frontier = keep;
    });

    function fit(s, keys, dir) {
      for (let i = 0; i < keys.length; i++) {
        const t = keys[i];
        if (dir === 'min' ? s.vec[t] < Number(mins[t]) : s.vec[t] > Number(maxs[t])) return false;
      }
      return true;
    }
    function pick(useMin, useMax) {
      let best = null;
      frontier.forEach(function (s) {
        if (!fit(s, useMin, 'min') || !fit(s, useMax, 'max')) return;
        if (!best || lex(s.vec, best.vec) > 0) best = s;
      });
      return best;
    }
    let relaxed = null;
    let res = pick(minKeys, maxKeys);
    if (!res) { relaxed = 'max'; res = pick(minKeys, []); }        // 上下限冲突：先放弃上限
    if (!res) {
      // 下限也配不出来：改成「先把没达成的目标尽量做高，再按原优先级排」，
      // 免得展示一个「钓速只有 10」的推荐组合、而面板上明明写着钓速最高能到 20。
      relaxed = 'all';
      const ord2 = minKeys.concat(prio.filter(function (t) { return minKeys.indexOf(t) < 0; }));
      let best = null;
      frontier.forEach(function (s) { if (!best || lexOrd(ord2, s.vec, best.vec) > 0) best = s; });
      res = best || { vec: autoBuildZero(), picks: {} };
    }
    const miss = {};
    minKeys.forEach(function (t) { if (res.vec[t] < Number(mins[t])) miss[t] = res.vec[t]; });
    return { vec: res.vec, picks: res.picks, order: prio, relaxed: relaxed, miss: miss };
  }
  // 单属性「可达」探针：把它排到优先级首位、去掉它自己的目标区间，
  // 在其余属性的目标区间约束下求它的最大值（dir='max'，默认）或最小值（dir='min'）。
  // 滑块轨道两端就是这两个值：调一项属性 → 其余属性的可达区间随之重算。
  function autoBuildPeek(cfg, type, dir) {
    if (AFFIX_TYPES.indexOf(type) < 0) return null;
    const c2 = {};
    for (const k in cfg) c2[k] = cfg[k];
    c2.order = [type].concat(AFFIX_TYPES.filter(function (t) { return t !== type; }));
    c2.enabled = null;
    c2.dir = dir === 'min' ? (function () { const d = {}; d[type] = 'min'; return d; })() : null;
    const mn = {}, mx = {};
    AFFIX_TYPES.forEach(function (t) {
      if (t === type) return;
      if (cfg.min && cfg.min[t] != null && cfg.min[t] !== '') mn[t] = cfg.min[t];
      if (cfg.max && cfg.max[t] != null && cfg.max[t] !== '') mx[t] = cfg.max[t];
    });
    c2.min = mn; c2.max = mx;
    return autoBuildPlan(c2).vec[type];
  }
  // 该属性在当前目标（其余属性的下限/上限）约束下的可达区间：{ min, max }
  function autoBuildRange(cfg, type) {
    const max = autoBuildPeek(cfg, type, 'max');
    if (max == null) return null;
    return { min: autoBuildPeek(cfg, type, 'min'), max: max };
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
        { id: 'dock', name: '老旧码头', pos: [61, 34], pool: [
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
  // v0.15.0 起一个入口承载一族功能，主页面内的子功能一律用页内页签切换：
  //   「钓鱼」= 🎣 钓鱼 / 🎯 钓竿（原「钓竿配置」入口），见 ui.js 的 renderFishing / renderBD；
  //   「图鉴」= 📖 图鉴 / 🏆 记录（原「渔获记录」入口），见 ui.js 的 renderCodex / renderRecords。
  //   页签页的功能开关 id 仍是 bd / records（见 features.js），旧 view id 由 navigateView 兜底兼容。
  const NAV = [
    { id: 'fishing', name: '钓鱼', icon: '🎣', implemented: true },
    { id: 'character', name: '角色', icon: '🧍', implemented: true },
    { id: 'ground', name: '社交', icon: '🌊', implemented: true },
    { id: 'inventory', name: '背包', icon: '🎒', implemented: true },
    // 「宝匣合成」不再是独立页面：并入「工坊」页（熔炼/重铸同款页签切换），改名「开箱」，见 ui.js 的 renderWorkshop。
    { id: 'workshop', name: '工坊', icon: '⚒', implemented: true },
    // 「系统商店」「开放市集」不再是独立页面：合并进「商城」页（工坊熔炼/重铸同款页签切换），
    // 系统商店改名「收购」、开放市集改名「市集」，见 ui.js 的 renderMall。
    { id: 'mall', name: '商城', icon: '🛒', implemented: true },
    { id: 'codex', name: '图鉴', icon: '📖', implemented: true },
    { id: 'feedback', name: '反馈', icon: '📮', implemented: true },
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
    AFFIX_LABEL: AFFIX_LABEL, AFFIX_CODES: AFFIX_CODES, AFFIX_TYPES: AFFIX_TYPES,
    QUALITY: QUALITY, QUALITY_ORDER: QUALITY_ORDER,
    CHESTS: CHESTS, chestOf: chestOf, isChest: isChest, rollChestQuality: rollChestQuality,
    genBreakthrough: genBreakthrough, RELIC_PRICE: RELIC_PRICE,
    CHEST_BASE_COSTS: CHEST_BASE_COSTS, applyChestCosts: applyChestCosts, chestCostOverrides: chestCostOverrides,
    rollAffixValueBoundary: rollAffixValueBoundary, rollAffixValueBoundaryWithRng: rollAffixValueBoundaryWithRng, rollAffixValueWithRng: rollAffixValueWithRng,
    rodEffectsOf: rodEffectsOf, mergedEffectsOf: mergedEffectsOf, castInfoOf: castInfoOf, castIntervalOf: castIntervalOf,
    effectiveSpeedOf: effectiveSpeedOf, spotSpeedOf: spotSpeedOf, spotBiteRateOf: spotBiteRateOf,
    biteProbabilityOf: biteProbabilityOf, doubleProbOf: doubleProbOf, simulateRodPlan: simulateRodPlan,
    SMELT_MATERIAL_AFFIX: SMELT_MATERIAL_AFFIX, SMELT_PEARL: SMELT_PEARL,
    SMELT_DEFAULTS: SMELT_DEFAULTS, defaultSmeltCfg: defaultSmeltCfg, setSmeltCfg: setSmeltCfg, getSmeltCfg: getSmeltCfg,
    SNAPSHOT_DEFAULTS: SNAPSHOT_DEFAULTS, defaultSnapshotCfg: defaultSnapshotCfg, setSnapshotCfg: setSnapshotCfg, getSnapshotCfg: getSnapshotCfg,
    smeltMaterialAffix: smeltMaterialAffix, smeltMaterialIds: smeltMaterialIds,
    smeltLoadOf: smeltLoadOf, smeltRatesOf: smeltRatesOf, smeltSuccessProbs: smeltSuccessProbs, smeltGoldOf: smeltGoldOf, smeltAddableAffixes: smeltAddableAffixes,
    smeltPlanOf: smeltPlanOf, simulateSmeltPlan: simulateSmeltPlan, smeltRollWithRng: smeltRollWithRng,
    smeltRangeOf: smeltRangeOf, smeltRangeEx: smeltRangeEx, smeltAddAffixCap: smeltAddAffixCap,
    affixSrcRangeOf: affixSrcRangeOf, catalystRangeOf: catalystRangeOf,
    smeltExtraAffixesOf: smeltExtraAffixesOf, smeltRetainChance: smeltRetainChance,
    breakthroughCountOf: breakthroughCountOf,
    affixKindOf: affixKindOf, extraKindName: extraKindName, extraKindDesc: extraKindDesc,
    retainChancePerRelic: retainChancePerRelic, RETAIN_VAR_NAMES: RETAIN_VAR_NAMES,
    compileExpr: compileExpr, EXPR_FUNCS: EXPR_FUNCS,
    catalystEnvelopeOf: catalystEnvelopeOf, catalystPreset: catalystPreset,
    RARE_K_DEFAULT: RARE_K_DEFAULT, rareKOf: rareKOf, rareCommonMult: rareCommonMult,
    RECAST_QUALITY: RECAST_QUALITY, canRecast: canRecast, recastAffixes: recastAffixes,
    recastPearlExtra: recastPearlExtra, recastPearlNeed: recastPearlNeed, recastGoldFor: recastGoldFor,
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
    adjectiveOf: adjectiveOf, affixCeilingOf: affixCeilingOf, instanceMeta: instanceMeta, componentOf: componentOf,
    legacyToInstance: legacyToInstance, normalizeItemId: normalizeItemId,
    ROD_SET_PREFIX: ROD_SET_PREFIX, isRodSet: isRodSet, rodPartsOf: rodPartsOf, rodSetId: rodSetId, rodMeta: rodMeta,
    autoBuildPlan: autoBuildPlan, autoBuildPeek: autoBuildPeek, autoBuildVec: autoBuildVec,
    autoBuildRange: autoBuildRange,
    normalizeRodSetId: normalizeRodSetId,
    fishTierOf: fishTierOf, spotsOf: spotsOf,
    GROUNDS: GROUNDS, NAV: NAV,
    allItems: allItems, itemOf: itemOf, itemName: itemName, isSellable: isSellable,
  };
});
