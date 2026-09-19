/* Admin editor regression: isolated HTTP server, real browser, persistence and scheduled supply. */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp, waitFor } = require('./_util.js');
const registrationProof = require('./_registration.js');
const { provisionAdmin } = require('./_admin.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8284;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-admin-editors-'));
const DATA = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function request(pathname, options) {
  options = options || {};
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = Object.assign({}, options.headers || {});
  if (body) headers['Content-Type'] = 'application/json';
  return new Promise(resolve => {
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method: options.method || 'GET', headers: headers }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, data: data, body: out });
      });
    });
    r.on('error', () => resolve({ status: 0, data: null, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
const BEARER = t => ({ Authorization: 'Bearer ' + t });
const getT = (p, t) => request(p, { headers: BEARER(t) });
const postT = (p, body, t) => request(p, { method: 'POST', body: body, headers: BEARER(t) });
const post = (p, body) => request(p, { method: 'POST', body: body });
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
async function registerAccount(username) {
  const payload = { username: username, password: 'loot-test-1234', name: '战利品组测试', qq: '828300' };
  let r = await post('/api/register', payload);
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}

let srv = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

  const uniq = String(Date.now() % 100000);
  const admUser = 'admloot' + uniq;
  await registerAccount(admUser);
  const otp = await provisionAdmin(srv, TMP_DATA, admUser);
  const admLogin = await post('/api/admin/login', { username: admUser, password: 'loot-test-1234', otp: otp });
  let AT = admLogin.data && admLogin.data.token;
  check('管理员登录成功', !!AT, JSON.stringify(admLogin.data));

  const F = require('../frontend/js/features');
  const menu = F.menuIds.slice().reverse();
  check('Sortable menu matches actual client navigation including WIKI', JSON.stringify(F.menuIds) === JSON.stringify(DATA.NAV.map(n => n.id)));
  let r = await postT('/api/admin/features', { featureOrder: { menu } }, AT);
  check('Menu order saves and returns complete sequence', r.status === 200 && JSON.stringify(r.data.featureOrder.menu) === JSON.stringify(menu));
  check('Invalid menu order rejected', (await postT('/api/admin/features', { featureOrder: { menu: ['fishing'] } }, AT)).status === 400);
  const base = DATA.COMPONENT_BASES[0];
  for (const selector of ['part/' + base.part, 'base/' + base.id]) {
    r = await postT('/api/admin/loot/group', { group: { id: 'selected', name: '定向组件', weight: 1, items: [{ pick: 'component:' + selector, weight: 1 }] } }, AT);
    check('Component selector persists: ' + selector, r.status === 200 && r.data.groups.find(g => g.id === 'selected').items[0].pick === 'component:' + selector);
    const rolls = Array.from({length: 100}, () => DATA.rollComponent(selector));
    check('Component selector generates only eligible components: ' + selector, rolls.every(c => selector.startsWith('base/') ? c.baseId === base.id : c.part === base.part));
  }
  check('Invalid component filter rejected', (await postT('/api/admin/loot/group', { group: { id: 'invalid', name: '无效', weight: 1, items: [{ pick: 'component:base/missing', weight: 1 }] } }, AT)).status === 400);
  const weights = [0,0,0,0,100,0,0,0,0,0];
  r = await postT('/api/admin/fish/config', { sizeModel: 'custom', sizeWeights: weights }, AT);
  check('Custom size model saved', r.status === 200 && r.data.fishCfg.sizeWeights[4] === 100);
  r = await postT('/api/admin/fish/simulate', { model: 'custom', sizeWeights: weights, n: 1000, fishId: 'tuna' }, AT);
  check('Preview follows custom distribution', r.status === 200 && r.data.buckets[8] + r.data.buckets[9] >= 990, JSON.stringify(r.data));
  check('All-zero distribution rejected', (await postT('/api/admin/fish/config', { sizeModel: 'custom', sizeWeights: new Array(10).fill(0) }, AT)).status === 400);
  r = await postT('/api/admin/smelt/config', { catalystRatio: 50, forgeAnyAffix: false }, AT);
  check('Catalyst ratio and forge restriction saved', r.status === 200 && r.data.smeltCfg.catalystRatio === 50 && r.data.smeltCfg.forgeAnyAffix === false);
  DATA.setSmeltCfg(r.data.smeltCfg);
  const type = base.pool[0].type, envelope = DATA.catalystEnvelopeOf(base.part, type), range = DATA.catalystRangeFor(base.part, type);
  check('Catalyst width uses configured ratio of in-pool envelope', Math.abs((range[1] - range[0]) - (envelope[1] - envelope[0]) * .5) <= 1);
  check('Invalid catalyst ratio rejected', (await postT('/api/admin/smelt/config', { catalystRatio: -1 }, AT)).status === 400);
  const seller2 = 'supply' + uniq;
  const sellerReg = await registerAccount(seller2);
  const PT = sellerReg.data.token;
  const forgeBase = DATA.COMPONENT_BASES.find(b => b.pool.length >= 2 && b.pool.length < DATA.AFFIX_TYPES.length);
  const outsideMat = DATA.smeltMaterialIds().find(id => !forgeBase.pool.some(a => a.type === DATA.smeltMaterialAffix(id)));
  const forgeId = DATA.instanceId(forgeBase.id, 'rare', [{type:forgeBase.pool[0].type, value:5}]);
  await postT('/api/dev/seed', {inventory:{[forgeId]:2,[outsideMat]:2}}, PT);
  check('Server rejects forged outside affix when disabled', (await postT('/api/workshop/forge', {id:forgeId,materialId:outsideMat}, PT)).status === 400);
  await postT('/api/admin/smelt/config', {forgeAnyAffix:true}, AT);
  const forged = await postT('/api/workshop/forge', {id:forgeId,materialId:outsideMat}, PT);
  check('Server allows outside affix when enabled', forged.status === 200 && forged.data.item.affixes.some(a => a.type === DATA.smeltMaterialAffix(outsideMat)));
  await postT('/api/admin/smelt/config', {forgeAnyAffix:false}, AT);
  const recipe = { sellers: [admUser, seller2], counts: { material: 6 }, picks: { material: [DATA.MATERIALS[0].id] }, hours: 24, qtyMin: 1, qtyMax: 1, mulMin: 1, mulMax: 1 };
  check('Unknown seller rejected', (await postT('/api/admin/market/bulk', { ...recipe, sellers: ['missing'] }, AT)).status === 400);
  const readListings = () => fs.existsSync(path.join(TMP_DATA, 'market.json')) ? JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'market.json'))).listings : [];
  check('Invalid item selection never falls back to random items', (await postT('/api/admin/market/bulk', {...recipe,picks:{material:['missing']}}, AT)).status === 400);
  check('Players cannot create supply plans', (await postT('/api/admin/market/supply', {...recipe,mode:'gradual',batch:1,intervalSeconds:1}, PT)).status === 403);
  const before = readListings().length;
  r = await postT('/api/admin/market/bulk', { ...recipe, dryRun: true }, AT);
  check('Preview is read only', r.status === 200 && readListings().length === before);
  r = await postT('/api/admin/market/supply', { ...recipe, mode: 'gradual', batch: 2, intervalSeconds: 1 }, AT);
  check('Gradual plan waits before first batch', r.status === 200 && r.data.rule.created === 0);
  check('Gradual plan completes requested count', await waitFor(async () => { const r = await getT('/api/admin/market/supply', AT); return r.data.rule.created === 6 && !r.data.rule.enabled; }, { timeout: 7000 }));
  let listings = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'market.json'))).listings;
  check('Supply uses only selected sellers and material', listings.slice(-6).every(l => recipe.sellers.includes(l.seller) && l.id === DATA.MATERIALS[0].id));
  r = await postT('/api/admin/market/supply', { ...recipe, mode: 'restock', batch: 2, intervalSeconds: 1, threshold: 2, target: 4 }, AT);
  check('Restock plan starts', r.status === 200);
  check('Restock fills to target across batches', await waitFor(async () => (await getT('/api/admin/market/supply', AT)).data.rule.stock === 4, { timeout: 5000 }));
  const ruleId = r.data.rule.id;
  listings = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'market.json'))).listings.filter(l => l.supplyId === ruleId);
  for (const l of listings.slice(0,3)) await postT('/api/admin/market/return', { lid: l.lid }, AT);
  check('Low stock triggers replenishment', await waitFor(async () => (await getT('/api/admin/market/supply', AT)).data.rule.stock === 4, { timeout: 5000 }));
  await postT('/api/admin/market/supply', { action: 'pause' }, AT);
  check('Pause persists disabled state', !(await getT('/api/admin/market/supply', AT)).data.rule.enabled);

  const { chromium } = require('playwright-core');
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, extraHTTPHeaders: { Authorization: 'Bearer ' + AT } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(7000);
  const shots = path.join(ROOT, 'output/admin-editors'); fs.mkdirSync(shots, { recursive: true });
  await page.goto('http://127.0.0.1:' + PORT + '/admin.html');
  const client = await browser.newPage({viewport:{width:1440,height:900},extraHTTPHeaders:{Authorization:'Bearer ' + PT}});
  client.on('pageerror', e => errors.push('client: ' + e.message));
  client.setDefaultTimeout(7000);
  await client.goto('http://127.0.0.1:' + PORT + '/');
  await client.waitForFunction(() => window.Engine && Engine.state.featureOrder && Engine.state.featureOrder.menu);
  await page.locator('#nav button').filter({hasText:'功能开关'}).click();
  await page.locator('.feature-group').first().waitFor();
  check('Features follow saved menu order', await page.locator('.feature-group').first().getAttribute('data-order-group') === menu[0]);
  check('Features use one group per row', await page.locator('.feature-group').evaluateAll(nodes => nodes.every((n,i) => !i || n.getBoundingClientRect().top >= nodes[i-1].getBoundingClientRect().bottom)));
  await page.locator('[data-order-group="feedback"] .feat-drag').dragTo(page.locator('[data-order-group="' + menu[0] + '"]'));
  await page.locator('#features-save').click();
  await page.waitForFunction(() => document.querySelector('.feature-group')?.dataset.orderGroup === 'feedback');
  await client.waitForFunction(() => document.querySelector('#nav [data-feature]')?.dataset.feature === 'feedback');
  check('Connected client menu updates without reload', await client.locator('#nav [data-feature]').first().getAttribute('data-feature') === 'feedback');
  await page.locator('[data-child-id="feedback.skip"]').dragTo(page.locator('[data-child-id="feedback.submit"]'), {sourcePosition:{x:5,y:5},targetPosition:{x:5,y:5}});
  await page.locator('#features-save').click();
  await client.waitForFunction(() => Engine.state.featureOrder.feedback?.[0] === 'feedback.skip');
  check('Subfeature drag persists and broadcasts', (await getT('/api/admin/features', AT)).data.featureOrder.feedback[0] === 'feedback.skip');
  await client.evaluate(() => { UI.setView('feedback'); UI.renderView(); });
  await client.waitForFunction(() => document.querySelector('[data-order-feature="feedback.skip"]'));
  check('Client feedback sections use configured order', await client.locator('[data-order-feature^="feedback."]').first().getAttribute('data-order-feature') === 'feedback.skip');
  await postT('/api/admin/features', {featureOrder:{feedback:['feedback.submit','feedback.skip']}}, AT);
  await client.waitForFunction(() => document.querySelector('[data-order-feature^="feedback."]')?.dataset.orderFeature === 'feedback.submit');
  check('Client sections reorder on live changes', await client.locator('[data-order-feature^="feedback."]').first().getAttribute('data-order-feature') === 'feedback.submit');
  const workshop = F.groups.find(g => g.id === 'workshop').children.map(c => c.id).reverse();
  await postT('/api/admin/features', {featureOrder:{workshop}}, AT);
  await client.waitForFunction(() => Engine.state.featureOrder.workshop?.[0] === 'workshop.forge');
  await client.evaluate(() => { UI.setView('workshop'); UI.renderView(); });
  check('Client workshop tabs use configured order', await client.locator('[data-wstab]').first().getAttribute('data-wstab') === 'forge');
  await client.evaluate(async () => { await Net.fetchChest(); UI.renderView(); });
  await client.locator('[data-wstab="open"]').click();
  check('Client craft and open buttons use configured order', await client.locator('.cc-acts').first().locator('[data-feature]').first().getAttribute('data-feature') === 'workshop.open');
  check('Menu drag persists', (await getT('/api/admin/features', AT)).data.featureOrder.menu[0] === 'feedback');
  await page.screenshot({path:path.join(shots,'features.png')});
  await page.locator('#nav button').filter({hasText:'钓点管理'}).click();
  await page.locator('#gd-map').waitFor();
  check('Smart configuration removed', await page.locator('#ac-layout').count() === 0);
  check('Ground map is visible alongside spot list', await page.locator('#gd-map').evaluate(n => n.getBoundingClientRect().top < 300));
  check('Ground editor uses two columns', await page.locator('#gd-body').evaluate(n => getComputedStyle(n).gridTemplateColumns.split(' ').length === 2));
  await page.screenshot({path:path.join(shots,'grounds.png')});
  await page.locator('#nav button').filter({hasText:'市集管理'}).click();
  await page.locator('#bl-seller-add').click();
  check('Editable seller pool adds an account', await page.locator('[data-remove-seller]').count() === 1);
  await page.locator('#bl-part').selectOption(base.part);
  check('Component selector filters bases by part', await page.locator('#bl-p-component .bl-opt:not([hidden])').count() === DATA.COMPONENT_BASES.filter(b => b.part === base.part).length);
  await page.screenshot({path:path.join(shots,'market.png')});
  await page.locator('#nav button').filter({hasText:'鱼类体型'}).click();
  await page.locator('[data-fish-weight="4"]').fill('20');
  check('Numeric editor updates slider', await page.locator('[data-fish-range="4"]').inputValue() === '20');
  await page.locator('[data-fish-range="4"]').fill('30');
  check('Slider updates numeric editor', await page.locator('[data-fish-weight="4"]').inputValue() === '30');
  await page.locator('.fish-percent-preview').waitFor();
  check('Preview groups percentages into ten bins', await page.locator('.fish-percent-preview > span').count() === 10);
  await page.screenshot({path:path.join(shots,'fishsize.png')});
  await page.locator('#nav button').filter({hasText:'工坊'}).click();
  await page.locator('#ws-cfg-forgeAnyAffix').waitFor();
  check('Forge restriction reloads correctly in admin UI', !await page.locator('#ws-cfg-forgeAnyAffix').isChecked());
  check('Catalyst ratio reloads correctly in admin UI', await page.locator('#ws-cfg-catalystRatio').inputValue() === '50');
  check('No admin page errors', errors.length === 0, errors.join('; '));
  await browser.close(); browser = null;
  const restartRule = await postT('/api/admin/market/supply', {...recipe, mode:'gradual', batch:2, intervalSeconds:1}, AT);
  check('Restart fixture creates pending plan', restartRule.status === 200);
  const restartId = restartRule.data.rule.id;
  killTree(srv);
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: {...process.env, PORT:String(PORT), FISHING_DATA_DIR:TMP_DATA, FISHING_DEV:'1'} });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', {timeout:10000});
  const restartOtp = await provisionAdmin(srv, TMP_DATA, admUser);
  AT = (await post('/api/admin/login', {username:admUser,password:'loot-test-1234',otp:restartOtp})).data.token;
  check('Plan resumes after server restart', await waitFor(async () => (await getT('/api/admin/market/supply', AT)).data.rule.remaining === 0, {timeout:7000}));
  const restartedListings = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'market.json'))).listings.filter(l => l.supplyId === restartId);
  check('Restart does not duplicate supply', restartedListings.length === 6);
  check('Menu order survives restart', (await getT('/api/admin/features', AT)).data.featureOrder.menu[0] === 'feedback');
  const config = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'config.json')));
  check('Distribution and forge settings survive restart', config.fishCfg.sizeModel === 'custom' && config.fishCfg.sizeWeights[4] === 100 && config.smeltCfg.forgeAnyAffix === false);

  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
}
let browser;
main().catch(e => { fail++; console.error('TEST ERROR:', e); }).finally(async () => {
  if (browser) await browser.close();
  if (srv) killTree(srv);
  process.exitCode = fail ? 1 : 0;
});
