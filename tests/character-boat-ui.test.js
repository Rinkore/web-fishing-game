'use strict';
// 角色 / 船型前端快速回归：只做静态结构校验 + 网络层 mock，不启动服务器或浏览器。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const Features = require('../frontend/js/features');
const Data = require('../frontend/js/data');
let pass = 0;
function check(value, name) { assert.ok(value, name); pass++; console.log('PASS ' + name); }

(async function () {
  const ui = read('frontend/js/ui.js');
  const pixel = read('frontend/css/pixel.css');
  const mobile = read('frontend/css/mobile.css');

  check(!!Features.byId['character.angler'], '功能开关包含钓手选择');
  check(Features.route('POST', '/api/appearance/boat') === 'character.boat', '切船接口受船型开关管理');
  check(Features.route('POST', '/api/appearance/boat/buy') === 'character.boat' &&
    Features.route('POST', '/api/appearance/angler') === 'character.angler', '购船与钓手解锁接口受开关管理');
  check(Array.isArray(Data.BOATS) && Data.BOATS.length >= 5 && Data.boatOf('marsh_skiff'), '共享船型目录含默认船与扩充船');
  check(Data.BOATS.every(b => b.id && b.name && b.trait && b.asset && typeof b.price === 'number' && b.water &&
    Array.isArray(b.fitSpots) && Array.isArray(b.buffs)), '船型字段完整（含价格与水域类型）');
  check(Data.boatOf('marsh_skiff').price === 0 && Data.freeBoatIds().join() === 'marsh_skiff', '免费船只有且仅有默认船');
  check(Data.boatFits('marsh_skiff', 'stillwater', 'dock') && !Data.boatFits('marsh_skiff', 'stillwater', 'deep'), '适航钓点匹配严格按 ground:spot');
  check(Array.isArray(Data.COMPANIONS) && Data.COMPANIONS.length === 18 &&
    Data.companionOf('golden') && Data.companionOf('saintbernard') && Data.companionOf('__proto__') === null,
    '同伴目录 18 只且白名单查询安全');
  check(Data.companionBreeds().length === 9 && Data.companionBreeds()[0].list.length === 5, '同伴按 9 个品种分组，金毛 5 个变体');
  check(Array.isArray(Data.ANGLERS) && Data.ANGLERS.length === 3 &&
    Data.anglerOf('lan').passive.type === 'speed' && Data.anglerOf('li').unlock.cost === 3000 &&
    Data.freeAnglerIds().join() === 'lan,mo', '钓手目录含属性面板 / 被动 / 解锁方式');

  check(/let charTab = 'angler'/.test(ui) && /\['angler', '🎣 钓手'\]/.test(ui), '钓手是角色页首页签');
  check(/D\.anglerOf/.test(ui) && /ownedAnglerIds/.test(ui) && /chooseAngler/.test(ui), '钓手来自共享目录并经服务端保存');
  check(/assets\/ui\/chars\/' \+ id \+ '_' \+ pose \+ '\.png'/.test(ui) && /charSrc\('sit'\)/.test(ui), '地图四帧与展示台坐姿共用角色 id');
  const artFiles = ['lan_a', 'lan_b', 'lan_hold', 'lan_sit', 'mo_a', 'mo_b', 'mo_hold', 'mo_sit', 'li_a', 'li_b', 'li_hold', 'li_sit']
    .map(name => path.join(ROOT, 'frontend', 'assets', 'ui', 'chars', name + '.png'))
    .concat(['boat_marsh_skiff', 'boat_leaky_bucket', 'boat_tide_cutter', 'boat_snow_wolf', 'boat_coast_rambler']
      .map(name => path.join(ROOT, 'frontend', 'assets', 'ui', 'char', name + '.png')));
  check(artFiles.every(fs.existsSync), '三名钓手四姿势与五艘原创船素材齐全');
  check(Data.COMPANIONS.every(c => fs.existsSync(path.join(ROOT, 'frontend', 'assets', 'ui', 'char', 'dog_' + c.id + '.png'))), '十八个原创同伴素材齐全');
  check(['boat_wood', 'boat_leaky', 'boat_loon', 'boat_rambler', 'boat_snowwolf']
    .every(name => !fs.existsSync(path.join(ROOT, 'frontend', 'assets', 'ui', 'char', name + '.png'))), '旧外部船图已移除');
  check(/LEGACY_BOAT_IDS/.test(ui) && /marsh_skiff/.test(ui) && /migratedLocalBoatId/.test(ui), '旧本地船型 id 有迁移回退');
  check(/companionBreeds/.test(ui) && /breed-group/.test(ui), '同伴页按品种分组展示');
  check(/\(D\.BOATS \|\| \[\]\)\.forEach/.test(ui) && /window\.Net\.setBoat\(boat\.id\)/.test(ui) && /buyBoat/.test(ui), '船型卡片来自共享目录并保存到服务端');
  check(/pn-boat/.test(ui) && /px-boat-route/.test(ui) && /boatMatched/.test(ui), '地图与钓速明细展示适航状态');
  check(/\.cs-angler/.test(pixel) && /\.boat-card/.test(pixel) && /\.angler-card/.test(pixel), '钓手与船型卡片有专项样式');
  check(/\.stat-row/.test(pixel) && /\.stat-cells/.test(pixel) && /\.cc-price/.test(pixel) && /\.cc-water/.test(pixel) && /\.breed-title/.test(pixel), '属性条 / 价格行 / 水域标签 / 品种标题样式齐全');
  check(/char-cards\.angler-cards, \.char-cards\.boat-cards/.test(mobile), '手机端详细卡片收为单列');

  // 真实执行 net.js，但把 fetch / EventSource / timer 全部换成内存 mock。
  const requests = [];
  const state = { features: {}, fishing: { active: false }, player: {} };
  class FakeEventSource { constructor(url) { this.url = url; this.readyState = 1; } close() {} }
  const sandbox = {
    URL: URL, URLSearchParams: URLSearchParams, AbortController: AbortController,
    Promise: Promise, Date: Date, Math: Math, JSON: JSON, encodeURIComponent: encodeURIComponent,
    setTimeout: function () { return 1; }, clearTimeout: function () {},
    setInterval: function () { return 1; }, clearInterval: function () {},
    EventSource: FakeEventSource,
    location: { hostname: 'mock.test', protocol: 'http:', href: 'http://mock.test/', pathname: '/', search: '', hash: '', replace: function () {} },
    document: { hidden: false, addEventListener: function () {} },
    fetch: async function (url, opts) {
      requests.push({ url: url, opts: opts });
      return { ok: true, status: 200, json: async function () { return { ok: true, appearance: { boatId: 'tide_cutter' } }; } };
    },
  };
  sandbox.window = {
    Engine: { state: state }, GameFeatures: Features, APP_CONFIG: { API_BASE: '' },
    addEventListener: function () {}, location: sandbox.location,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('frontend/js/net.js'), sandbox, { filename: 'frontend/js/net.js' });
  sandbox.window.Net.setAuth('secret-token', { username: 'boat_mock', name: '测试钓手', appearance: { boatId: 'marsh_skiff' } });
  check(state.appearance && state.appearance.boatId === 'marsh_skiff', '登录 profile 外观同步到前端状态');
  const response = await sandbox.window.Net.setBoat('tide_cutter');
  const req = requests[requests.length - 1];
  const body = JSON.parse(req.opts.body);
  check(response.ok && req.url === '/api/appearance/boat' && req.opts.method === 'POST', 'Net.setBoat 请求正确接口');
  check(body.boatId === 'tide_cutter' && !Object.prototype.hasOwnProperty.call(body, 'token'), '切船请求只发 boatId，凭据不进 JSON');
  const buyRes = await sandbox.window.Net.buyBoat('snow_wolf');
  const buyReq = requests[requests.length - 1];
  check(buyRes.ok && buyReq.url === '/api/appearance/boat/buy' && JSON.parse(buyReq.opts.body).boatId === 'snow_wolf' &&
    !Object.prototype.hasOwnProperty.call(JSON.parse(buyReq.opts.body), 'token'), 'Net.buyBoat 请求购船接口且凭据不进 JSON');
  const anglerRes = await sandbox.window.Net.setAngler('li');
  const anglerReq = requests[requests.length - 1];
  check(anglerRes.ok && anglerReq.url === '/api/appearance/angler' && JSON.parse(anglerReq.opts.body).anglerId === 'li' &&
    !Object.prototype.hasOwnProperty.call(JSON.parse(anglerReq.opts.body), 'token'), 'Net.setAngler 请求钓手接口且凭据不进 JSON');

  console.log('通过 ' + pass + ' 项，失败 0 项');
})().catch(function (err) { console.error(err); process.exitCode = 1; });
