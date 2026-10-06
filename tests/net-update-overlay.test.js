'use strict';
// A healthy version endpoint must not turn a transient SSE reconnect into a
// full-screen maintenance page. Real draining still shows one after grace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

(async () => {
  let versionOnline = true;
  let ready = true;
  let readyChecks = 0;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://net.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      if (url.pathname === '/shop') return route.fulfill({ contentType: 'application/json', body: '{"crucian":{"base":1}}' });
      if (url.pathname === '/api/version') return route.fulfill({ status: versionOnline ? 200 : 503, contentType: 'application/json', body: versionOnline ? '{"version":"v0.31.5"}' : '{"error":"unavailable"}' });
      if (url.pathname === '/readyz') { readyChecks++; return route.fulfill({ status: ready ? 200 : 503, contentType: 'application/json', body: ready ? '{"status":"ready"}' : '{"status":"unavailable"}' }); }
      if (url.pathname === '/api/me') return route.fulfill({ contentType: 'application/json', body: '{}' });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://net.test/');
    await page.evaluate(() => {
      window.GameData = { VERSION: 'v0.31.5' };
      window.Engine = { state: { features: {}, me: null } };
      window.UI = { onConnChange() {}, toast() {} };
      window.APP_CONFIG = { API_BASE: '' };
      window.streams = [];
      window.EventSource = class {
        constructor() { this.readyState = 1; window.streams.push(this); }
        close() { this.readyState = 2; }
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../frontend/js/net.js'), 'utf8') });
    await page.evaluate(() => Net.setAuth('test-token', { username: 'tester', name: 'tester' }));

    // onerror confirms a stream interruption after four seconds; REST remains
    // healthy, so the HUD may say disconnected but the game must stay visible.
    await page.evaluate(() => streams[0].onerror());
    await page.waitForTimeout(4300);
    assert.equal(await page.locator('#server-update-page').count(), 0, 'brief SSE reconnect covered the game');
    assert.equal(await page.evaluate(() => Net.connState()), false);
    await page.evaluate(() => Net.probeServer());
    assert.equal(await page.evaluate(() => Net.connState()), true);

    versionOnline = false;
    await page.evaluate(() => Net.probeServer());
    await page.evaluate(() => Net.probeServer());
    assert.equal(await page.locator('#server-update-page').count(), 0, 'two brief version-probe failures covered the game');
    versionOnline = true;
    await page.evaluate(() => Net.probeServer());

    // An explicit maintenance event with an already-ready backend should be
    // cancelled before its grace timer can paint a page.
    await page.evaluate(() => streams[0].onmessage({ data: JSON.stringify({ type: 'maintenance', version: 'v0.31.5' }) }));
    assert.equal(await page.locator('#server-update-page').count(), 0);
    await page.evaluate(() => Net.probeServer());
    await page.waitForTimeout(8300);
    assert.equal(await page.locator('#server-update-page').count(), 0, 'recovered maintenance flashed after grace');
    assert.ok(readyChecks > 0, 'maintenance recovery did not check readiness');

    // During a real drain, /api/version can still be healthy. /readyz is the
    // recovery gate, and only a sustained interruption may cover the game.
    ready = false;
    await page.evaluate(() => streams[0].onmessage({ data: JSON.stringify({ type: 'maintenance', version: 'v0.31.5' }) }));
    await page.waitForTimeout(8400);
    assert.equal(await page.locator('#server-update-page').count(), 1, 'long maintenance did not show status');
    assert.equal(await page.locator('#server-update-page h1').innerText(), '服务器正在更新中');
    ready = true;
    await page.evaluate(() => Net.probeServer());
    assert.equal(await page.locator('#server-update-page').count(), 0, 'maintenance page did not clear after readiness');
    assert.deepEqual(errors, []);
    console.log('网络更新提示：短暂重连不闪屏，持续维护显示并恢复');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
