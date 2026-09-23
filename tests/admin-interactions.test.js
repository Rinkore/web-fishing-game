'use strict';
// DOM regression with controlled API responses; no server ports or screenshots.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

(async function () {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server-go/internal/rules/catalog.json'), 'utf8'));
    const componentWorld = {
      catalog: { components: catalog.items.filter(item => item.kind === 'component') },
      componentCfg: catalog.defaults.component,
    };
    let worldMode = 'ok', releaseWorld;
    let loginCalls = 0, feedbackReads = 0, statusCalls = 0;
    let releaseLogin;
    const loginGate = new Promise(resolve => { releaseLogin = resolve; });
    await page.route('http://admin.test/**', async route => {
      const url = new URL(route.request().url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/shop') return json({ crucian: { base: 1 } });
      if (url.pathname === '/api/admin/session') return json({ error: '未登录' }, 401);
      if (url.pathname === '/api/admin/login') {
        loginCalls++;
        assert.equal(route.request().postDataJSON().otp, '123456');
        await loginGate;
        return json({ token: 'cookie', username: 'admin', name: '管理员' });
      }
      if (url.pathname === '/api/admin/feedback') {
        feedbackReads++;
        return json({ feedback: [{ id: 'f1', kind: 'bug', text: '测试反馈', status: 'submitted', t: Date.now() }], statuses: { submitted: '已提交', accepted: '已受理', done: '已完成' }, cfg: { cdHours: 24, skipCost: 10000 } });
      }
      if (url.pathname === '/api/admin/feedback/status') {
        statusCalls++;
        return statusCalls === 1 ? json({ ok: true, status: 'accepted' }) : json({ error: '测试失败反馈' }, 400);
      }
      if (url.pathname === '/api/admin/world') {
        if (worldMode === 'error') return json({ error: '测试配置加载失败' }, 500);
        if (worldMode === 'delayed') await new Promise(resolve => { releaseWorld = resolve; });
        const world = structuredClone(componentWorld);
        if (worldMode === 'missing-pool') delete world.catalog.components[0].pool;
        return json(world);
      }
      if (url.pathname.startsWith('/api/')) return json({ error: '测试未启用' }, 400);
      const files = { '/admin.html': ['admin.html', 'text/html'], '/css/admin.css': ['css/admin.css', 'text/css'], '/js/data.js': ['js/data.js', 'text/javascript'], '/js/features.js': ['js/features.js', 'text/javascript'], '/js/admin.js': ['js/admin.js', 'text/javascript'] };
      const file = files[url.pathname];
      if (!file) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: file[1], body: fs.readFileSync(path.join(__dirname, '..', 'frontend', file[0])) });
    });
    await page.goto('http://admin.test/admin.html');
    await page.locator('#login-user').fill('admin');
    await page.locator('#login-pass').fill('password');
    await page.locator('#login-otp').fill('12345');
    assert.equal(loginCalls, 0);
    const loginRequest = page.waitForRequest('**/api/admin/login');
    await page.locator('#login-otp').fill('123456');
    await loginRequest;
    await page.locator('#login-otp').press('Enter');
    assert.equal(loginCalls, 1, 'six digits trigger one login; Enter while pending does not duplicate it');
    releaseLogin();
    await page.locator('.nav-item').filter({ hasText: '反馈' }).click();
    await page.locator('.fb-status-sel').waitFor();
    await page.evaluate(() => {
      window.originalFeedbackCard = document.querySelector('.fb-card');
      document.querySelector('.fb-rules').open = true;
      document.querySelector('#fbc-cd').value = '12';
    });
    await page.locator('.fb-status-sel').selectOption('accepted');
    await page.waitForFunction(() => document.querySelector('.fb-status').textContent === '已受理');
    assert.equal(feedbackReads, 1, 'status success does not reload feedback');
    assert.equal(await page.evaluate(() => window.originalFeedbackCard === document.querySelector('.fb-card') && document.querySelector('.fb-rules').open && document.querySelector('#fbc-cd').value === '12'), true);
    assert.equal(await page.locator('[data-fb-count="accepted"]').textContent(), '1');
    assert.equal(await page.locator('[data-fb-count="submitted"]').textContent(), '0');
    await page.locator('.fb-status-sel').selectOption('done');
    await page.waitForFunction(() => !document.querySelector('.fb-status-sel').disabled && document.querySelector('.fb-status-sel').value === 'accepted');
    assert.equal(await page.locator('.fb-status').textContent(), '已受理');
    assert.equal(feedbackReads, 1, 'failed status update also preserves the page');
    const componentNav = page.locator('.nav-item').filter({ hasText: '组件生成' });
    worldMode = 'error';
    await componentNav.click();
    await page.locator('#cmp-retry').waitFor();
    assert.equal(await page.locator('#comp-body').innerText().then(text => text.includes('加载失败')), true, 'initial failure replaces loading state');
    worldMode = 'ok';
    await page.locator('#cmp-retry').click();
    await page.locator('#cmp-save').waitFor();
    const base = componentWorld.catalog.components.find(item => item.pool.length);
    const affix = base.pool[0];
    assert.equal(await page.locator('input[data-bid="' + base.id + '"][data-t="' + affix.type + '"][data-i="0"]').inputValue(), String(affix.min), 'editor renders authoritative affix bounds');
    assert.equal(await page.locator('#qw-common').inputValue(), String(componentWorld.componentCfg.qualityWeights.common));
    worldMode = 'error';
    await componentNav.click();
    await page.locator('#cmp-retry').waitFor();
    assert.equal(await page.locator('#cmp-save').count(), 0, 'failed refresh must not expose stale cached settings for saving');
    worldMode = 'missing-pool';
    await page.locator('#cmp-retry').click();
    await page.locator('#cmp-retry').waitFor();
    assert.equal(await page.locator('#cmp-save').count(), 0, 'malformed config fails visibly rather than rendering incomplete settings');
    worldMode = 'ok';
    await page.locator('#cmp-retry').click();
    await page.locator('#cmp-save').waitFor();
    worldMode = 'delayed';
    const worldRequest = page.waitForRequest('**/api/admin/world*');
    await componentNav.click();
    await worldRequest;
    await page.locator('.nav-item').filter({ hasText: '反馈' }).click();
    await page.locator('.fb-status-sel').waitFor();
    const worldResponse = page.waitForResponse('**/api/admin/world*');
    releaseWorld();
    await worldResponse;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    assert.equal(await page.locator('#comp-body').count(), 0, 'late response does not overwrite another page');
    assert.deepEqual(pageErrors, [], 'no unhandled page exceptions');
    console.log('PASS admin interactions: login, feedback edits, component loading/retry, affix bounds, stale/malformed responses, navigation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
