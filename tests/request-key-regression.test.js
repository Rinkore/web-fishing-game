'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../frontend');
let server;
let browser;

function serve(req, res) {
  const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(file);
  if (file.endsWith('index.html')) body = body.toString().replace('window.Engine.init();', '').replace('window.UI.init();', '');
  const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)];
  if (type) res.setHeader('Content-Type', type);
  res.end(body);
}

(async function run() {
  server = http.createServer(serve);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(() => {
    document.querySelector('#auth').remove();
    const st = Engine.state;
    st.me = { id: 'buyer', name: 'Buyer' };
    st.player.coins = 100000;
    st.inventory = { relic: 0 };
    const listing = { lid: 'request-key-listing', id: 'relic', name: '残片', seller: 'other', sellerName: 'Other', price: 10, qty: 1, t: Date.now() };
    let attempts = 0;
    window.marketRequestKeys = [];
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => ({ getItem: () => { throw new Error('storage disabled'); }, setItem: () => { throw new Error('storage disabled'); } }) });
    Net.fetchMarket = async query => {
      st.market = [Object.assign({}, listing)];
      st.marketQuery = JSON.stringify(query);
      st.marketPage = { listings: st.market, page: 1, pages: 1, total: 1, mineCount: 0, marketTotal: 1, counts: { all: 1, material: 1 } };
      return { ok: true, data: st.marketPage };
    };
    Net.marketBuy = async (lid, qty, requestKey) => {
      window.marketRequestKeys.push(requestKey);
      attempts++;
      if (attempts === 1) return new Promise(resolve => { window.finishMarketTimeout = () => resolve({ ok: false, status: 0, timedOut: true, data: { error: '模拟网络超时' } }); });
      return { ok: true, data: { coins: 99990, inventory: { relic: 1 }, invRev: 1 } };
    };
    UI.setView('mall'); UI.renderView();
  });
  await page.locator('[data-malltab="market"]').click();
  await page.locator('[data-listing-id="request-key-listing"]').waitFor();
  async function buy() {
    await page.locator('[data-listing-id="request-key-listing"] .mk-acts button').click();
    await page.locator('.cf-ok').click();
    await page.locator('.cf-ok').click();
  }
  await buy();
  await page.waitForFunction(() => window.marketRequestKeys.length === 1);
  await page.evaluate(() => { document.getElementById('main').innerHTML = ''; UI.renderView(); });
  await buy();
  assert.equal(await page.evaluate(() => marketRequestKeys.length), 1, 'redrawing the view must not allow a duplicate in-flight request');
  await page.evaluate(() => finishMarketTimeout());
  await page.waitForFunction(() => document.body.innerText.includes('模拟网络超时'));
  await buy();
  await page.waitForFunction(() => window.marketRequestKeys.length === 2);
  assert.equal(await page.evaluate(() => marketRequestKeys[0]), await page.evaluate(() => marketRequestKeys[1]), 'timeout retry must reuse request key when sessionStorage is unavailable');
  await page.evaluate(() => {
    const stale = JSON.stringify({ 'buyer:request-key-listing:1:10': marketRequestKeys[0] });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => ({ getItem: () => stale, setItem: () => { throw new Error('storage read only'); } }) });
  });
  await buy();
  await page.waitForFunction(() => window.marketRequestKeys.length === 3);
  assert.notEqual(await page.evaluate(() => marketRequestKeys[1]), await page.evaluate(() => marketRequestKeys[2]), 'successful purchase must clear its key even when storage still contains stale data');
  assert.equal(errors.length, 0, 'request-key retry must not create browser errors: ' + errors.join('; '));
  console.log('PASS pending purchase survives redraw, timeout retry and unavailable storage');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});
