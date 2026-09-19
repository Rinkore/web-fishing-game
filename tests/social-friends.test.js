'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { waitHttp } = require('./_util');
const registration = require('./_registration');
const D = require('../frontend/js/data');
const ROOT = path.resolve(__dirname, '..'), PORT = 8294, BASE = 'http://127.0.0.1:' + PORT;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-social-'));
let server, browser, count = 0;
function check(name, ok) { assert.ok(ok, name); count++; console.log('PASS ' + name); }
async function post(context, endpoint, data) {
  const response = await context.request.post(BASE + endpoint, { data });
  const body = await response.json();
  assert.ok(response.ok(), endpoint + ': ' + JSON.stringify(body));
  return body;
}
async function register(context, username, name) {
  const data = { username, name, password: 'social-test-1234', qq: '829400' };
  let r = await post(context, '/api/register', data);
  if (r.code === 'REGISTRATION_CHALLENGE') {
    const ch = await (await context.request.get(BASE + '/api/register/challenge')).json();
    r = await post(context, '/api/register', { ...data, proof: registration.solve(ch) });
  }
  assert.ok(r.profile, JSON.stringify(r));
  await post(context, '/api/login', { username, password: 'social-test-1234' });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => Engine.state.me && document.querySelector('#auth').style.display === 'none');
  return page;
}
(async () => {
  server = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FISHING_DATA_DIR: DIR, FISHING_DEV: '1' } });
  server.stdout.resume(); server.stderr.resume();
  await waitHttp(BASE + '/api/version', { timeout: 20000 });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const opts = { viewport: { width: 1200, height: 900 }, extraHTTPHeaders: { 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' } };
  const context = await browser.newContext(opts), peer = await browser.newContext(opts), guest = await browser.newContext(opts);
  const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  const page = await register(context, 'socialowner', '测试甲');
  const other = await register(peer, 'socialpeer', '测试乙');
  check('未登录不能查询好友', (await guest.request.get(BASE + '/api/friends')).status() === 401);
  check('未登录不能添加好友', (await guest.request.post(BASE + '/api/friends', { data: { target: 'socialpeer', action: 'add' } })).status() === 401);
  check('不能添加自己', (await context.request.post(BASE + '/api/friends', { data: { target: 'socialowner', action: 'add' } })).status() === 400);
  check('不存在的玩家被拒绝', (await context.request.post(BASE + '/api/friends', { data: { target: '__proto__', action: 'add' } })).status() === 404);
  await page.evaluate(() => { UI.setView('ground'); UI.renderView(); });
  await page.getByRole('button', { name: '👥 好友', exact: true }).click();
  await page.locator('.friends-panel .peep').waitFor();
  await page.fill('.friend-search-input', '测试乙');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.friends-panel .peep').length === 1);
  check('好友搜索结果仅显示添加按钮', await page.locator('.friends-panel .peep button').count() === 1 && await page.getByRole('button', { name: '添加好友', exact: true }).count() === 1);
  check('好友搜索不显示交易/查看', await page.locator('.friends-panel').getByRole('button', { name: /交易|查看/ }).count() === 0);
  await page.getByRole('button', { name: '添加好友', exact: true }).click();
  await page.getByRole('button', { name: '移除好友', exact: true }).waitFor();
  check('添加后同时更新好友列表和搜索按钮', await page.getByRole('button', { name: '已添加', exact: true }).isDisabled());
  await post(context, '/api/friends', { target: 'socialpeer', action: 'add' });
  check('重复添加不会重复记录', (await (await context.request.get(BASE + '/api/friends')).json()).friends.length === 1);
  check('自己的好友列表不改变对方列表', (await (await peer.request.get(BASE + '/api/friends')).json()).friends.length === 0);
  await page.reload(); await page.waitForFunction(() => Engine.state.me);
  await page.evaluate(() => { UI.setView('ground'); UI.renderView(); });
  await page.getByRole('button', { name: '👥 好友', exact: true }).click();
  await page.getByRole('button', { name: '移除好友', exact: true }).waitFor();
  check('刷新后保留好友', true);
  await post(peer, '/api/logout', {});
  await page.evaluate(() => UI.renderView());
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.friends-panel').textContent.includes('离线'));
  check('离线好友仍保留且显示离线状态', await page.getByRole('button', { name: '移除好友', exact: true }).count() === 1);
  await page.getByRole('button', { name: '移除好友', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.friends-panel').textContent.includes('还没有好友'));
  check('可以移除离线好友', (await (await context.request.get(BASE + '/api/friends')).json()).friends.length === 0);
  check('不能添加已经离线的玩家', (await context.request.post(BASE + '/api/friends', { data: { target: 'socialpeer', action: 'add' } })).status() === 400);
  await post(peer, '/api/login', { username: 'socialpeer', password: 'social-test-1234' });
  await other.reload(); await other.waitForFunction(() => Engine.state.me && Net.connState());
  const ground = D.GROUNDS.find(g => !g.locked && g.spots.some(s => !s.locked && !s.minShip));
  const spot = ground.spots.find(s => !s.locked && !s.minShip);
  await post(peer, '/api/fishing/start', { groundId: ground.id, spotId: spot.id });
  await page.getByRole('button', { name: '🌊 在线动态', exact: true }).click();
  const key = ground.id + ':' + spot.id;
  await page.waitForFunction(key => Engine.state.spotCounts[key] === 1, key);
  await page.evaluate(key => {
    window.socialCountSamples = [];
    window.socialCountTimer = setInterval(() => window.socialCountSamples.push(Engine.state.spotCounts[key] || 0), 50);
    Net.setPlayersView({ page: 1, size: 20 });
  }, key);
  await page.waitForFunction(() => window.socialCountSamples.length >= 48);
  check('presence 周期刷新不会把有人钓点清零', await page.evaluate(() => { clearInterval(window.socialCountTimer); return window.socialCountSamples.every(n => n === 1); }));
  await post(peer, '/api/fishing/stop', {});
  await page.waitForFunction(key => !Engine.state.spotCounts[key], key);
  check('玩家离开后钓点人数正常归零', true);
  check('浏览器无未捕获错误', errors.length === 0);
  console.log('通过 ' + count + ' 项，失败 0 项');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' }); } catch (_) {} }
});
