/*
 * 网页钓鱼小游戏 - 静态数据（框架版 v0.2）
 * 仅定义大框架：钓场 / 钓点 / 渔获 / 钓竿部位与默认组件。
 * 不含任何数值平衡、具体词缀效果或 BD 配方。
 */
window.GameData = (function () {
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
    ],
    big: [
      { id: 'catfish', name: '巨型鲶鱼', rarity: 'big', price: 120, size: [80, 220] },
      { id: 'bass', name: '湖王鲈鱼', rarity: 'big', price: 150, size: [60, 180] },
      { id: 'tuna', name: '黄金枪鱼', rarity: 'big', price: 260, size: [120, 320] },
      { id: 'sturgeon', name: '远古巨鲟', rarity: 'big', price: 320, size: [150, 400] },
    ],
    rare: [
      { id: 'koi', name: '黄金锦鲤', rarity: 'rare', price: 400, size: [40, 110] },
      { id: 'pearl', name: '深海珍珠贝', rarity: 'rare', price: 300, size: [10, 40] },
      { id: 'relic', name: '沉船宝匣残片', rarity: 'rare', price: 380, size: [5, 60] },
    ],
  };

  const MATERIALS = [
    { id: 'bait_pack', name: '诱饵包', rarity: 'common', price: 5, size: null },
    { id: 'rope', name: '耐磨绳', rarity: 'common', price: 4, size: null },
    { id: 'lure', name: '反光假饵', rarity: 'common', price: 7, size: null },
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
          p('fish', 'crucian', 30), p('fish', 'carp', 20), p('fish', 'white', 18),
          p('fish', 'catfish', 4), p('fish', 'bass', 3),
          p('material', 'bait_pack', 10), p('component', '', 6), p('fish', 'koi', 1),
        ] },
        { id: 'reed', name: '芦苇浅滩', pool: [
          p('fish', 'grass', 28), p('fish', 'white', 24), p('fish', 'crucian', 16),
          p('fish', 'sturgeon', 3), p('material', 'rope', 12), p('component', '', 7),
        ] },
        { id: 'deep', name: '深水区', pool: [
          p('fish', 'carp', 26), p('fish', 'crucian', 18), p('fish', 'catfish', 6),
          p('fish', 'bass', 5), p('fish', 'sturgeon', 2), p('fish', 'relic', 1),
          p('material', 'lure', 10), p('component', '', 6),
        ] },
      ],
    },
    {
      id: 'rapids', name: '急流河', type: 'normal',
      desc: '水流湍急的河流，大鱼概率略高。',
      spots: [
        { id: 'shoal', name: '石滩', pool: [
          p('fish', 'white', 26), p('fish', 'crucian', 20), p('fish', 'grass', 16),
          p('fish', 'bass', 6), p('material', 'rope', 12), p('component', '', 7),
        ] },
        { id: 'eddy', name: '回水湾', pool: [
          p('fish', 'carp', 24), p('fish', 'crucian', 22), p('fish', 'catfish', 7),
          p('fish', 'sturgeon', 3), p('material', 'bait_pack', 11), p('component', '', 6),
        ] },
        { id: 'fall', name: '瀑布潭', pool: [
          p('fish', 'bass', 10), p('fish', 'catfish', 8), p('fish', 'carp', 16),
          p('fish', 'sturgeon', 4), p('fish', 'relic', 1), p('material', 'lure', 10),
          p('component', '', 7),
        ] },
      ],
    },
    {
      id: 'sunset', name: '落日海湾', type: 'normal',
      desc: '咸淡水交界的海湾，稀有渔获倾向更高。',
      spots: [
        { id: 'beach', name: '沙滩', pool: [
          p('fish', 'tilapia', 24), p('fish', 'crucian', 18), p('fish', 'tuna', 5),
          p('fish', 'pearl', 2), p('material', 'bait_pack', 12), p('component', '', 7),
        ] },
        { id: 'pier', name: '防波堤', pool: [
          p('fish', 'tuna', 8), p('fish', 'bass', 6), p('fish', 'carp', 16),
          p('fish', 'catfish', 5), p('fish', 'pearl', 2), p('material', 'lure', 11),
          p('component', '', 7),
        ] },
        { id: 'reef', name: '礁石区', pool: [
          p('fish', 'tuna', 10), p('fish', 'sturgeon', 4), p('fish', 'pearl', 3),
          p('fish', 'koi', 2), p('fish', 'relic', 1), p('material', 'rope', 10),
          p('component', '', 7),
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
    { id: 'bd', name: '钓竿 BD', icon: '🎯', implemented: true },
    { id: 'ground', name: '渔场动态', icon: '🌊', implemented: true },
    { id: 'shop', name: '系统商店', icon: '🏪', implemented: true },
    { id: 'market', name: '开放市集', icon: '💱', implemented: true },
    { id: 'trade', name: '在线交易', icon: '🤝', implemented: true },
    { id: 'mall', name: '商城', icon: '🛒', implemented: false },
    { id: 'codex', name: '鱼类图鉴', icon: '📖', implemented: true },
    { id: 'records', name: '大鱼记录', icon: '🏆', implemented: true },
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
    out.push({ id: COMPONENT_DROP.id, name: COMPONENT_DROP.name, rarity: COMPONENT_DROP.rarity, price: COMPONENT_DROP.price, size: null, kind: 'component' });
    return out;
  }
  const ITEM_MAP = {};
  allItems().forEach(function (it) { ITEM_MAP[it.id] = it; });
  function itemOf(id) { return ITEM_MAP[id] || { id: id, name: id, rarity: 'common', price: RARITY_PRICE.common, size: null, kind: 'unknown' }; }
  function itemName(id) { return itemOf(id).name; }

  return {
    FISH: FISH, MATERIALS: MATERIALS, COMPONENT_DROP: COMPONENT_DROP,
    RARITY_PRICE: RARITY_PRICE,
    ROD_PARTS: ROD_PARTS, AFFIX_FRAMEWORK: AFFIX_FRAMEWORK,
    GROUNDS: GROUNDS, NAV: NAV,
    allItems: allItems, itemOf: itemOf, itemName: itemName,
  };
})();
