'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
const screenshots = path.resolve(__dirname, '../output/equipment-update');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    fs.mkdirSync(screenshots, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.route('http://equipment-filters.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '') });
      return route.fulfill({ path: file });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://equipment-filters.test/');
    await page.evaluate(() => {
      document.querySelector('#auth').remove();
      const D = GameData, st = Engine.state;
      window.filterIds = {
        common: D.instanceId('line_nylon', 'common', [{ type: 'material', value: 5 }]),
        rare: D.instanceId('line_nylon', 'rare', [{ type: 'material', value: 8 }]),
        modern: D.gearSignature('gear_line_1', 0, '', 'none', 0),
        hook: D.gearSignature('gear_hook_1', 0, '', 'none', 0),
      };
      st.me = { id: 'seller', name: 'Seller' };
      st.inventory = { relic: 2 };
      Object.values(filterIds).forEach(id => { st.inventory[id] = 1; });
      Net.fetchMarket = async query => {
        st.market = []; st.marketQuery = JSON.stringify(query);
        st.marketPage = { listings: [], page: 1, pages: 1, total: 0, mineCount: 0, marketTotal: 0, counts: { all: 0 } };
        return { ok: true, data: st.marketPage };
      };
      UI.setView('market'); UI.renderView();
    });
    const sell = page.locator('.mkt-sell');
    await sell.locator('[data-cat="component"]').click();
    const initialRows = await sell.locator('.mkt-sell-row').evaluateAll(nodes => nodes.map(n => n.dataset.mktId));
    check('Market component category excludes materials: ' + JSON.stringify(initialRows), initialRows.length === 4);
    await sell.getByLabel('装备成长筛选').selectOption('modern');
    check('Market growth filter removes legacy equipment from actual listing rows', await sell.locator('.mkt-sell-row').evaluateAll(nodes => nodes.length === 2 && nodes.every(n => [filterIds.modern, filterIds.hook].includes(n.dataset.mktId))));
    await sell.getByLabel('装备部位筛选').selectOption('line');
    check('Market part and growth filters combine', await sell.locator('.mkt-sell-row').evaluateAll(nodes => nodes.length === 1 && nodes[0].dataset.mktId === filterIds.modern));
    await page.screenshot({ path: path.join(screenshots, 'market-filters.png'), fullPage: true });
    await sell.getByRole('button', { name: '重置装备筛选', exact: true }).click();
    await sell.getByLabel('装备品质筛选').selectOption('rare');
    check('Market quality filter selects only the requested equipment', await sell.locator('.mkt-sell-row').evaluateAll(nodes => nodes.length === 1 && nodes[0].dataset.mktId === filterIds.rare));
    await sell.getByRole('button', { name: '重置装备筛选', exact: true }).click();
    check('Reset restores all market components and control values', await sell.locator('.mkt-sell-row').count() === 4 && await sell.getByLabel('装备品质筛选').inputValue() === 'all');

    await page.evaluate(() => { UI.setView('bd'); UI.renderView(); });
    const lineName = await page.evaluate(() => GameData.ROD_PARTS.find(p => p.key === 'line').name);
    await page.locator('.bd-cell').filter({ has: page.locator('.bd-part', { hasText: lineName }) }).getByRole('button', { name: '装备组件', exact: true }).click();
    const picker = page.locator('.modal-overlay');
    check('Equipment picker starts with all owned pieces for its part', await picker.locator('.bec-card').count() === 3);
    await picker.getByLabel('装备品质筛选').selectOption('rare');
    check('Shared equipment picker filters rarity', await picker.locator('.bec-card').count() === 1);
    await picker.getByRole('button', { name: '重置装备筛选', exact: true }).click();
    await picker.getByLabel('装备成长筛选').selectOption('modern');
    check('Shared equipment picker filters growth equipment', await picker.locator('.bec-card').count() === 1);
    await page.screenshot({ path: path.join(screenshots, 'picker-filters.png'), fullPage: true });
    await picker.getByRole('button', { name: '重置装备筛选', exact: true }).click();
    check('Shared equipment picker reset restores all choices', await picker.locator('.bec-card').count() === 3);
    check('No browser script errors', errors.length === 0);
  } finally { await browser.close(); }
  console.log('通过 ' + count + ' 项，失败 0 项');
})().catch(error => { console.error(error); process.exitCode = 1; });
