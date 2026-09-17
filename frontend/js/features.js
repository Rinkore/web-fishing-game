(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameFeatures = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const groups = [
    ['fishing', '钓鱼', [['cast', '抛竿与自动钓鱼']]],
    ['character', '角色', [['companion', '更换同伴'], ['boat', '更换船型']]],
    ['bd', '钓竿配置', [['equip', '装备组件'], ['slots', '购买槽位'], ['save', '保存与管理钓竿'], ['autobuild', '自动配装']]],
    ['ground', '渔场动态', [['trade', '玩家交易']]],
    ['inventory', '背包', [['subscribe', '组件订阅提醒']]],
    ['workshop', '工坊', [['craft', '合成宝匣'], ['open', '开启宝匣'], ['smelt', '熔炼'], ['recast', '重铸']]],
    ['mall', '商城', [['buy', '限购商品购买'], ['sell', '出售物品（含背包入口）'], ['autosell', '自动售出'], ['list', '市集上架'], ['marketbuy', '市集购买']]],
    ['codex', '鱼类图鉴', []], ['records', '渔获记录', []],
    ['feedback', '反馈意见', [['submit', '提交反馈'], ['skip', '付费跳过冷却']]],
    ['logs', '日志', []],
  ].map(function (g) { return { id: g[0], name: g[1], children: g[2].map(function (a) { return { id: g[0] + '.' + a[0], name: a[1], parent: g[0] }; }) }; });
  const entries = [];
  groups.forEach(function (g) { entries.push(g); entries.push.apply(entries, g.children); });
  const byId = Object.create(null);
  entries.forEach(function (e) { byId[e.id] = e; });
  const routes = {
    '/api/fishing/start': 'fishing.cast', '/api/bd/set': 'bd.equip',
    '/api/rod/slot/buy': 'bd.slots', '/api/rod/save': 'bd.save', '/api/rod/name': 'bd.save',
    '/api/rod/rename': 'bd.save', '/api/rod/use': 'bd.save', '/api/rod/stow': 'bd.save', '/api/rod/delete': 'bd.save',
    '/api/chest/craft': 'workshop.craft', '/api/chest/open': 'workshop.open',
    '/api/workshop/smelt': 'workshop.smelt', '/api/workshop/recast': 'workshop.recast',
    '/api/mall/buy': 'mall.buy', '/api/sell': 'mall.sell', '/api/autosell': 'mall.autosell',
    '/api/market/list': 'mall.list', '/api/market/buy': 'mall.marketbuy',
    '/api/trade/invite': 'ground.trade', '/api/trade/respond': 'ground.trade',
    '/api/trade/set': 'ground.trade', '/api/trade/confirm': 'ground.trade',
    '/api/subscribe': 'inventory.subscribe', '/api/feedback/submit': 'feedback.submit', '/api/feedback/skip': 'feedback.skip',
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
  return { groups: groups, entries: entries, byId: byId, blocked: blocked, route: route, message: message };
});
