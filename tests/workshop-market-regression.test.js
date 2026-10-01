'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
let browser;
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(file);
  if (file.endsWith('index.html')) body = body.toString().replace('window.Engine.init();', '').replace('window.UI.init();', '');
  const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)];
  if (type) res.setHeader('Content-Type', type);
  res.end(body);
});
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(() => {
    document.querySelector('#auth').remove();
    const st = Engine.state;
    st.me = { id: 'buyer', name: 'Buyer' };
    st.inventory = { dragonpearl: 100, relic: 100 };
    st.player.coins = 0;
    st.mall = { items: [{ id: 'relic', name: '残片', price: 100, limit: 3, remain: 3, have: 0 }], resetAt: Date.now() + 100000 };
    UI.setView('mall'); UI.renderView();
  });
  await page.locator('.mc-acts button').first().click();
  check('Unaffordable purchase gives visible feedback', await page.locator('body').innerText().then(t => t.includes('金币不足，购买需要')));
  await page.locator('.mc-acts button').nth(1).click();
  check('Unaffordable buy-all gives visible feedback', await page.locator('body').innerText().then(t => t.includes('金币不足，买满需要')));
  await page.evaluate(() => {
    const st = Engine.state; st.player.coins = 10000;
    window.marketItems = [{ lid: 'a', id: 'relic', name: '残片', seller: 'other', sellerName: 'Other', price: 10, qty: 3, t: Date.now() }, { lid: 'b', id: 'dragonpearl', name: '宝珠', seller: 'other', sellerName: 'Other', price: 20, qty: 2, t: Date.now() }];
    Net.fetchMarket = async query => {
      await new Promise(resolve => setTimeout(resolve, 50));
      st.market = marketItems.filter(i => i.qty > 0).map(i => Object.assign({}, i)); st.marketQuery = JSON.stringify(query);
      st.marketPage = { listings: st.market, page: 1, pages: 1, total: st.market.length, mineCount: 0, marketTotal: st.market.length, counts: { all: st.market.length, material: st.market.length } };
      return { ok: true, data: st.marketPage };
    };
    Net.marketBuy = async (lid, qty) => {
      const item = marketItems.find(i => i.lid === lid); item.qty -= qty;
      return { ok: true, data: { coins: 9990, inventory: Object.assign({}, st.inventory, { relic: 101 }) } };
    };
  });
  await page.locator('[data-malltab="market"]').click(); await page.locator('[data-listing-id="a"]').waitFor();
  await page.evaluate(() => { window.oldMarketPanel = document.querySelector('[data-market-query]'); window.oldOtherRow = document.querySelector('[data-listing-id="b"]'); window.oldBoughtRow = document.querySelector('[data-listing-id="a"]'); });
  await page.locator('[data-listing-id="a"] .mk-acts button').click();
  await page.locator('.cf-ok').click(); await page.locator('.cf-ok').click();
  await page.waitForFunction(() => document.querySelector('[data-listing-id="a"] .qty').textContent === '×2');
  check('Market purchase updates quantity without replacing panel or rows', await page.evaluate(() => oldMarketPanel === document.querySelector('[data-market-query]') && oldOtherRow === document.querySelector('[data-listing-id="b"]') && oldBoughtRow === document.querySelector('[data-listing-id="a"]')));
  await page.locator('[data-listing-id="a"] .mk-acts button').click();
  check('Repeated purchase uses the updated remaining quantity', await page.locator('.cf-input').getAttribute('max') === '2');
  await page.locator('.cf-input').fill('2');
  await page.locator('.cf-ok').click(); await page.locator('.cf-ok').click();
  await page.waitForFunction(() => !document.querySelector('[data-listing-id="a"]'));
  check('Sold-out listing is removed while other rows and filters stay mounted', await page.evaluate(() => oldMarketPanel === document.querySelector('[data-market-query]') && oldOtherRow === document.querySelector('[data-listing-id="b"]') && document.querySelector('[data-market-count="all"]').textContent === '全部 1'));
  check('No browser runtime errors', errors.length === 0);
  console.log('通过 ' + count + ' 项，失败 0 项');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
