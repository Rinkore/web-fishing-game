'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { waitHttp } = require('./_util');
const { provisionAdmin } = require('./_admin');
const registration = require('./_registration');
const D = require('../frontend/js/data');
const ROOT = path.resolve(__dirname, '..'), PORT = 8285, BASE = 'http://127.0.0.1:' + PORT;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-v0200-ui-'));
const SHOTS = path.join(ROOT, 'output/v0200-preview');
let server, browser, count = 0;
function check(name, ok) { assert.ok(ok, name); count++; console.log('PASS ' + name); }
async function register(context, username, name) {
  const data = { username, name, password: 'v0200-test-1234', qq: '828500' };
  let r = await (await context.request.post(BASE + '/api/register', { data })).json();
  if (r.code === 'REGISTRATION_CHALLENGE') {
    const ch = await (await context.request.get(BASE + '/api/register/challenge')).json();
    r = await (await context.request.post(BASE + '/api/register', { data: { ...data, proof: registration.solve(ch) } })).json();
  }
  assert.ok(r.profile, JSON.stringify(r));
}
async function post(context, endpoint, data) {
  const r = await context.request.post(BASE + endpoint, { data });
  const body = await r.json();
  assert.ok(r.ok(), endpoint + ': ' + JSON.stringify(body));
  return body;
}
async function loginPage(context, username) {
  await post(context, '/api/login', { username, password: 'v0200-test-1234' });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => Engine.state.me && document.querySelector('#auth').style.display === 'none');
  return page;
}
(async () => {
  server = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FISHING_DATA_DIR: DIR, FISHING_DEV: '1' } });
  await waitHttp(BASE + '/api/version', { timeout: 20000 });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const opts = { viewport: { width: 1440, height: 960 }, extraHTTPHeaders: { 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' } };
  const context = await browser.newContext(opts), peer = await browser.newContext(opts);
  const errors = [];
  context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  await register(context, 'uiadmin', '同名玩家');
  await register(peer, 'uipeer', '同名玩家');
  const otp = await provisionAdmin(server, DIR, 'uiadmin');
  const admin = await context.newPage();
  await admin.goto(BASE + '/admin.html');
  await admin.fill('#login-user', 'uiadmin'); await admin.fill('#login-pass', 'v0200-test-1234'); await admin.fill('#login-otp', otp);
  await admin.locator('.nav-item').filter({ hasText: '钓点管理' }).click();
  await admin.locator('#lg-add').waitFor();
  check('后台正常登录并加载战利品组管理', true);
  await admin.fill('#lg-name', '浏览器测试组'); await admin.fill('#lg-weight', '7'); await admin.click('#lg-add');
  await admin.selectOption('#lge-rows [data-f=id]', D.FISH.common[0].id);
  await admin.fill('#lge-rows [data-f=weight]', '3'); await admin.click('#lge-add');
  await admin.selectOption('#lge-rows .pool-row:nth-child(2) [data-f=type]', 'material');
  await admin.selectOption('#lge-rows .pool-row:nth-child(2) [data-f=id]', D.MATERIALS[0].id);
  await admin.fill('#lge-rows .pool-row:nth-child(2) [data-f=weight]', '1');
  await admin.click('#lge-save');
  await admin.locator('#lg-list .lg-row').waitFor();
  check('通过界面创建包含两项独立权重的战利品组', (await admin.locator('#lg-list').textContent()).includes('2 项产出'));
  await admin.click('#pool-add');
  await admin.locator('#pool-rows .pool-row').last().locator('[data-f=type]').selectOption('group');
  const groupId = await admin.locator('#pool-rows .pool-row').last().locator('[data-f=id] option').last().getAttribute('value');
  await admin.locator('#pool-rows .pool-row').last().locator('[data-f=id]').selectOption(groupId);
  check('选择战利品组时自动使用默认权重', await admin.locator('#pool-rows .pool-row').last().locator('[data-f=weight]').inputValue() === '7');
  await admin.click('#pool-save');
  await admin.waitForFunction(() => document.querySelector('#pool-state').textContent.includes('总权重'));
  await admin.locator('[data-lge]').click(); await admin.fill('#lge-name', '已修改组'); await admin.click('#lge-save');
  await admin.waitForFunction(() => document.querySelector('#lg-list').textContent.includes('已修改组'));
  check('通过界面编辑并保存组名称', true);
  fs.mkdirSync(SHOTS, { recursive: true });
  await admin.locator('#lg-list').scrollIntoViewIfNeeded();
  await admin.screenshot({ animations: 'disabled', path: path.join(SHOTS, 'loot-groups.png') });

  const adminSession = await browser.newContext({ ...opts, storageState: await context.storageState() });
  await register(context, 'uiplayer', '同名玩家');
  const page = await loginPage(context, 'uiplayer');
  const other = await loginPage(peer, 'uipeer');
  const order = ['forge', 'recast', 'smelt', 'open', 'craft'].map(k => 'workshop.' + k);
  await post(adminSession, '/api/admin/features', { featureOrder: { workshop: order } });
  await page.waitForFunction(() => Engine.state.featureOrder?.workshop?.[0] === 'workshop.forge');
  await page.evaluate(() => { UI.setView('workshop'); UI.renderView(); });
  check('后台排序实时同步到玩家工坊页签', await page.locator('[data-wstab]').first().getAttribute('data-wstab') === 'forge');
  await page.reload();
  await page.waitForFunction(() => Engine.state.me && Engine.state.featureOrder?.workshop?.[0] === 'workshop.forge');
  await page.evaluate(() => { UI.setView('workshop'); UI.renderView(); });
  check('刷新后保留子功能顺序', await page.locator('[data-wstab]').first().getAttribute('data-wstab') === 'forge');
  const envelope = D.catalystEnvelopeOf('rod', 'speed');
  await post(adminSession, '/api/admin/smelt/config', { catalystRanges: D.catalystPreset() });
  const component = D.instanceId('rod_bamboo', 'epic', [{ type: 'size', value: 1 }]);
  await post(context, '/api/dev/seed', { inventory: { [component]: 1, tide_sand: 3 } });
  const forged = await post(context, '/api/workshop/forge', { id: component, materialId: 'tide_sand' });
  check('锻造添加催化词条并准确扣除物品', forged.item.affixes.length === 2 && forged.affix.src === 'ct' && forged.material.have === 2 && !forged.inventory[component] && forged.inventory[forged.id] === 1);
  check('催化预设保存后只收窄一次且中心不变', JSON.stringify([forged.affix.min, forged.affix.max]) === JSON.stringify(D.scaleCatalystRange(envelope)) && forged.affix.min + forged.affix.max === envelope[0] + envelope[1]);
  const duplicate = await context.request.post(BASE + '/api/workshop/forge', { data: { id: forged.id, materialId: 'tide_sand' } });
  check('拒绝重复催化词条', duplicate.status() === 400);
  const full = D.instanceId('rod_bamboo', 'common', [{ type: 'size', value: 1 }]);
  await post(context, '/api/dev/seed', { inventory: { [full]: 1, tide_sand: 3 } });
  const capped = await context.request.post(BASE + '/api/workshop/forge', { data: { id: full, materialId: 'tide_sand' } });
  check('词条达到品质上限时拒绝锻造', capped.status() === 400);
  const fish = D.FISH.common[0];
  for (const size of [11, 43]) await post(context, '/api/dev/catch', { item: { id: fish.id, size } });
  await post(peer, '/api/dev/catch', { item: { id: fish.id, size: 27 } });
  await page.evaluate(async () => { await Net.fetchRecords(); UI.setView('records'); UI.renderView(); });
  await page.locator('.record-cell').filter({ hasText: fish.name }).click();
  await page.locator('.top10-row.self').waitFor();
  check('鱼类详情同时显示个人最小和最大值', (await page.locator('.rec-personal').textContent()).includes('11 cm') && (await page.locator('.rec-personal').textContent()).includes('43 cm'));
  check('同名玩家只高亮自己的条目', await page.locator('.top10-row').count() === 2 && await page.locator('.top10-row.self').count() === 1 && (await page.locator('.top10-row.self .top10-size').textContent()).includes('43'));
  check('自己上榜显示金色边框', await page.locator('.top10-row.self').evaluate(e => getComputedStyle(e).boxShadow.includes('231, 189, 88')));
  await page.screenshot({ animations: 'disabled', path: path.join(SHOTS, 'fish-records.png') });
  for (const range of ['周榜', '总榜']) {
    await page.locator('#rt-range button').filter({ hasText: range }).click();
    await page.locator('.top10-row.self').waitFor();
    check(range + '保留本人高亮', await page.locator('.top10-row.self').count() === 1);
  }
  await page.locator('#rt-kind button').filter({ hasText: '最小' }).click();
  await page.waitForFunction(() => document.querySelector('.top10-row.self .top10-size')?.textContent.includes('11'));
  check('最小榜高亮个人最小纪录', true);
  await page.locator('.modal-close').click();
  await page.locator('.record-cell').filter({ hasText: D.FISH.common[1].name }).click();
  await page.locator('.rec-personal').waitFor();
  check('未捕获鱼类显示暂无纪录', (await page.locator('.rec-personal').textContent()).match(/暂无纪录/g).length === 2);
  await page.locator('.modal-close').click();

  await post(peer, '/api/dev/seed', { sea: { charts: 0, zones: [{ id: 'ztest', name: '风暴湾', mood: 'normal', expire: Date.now() + 600000, spots: [{ id: 'z1', name: '不应显示的子钓点', pool: [{ pick: 'fish:' + fish.id, weight: 1 }], buffs: [] }] }] } });
  await post(peer, '/api/fishing/start', { groundId: 'sea:uipeer:ztest', spotId: 'z1' });
  await page.evaluate(() => { UI.setView('ground'); UI.renderView(); });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.peep-loc')).some(e => e.textContent === '风暴湾'));
  check('社交可显示他人私有远洋位置且不含子钓点', !(await page.locator('.peep-loc').allTextContents()).some(t => t.includes('不应显示')));
  await page.screenshot({ animations: 'disabled', path: path.join(SHOTS, 'social-location.png') });
  await post(peer, '/api/fishing/start', { groundId: 'map', spotId: 'shore' });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.peep-loc')).some(e => e.textContent === '近海渔场'));
  check('固定远洋钓点只显示钓点名称', true);
  await post(peer, '/api/fishing/stop', {});
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.peep-loc')).every(e => e.textContent === '未出发'));
  check('收竿后清除旧位置', true);
  await page.click('#settings-btn');
  await page.screenshot({ animations: 'disabled', path: path.join(SHOTS, 'settings.png') });
  check('无页面脚本错误', errors.length === 0);
  await other.close();
  console.log('通过 ' + count + ' 项，失败 0 项');
})().catch(e => { console.error(e); console.log('通过 ' + count + ' 项，失败 1 项'); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
});
