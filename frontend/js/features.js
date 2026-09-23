(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameFeatures = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const groups = [
    ['fishing', '钓鱼', [['cast', '抛竿与自动钓鱼']]],
    // 侧栏入口与页面是多对一：钓竿 / 记录分别是「角色」「图鉴」页里的页签，
    // 这里仍保留独立 id —— 管理员可以只关掉某一个页签，关闭主页面会连带它一起关。
    ['bd', '钓竿（角色页签）', [['equip', '装备组件'], ['slots', '购买槽位'], ['save', '保存与管理钓竿'], ['autobuild', '自动配装']]],
    ['character', '角色', [['companion', '选择同伴'], ['boat', '选择船型']]],
    ['sea', '远洋', [['upgrade', '船升级'], ['chart', '海图合成'], ['voyage', '随机海域出航'], ['expedition', '离线远航派遣'], ['quest', '每日悬赏'], ['anchor', '锚地续期']]],
    ['ground', '社交', [['trade', '玩家交易'], ['party', '编队出海']]],
    ['inventory', '背包', [['subscribe', '组件订阅提醒']]],
    ['workshop', '工坊', [['craft', '合成宝匣'], ['open', '开启宝匣'], ['smelt', '熔炼'], ['recast', '重铸'], ['forge', '锻造']]],
    ['mall', '商城', [['buy', '限购商品购买'], ['sell', '出售物品（含背包入口）'], ['autosell', '自动售出'], ['list', '市集上架'], ['marketbuy', '市集购买']]],
    ['codex', '图鉴', []],
    ['records', '记录（图鉴页签）', []],
    ['feedback', '反馈', [['submit', '提交反馈'], ['skip', '付费跳过冷却']]],
    ['logs', '日志', []],
    ['wiki', 'WIKI', []],
  ].map(function (g) {
    // 页签页与主页面共用一个侧栏入口：主页面关闭时，页签也必须跟着关闭，
    // 否则会出现「侧栏入口锁着、页签却能继续用」的漏口（这正是 parent 链的作用）。
    const PAGE_PARENT = { bd: 'fishing', records: 'codex' };
    return {
      id: g[0], name: g[1], parent: PAGE_PARENT[g[0]] || null,
      children: g[2].map(function (a) { return { id: g[0] + '.' + a[0], name: a[1], parent: g[0] }; }),
    };
  });
  const menuIds = ['fishing', 'sea', 'character', 'ground', 'inventory', 'workshop', 'mall', 'codex', 'feedback', 'logs', 'wiki'];
  function orderedMenu(order) {
    const saved = Array.isArray(order) ? order.filter(function (id, i) { return menuIds.indexOf(id) >= 0 && order.indexOf(id) === i; }) : [];
    return saved.concat(menuIds.filter(function (id) { return saved.indexOf(id) < 0; }));
  }
  const entries = [];
  groups.forEach(function (g) { entries.push(g); entries.push.apply(entries, g.children); });
  const byId = Object.create(null);
  entries.forEach(function (e) { byId[e.id] = e; });
  const routes = {
    '/api/fishing/start': 'fishing.cast', '/api/bd/set': 'bd.equip',
    '/api/rod/slot/buy': 'bd.slots', '/api/rod/save': 'bd.save', '/api/rod/name': 'bd.save',
    '/api/rod/rename': 'bd.save', '/api/rod/use': 'bd.save', '/api/rod/stow': 'bd.save', '/api/rod/delete': 'bd.save',
    '/api/chest/craft': 'workshop.craft', '/api/chest/open': 'workshop.open',
    '/api/workshop/smelt': 'workshop.smelt', '/api/workshop/recast': 'workshop.recast', '/api/workshop/forge': 'workshop.forge',
    '/api/mall/buy': 'mall.buy', '/api/sell': 'mall.sell', '/api/autosell': 'mall.autosell',
    '/api/market/list': 'mall.list', '/api/market/buy': 'mall.marketbuy',
    '/api/trade/invite': 'ground.trade', '/api/trade/respond': 'ground.trade',
    '/api/trade/set': 'ground.trade', '/api/trade/confirm': 'ground.trade',
    '/api/friends': 'ground', '/api/party': 'ground.party',
    '/api/subscribe': 'inventory.subscribe', '/api/feedback/submit': 'feedback.submit', '/api/feedback/skip': 'feedback.skip',
    '/api/sea/expedition/start': 'sea.expedition',
    '/api/sea/ship/up': 'sea.upgrade', '/api/sea/chart': 'sea.chart', '/api/sea/voyage': 'sea.voyage',
    '/api/sea/quest/claim': 'sea.quest', '/api/sea/anchor': 'sea.anchor',
  };
  function blocked(config, id) {
    const e = byId[id];
    if (!e) return null;
    config = config || {};
    if (config[id] === false) return id;
    return e.parent ? blocked(config, e.parent) : null;
  }
  function route(method, path) { return method === 'POST' ? routes[path.split('?')[0]] : null; }
  function message(config, id) { const key = blocked(config, id); return key ? '「' + byId[key].name + '」暂时关闭，请稍后再试' : ''; }
  return { menuIds: menuIds, orderedMenu: orderedMenu, groups: groups, entries: entries, byId: byId, blocked: blocked, route: route, message: message };
});
