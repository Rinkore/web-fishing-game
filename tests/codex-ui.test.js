'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../frontend');
const browserPath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);

let pass = 0;
function check(name, value, extra) {
  assert.ok(value, name + (extra ? ': ' + extra : ''));
  pass++;
  console.log('PASS ' + name);
}

(async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 820 } });
    await context.route('http://codex.test/**', route => {
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
    await page.goto('http://codex.test/');
    await page.evaluate(() => {
      document.querySelector('#auth').remove();
      Engine.applyProfile({
        username: 'codex_test', name: '图鉴测试', coins: 0, inventory: {}, bd: {}, catchCount: 3,
        codex: {
          crucian: { count: 2, first: Date.now() - 2000, min: 18, max: 33, tier: 'L' },
          koi: { count: 1, first: Date.now() - 1000, min: 88, max: 88, tier: 'G' },
        },
      });
      UI.setView('codex');
      UI.renderNav(); UI.renderTopbar(); UI.renderView();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.codex-cell img')).every(img => img.complete));

    const base = await page.evaluate(() => {
      const fish = Array.from(document.querySelectorAll('.codex-cell.k-fish'));
      const firstVisual = fish[0].querySelector('.cx-visual-fish').getBoundingClientRect();
      const rows = {};
      document.querySelectorAll('.codex-cell').forEach(el => {
        const r = el.getBoundingClientRect();
        (rows[Math.round(r.top)] ||= []).push(Math.round(r.height));
      });
      return {
        fish: fish.length,
        visuals: document.querySelectorAll('.codex-cell.k-fish .cx-visual-fish').length,
        size: [Math.round(firstVisual.width), Math.round(firstVisual.height)],
        keyboard: fish.every(el => el.getAttribute('role') === 'button' && el.tabIndex === 0),
        rowAligned: Object.values(rows).every(row => new Set(row).size === 1),
        rowHeightKinds: new Set(Object.values(rows).map(row => row[0])).size,
        materialMotion: getComputedStyle(document.querySelector('.codex-cell.k-material .cx-icon')).animationName,
        fishMotion: getComputedStyle(document.querySelector('.codex-cell.k-fish.got .cx-icon')).animationName,
      };
    });
    check('40 fish cards use a shared art window', base.fish === 40 && base.visuals === 40, JSON.stringify(base));
    check('fish art window keeps the 132x78 logical ratio', base.size[0] === 132 && base.size[1] === 78, JSON.stringify(base.size));
    check('cards are keyboard reachable', base.keyboard, JSON.stringify(base));
    check('only fish artwork swims', base.fishMotion === 'px-swim' && base.materialMotion === 'none', JSON.stringify(base));
    check('cards align by row without global tallest-card stretching', base.rowAligned && base.rowHeightKinds >= 2, JSON.stringify(base));
    if (process.env.CODEX_UI_SHOT_DIR) {
      fs.mkdirSync(process.env.CODEX_UI_SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CODEX_UI_SHOT_DIR, 'codex-desktop.png'), fullPage: true });
    }

    const refreshed = await page.evaluate(() => {
      const id = 'crucian';
      const old = Engine.state.codex[id];
      Engine.state.codex[id] = Object.assign({}, old, { count: 9, tier: 'G', max: 45 });
      UI.renderView();
      const cell = document.querySelector('.codex-cell[data-cxid="' + id + '"]');
      cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const detail = document.querySelector('.codex-modal .codex-detail');
      return {
        text: detail && detail.textContent.replace(/\s+/g, ' '),
        gold: cell.classList.contains('tier-gold'),
        badge: (cell.querySelector('.cx-tier-badge') || {}).textContent || '',
      };
    });
    check('soft refresh updates tier border and badge', refreshed.gold && /巨型/.test(refreshed.badge), JSON.stringify(refreshed));
    check('detail opens from keyboard with the latest record object', /已钓 9 次/.test(refreshed.text || ''), JSON.stringify(refreshed));
    await page.click('.codex-modal .modal-close');

    const unlocked = await page.evaluate(() => {
      const cell0 = document.querySelector('.codex-cell.k-fish:not(.got)[data-cxid]');
      const id = cell0.dataset.cxid;
      Engine.state.codex[id] = { count: 1, first: Date.now(), min: 1, max: 2, tier: 'L' };
      UI.renderView();
      const cell = document.querySelector('.codex-cell[data-cxid="' + id + '"]');
      return {
        got: cell.classList.contains('got'),
        silver: cell.classList.contains('tier-silver'),
        lockedName: cell.querySelector('.cx-name').classList.contains('locked-name'),
        lockBadge: !!cell.querySelector('.cx-lock-badge'),
      };
    });
    check('first unlock fully lights the card', unlocked.got && unlocked.silver && !unlocked.lockedName && !unlocked.lockBadge, JSON.stringify(unlocked));

    await page.setViewportSize({ width: 350, height: 800 });
    const mobile = await page.evaluate(() => ({
      columns: getComputedStyle(document.querySelector('.codex-grid')).gridTemplateColumns.split(' ').length,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      metaPx: parseFloat(getComputedStyle(document.querySelector('.codex-cell .cx-meta')).fontSize),
    }));
    check('very narrow screens use one column without horizontal overflow', mobile.columns === 1 && !mobile.overflow, JSON.stringify(mobile));
    check('mobile metadata remains readable', mobile.metaPx >= 12, JSON.stringify(mobile));
    if (process.env.CODEX_UI_SHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.CODEX_UI_SHOT_DIR, 'codex-mobile.png'), fullPage: true });
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    console.log('通过 ' + pass + ' 项，失败 0 项');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
