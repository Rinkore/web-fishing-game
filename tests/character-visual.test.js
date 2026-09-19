'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../frontend');
const browserPath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);
let pass = 0;
function check(name, value, extra) { assert.ok(value, name + (extra ? ': ' + extra : '')); pass++; console.log('PASS ' + name); }

(async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 820 } });
    await context.route('http://character.test/**', route => {
      const url = new URL(route.request().url());
      const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) {
        const html = fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '');
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      return route.fulfill({ path: file });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://character.test/');
    await page.evaluate(() => {
      document.querySelector('#auth').remove();
      Engine.applyProfile({ username: 'art_test', name: '美术测试', coins: 0, inventory: {}, bd: {}, codex: {}, catchCount: 0 });
      // 账号外观：拥有两艘免费迁移船与两名免费钓手（砾需付费解锁）
      const owned = { boatId: 'marsh_skiff', anglerId: 'lan', boats: ['marsh_skiff', 'tide_cutter'], anglers: ['lan', 'mo'] };
      Engine.state.appearance = owned;
      Net.setBoat = async function (boatId) { return { ok: true, data: { ok: true, appearance: Object.assign({}, owned, { boatId }) } }; };
      Net.buyBoat = async function (boatId) {
        owned.boats = owned.boats.concat([boatId]);
        return { ok: true, data: { ok: true, cost: 200, coins: 0, appearance: Object.assign({}, owned) } };
      };
      Net.setAngler = async function (anglerId) {
        if (owned.anglers.indexOf(anglerId) < 0) owned.anglers = owned.anglers.concat([anglerId]);
        return { ok: true, data: { ok: true, cost: 0, appearance: Object.assign({}, owned, { anglerId }) } };
      };
      UI.setView('character'); UI.renderNav(); UI.renderTopbar(); UI.renderView();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.char-view img')).every(img => img.complete));
    const anglers = await page.evaluate(() => ({
      cards: document.querySelectorAll('.angler-card').length,
      selected: document.querySelectorAll('.angler-card[aria-pressed=true]').length,
      locked: document.querySelectorAll('.angler-card.locked').length,
      statRows: document.querySelectorAll('.angler-card .stat-row').length,
      statCellsFilled: document.querySelectorAll('.angler-card .stat-cells i.f').length,
      passive: document.querySelectorAll('.angler-card .cc-passive').length,
      price: Array.from(document.querySelectorAll('.angler-card .cc-price')).map(e => e.textContent),
      stageSrc: (document.querySelector('.cs-angler') || {}).getAttribute('src') || '',
      layers: (() => {
        const base = document.querySelector('.cs-boat:not(.cs-boat-front)');
        const angler = document.querySelector('.cs-angler');
        const front = document.querySelector('.cs-boat-front');
        const dog = document.querySelector('.cs-dog');
        return {
          boats: document.querySelectorAll('.cs-boat').length,
          base: base && Number(getComputedStyle(base).zIndex),
          angler: angler && Number(getComputedStyle(angler).zIndex),
          front: front && Number(getComputedStyle(front).zIndex),
          dog: dog && Number(getComputedStyle(dog).zIndex),
          clip: front && getComputedStyle(front).clipPath,
        };
      })(),
      broken: Array.from(document.querySelectorAll('.char-view img')).filter(img => !img.naturalWidth).map(img => img.src),
    }));
    check('three anglers render with one selected and one locked', anglers.cards === 3 && anglers.selected === 1 && anglers.locked === 1, JSON.stringify(anglers));
    check('angler cards show 4-stat panels and passives', anglers.statRows === 12 && anglers.statCellsFilled > 0 && anglers.passive === 3, JSON.stringify(anglers));
    check('locked angler shows coin unlock price', anglers.price.length === 1 && /3000/.test(anglers.price[0]), JSON.stringify(anglers.price));
    check('character stage uses seated sprite', /lan_sit\.png$/.test(anglers.stageSrc), anglers.stageSrc);
    check('stage layers seat the angler between boat base and foreground gunwale', anglers.layers.boats === 2 &&
      anglers.layers.base < anglers.layers.angler && anglers.layers.angler < anglers.layers.front &&
      anglers.layers.front < anglers.layers.dog && anglers.layers.clip !== 'none', JSON.stringify(anglers.layers));
    check('all initial character-page artwork loads', anglers.broken.length === 0, JSON.stringify(anglers.broken));
    if (process.env.CHARACTER_UI_SHOT_DIR) {
      fs.mkdirSync(process.env.CHARACTER_UI_SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CHARACTER_UI_SHOT_DIR, 'character-anglers-desktop.png'), fullPage: true });
    }

    await page.locator('.angler-card').nth(1).click();
    check('selecting 墨 updates stage and account preference', await page.evaluate(() =>
      /mo_sit\.png$/.test(document.querySelector('.cs-angler').src) &&
      Engine.state.appearance.anglerId === 'mo' && localStorage.getItem('fishing_char_v1') === 'mo'));

    await page.locator('[data-sectiontab=companion]').click();
    await page.waitForFunction(() => document.querySelectorAll('.breed-group').length === 9);
    const companions = await page.evaluate(() => ({
      groups: document.querySelectorAll('.breed-group').length,
      titles: Array.from(document.querySelectorAll('.breed-title')).map(e => e.textContent),
      cards: document.querySelectorAll('.companion-cards .cc-card').length,
      selected: document.querySelectorAll('.companion-cards .cc-card.on').length,
      broken: Array.from(document.querySelectorAll('.companion-cards img')).filter(img => !img.naturalWidth).map(img => img.src),
    }));
    check('companions group into 9 breeds with 18 variants', companions.groups === 9 && companions.cards === 18 && companions.selected === 1, JSON.stringify(companions));
    check('all companion artwork loads', companions.broken.length === 0, JSON.stringify(companions.broken));
    await page.locator('.breed-group').nth(5).locator('.cc-card').first().click();
    check('selecting a companion variant updates stage dog', await page.evaluate(() =>
      /dog_dachshund\.png$/.test(document.querySelector('.cs-dog').src) &&
      JSON.parse(localStorage.getItem('fishing_char_v2')).dog === 'dachshund'));

    await page.locator('[data-sectiontab=boat]').click();
    await page.waitForFunction(() => document.querySelectorAll('.boat-card').length === 5);
    const boats = await page.evaluate(() => ({
      cards: document.querySelectorAll('.boat-card').length,
      text: Array.from(document.querySelectorAll('.boat-card')).map(e => e.textContent.replace(/\s+/g, ' ')),
      waters: document.querySelectorAll('.boat-card .cc-water').length,
      prices: Array.from(document.querySelectorAll('.boat-card .cc-price')).map(e => e.textContent),
      broken: Array.from(document.querySelectorAll('.boat-card img')).filter(img => !img.naturalWidth).map(img => img.src),
    }));
    check('five boats show traits, spots, buffs and water type', boats.cards === 5 && boats.waters === 5 &&
      boats.text.every(t => /适航增益/.test(t) && /📍/.test(t)), JSON.stringify(boats));
    check('boat cards show price rows', boats.prices.length === 5 && boats.prices.some(t => /5000/.test(t)) &&
      boats.prices.some(t => /已购入/.test(t)), JSON.stringify(boats.prices));
    check('all boat artwork loads', boats.broken.length === 0, JSON.stringify(boats.broken));
    await page.locator('.boat-card').nth(2).click();
    await page.waitForFunction(() => Engine.state.appearance.boatId === 'tide_cutter');
    check('owned boat selection updates the account appearance state', await page.evaluate(() =>
      document.querySelectorAll('.boat-card[aria-pressed=true]').length === 1 && Engine.state.appearance.boatId === 'tide_cutter'));
    await page.locator('.boat-card').nth(1).click();
    await page.waitForFunction(() => Engine.state.appearance.boats.indexOf('leaky_bucket') >= 0 && Engine.state.appearance.boatId === 'leaky_bucket');
    check('unowned boat card buys then equips', await page.evaluate(() =>
      Engine.state.appearance.boatId === 'leaky_bucket' && Engine.state.appearance.boats.length === 3));

    if (process.env.CHARACTER_UI_SHOT_DIR) {
      fs.mkdirSync(process.env.CHARACTER_UI_SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CHARACTER_UI_SHOT_DIR, 'character-boats-desktop.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 350, height: 800 });
    const mobile = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      boatCols: getComputedStyle(document.querySelector('.boat-cards')).gridTemplateColumns.split(' ').length,
    }));
    check('mobile boat cards use one column without overflow', !mobile.overflow && mobile.boatCols === 1, JSON.stringify(mobile));
    if (process.env.CHARACTER_UI_SHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.CHARACTER_UI_SHOT_DIR, 'character-boats-mobile.png'), fullPage: true });
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    console.log('通过 ' + pass + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
