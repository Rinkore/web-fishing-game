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
    let snapshotReads = 0, snapshotPayload, smeltPayload;
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
      if (url.pathname === '/api/admin/users') return json({ me: 'admin', users: [{ key: 'synthetic', username: 'synthetic', name: '合成账号', coins: snapshot.coins }] });
      if (url.pathname === '/api/admin/users/snapshot') {
        if (route.request().method() === 'GET') { snapshotReads++; return json(snapshot); }
        snapshotPayload = route.request().postDataJSON();
        snapshot.coins = 600; snapshot.invRev = '8';
        return json({ error: '资产已更新，请刷新后重试' }, 409);
      }
      if (url.pathname === '/api/admin/smelt/config') {
        smeltPayload = route.request().postDataJSON();
        return json({ ok: true, smeltCfg: smeltPayload });
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
    worldMode = 'ok';
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
    const workshopNav = page.locator('.nav-item').filter({ hasText: '工坊配置' });
    await workshopNav.click();
    await page.locator('#ws-cfg-save').click();
    await page.waitForFunction(() => document.querySelector('#ws-cfg-state').textContent.includes('已保存'));
    assert.equal(typeof smeltPayload.baseRate, 'number');
    assert.equal(typeof smeltPayload.recastGold, 'number');
    assert.equal(typeof smeltPayload.recastMinValue, 'boolean');
    assert.deepEqual(smeltPayload.catalystRanges, {});
    await workshopNav.click();
    await page.locator('#ws-cfg-save').waitFor();
    worldMode = 'error';
    await workshopNav.click();
    await page.locator('#world-retry').waitFor();
    assert.equal(await page.locator('#ws-cfg-save').count(), 0, 'shared loader hides cached config after a failed refresh');
    worldMode = 'ok';
    await page.locator('#world-retry').click();
    await page.locator('#ws-cfg-save').waitFor();
    assert.deepEqual(pageErrors, [], 'no unhandled page exceptions');
    console.log('PASS admin interactions: login, feedback, component and shared config loading/retry, snapshot tiers/conflict, workshop numeric payload');
    console.log('通过 30 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
