'use strict';
// Run via TestIntegrationLegacyBrowserConfigBannerParty; stdin contains only
// synthetic fixture credentials. Nothing is sent to an existing game server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

(async () => {
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const adminContext = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
    const playerContext = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
    await adminContext.addCookies([{ name: 'fish_admin', value: fixture.adminToken, url: fixture.url, httpOnly: true }]);
    await playerContext.addCookies([{ name: 'fish_game', value: fixture.playerToken, url: fixture.url, httpOnly: true }]);
    const admin = await adminContext.newPage();
    const player = await playerContext.newPage();
    admin.setDefaultTimeout(15000);
    player.setDefaultTimeout(15000);
    const errors = [];
    admin.on('pageerror', e => errors.push('admin: ' + e.message));
    player.on('pageerror', e => errors.push('player: ' + e.message));
    await Promise.all([admin.goto(fixture.url + '/admin.html'), player.goto(fixture.url + '/')]);
    await player.waitForFunction(() => window.Net && Net.getMe() && Net.getMe().id === 'console_target');
    await admin.locator('.nav-item').filter({ hasText: '横幅管理' }).click();
    await admin.locator('#bn-content').fill('Go 浏览器公告验证');
    await admin.locator('#bn-dur').fill('60');
    const published = admin.waitForResponse(r => r.url().endsWith('/api/admin/banner/add') && r.request().method() === 'POST');
    await admin.locator('#bn-add').click();
    const publication = await (await published).json();
    assert.equal(publication.ok, true, 'old console publishes against real Go endpoint');
    await player.waitForFunction(() => (Engine.state.banners || []).some(b => b.content === 'Go 浏览器公告验证'));
    await player.locator('#notice-banner.show').waitFor();
    await admin.locator('#bn-list [data-stop2]').first().click();
    await player.waitForFunction(() => !document.querySelector('#notice-banner').classList.contains('show'));
    await admin.locator('#bn-blink + .sl').click();
    await admin.locator('#bn-blink-title').fill('Go 测试闪烁');
    await admin.locator('#bn-cfg-save').click();
    await player.waitForFunction(() => Engine.state.bannerCfg && Engine.state.bannerCfg.blink && Engine.state.bannerCfg.blinkTitle === 'Go 测试闪烁');

    // Publish the actual immutable catalog and verify that the existing
    // browser's previews and cast settings refresh without a reload.
    const before = await (await adminContext.request.get(fixture.url + '/api/admin/v1/catalog')).json();
    before.catalog.runtime = { ...(before.catalog.runtime || {}), cast: { baseMs: 4500, minMs: 900, speedBonus: 25 } };
    const changed = await adminContext.request.post(fixture.url + '/api/admin/v1/catalog', {
      headers: { Origin: fixture.url, 'X-Requested-With': 'FishGame' },
      data: { requestKey: 'browser-catalog', expectedRevision: before.revision, catalog: before.catalog },
    });
    assert.equal(changed.status(), 200, 'catalog publication status');
    await player.waitForFunction(() => Engine.state.castCfg && Engine.state.castCfg.baseMs === 4500 && Engine.state.castCfg.speedBonus === 25);
    const featureResponse = await adminContext.request.post(fixture.url + '/api/admin/v1/features', {
      headers: { Origin: fixture.url, 'X-Requested-With': 'FishGame' },
      data: { requestKey: 'browser-features', expectedRevision: '0', flags: {
        market: false, trade: true, workshop: true, chest: true, mall: true, sell: true, autosell: true, friends: true,
      } },
    });
    assert.equal(featureResponse.status(), 200, 'feature publication status');
    await player.waitForFunction(() => Engine.state.features['mall.list'] === false && Engine.state.features['mall.marketbuy'] === false);
    assert.equal(await player.evaluate(() => GameFeatures.blocked(Engine.state.features, 'mall.buy')), null);

    await admin.locator('.nav-item').filter({ hasText: '编队管理' }).click();
    const disband = admin.locator('[data-pid]').first();
    await disband.waitFor();
    const removed = admin.waitForResponse(r => r.url().endsWith('/api/admin/party/disband') && r.request().method() === 'POST');
    await disband.click();
    assert.equal((await (await removed).json()).ok, true, 'old console disbands real party');
    await admin.waitForFunction(() => !document.querySelector('[data-pid]'));
    const party = await player.evaluate(async () => (await Net.partyFetch()).data);
    assert.equal(party.party, null);

    // The fourth registration from this source exercises the unchanged
    // browser proof worker and the actual registration form, without cookies.
    const newContext = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
    const newcomer = await newContext.newPage();
    newcomer.on('pageerror', e => errors.push('new player: ' + e.message));
    await newcomer.goto(fixture.url + '/');
    await newcomer.locator('#tab-register').click();
    await newcomer.locator('#auth-user').fill('browser_new_player');
    await newcomer.locator('#auth-pass').fill('Synthetic-browser-Pass42');
    await newcomer.locator('#auth-pass2').fill('Synthetic-browser-Pass42');
    await newcomer.locator('#auth-qq').fill('123456');
    const proofRound = newcomer.waitForResponse(r => r.url().endsWith('/api/register/challenge'));
    await newcomer.locator('#auth-submit').click();
    assert.equal((await proofRound).status(), 200, 'real proof challenge issued');
    await newcomer.waitForFunction(() => Net.getMe() && Net.getMe().id === 'browser_new_player', null, { timeout: 95000 });
    assert.equal(await newcomer.evaluate(() => Engine.state.player.coins), 500);
    await newcomer.evaluate(() => Net.logout());
    await newcomer.reload();
    await newcomer.locator('#auth-user').fill('browser_new_player');
    await newcomer.locator('#auth-pass').fill('Synthetic-browser-Pass42');
    await newcomer.locator('#auth-submit').click();
    await newcomer.waitForFunction(() => Net.getMe() && Net.getMe().id === 'browser_new_player');
    assert.equal(await newcomer.evaluate(() => Engine.state.player.coins), 500);
    await newContext.close();
    assert.deepEqual(errors, [], 'no browser script exceptions');
    console.log('Browser passed: real legacy console banner/config/party flows, player SSE and registration proof worker.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
