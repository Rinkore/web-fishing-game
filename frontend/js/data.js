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
  const VERSION = 'v0.9.7';
  const BUILD = '2026-09-14';

  // ---- 渔获定义 ----
  // price = 系统商店基准收购价；size = [min, max] 体型范围（cm），用于大鱼记录
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
      { id: 'catfish', name: '巨型鲶鱼', rarity: 'big', price: 120, size: [80, 220] },
      { id: 'bass', name: '湖王鲈鱼', rarity: 'big', price: 150, size: [60, 180] },
      { id: 'tuna', name: '黄金枪鱼', rarity: 'big', price: 260, size: [120, 320] },
      { id: 'sturgeon', name: '远古巨鲟', rarity: 'big', price: 320, size: [150, 400] },
      { id: 'mandarin', name: '鳜鱼', rarity: 'big', price: 140, size: [35, 90] },
      { id: 'blackbass', name: '大口黑鲈', rarity: 'big', price: 160, size: [45, 130] },
      { id: 'seabass', name: '海鲈', rarity: 'big', price: 170, size: [55, 140] },
      { id: 'yellowcheek', name: '鳡鱼', rarity: 'big', price: 180, size: [70, 170] },
      { id: 'mackerel', name: '马鲛鱼', rarity: 'big', price: 210, size: [55, 160] },
      { id: 'grouper', name: '石斑鱼', rarity: 'big', price: 230, size: [45, 150] },
      { id: 'cobia', name: '军曹鱼', rarity: 'big', price: 250, size: [90, 200] },
      { id: 'rubysnapper', name: '金目鲷', rarity: 'big', price: 280, size: [55, 140] },
      { id: 'sunfish', name: '翻车鱼', rarity: 'big', price: 300, size: [150, 300] },
      { id: 'arapaima', name: '巨骨舌鱼', rarity: 'big', price: 350, size: [180, 330] },
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
      { id: 'dragonpearl', name: '龙宫宝珠', rarity: 'rare', price: 600, size: [5, 30] },
    ],
  };

  const MATERIALS = [
    { id: 'bait_pack', name: '诱饵包', rarity: 'common', price: 5, size: null },
    { id: 'rope', name: '耐磨绳', rarity: 'common', price: 4, size: null },
    { id: 'lure', name: '反光假饵', rarity: 'common', price: 7, size: null },
    { id: 'relic', name: '沉船宝匣残片', rarity: 'rare', price: 380, size: null },
  ];

  // 稀有度基准价倍率（无独立 price 时兜底；仅用于渔获/材料）
  const RARITY_PRICE = { common: 10, big: 150, rare: 350 };

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
  const AFFIX_LABEL = {
    speed: '钓速', big: '大鱼概率', rare: '稀有概率',
    material: '材料概率', size: '体型', double: '双钓概率',
  };
  // 效果代码（实例签名里用的短码）
  const AFFIX_CODES = {
    speed: 'spd', big: 'big', rare: 'rare', material: 'mat', size: 'size', double: 'dbl',
  };
  const CODE_TO_TYPE = {};
  Object.keys(AFFIX_CODES).forEach(function (t) { CODE_TO_TYPE[AFFIX_CODES[t]] = t; });

  // ---- 品质（== 组件的“稀有度”概念，统一称为品质） ----
  // cap = 该品质最多可拥有的词缀条数；mult = 实例基准价倍率；cls = 展示配色（满词条时另有金色）
  const QUALITY = {
    common: { key: 'common', name: '普通', cap: 1, mult: 1,   cls: 'q-common' },
    rare:   { key: 'rare',   name: '稀有', cap: 2, mult: 1.5, cls: 'q-rare' },
    epic:   { key: 'epic',   name: '史诗', cap: 3, mult: 2.4, cls: 'q-epic' },
  };
  const QUALITY_ORDER = { common: 1, rare: 2, epic: 3 };

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
      { type: 'big', min: 8, max: 14 }, { type: 'size', min: 4, max: 12 }, { type: 'speed', min: -18, max: -8 } ] },
    // 线组
    { id: 'line_nylon', name: '尼龙线组', part: 'line', price: 45, pool: [
      { type: 'material', min: 15, max: 28 }, { type: 'size', min: -6, max: 4 } ] },
    { id: 'line_stealth', name: '隐形鱼线', part: 'line', price: 140, pool: [
      { type: 'rare', min: 3, max: 7 }, { type: 'size', min: -14, max: -5 } ] },
    { id: 'line_titan', name: '钛芯线', part: 'line', price: 170, pool: [
      { type: 'size', min: 10, max: 18 }, { type: 'speed', min: -9, max: -2 } ] },
    { id: 'line_dragon', name: '龙筋线', part: 'line', price: 250, pool: [
      { type: 'big', min: 4, max: 8 }, { type: 'rare', min: 3, max: 6 }, { type: 'speed', min: -14, max: -6 } ] },
    // 钩
    { id: 'hook_barb', name: '倒刺钩', part: 'hook', price: 50, pool: [
      { type: 'big', min: 3, max: 6 }, { type: 'size', min: -4, max: 3 } ] },
    { id: 'hook_swallow', name: '血燕钩', part: 'hook', price: 70, pool: [
      { type: 'speed', min: 8, max: 15 }, { type: 'size', min: -12, max: -4 } ] },
    { id: 'hook_steel', name: '精钢鱼钩', part: 'hook', price: 150, pool: [
      { type: 'big', min: 6, max: 10 }, { type: 'speed', min: -8, max: -2 } ] },
    { id: 'hook_ghost', name: '千钩·鬼牙', part: 'hook', price: 245, pool: [
      { type: 'big', min: 8, max: 12 }, { type: 'rare', min: -9, max: -3 }, { type: 'size', min: 3, max: 9 } ] },
    // 饵
    { id: 'bait_corn', name: '浓香饵料', part: 'bait', price: 40, pool: [
      { type: 'rare', min: 1, max: 3 }, { type: 'speed', min: 4, max: 9 } ] },
    { id: 'bait_rice', name: '酒米窝料', part: 'bait', price: 42, pool: [
      { type: 'material', min: 22, max: 34 }, { type: 'speed', min: -8, max: -2 } ] },
    { id: 'bait_secret', name: '秘制香饵', part: 'bait', price: 165, pool: [
      { type: 'rare', min: 4, max: 8 }, { type: 'material', min: -14, max: -5 } ] },
    { id: 'bait_bionic', name: '仿生拟饵', part: 'bait', price: 175, pool: [
      { type: 'big', min: 4, max: 8 }, { type: 'rare', min: 2, max: 5 }, { type: 'material', min: -18, max: -9 } ] },
    // 卷线器
    { id: 'reel_smooth', name: '顺滑卷线器', part: 'reel', price: 55, pool: [
      { type: 'speed', min: 8, max: 13 }, { type: 'material', min: -5, max: 3 } ] },
    { id: 'reel_magnetic', name: '磁力刹车卷线器', part: 'reel', price: 160, pool: [
      { type: 'speed', min: 12, max: 18 }, { type: 'material', min: -14, max: -5 } ] },
    { id: 'reel_electric', name: '电动卷线器', part: 'reel', price: 240, pool: [
      { type: 'speed', min: 20, max: 28 }, { type: 'big', min: -6, max: 2 } ] },
    { id: 'reel_turbo', name: '涡轮卷线器', part: 'reel', price: 270, pool: [
      { type: 'speed', min: 28, max: 38 }, { type: 'big', min: -12, max: -4 } ] },
    // 配件
    { id: 'acc_net', name: '鱼护网袋', part: 'accessory', price: 60, pool: [
      { type: 'double', min: 7, max: 12 }, { type: 'speed', min: -4, max: 3 } ] },
    { id: 'acc_float', name: '夜光浮漂', part: 'accessory', price: 52, pool: [
      { type: 'rare', min: 2, max: 5 }, { type: 'size', min: -10, max: -3 } ] },
    { id: 'acc_scoop', name: '自动抄网', part: 'accessory', price: 165, pool: [
      { type: 'double', min: 12, max: 18 }, { type: 'material', min: -8, max: -2 } ] },
    { id: 'acc_sonar', name: '智能探鱼器', part: 'accessory', price: 255, pool: [
      { type: 'big', min: 5, max: 9 }, { type: 'rare', min: 3, max: 6 }, { type: 'speed', min: -10, max: -3 } ] },
    { id: 'acc_radar', name: '深海声呐雷达', part: 'accessory', price: 300, pool: [
      { type: 'rare', min: 5, max: 9 }, { type: 'size', min: 8, max: 14 }, { type: 'speed', min: -14, max: -6 } ] },
    // 饰品
    { id: 'charm_coin', name: '幸运硬币', part: 'charm', price: 145, pool: [
      { type: 'rare', min: 2, max: 5 }, { type: 'size', min: 6, max: 12 } ] },
    { id: 'charm_jade', name: '翡翠鲤玉', part: 'charm', price: 155, pool: [
      { type: 'size', min: 15, max: 24 }, { type: 'speed', min: -12, max: -4 } ] },
    { id: 'charm_gold', name: '金鳞坠饰', part: 'charm', price: 250, pool: [
      { type: 'big', min: 3, max: 6 }, { type: 'rare', min: 2, max: 5 }, { type: 'speed', min: 6, max: 12 } ] },
    { id: 'charm_trident', name: '海王徽记', part: 'charm', price: 290, pool: [
      { type: 'big', min: 6, max: 10 }, { type: 'rare', min: 4, max: 8 }, { type: 'double', min: 8, max: 14 }, { type: 'speed', min: -16, max: -8 } ] },
  ];
  const BASE_MAP = {};
  COMPONENT_BASES.forEach(function (b) { b.pool = b.pool.map(function (a) { return { type: a.type, min: a.min, max: a.max }; }); BASE_MAP[b.id] = b; });
  function componentBase(id) { return BASE_MAP[id] || null; }

  // ---- 实例签名 ----
  // 格式：baseId#quality#code+value,code+value…（无词缀时第三段为空）
  const INSTANCE_SEP = '#';
  function codeOf(type) { return AFFIX_CODES[type] || type; }
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
        const m = /^(spd|big|rare|mat|size|dbl)([+-]?\d+)$/.exec(tok);
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
    const maxN = Math.min(q.cap, poolLen);
    const full = inst.affixes.length >= poolLen && poolLen <= q.cap;
    const adjective = adjectiveOf(inst.affixes, base, inst.quality);
    return {
      id: id, kind: 'component', baseId: base.id, baseName: base.name, part: base.part,
      quality: inst.quality, qualityName: q.name, qualityCls: q.cls,
      rarity: inst.quality, rarityName: q.name,
      affixes: inst.affixes, pool: base.pool, maxAffixes: maxN,
      full: full, isFull: full,
      adjective: adjective,
      name: adjective + ' ' + base.name,
      price: Math.round(base.price * q.mult),
      size: null,
    };
  }

  // ---- 组件生成：先定品质，再抽词条，最后 roll 数值 ----
  // 生成参数可被管理后台覆盖（品质概率 / 词条数量概率 / 数值 roll 模型 / 底材词缀数值范围）。
  const DEFAULT_QUALITY_WEIGHTS = { common: 0.62, rare: 0.30, epic: 0.08 };
  const DEFAULT_COUNT_WEIGHTS = {
    common: [1],                 // 词条数 1..cap 的权重
    rare: [0.5, 0.5],
    epic: [1 / 3, 1 / 3, 1 / 3],
  };
  // affixRanges: { baseId: { type: [min, max] } }，覆盖底材池中对应词缀的数值区间
  let componentCfg = {
    qualityWeights: Object.assign({}, DEFAULT_QUALITY_WEIGHTS),
    countWeights: JSON.parse(JSON.stringify(DEFAULT_COUNT_WEIGHTS)),
    rollModel: 'linear',         // linear | normal | skew
    affixRanges: {},
    adjectiveRules: DEFAULT_ADJECTIVE_RULES.map(function (r) { return Object.assign({}, r); }),
  };
  function defaultComponentCfg() {
    return {
      qualityWeights: Object.assign({}, DEFAULT_QUALITY_WEIGHTS),
      countWeights: JSON.parse(JSON.stringify(DEFAULT_COUNT_WEIGHTS)),
      rollModel: 'linear',
      affixRanges: {},
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
      rollModel: (['linear', 'normal', 'skew'].indexOf(cfg.rollModel) >= 0) ? cfg.rollModel : d.rollModel,
      affixRanges: cfg.affixRanges || {},
      adjectiveRules: (Array.isArray(cfg.adjectiveRules) && cfg.adjectiveRules.length) ? cfg.adjectiveRules : d.adjectiveRules,
    };
    return componentCfg;
  }
  function getComponentCfg() { return componentCfg; }
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
  // 数值 roll：在 [min,max] 内按模型取值（整数）
  // 0 值词条无意义（+0% 加成）：roll 到 0 会被拒绝并重 roll 一次；
  // 若两次都为 0（区间跨越 0 时仍可能），落到区间内最近的 ±1，保证不产生 0 值词条。
  function rollAffixValue(min, max, model) {
    if (max <= min) return min;
    const span = max - min;
    function draw() {
      let r;
      if (model === 'normal') {
        // 正态：均值居中、标准差取 1/6 区间，截断在 [min,max]
        let u1 = Math.random() || 1e-9, u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        r = Math.max(0, Math.min(1, 0.5 + z / 6));
      } else if (model === 'skew') {
        // 偏态：偏向低值（平方分布）
        r = Math.pow(Math.random(), 2);
      } else {
        r = Math.random();
      }
      return min + Math.round(r * span);
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
  // 按品质的词条数量权重取 n（1..min(池长, cap)）
  function rollAffixCount(quality, poolLen, cap) {
    const upper = Math.min(poolLen, cap);
    const w = (componentCfg.countWeights && componentCfg.countWeights[quality]) || null;
    if (!w || !w.length) return 1 + Math.floor(Math.random() * Math.max(1, upper));
    let total = 0;
    for (let i = 0; i < upper; i++) total += Math.max(0, Number(w[i]) || 0);
    if (!(total > 0)) return 1 + Math.floor(Math.random() * Math.max(1, upper));
    let r = Math.random() * total;
    for (let i = 0; i < upper; i++) { r -= Math.max(0, Number(w[i]) || 0); if (r <= 0) return i + 1; }
    return upper;
  }
  // 生成一件组件实例（底材 → 品质 → 抽 1..min(池长, 上限) 条词缀 → roll 数值）
  function genComponent(baseId, quality) {
    const base = BASE_MAP[baseId];
    if (!base) return null;
    const q = QUALITY[quality] || QUALITY.common;
    const n = rollAffixCount(q.key, base.pool.length, q.cap);
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
  // 从整份底材目录均匀抽一个底材，再定品质生成
  function rollComponent() {
    const base = COMPONENT_BASES[Math.floor(Math.random() * COMPONENT_BASES.length)];
    return genComponent(base.id, rollComponentQuality());
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
  // 任意 id 规范化：实例签名原样返回；旧组件 id 升级为实例签名；其余（鱼/材料）不变
  function normalizeItemId(id) {
    if (id == null) return id;
    const s = String(id);
    if (instanceOf(s)) return s;
    if (s === 'comp_generic') return s;
    const up = legacyToInstance(s);
    return up || s;
  }

  // ---- 组件识别：既接受实例签名，也接受旧组件 id ----
  function componentOf(id) {
    if (id == null) return null;
    const s = String(id);
    const inst = instanceMeta(s);
    if (inst) return inst;
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
        { id: 'dock', name: '老旧码头', pool: [
          p('fish', 'crucian', 30), p('fish', 'white', 16), p('fish', 'carp', 18),
          p('fish', 'minnow', 12), p('fish', 'bream', 8),
          p('fish', 'catfish', 4), p('fish', 'bass', 3), p('fish', 'koi', 1),
          p('material', 'bait_pack', 10), p('component', '', 6),
        ] },
        { id: 'reed', name: '芦苇浅滩', pool: [
          p('fish', 'grass', 24), p('fish', 'white', 18), p('fish', 'crucian', 12),
          p('fish', 'minnow', 12), p('fish', 'loach', 10), p('fish', 'yellowcat', 8),
          p('material', 'rope', 12), p('component', '', 7),
        ] },
        { id: 'deep', name: '深水区', pool: [
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
        { id: 'shoal', name: '石滩', pool: [
          p('fish', 'white', 24), p('fish', 'riverperch', 18), p('fish', 'culter', 14),
          p('fish', 'crucian', 10), p('fish', 'blackbass', 5),
          p('material', 'rope', 12), p('component', '', 7),
        ] },
        { id: 'eddy', name: '回水湾', pool: [
          p('fish', 'carp', 24), p('fish', 'crucian', 20), p('fish', 'yellowcat', 12),
          p('fish', 'grass', 10), p('fish', 'culter', 6), p('fish', 'mandarin', 5),
          p('fish', 'arowana', 1),
          p('material', 'bait_pack', 11), p('component', '', 6),
        ] },
        { id: 'fall', name: '瀑布潭', pool: [
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
        { id: 'beach', name: '沙滩', pool: [
          p('fish', 'tilapia', 22), p('fish', 'sardine', 18), p('fish', 'croaker', 14),
          p('fish', 'sunfish', 5), p('fish', 'pearl', 2),
          p('material', 'bait_pack', 12), p('component', '', 7),
        ] },
        { id: 'pier', name: '防波堤', pool: [
          p('fish', 'seabass', 10), p('fish', 'tuna', 8), p('fish', 'mackerel', 8),
          p('fish', 'cobia', 6), p('fish', 'bluefin', 3), p('fish', 'swordfish', 2),
          p('fish', 'pearl', 2),
          p('material', 'lure', 11), p('component', '', 7),
        ] },
        { id: 'reef', name: '礁石区', pool: [
          p('fish', 'tuna', 10), p('fish', 'grouper', 9), p('fish', 'rubysnapper', 7),
          p('fish', 'seabass', 4), p('fish', 'sturgeon', 3), p('fish', 'pearl', 3),
          p('fish', 'dragonfish', 2), p('fish', 'amberlobster', 2),
          p('material', 'relic', 1), p('fish', 'dragonpearl', 1),
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
  const NAV = [
    { id: 'fishing', name: '钓鱼', icon: '🎣', implemented: true },
    { id: 'bd', name: '钓竿配置', icon: '🎯', implemented: true },
    { id: 'ground', name: '渔场动态', icon: '🌊', implemented: true },
    { id: 'inventory', name: '背包', icon: '🎒', implemented: true },
    { id: 'shop', name: '系统商店', icon: '🏪', implemented: true },
    { id: 'market', name: '开放市集', icon: '💱', implemented: true },
    { id: 'trade', name: '在线交易', icon: '🤝', implemented: true },
    { id: 'mall', name: '商城', icon: '🛒', implemented: false },
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
  // 可出售/可上架：渔获、材料、已生成的组件实例；组件底材（模板）与未知物不可交易
  function isSellable(id) {
    const it = itemOf(id);
    if (it.kind === 'fish' || it.kind === 'material') return true;
    if (it.kind === 'rod') return true; // 整根钓竿：仅市集出售（服务端拒绝系统商店收购）
    if (it.kind === 'component') return isInstance(String(id)) || String(id) === 'comp_generic';
    return false;
  }

  return {
    VERSION: VERSION, BUILD: BUILD,
    FISH: FISH, MATERIALS: MATERIALS, RARITY_PRICE: RARITY_PRICE,
    ROD_PARTS: ROD_PARTS,
    AFFIX_LABEL: AFFIX_LABEL, AFFIX_CODES: AFFIX_CODES,
    QUALITY: QUALITY, QUALITY_ORDER: QUALITY_ORDER,
    COMPONENT_BASES: COMPONENT_BASES, componentBase: componentBase,
    instanceId: instanceId, instanceOf: instanceOf, isInstance: isInstance,
    genComponent: genComponent, rollComponent: rollComponent, rollComponentQuality: rollComponentQuality,
    setComponentCfg: setComponentCfg, getComponentCfg: getComponentCfg, defaultComponentCfg: defaultComponentCfg,
    affixRangeOf: affixRangeOf, rollAffixValue: rollAffixValue, weightedKey: weightedKey,
    adjectiveOf: adjectiveOf, instanceMeta: instanceMeta, componentOf: componentOf,
    legacyToInstance: legacyToInstance, normalizeItemId: normalizeItemId,
    ROD_SET_PREFIX: ROD_SET_PREFIX, isRodSet: isRodSet, rodPartsOf: rodPartsOf, rodSetId: rodSetId, rodMeta: rodMeta,
    fishTierOf: fishTierOf, spotsOf: spotsOf,
    GROUNDS: GROUNDS, NAV: NAV,
    allItems: allItems, itemOf: itemOf, itemName: itemName, isSellable: isSellable,
  };
});
