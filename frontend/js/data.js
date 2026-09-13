/*
 * 网页钓鱼小游戏 - 静态数据（前后端共享，单一来源）
 * 浏览器经 <script> 加载挂到 window.GameData；后端 require 得到同一对象（UMD）。
 * 钓场 / 钓点 / 渔获 / 组件目录 / 词缀定义只有这一份，服务器掷骰与前端展示共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameData = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

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

  // 掉落用默认组件（框架占位：无效果、无词缀）
  const COMPONENT_DROP = { id: 'comp_generic', name: '钓竿组件（默认）', rarity: 'common', price: 40, note: '框架占位，无效果' };

  // 稀有度基准价倍率（无独立 price 时兜底）
  const RARITY_PRICE = { common: 10, big: 150, rare: 350 };

  // ---- 钓竿部位框架（含饰品栏位） ----
  // 每个部位默认安装一个“标准”组件，默认无词缀、无效果。
  const ROD_PARTS = [
    { key: 'rod', name: '竿身', default: { name: '标准竿身', affixes: [], rare: null } },
    { key: 'line', name: '线组', default: { name: '标准线组', affixes: [], rare: null } },
    { key: 'hook', name: '钩', default: { name: '标准钩', affixes: [], rare: null } },
    { key: 'bait', name: '饵', default: { name: '标准饵', affixes: [], rare: null } },
    { key: 'reel', name: '卷线器', default: { name: '标准卷线器', affixes: [], rare: null } },
    { key: 'accessory', name: '配件', default: { name: '标准配件', affixes: [], rare: null } },
    { key: 'charm', name: '饰品栏位', isCharm: true, default: { name: '（空）', affixes: [], rare: null } },
  ];

  // 词缀框架占位文本（具体词缀/效果后续设计）
  const AFFIX_FRAMEWORK = {
    normalNote: '普通词缀：每个组件可拥有 1 至 3 条（框架占位，未实现具体效果）。',
    rareNote: '稀有词缀：不一定拥有；拥有时提供特殊效果与联动（框架占位，未实现）。',
  };

  // ---- 词缀类型（engine 计算效果、UI 展示共用） ----
  const AFFIX_LABEL = {
    speed: '钓速', big: '大鱼概率', rare: '稀有概率',
    material: '材料概率', size: '体型', double: '双钓概率',
  };

  // ---- 钓竿组件目录（钓竿配置核心） ----
  // 组件 id 即效果编码：`部位_效果数值_效果数值…`，词缀直接由 id 解析（单一来源）。
  // 新增组件只需按格式写 id，效果与数值自动生效，无需再手写 affixes。
  // 效果代码：spd=钓速 big=大鱼概率 rare=稀有概率 mat=材料概率 size=体型 dbl=双钓概率
  // 数值允许负数（取舍型词条），如 rod_spd15_size-5 = 钓速+15%、体型-5%。
  const EFFECT_CODES = {
    spd: 'speed', speed: 'speed',
    big: 'big',
    rare: 'rare',
    mat: 'material', material: 'material',
    size: 'size',
    dbl: 'double', double: 'double',
  };
  const AFFIX_SEG_RE = /^(spd|speed|big|rare|mat|material|size|dbl|double)(-?\d+)$/i;
  function affixesOf(id) {
    const out = [];
    String(id).split('_').slice(1).forEach(function (seg) {
      const m = AFFIX_SEG_RE.exec(seg);
      if (m) out.push({ type: EFFECT_CODES[m[1].toLowerCase()], value: parseInt(m[2], 10) });
    });
    return out;
  }
  const COMPONENTS = [
    { id: 'rod_spd10', name: '竹制短竿', part: 'rod', rarity: 'common', price: 60 },
    { id: 'rod_spd15_size-5', name: '玻璃钢竿', part: 'rod', rarity: 'common', price: 90 },
    { id: 'rod_spd20_mat-10', name: '碳素长竿', part: 'rod', rarity: 'rare', price: 240 },
    { id: 'rod_big8_spd-8', name: '深海碳叉竿', part: 'rod', rarity: 'rare', price: 300 },
    { id: 'rod_big12_size10_spd-15', name: '龙骨巨竿', part: 'rod', rarity: 'epic', price: 640 },
    { id: 'line_mat25_rare-5', name: '强化线组', part: 'line', rarity: 'common', price: 50 },
    { id: 'line_rare5_size-10', name: '隐形鱼线', part: 'line', rarity: 'rare', price: 220 },
    { id: 'line_size15_spd-5', name: '钛芯线', part: 'line', rarity: 'rare', price: 260 },
    { id: 'line_big6_rare4_spd-10', name: '龙筋线', part: 'line', rarity: 'epic', price: 600 },
    { id: 'hook_big4', name: '倒刺钩', part: 'hook', rarity: 'common', price: 55 },
    { id: 'hook_spd12_size-8', name: '血燕钩', part: 'hook', rarity: 'common', price: 70 },
    { id: 'hook_big8_spd-5', name: '精钢鱼钩', part: 'hook', rarity: 'rare', price: 260 },
    { id: 'hook_big10_rare-5', name: '千钩·鬼牙', part: 'hook', rarity: 'epic', price: 580 },
    { id: 'bait_rare2', name: '浓香饵料', part: 'bait', rarity: 'common', price: 45 },
    { id: 'bait_mat30_spd-5', name: '酒米窝料', part: 'bait', rarity: 'common', price: 40 },
    { id: 'bait_rare6_mat-10', name: '秘制香饵', part: 'bait', rarity: 'rare', price: 280 },
    { id: 'bait_big6_rare3_mat-15', name: '仿生拟饵', part: 'bait', rarity: 'rare', price: 250 },
    { id: 'bait_rare8_big4_mat-20', name: '龙涎香饵', part: 'bait', rarity: 'epic', price: 620 },
    { id: 'reel_spd10', name: '顺滑卷线器', part: 'reel', rarity: 'common', price: 60 },
    { id: 'reel_spd15_mat-10', name: '磁力刹车卷线器', part: 'reel', rarity: 'rare', price: 270 },
    { id: 'reel_spd25', name: '电动卷线器', part: 'reel', rarity: 'epic', price: 520 },
    { id: 'reel_spd35_big-8', name: '涡轮卷线器', part: 'reel', rarity: 'epic', price: 650 },
    { id: 'acc_dbl10', name: '鱼护网袋', part: 'accessory', rarity: 'common', price: 70 },
    { id: 'acc_rare3_size-5', name: '夜光浮漂', part: 'accessory', rarity: 'common', price: 55 },
    { id: 'acc_dbl15', name: '自动抄网', part: 'accessory', rarity: 'rare', price: 290 },
    { id: 'acc_big6_rare4', name: '智能探鱼器', part: 'accessory', rarity: 'epic', price: 560 },
    { id: 'acc_rare6_size10_spd-10', name: '深海声呐雷达', part: 'accessory', rarity: 'epic', price: 700 },
    { id: 'charm_rare3_size10', name: '幸运硬币', part: 'charm', rarity: 'rare', price: 300 },
    { id: 'charm_size20_spd-8', name: '翡翠鲤玉', part: 'charm', rarity: 'rare', price: 320 },
    { id: 'charm_big4_rare3_spd10', name: '金鳞坠饰', part: 'charm', rarity: 'epic', price: 600 },
    { id: 'charm_big8_rare5_dbl10_spd-12', name: '海王徽记', part: 'charm', rarity: 'epic', price: 680 },
  ];
  const COMPONENT_MAP = {};
  COMPONENTS.forEach(function (c) { c.affixes = affixesOf(c.id); COMPONENT_MAP[c.id] = c; });
  // 旧存档兼容：框架版掉落的通用组件（无效果，不可装备，可出售）
  const LEGACY_COMPONENT = { id: 'comp_generic', name: '钓竿组件（默认）', part: null, rarity: 'common', price: 40, affixes: [] };
  // v0.7.0 组件 ID 改版前的旧 id → 新编码 id（读档/挂单/统计原位换新）
  const LEGACY_ID_ALIAS = {
    rod_bamboo: 'rod_spd10', rod_carbon: 'rod_spd20_mat-10',
    line_strong: 'line_mat25_rare-5', line_ghost: 'line_rare5_size-10',
    hook_barb: 'hook_big4', hook_steel: 'hook_big8_spd-5',
    bait_rich: 'bait_rare2', bait_secret: 'bait_rare6_mat-10',
    reel_smooth: 'reel_spd10', reel_electric: 'reel_spd25',
    acc_net: 'acc_dbl10', acc_sonar: 'acc_big6_rare4',
    charm_coin: 'charm_rare3_size10', charm_gold: 'charm_big4_rare3_spd10',
  };
  function normalizeItemId(id) { return LEGACY_ID_ALIAS[id] || id; }

  // 组件掉落：先按稀有度 roll（common 70% / rare 24% / epic 6%），再在同稀有度中均匀取一个
  function rollComponent() {
    const r = Math.random();
    const tier = r < 0.70 ? 'common' : (r < 0.94 ? 'rare' : 'epic');
    const pool = COMPONENTS.filter(function (c) { return c.rarity === tier; });
    const c = pool[Math.floor(Math.random() * pool.length)];
    return { kind: 'component', rarity: c.rarity, id: c.id, name: c.name, size: null };
  }
  function componentOf(id) {
    const nid = normalizeItemId(id);
    return COMPONENT_MAP[nid] || (id === 'comp_generic' ? LEGACY_COMPONENT : null);
  }
  function fishTierOf(id) {
    for (const tier of ['common', 'big', 'rare']) {
      if (FISH[tier].some(function (f) { return f.id === id; })) return tier;
    }
    return null;
  }
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
    { id: 'collect', name: '收藏', icon: '⭐', implemented: false },
  ];

  // ---- 物品索引（供 UI / 引擎统一查询） ----
  // 返回 { id, name, rarity, price, size }
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
    COMPONENTS.forEach(function (c) {
      out.push({ id: c.id, name: c.name, rarity: c.rarity, price: c.price, size: null, kind: 'component' });
    });
    out.push({ id: COMPONENT_DROP.id, name: COMPONENT_DROP.name, rarity: COMPONENT_DROP.rarity, price: COMPONENT_DROP.price, size: null, kind: 'component' });
    return out;
  }
  const ITEM_MAP = {};
  allItems().forEach(function (it) { ITEM_MAP[it.id] = it; });
  function itemOf(id) {
    const nid = normalizeItemId(id);
    return ITEM_MAP[nid] || { id: nid, name: nid, rarity: 'common', price: RARITY_PRICE.common, size: null, kind: 'unknown' };
  }
  function itemName(id) { return itemOf(id).name; }

  return {
    FISH: FISH, MATERIALS: MATERIALS, COMPONENT_DROP: COMPONENT_DROP,
    RARITY_PRICE: RARITY_PRICE,
    ROD_PARTS: ROD_PARTS, AFFIX_FRAMEWORK: AFFIX_FRAMEWORK,
    AFFIX_LABEL: AFFIX_LABEL, COMPONENTS: COMPONENTS,
    EFFECT_CODES: EFFECT_CODES, affixesOf: affixesOf, normalizeItemId: normalizeItemId,
    rollComponent: rollComponent, componentOf: componentOf, fishTierOf: fishTierOf, spotsOf: spotsOf,
    GROUNDS: GROUNDS, NAV: NAV,
    allItems: allItems, itemOf: itemOf, itemName: itemName,
  };
});
