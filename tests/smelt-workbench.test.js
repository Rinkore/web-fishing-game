/* Isolated UI contract tests. Real renderer/data rules; no player accounts or saves. */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../frontend');
const SHOTS = path.resolve(__dirname, '../output/smelt-preview');
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(p => fs.existsSync(p));
const MIME = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2' };
let browser, count = 0;
function check(name, value) { assert.ok(value, name); console.log('PASS ' + name); count++; }
const srv = http.createServer((req, res) => {
  const fp = path.resolve(ROOT, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!fp.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(fp);
  // Skip network bootstrap only. All production UI, styles and shared game rules execute normally.
  if (fp.endsWith('index.html')) body = body.toString().replace('window.Engine.init();', '').replace('window.UI.init();', '');
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream'); res.end(body);
});
async function run() {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1080 } });
  page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + srv.address().port);
  await page.evaluate(() => {
    document.querySelector('#auth').remove();
    const D = GameData, st = Engine.state;
    window.fixtureMain = 'rod_dragonbone#mythic#spd+18,dbl+12@bt,rare+4@ct';
    window.fixtureSub = 'rod_carbon#epic#skl+6,spd+10';
    st.player.coins = 200000;
    st.inventory = { [fixtureMain]: 1, [fixtureSub]: 1, dragonpearl: 3, relic: 10 };
    st.workshop = { materials: D.smeltMaterialIds().map(id => {
      st.inventory[id] = 12;
      return { id, name: D.itemOf(id).name, affix: D.smeltMaterialAffix(id), affixName: D.AFFIX_LABEL[D.smeltMaterialAffix(id)] };
    }) };
    window.Net.smelt = async payload => { window.lastSmelt = payload; return { ok: false, data: { error: '测试：库存已变动' } }; };
    UI.setView('workshop'); UI.renderNav(); UI.renderView();
  });
  check('Empty state keeps the result preview and blocks submit', await page.locator('#ws-go').isDisabled() && await page.locator('.sm-preview-panel').isVisible());
  check('Secondary slot is unavailable before a main component', await page.locator('[data-pick="sub"]').isDisabled());
  async function pick(which, name) {
    await page.locator('[data-pick="' + which + '"]').click();
    const card = page.locator('.bec-card').filter({ hasText: name }).first();
    await card.locator('.bec-acts button:not([disabled])').first().click();
  }
  await pick('main', '龙骨'); await pick('sub', '碳素');
  check('Relics default to zero on selection', await page.locator('#ws-relic-qty').inputValue() === '0');
  const sourceColors = await page.evaluate(() => {
    const bt = document.querySelector('.ws-aff .inst-aff.extra.bt'), ct = document.querySelector('.ws-aff .inst-aff.extra.ct');
    return bt && ct && getComputedStyle(bt).backgroundImage !== 'none' && getComputedStyle(ct).backgroundImage !== 'none' && getComputedStyle(bt).backgroundImage !== getComputedStyle(ct).backgroundImage;
  });
  check('Breakthrough and catalyst keep their original distinct gradients', sourceColors);
  await page.locator('.ws-aff[data-which="main"][data-type="double"]').click();
  check('Selected affix retains its source gradient', await page.locator('.ws-aff.on .inst-aff.bt').evaluate(n => getComputedStyle(n).backgroundImage.includes('linear-gradient')));
  await page.locator('.ws-aff[data-which="main"][data-type="speed"]').click();
  check('Duplicate affix is visibly disabled', await page.locator('.ws-aff[data-which="sub"][data-type="speed"]').isDisabled());
  await page.locator('.ws-aff[data-which="sub"][data-type="skill"]').click();
  check('Two chosen affixes enable submit', await page.locator('#ws-go').isEnabled());
  check('Preview has two result rows', await page.locator('.sm-result-aff').count() === 2);
  const baseRate = await page.evaluate(() => GameData.smeltRatesOf(GameData.smeltLoadOf([]), false).rate);
  check('Base probabilities use shared rules', (await page.locator('.ws-aff-prob').allTextContents()).every(s => s === '获得概率 ' + baseRate + '%'));
  await page.locator('#ws-material-open').click();
  check('Catalysts open in an accessible dialog with loaded material images', await page.locator('#ws-material-modal').getAttribute('role') === 'dialog' && await page.locator('.sm-material-icon').evaluateAll(nodes => nodes.length === 6 && nodes.every(n => n.complete && n.naturalWidth > 0)));
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'fixed-catalyst-dialog.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  check('Material dialog fits mobile width with its completion button visible', await page.locator('#ws-material-modal').evaluate(n => {
    const rect = n.getBoundingClientRect(), done = n.querySelector('.sm-material-done').getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth + 1 && n.scrollWidth <= n.clientWidth + 1 && done.bottom <= innerHeight;
  }));
  await page.setViewportSize({ width: 1600, height: 1080 });
  const material = page.locator('.ws-mat[data-affix="material"] input');
  await material.fill('3');
  check('Catalyst adds a live preview row', await page.locator('.sm-result-aff').count() === 3);
  const probability = await page.evaluate(() => {
    const input = document.querySelector('.ws-mat[data-affix="material"] input');
    return GameData.smeltSuccessProbs(GameData.smeltRatesOf(GameData.smeltLoadOf([{ id: input.dataset.mat, qty: 3 }]), false), true).full;
  });
  check('Catalyst probability is success × extra chance', await page.locator('.sm-result-aff.add .ws-aff-prob').textContent() === '获得概率 ' + probability + '%');
  const inputHandle = await material.elementHandle(); await material.focus();
  await page.evaluate(() => { Engine.state.player.coins++; UI.refreshAll('assets'); });
  check('Asset updates preserve the live material input and focus', await inputHandle.evaluate(n => n.isConnected && document.activeElement === n));
  await page.locator('.sm-material-done').click();
  check('Closing material dialog keeps the selection and returns focus', await page.locator('#ws-material-images img').count() === 1 && await page.locator('#ws-material-open').evaluate(n => document.activeElement === n));
  await page.locator('#ws-relic-qty').fill('1');
  check('Relic changes failure outcome to protection', (await page.locator('.sm-risk').textContent()).includes('受残片保护'));
  await page.locator('#ws-pearl').check();
  await page.evaluate(() => { document.querySelector('#main').scrollTop = 0; });
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'implemented-desktop.png'), fullPage: true });
  for (const [width, height] of [[1920,1080],[1600,900],[1366,768],[1280,720],[1024,768]]) {
    await page.setViewportSize({ width, height });
    const fit = await page.evaluate(() => {
      const main = document.querySelector('#main'), preview = document.querySelector('#ws-preview'), go = document.querySelector('#ws-go');
      return { page: main.scrollHeight <= main.clientHeight + 1, preview: preview.scrollHeight <= preview.clientHeight + 1, previewHeight: [preview.scrollHeight,preview.clientHeight],
        bottom: go.getBoundingClientRect().bottom, limit: main.getBoundingClientRect().bottom };
    });
    console.log('Layout', width, height, fit);
    if (width === 1366) await page.screenshot({ path: path.join(SHOTS, 'fixed-desktop-1366.png') });
    check('Workbench fully visible without scrolling at ' + width + 'x' + height, fit.page && fit.preview && fit.bottom <= fit.limit);
  }
  for (const width of [1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check('No horizontal overflow at ' + width, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#main').scrollWidth <= document.querySelector('#main').clientWidth + 1));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.querySelector('#main').scrollTop = 0; });
  await page.screenshot({ path: path.join(SHOTS, 'implemented-mobile.png'), fullPage: true });
  await page.locator('.sm-preview-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'implemented-mobile-preview.png'), fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1080 });
  await page.evaluate(() => { Engine.state.player.coins = 0; UI.refreshAll('assets'); });
  check('Insufficient coins disables submit with the deficit', await page.locator('#ws-go').isDisabled() && /金币不足/.test(await page.locator('#ws-go').textContent()));
  await page.evaluate(() => { Engine.state.player.coins = 200000; UI.refreshAll('assets'); });
  await page.locator('#ws-go').click();
  check('Confirmation states guaranteed consumption and protection', /必定消耗/.test(await page.locator('.sm-confirm').textContent()) && /受残片保护/.test(await page.locator('.sm-confirm').textContent()));
  await page.locator('.confirm-modal .cf-actions button').last().click();
  await page.waitForFunction(() => document.querySelector('#ws-submit-error')?.textContent.includes('库存已变动'));
  check('Errors persist beside submit and draft remains retryable', await page.locator('#ws-go').isEnabled());
  check('Submission contains the reviewed ingredients', await page.evaluate(() => lastSmelt.mainId === fixtureMain && lastSmelt.subId === fixtureSub && lastSmelt.relics === 1 && lastSmelt.pearl === true && lastSmelt.materials[0].qty === 3));
  await page.evaluate(() => {
    Net.smelt = async () => ({ ok: true, data: { success: false, protectAffix: true, relics: 1, rate: 80, gold: 100,
      coins: 199900, inventory: Engine.state.inventory, invRev: 100, mainAfter: GameData.componentOf(fixtureMain) } });
  });
  await page.locator('#ws-go').click(); await page.locator('.confirm-modal .cf-actions button').last().click();
  await page.waitForFunction(() => document.querySelector('.cr-fail'));
  check('Failure result reads the actual server protectAffix field', /已被残片保护/.test(await page.locator('.cr-fail').textContent()));
  await page.locator('.cr-ok').click();
  check('Result resets draft and leaves the preview available', await page.locator('#ws-go').isDisabled() && await page.locator('.sm-preview-panel').isVisible());
  await pick('main', '龙骨'); await pick('sub', '碳素');
  await page.locator('.ws-aff[data-which="main"][data-type="speed"]').click();
  await page.locator('.ws-aff[data-which="sub"][data-type="skill"]').click();
  await page.locator('#ws-material-open').click();
  await material.fill('999');
  check('Material entry clamps to actual stock', await material.inputValue() === '12');
  await page.evaluate(() => {
    const id = document.querySelector('.ws-mat[data-affix="material"] input').dataset.mat;
    Engine.state.inventory[id] = 1; UI.refreshAll('assets');
  });
  check('Shrinking inventory clamps selected quantity', await material.inputValue() === '1');
  await page.keyboard.press('Escape');
  check('Escape closes material dialog', await page.locator('#ws-material-modal').count() === 0);
  await page.locator('#ws-relic-qty').fill('2');
  await page.locator('[data-unload="main"]').click();
  check('Removing main clears both slots', await page.locator('.ws-pick.chosen').count() === 0);
  await pick('main', '龙骨'); await pick('sub', '碳素');
  check('New main after removal resets relics to zero', await page.locator('#ws-relic-qty').inputValue() === '0');
  await page.locator('.ws-aff[data-which="main"][data-type="speed"]').click();
  await page.locator('.ws-aff[data-which="sub"][data-type="skill"]').click();
  await page.evaluate(() => { delete Engine.state.inventory[fixtureSub]; UI.refreshAll('assets'); });
  check('Consumed component is removed immediately from draft', await page.locator('.ws-pick.chosen[data-pick="sub"]').count() === 0 && await page.locator('#ws-go').isDisabled());
  await page.evaluate(() => { Engine.state.inventory[fixtureSub] = 1; UI.refreshAll('assets'); });
  await pick('sub', '碳素'); await page.locator('.ws-aff[data-which="sub"][data-type="skill"]').click();
  await page.evaluate(() => {
    Net.smelt = async () => ({ ok: true, data: { success: true, item: GameData.componentOf(fixtureMain), rate: 100,
      gold: 100, coins: 199800, inventory: { [fixtureMain]: 1 }, invRev: 101 } });
  });
  await page.locator('#ws-go').click(); await page.locator('.confirm-modal .cf-actions button').last().click();
  await page.waitForFunction(() => document.querySelector('.chest-result-modal .modal-title')?.textContent.includes('熔炼成功'));
  check('Successful response opens result and resets draft', await page.locator('.cr-ok').isVisible() && await page.locator('.ws-pick.chosen').count() === 0);
  check('No page errors', errors.length === 0);
  console.log('通过 ' + count + ' 项，失败 0 项');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); srv.close(); });
