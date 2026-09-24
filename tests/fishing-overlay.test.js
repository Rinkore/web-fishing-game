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
      GameData.GROUNDS.forEach(g => (g.spots || []).forEach(s => { s.buffs = []; }));
      UI.setView('fishing'); UI.renderNav(); UI.renderTopbar(); UI.renderView();
    });
    await page.evaluate(() => document.fonts.ready);
    const overlay = page.locator('#fishing-overlay');
    check(!await overlay.isVisible(), 'overlay starts closed');
    check(await page.locator('.vm-art').count() === 1, 'one CSS world map renders');
    check(await page.locator('.fishing-map-controls, .fishing-map-hint').count() === 0, 'map control strip is removed');
    check(await page.locator('.px-map .px-map-img').count() === 0, 'world map does not use a bitmap background');
    check(await page.locator('.px-node[data-s="dock"]').count() === 1 && await page.locator('.px-node[data-s="trench"]').count() === 1, 'nearshore and offshore spots share the map');
    check(await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.px-map .px-node')];
      return nodes.every(node => {
        const spot = GameData.GROUNDS.find(g => g.id === node.dataset.g).spots.find(s => s.id === node.dataset.s);
        const projected = VoyageMap.project(spot.pos, spot.map === 'voyage');
        const local = VoyageMap.unproject(projected, spot.map === 'voyage');
        return Math.abs(parseFloat(node.style.left) - projected[0]) < .001 && Math.abs(parseFloat(node.style.top) - projected[1]) < .001 && local.every((v, i) => Math.abs(v - spot.pos[i]) < .001);
      });
    }), 'existing spot positions project consistently and round trip without migrations');
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
    // Locked locations keep the original prechecks on the unified map.
    await page.locator('.px-node[data-s="ice"] .pn-name').click();
    check(await page.evaluate(() => !Engine.state.fishing.active), 'locked nearshore spot does not start fishing');
    await page.locator('.px-node[data-s="shore"] .pn-name').click();
    check(await page.evaluate(() => !Engine.state.fishing.active), 'offshore spot still requires a registered ship');
    const zoomedWidth = await page.locator('.px-map').evaluate(e => e.getBoundingClientRect().width);
    await page.locator('.fish-select').hover();
    await page.mouse.wheel(0, -180);
    await page.waitForFunction(width => document.querySelector('.px-map').getBoundingClientRect().width > width + 1, zoomedWidth);
    check(await page.locator('.px-map').evaluate(e => parseFloat(e.style.getPropertyValue('--map-scale')) > 1), 'wheel enlarges the map');
    check(await page.locator('.px-map').evaluate(e => {
      // The CSS-pixel terrain must be laid out at its zoomed size. Scaling the
      // whole map element promotes box-shadow art to a filtered compositing
      // layer and makes the pixel coastline soft after zooming.
      return parseFloat(e.style.width) > 0 && parseFloat(e.style.height) > 0 &&
        !/\bscale\s*\(/.test(e.style.transform);
    }), 'zoom lays out the map at its target size instead of filtering a scaled layer');
    const dragNode = await page.locator('.px-node[data-s="dock"] .pn-name').boundingBox();
    await page.mouse.move(dragNode.x + dragNode.width / 2, dragNode.y + dragNode.height / 2);
    const beforeDrag = await page.locator('.px-map').evaluate(e => e.getBoundingClientRect().left);
    await page.mouse.down();
    await page.mouse.move(dragNode.x + dragNode.width / 2 + 70, dragNode.y + dragNode.height / 2 + 20, { steps: 6 });
    await page.mouse.up();
    check(await page.evaluate(() => !Engine.state.fishing.active), 'dragging from a spot does not select it');
    check(Math.abs(await page.locator('.px-map').evaluate(e => e.getBoundingClientRect().left) - beforeDrag) > 20, 'pointer drag moves the map');
    check(await page.locator('.px-map').evaluate(e => e.getBoundingClientRect().width) > zoomedWidth, 'wheel zoom enlarges the map');
    const selectedZoom = await page.locator('.px-map').evaluate(e => e.style.getPropertyValue('--map-scale'));
    // Map click still reaches original start/stop flow behind the overlay controls.
    await page.locator('.px-node[data-s="dock"] .pn-name').click();
    await page.waitForFunction(() => Engine.state.fishing.active && Engine.state.castInfo);
    check(await page.locator('.px-map').evaluate(e => e.style.getPropertyValue('--map-scale')) === selectedZoom, 'selecting a spot preserves the zoom level');
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
    // Closed sidebar state survives zooming and restoring the unified map.
    await page.locator('.fishing-dock-toggle').click();
    check(await page.locator('.vm-art').count() === 1, 'restoring the view keeps one map');
    check(await page.locator('.fishing-dock').evaluate(e => e.classList.contains('collapsed')), 'restoring the map preserves dock state');
    await page.locator('.fishing-dock-toggle').click();
    await page.locator('.fish-select').focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('-');
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
          ratio: Math.abs(map.width / map.height - 2) < .001,
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
    // Start a fresh touch session: first mobile visit focuses a readable nearshore area.
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    mobile.on('pageerror', e => errors.push(e.message));
    await mobile.route('http://fishing.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '') });
      const file = path.join(root, pathname);
      return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    });
    await mobile.goto('http://fishing.test/');
    for (const file of ['data', 'features', 'engine', 'voyage-map', 'ui']) await mobile.addScriptTag({ path: path.join(root, 'js', file + '.js') });
    await mobile.evaluate(() => {
      document.querySelector('#auth').style.display = 'none';
      window.touchFishingStarts = 0;
      window.Net = {
        fishingStart: () => { window.touchFishingStarts++; return Promise.resolve({ ok: true, data: { interval: 8000 } }); },
        fishingStop: () => {},
      };
      UI.setView('fishing'); UI.renderNav(); UI.renderTopbar(); UI.renderView();
    });
    await mobile.evaluate(() => document.fonts.ready);
    check(await mobile.locator('.px-map').evaluate(e => parseFloat(e.style.getPropertyValue('--map-scale')) === 2.5), 'first narrow-screen visit starts at a readable 250% zoom');
    check(await mobile.locator('.px-node[data-s="dock"]').evaluate(e => {
      const node = e.getBoundingClientRect(), stage = document.querySelector('.fishing-stage').getBoundingClientRect();
      return node.left >= stage.left && node.right <= stage.right && Math.abs((node.left + node.right - stage.left - stage.right) / 2) < 25;
    }), 'first narrow-screen visit focuses the starter fishing spot');
    const touchSession = await mobile.context().newCDPSession(mobile);
    const touchNode = await mobile.locator('.px-node[data-s="dock"] .pn-name').boundingBox();
    const firstTouch = { id: 1, x: touchNode.x + touchNode.width / 2, y: touchNode.y + touchNode.height / 2 };
    const secondTouch = { id: 2, x: firstTouch.x + 60, y: firstTouch.y };
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [firstTouch] });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [firstTouch, secondTouch] });
    firstTouch.x -= 15; secondTouch.x += 15;
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [firstTouch, secondTouch] });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(await mobile.locator('.px-map').evaluate(e => parseFloat(e.style.getPropertyValue('--map-scale')) > 2.5), 'two-finger pinch enlarges the map');
    check(await mobile.evaluate(() => window.touchFishingStarts === 0 && !Engine.state.fishing.active), 'ending a pinch started on a fishing spot never selects it');
    await mobile.locator('.px-node[data-s="dock"] .pn-name').tap();
    await mobile.waitForFunction(() => Engine.state.fishing.active);
    check(await mobile.evaluate(() => window.touchFishingStarts === 1), 'a single tap still selects the spot once after a pinch');
    await touchSession.detach();
    await mobile.close();
    // The admin editor saves original region coordinates while showing the same world map.
    const admin = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    admin.on('pageerror', e => errors.push(e.message));
    const ground = { id: 'map', name: '世界地图', spots: [
      { id: 'dock', name: '湖畔老码头', pos: [62, 47], pool: [], buffs: [] },
      { id: 'shore', name: '近海渔场', map: 'voyage', pos: [26, 73], minShip: 1, pool: [], buffs: [] },
    ] };
    let savedPositions;
    await admin.route('http://admin.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname === '/shop') return json({ crucian: { base: 1 } });
      if (pathname === '/api/admin/session') return json({ username: 'test', name: '测试管理员' });
      if (pathname === '/api/admin/world') return json({ grounds: [ground], catalog: { fish: [], materials: [] }, poolPresets: {}, lootGroups: [] });
      if (pathname === '/api/admin/spot/pos') { savedPositions = route.request().postDataJSON(); return json({ changed: 2 }); }
      if (pathname.startsWith('/api/')) return json({ error: '未启用' }, 400);
      const file = path.join(root, pathname);
      if (pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '') });
      return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    });
    await admin.goto('http://admin.test/admin.html');
    for (const file of ['data', 'features', 'voyage-map', 'admin']) await admin.addScriptTag({ path: path.join(root, 'js', file + '.js') });
    await admin.locator('#nav').getByRole('button', { name: '🎣 钓点管理', exact: true }).click();
    await admin.locator('#gd-map-canvas .vm-art').waitFor();
    check(await admin.locator('.gd-node').count() === 2, 'admin shows both regions together');
    for (const [sid, x, y] of [['dock', 35, 40], ['shore', 70, 60]]) {
      await admin.locator('#gd-map-canvas').scrollIntoViewIfNeeded();
      const mapBox = await admin.locator('#gd-map-canvas').boundingBox();
      const nodeBox = await admin.locator('.gd-node[data-s="' + sid + '"]').boundingBox();
      await admin.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
      await admin.mouse.down();
      await admin.mouse.move(mapBox.x + mapBox.width * x / 100, mapBox.y + mapBox.height * y / 100, { steps: 5 });
      await admin.mouse.up();
    }
    await admin.locator('#gd-map-save').click();
    await admin.waitForFunction(() => document.querySelector('#gd-map-state').textContent.includes('已保存'));
    check(savedPositions.groundId === 'map', 'admin keeps existing save endpoint and ground identity');
    const positions = Object.fromEntries(savedPositions.list.map(s => [s.spotId, s.pos]));
    check(Math.abs(positions.dock[0] - 65.2) < .2 && Math.abs(positions.dock[1] - 38.1) < .2, 'nearshore drag saves inverse projected legacy coordinates across list changes');
    check(Math.abs(positions.shore[0] - 40.5) < .2 && Math.abs(positions.shore[1] - 61.9) < .2, 'offshore drag saves inverse projected legacy coordinates');
    check(await admin.locator('.gd-node[data-s="shore"]').evaluate(e => Math.abs(parseFloat(e.style.left) - 70) < .2), 'saved map positions survive redraws');
    check(await admin.locator('[data-mtab]').count() === 0 && await admin.locator('#ns-map').count() === 0, 'admin no longer exposes deprecated fishing zones');
    // 拖过中线：坐标带跟着光标切换，保存时连带提交 map 归属（远洋点拖回左侧变近岸）
    {
      const mapBox = await admin.locator('#gd-map-canvas').boundingBox();
      const nodeBox = await admin.locator('.gd-node[data-s="shore"]').boundingBox();
      await admin.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
      await admin.mouse.down();
      await admin.mouse.move(mapBox.x + mapBox.width * 20 / 100, mapBox.y + mapBox.height * 60 / 100, { steps: 5 });
      await admin.mouse.up();
    }
    await admin.locator('#gd-map-save').click();
    await admin.waitForFunction(() => document.querySelector('#gd-map-state').textContent.includes('已保存'));
    const savedShore = savedPositions.list.find(s => s.spotId === 'shore');
    check(savedShore.map === '' && Math.abs(savedShore.pos[0] - 32.6) < .2, 'crossing the midline switches the coordinate band and submits the map ownership');
    await admin.close();
    assert.deepEqual(errors, []); pass++;
    console.log('通过 ' + pass + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
