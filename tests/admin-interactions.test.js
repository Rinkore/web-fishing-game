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
    console.log('PASS admin interactions: six-digit login, duplicate guard, in-place feedback status/counts/draft, failure rollback');
    console.log('通过 9 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
