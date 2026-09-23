'use strict';
// Real browser interactions against the shipped UI, without player accounts or backend writes.
const { chromium } = require('playwright-core');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let pass = 0;
  function check(value, label) { assert.equal(value, true, label); pass++; }
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 940 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const root = path.join(__dirname, '../frontend');
    await page.route('http://fishing.test/**', route => {
      const name = new URL(route.request().url()).pathname;
      if (name === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '') });
      const file = path.join(root, name);
      return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://fishing.test/');
    for (const file of ['data', 'features', 'engine', 'voyage-map', 'ui']) await page.addScriptTag({ path: path.join(root, 'js', file + '.js') });
    await page.evaluate(() => {
      document.querySelector('#auth').style.display = 'none';
      window.Net = {
        fishingStart: () => Promise.resolve({ ok: true, data: { interval: 8000, castInfo: { baseMs: 10000, interval: 8000, biteRate: 80 } } }),
        fishingStop: () => {},
      };
      UI.setView('fishing'); UI.renderNav(); UI.renderTopbar(); UI.renderView();
    });
    await page.evaluate(() => document.fonts.ready);
    const overlay = page.locator('#fishing-overlay');
    check(!await overlay.isVisible(), 'overlay starts closed');
    await page.locator('[data-overlay="buffs"]').click();
    check(await page.locator('.live-buff-row').count() === 0, 'spots without buffs are omitted');
    check((await page.locator('.live-buffs').innerText()).includes('暂无钓点增益'), 'empty buff menu explains its empty state');
    await page.evaluate(() => {
      GameData.GROUNDS.find(g => g.id === 'map').spots.find(s => s.id === 'dock').buffs = [{ type: 'speed', value: 20 }];
      UI.onFishingTick();
    });
    check(await page.locator('.live-buff-row').count() === 1, 'new buff appears after live refresh');
    check((await page.locator('.live-buff-row').innerText()).includes('湖畔老码头'), 'only the buffed spot is shown');
    check((await page.locator('.live-buff-count').innerText()) === '1 个增益钓点', 'count matches filtered spots');
    await page.evaluate(() => {
      GameData.GROUNDS.find(g => g.id === 'map').spots.find(s => s.id === 'dock').buffs = [];
      UI.onFishingTick();
    });
    check(await page.locator('.live-buff-row').count() === 0, 'expired buff disappears after live refresh');
    check((await page.locator('.live-buff-count').innerText()) === '0 个增益钓点', 'expired buff count updates');
    await page.locator('[data-overlay="buffs"]').click();
    for (const key of ['buffs', 'players', 'log']) {
      const button = page.locator('[data-overlay="' + key + '"]');
      await button.click();
      check(await overlay.isVisible(), key + ' opens');
      await button.click();
      check(!await overlay.isVisible(), key + ' closes on second click');
    }
    await page.locator('[data-overlay="buffs"]').click();
    await page.locator('[data-overlay="log"]').click();
    check(await page.locator('.fishing-stage .live-block:visible').count() === 1, 'switches display exactly one section');
    await page.keyboard.press('Escape');
    check(!await overlay.isVisible(), 'Escape closes panel');
    check(await page.locator('[data-overlay="log"]').evaluate(e => e === document.activeElement), 'closing restores trigger focus');
    // Map click still reaches original start/stop flow behind the overlay controls.
    await page.locator('.px-node[data-s="dock"] .pn-name').click();
    await page.waitForFunction(() => Engine.state.fishing.active && Engine.state.castInfo);
    check((await page.locator('.fish-state').innerText()).includes('360 次/时'), 'server interval and bite rate produce expected hourly hook count');
    await page.locator('[data-overlay="log"]').click();
    await page.evaluate(() => { window.originalMap = document.querySelector('.px-map'); });
    await page.locator('.fishing-dock-toggle').click();
    check(await page.locator('.fishing-dock-content').evaluate(e => e.inert), 'collapsed controls are not focusable');
    check(await page.locator('.fishing-dock').evaluate(e => e.getBoundingClientRect().left >= document.querySelector('.fishing-stage').getBoundingClientRect().right - 1), 'entire dock leaves viewport');
    check((await page.locator('.fishing-dock-toggle').innerText()) === '‹', 'collapsed control is icon only');
    await page.evaluate(() => {
      Engine.state.log.unshift({ t: Date.now(), item: { name: '测试鲫鱼', size: 27, rarity: 'common' } });
      UI.onFishingTick();
    });
    check(await page.locator('.px-map').evaluate(e => e === window.originalMap), 'catch update preserves map identity');
    check(await page.locator('.fishing-dock').evaluate(e => e.classList.contains('collapsed')), 'catch update keeps dock collapsed');
    await page.locator('.fishing-dock-toggle').click();
    check((await page.locator('.catch-log').innerText()).includes('测试鲫鱼'), 'reopening restores selected log with new catch');
    await page.locator('.fishing-overlay-close').click();
    await page.locator('.px-node[data-s="dock"] .pn-name').click();
    check(await page.evaluate(() => !Engine.state.fishing.active), 'same spot stops fishing');
    check((await page.locator('.fish-metric').last().innerText()).includes('—'), 'idle status does not show stale estimates');
    // Closed sidebar state survives map rebuilds, including the procedural voyage map.
    await page.locator('.fishing-dock-toggle').click();
    await page.locator('.fishing-toolbar').getByRole('button', { name: '⛵ 远洋', exact: true }).click();
    check(await page.locator('.vm-art').count() === 1, 'voyage map renders');
    check(await page.locator('.fishing-dock').evaluate(e => e.classList.contains('collapsed')), 'map switch preserves dock state');
    await page.getByRole('button', { name: '🏞 近岸', exact: true }).click();
    await page.locator('.fishing-dock-toggle').click();
    // Responsive containment, footer sizing and overlay scrolling.
    for (const [width, height] of [[1600, 940], [1280, 720], [880, 700], [640, 700], [390, 844], [320, 700]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('[data-overlay="buffs"]').click();
      const metrics = await page.evaluate(() => {
        const stage = document.querySelector('.fishing-stage').getBoundingClientRect();
        const map = document.querySelector('.px-map').getBoundingClientRect();
        const legend = document.querySelector('.px-legend').getBoundingClientRect();
        const status = document.querySelector('.fish-state').getBoundingClientRect();
        const panel = document.querySelector('.fish-live').getBoundingClientRect();
        return {
          ratio: Math.abs(map.width / map.height - 1.6) < .001,
          fit: map.width <= stage.width + 1 && map.height <= stage.height + 1,
          fill: Math.abs(map.width - stage.width) < 1 || Math.abs(map.height - stage.height) < 1,
          footer: legend.height === status.height,
          panel: panel.left >= stage.left && panel.right <= stage.right + 1 && panel.bottom <= legend.top + 1,
          overflow: document.querySelector('#main').scrollWidth <= document.querySelector('#main').clientWidth + 1,
        };
      });
      for (const [key, value] of Object.entries(metrics)) check(value, width + ' ' + key);
      await page.locator('[data-overlay="buffs"]').click();
    }
    // Leaving the page removes its layout mode and disposes its resize observer.
    await page.evaluate(() => { UI.setView('logs'); UI.renderView(); });
    check(!await page.locator('#main').evaluate(e => e.classList.contains('fishing-page')), 'other views retain original layout');
    await page.setViewportSize({ width: 1600, height: 940 });
    await page.evaluate(() => { UI.setView('fishing'); UI.renderView(); });
    await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(await page.locator('.fishing-stage').evaluate(e => Math.abs(e.getBoundingClientRect().bottom - innerHeight) < 2), 'font scaling keeps stage within viewport');
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    await page.locator('.px-node[data-s="dock"] .pn-name').click();
    await page.locator('[data-overlay="buffs"]').click();
    if (process.env.FISHING_SCREENSHOT_DIR) {
      await page.locator('#toast').evaluate(e => e.style.display = 'none');
      await page.screenshot({ path: path.join(process.env.FISHING_SCREENSHOT_DIR, 'fishing-overlay-desktop.png') });
      await page.locator('.fishing-dock-toggle').click();
      await page.screenshot({ path: path.join(process.env.FISHING_SCREENSHOT_DIR, 'fishing-overlay-collapsed.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.fishing-dock-toggle').click();
      await page.screenshot({ path: path.join(process.env.FISHING_SCREENSHOT_DIR, 'fishing-overlay-mobile.png') });
    }
    assert.deepEqual(errors, []); pass++;
    console.log('通过 ' + pass + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
