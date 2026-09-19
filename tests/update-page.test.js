'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { waitHttp } = require('./_util');
const registration = require('./_registration');
const D = require('../frontend/js/data');
const ROOT = path.resolve(__dirname, '..'), PORT = 8297, BASE = 'http://127.0.0.1:' + PORT;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-update-page-'));
let server, browser, count = 0;
function check(name, ok) { assert.ok(ok, name); count++; console.log('PASS ' + name); }
async function start() {
  server = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FISHING_DATA_DIR: DIR }, stdio: ['pipe', 'ignore', 'ignore'] });
  assert.ok(await waitHttp(BASE + '/api/version', { timeout: 20000 }), 'server ready');
}
async function stop() {
  const exit = new Promise(resolve => server.once('exit', resolve));
  server.stdin.write('q\n');
  await exit;
}
(async () => {
  await start();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' } });
  const data = { username: 'updatetest', name: '更新测试', password: 'update-test-1234', qq: '829700' };
  let result = await (await context.request.post(BASE + '/api/register', { data })).json();
  if (result.code === 'REGISTRATION_CHALLENGE') {
    const ch = await (await context.request.get(BASE + '/api/register/challenge')).json();
    result = await (await context.request.post(BASE + '/api/register', { data: { ...data, proof: registration.solve(ch) } })).json();
  }
  assert.ok(result.profile, JSON.stringify(result));
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => Engine.state.me && Engine.state.me.token);
  // Wait for the initial SSE snapshot, not just the login response.
  await page.waitForFunction(() => Engine.state.onlineTotal > 0);
  await stop();
  await page.locator('#server-update-page').waitFor({ state: 'visible', timeout: 8000 });
  check('正常停服显示更新页和当前版本', (await page.locator('#server-update-page').textContent()).includes(D.VERSION));
  check('更新页覆盖游戏操作', await page.locator('#server-update-page').evaluate(el => getComputedStyle(el).position === 'fixed'));
  await start();
  await page.locator('#server-update-page').waitFor({ state: 'detached', timeout: 20000 });
  check('服务器恢复后自动返回游戏并保留登录', await page.evaluate(() => !!Engine.state.me.token));
  // An already loaded login page also recovers when its initial version probe fails.
  await context.clearCookies();
  await page.reload();
  await page.waitForFunction(() => !!window.Net);
  await stop();
  await page.evaluate(() => Net.guardVersion());
  check('登录前版本请求失败也显示更新页', await page.locator('#server-update-page').count() === 1);
  await start();
  await page.locator('#server-update-page').waitFor({ state: 'detached', timeout: 20000 });
  check('登录前更新页可自动恢复', true);
  console.log('通过 ' + count + ' 项，失败 0 项');
})().catch(e => { console.error(e); console.log('通过 ' + count + ' 项，失败 1 项'); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close();
    if (server && server.exitCode === null) await stop();
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
