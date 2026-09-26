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
      smeltCfg: catalog.defaults.smelt,
      smeltDefaults: catalog.defaults.smelt,
      snapshotCfg: { enabled: false, intervalMin: 7, keep: 3 },
      notifyLevel: 'all',
      notifyLevels: { all: '全部渔获', uncommon: '大鱼、稀有鱼与组件', offrange: '超出基准体型', records: '破纪录', none: '关闭全服渔获动态' },
    };
    let worldMode = 'ok', releaseWorld;
    let loginCalls = 0, feedbackReads = 0, statusCalls = 0;
    let snapshotReads = 0, snapshotPayload, totpPayload;
    const snapshot = { name: '合成账号', coins: 500, invRev: '7', inventory: { crucian: 6 }, inventoryTiers: { crucian: { normal: 1, large: 2, giant: 3 } }, bd: {} };
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
      if (url.pathname === '/api/admin/users') return json({ me: 'admin', users: [
        { key: 'synthetic', username: 'synthetic', name: '合成账号', coins: snapshot.coins },
        { key: 'keeper', username: 'keeper', name: '另一位管理员', coins: 10, admin: true },
      ] });
      if (url.pathname === '/api/admin/users/totp') {
        totpPayload = route.request().postDataJSON();
        return json({ ok: true, target: 'keeper', secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/%E9%92%93%E9%B1%BC%E7%BD%91%E7%AB%99:keeper?secret=JBSWY3DPEHPK3PXP' });
      }
      if (url.pathname === '/api/admin/users/snapshot') {
        if (route.request().method() === 'GET') { snapshotReads++; return json(snapshot); }
        snapshotPayload = route.request().postDataJSON();
        snapshot.coins = 600; snapshot.invRev = '8';
        return json({ error: '资产已更新，请刷新后重试' }, 409);
      }
      if (url.pathname === '/api/admin/gear') return json({ config: catalog.constants.GEAR_SYSTEM, revision: 1, items: catalog.items });
      if (url.pathname === '/api/admin/house') return json({ config: catalog.constants.HUT, revision: 3, invariants: [{ name: '等级曲线单调不减', ok: true, detail: 'Lv1→Lv10' }] });
      if (url.pathname.startsWith('/api/')) return json({ error: '测试未启用' }, 400);
      const files = { '/admin.html': ['admin.html', 'text/html'], '/css/admin.css': ['css/admin.css', 'text/css'], '/js/data.js': ['js/data.js', 'text/javascript'], '/js/features.js': ['js/features.js', 'text/javascript'], '/js/gear.js': ['js/gear.js', 'text/javascript'], '/js/admin-edit.js': ['js/admin-edit.js', 'text/javascript'], '/js/admin-pool-import.js': ['js/admin-pool-import.js', 'text/javascript'], '/js/admin-gear.js': ['js/admin-gear.js', 'text/javascript'], '/js/admin-house.js': ['js/admin-house.js', 'text/javascript'], '/js/admin.js': ['js/admin.js', 'text/javascript'] };
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
    await page.locator('.nav-item').filter({ hasText: '装备与套装' }).click();
    await page.locator('[data-config]').waitFor();
    assert.equal(await page.locator('.gear-system').count(), 1, 'equipment administration page renders authoritative config');
    await page.locator('.nav-item').filter({ hasText: '渔屋配置' }).click();
    await page.locator('.house-admin [data-config]').waitFor();
    assert.equal(await page.locator('.house-admin [data-path^="levels."]').count(), 10, 'fish house page renders the ten level rates from the authoritative config');
    assert.equal(await page.locator('.house-admin [data-invariants] .tag').count(), 1, 'fish house invariants render');
    assert.equal(await page.locator('.house-admin [data-path="capacityHours"]').inputValue(), '8', 'capacity renders the published value');
    assert.equal(await page.locator('.house-admin form :invalid').count(), 0, 'the published fish house config is always submittable (no step/min mismatch)');
    await page.locator('.nav-item').filter({ hasText: '通知等级' }).click();
    await page.locator('#nt-save').waitFor();
    assert.equal(await page.locator('input[name=ntlv]').count(), 5, 'notification levels render');
    assert.equal(await page.locator('input[name=ntlv]:checked').inputValue(), 'all', 'notification default renders selected');
    await page.locator('.nav-item').filter({ hasText: '账号管理' }).click();
    await page.locator('[data-snap="synthetic"]').click();
    await page.locator('#snap-save').waitFor();
    assert.equal(await page.locator('[data-inv="crucian"][data-tier="giant"]').inputValue(), '3');
    await page.locator('[data-inv="crucian"][data-tier="large"]').fill('4');
    await page.locator('#snap-add-id').selectOption('relic');
    await page.locator('#snap-add').click();
    assert.equal(await page.locator('[data-inv="crucian"][data-tier="large"]').inputValue(), '4', 'adding a row preserves edited tiers');
    await page.locator('#snap-save').click();
    await page.waitForFunction(() => document.querySelector('#snap-coins')?.value === '600');
    assert.equal(snapshotPayload.expectedInvRev, '7');
    assert.deepEqual(snapshotPayload.inventoryTiers.crucian, { normal: 1, large: 4, giant: 3 });
    assert.equal(snapshotPayload.inventory.crucian, 8);
    assert.equal(snapshotReads, 2, 'conflict reloads the editor instead of overwriting new assets');
    await page.locator('.cf-no').click();
    // 验证器：按钮只挂在管理员行；二次确认后才请求，密钥弹窗展示一次性 Base32 与 otpauth 链接
    assert.equal(await page.locator('[data-totp]').count(), 1, 'only the authorized administrator row offers enrollment');
    await page.locator('[data-totp="keeper"]').click();
    await page.locator('.cf-yes').click();
    await page.locator('#totp-secret').waitFor();
    // 会话走 cookie：apiOnce 会把 body 里的 token 去掉，只留业务字段
    assert.deepEqual(totpPayload, { target: 'keeper', confirm: true });
    assert.equal(await page.locator('#totp-secret').inputValue(), 'JBSWY3DPEHPK3PXP');
    assert.equal((await page.locator('#totp-url').inputValue()).startsWith('otpauth://totp/'), true, 'enrollment returns the otpauth link');
    await page.locator('#totp-copy').click();
    await page.waitForFunction(() => document.querySelector('#totp-tip').textContent.includes('复制'));
    await page.locator('.cf-x').click();
    assert.equal(await page.locator('#totp-secret').count(), 0, 'closing the dialog drops the one-time secret');
    assert.deepEqual(pageErrors, [], 'no unhandled page exceptions');
    console.log('PASS admin interactions: login, feedback, gear config, fish house config, snapshot tiers/conflict, admin TOTP enrollment');
    console.log('通过 32 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
