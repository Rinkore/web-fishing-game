'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.route('http://settings.test/**', route => {
      const file = path.join(root, new URL(route.request().url()).pathname === '/' ? 'index.html' : new URL(route.request().url()).pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '') });
      return route.fulfill({ path: file });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    async function load() { await page.goto('http://settings.test/'); await page.evaluate(() => { document.querySelector('#auth').remove(); UI.renderNav(); UI.renderTopbar(); UI.renderView(); }); }
    await load();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('System reduced motion applies by default', await page.evaluate(() => PlayerSettings.motion() === 'reduced'));
    await page.click('#settings-btn');
    check('Accessible modal opens and focuses close', await page.evaluate(() => document.querySelector('#settings-dialog').open && document.activeElement.className === 'settings-close'));
    await page.selectOption('[data-setting=font]', 'clear');
    await page.selectOption('[data-setting=textSize]', 'large');
    check('Clear font and larger controls take effect', await page.evaluate(() => !getComputedStyle(document.querySelector('#settings-btn')).fontFamily.includes('FusionPixel') && getComputedStyle(document.querySelector('[data-setting=font]')).fontSize === '16px'));
    await page.selectOption('[data-setting=motion]', 'off');
    await page.selectOption('[data-setting=tips]', 'brief');
    await page.evaluate(() => { UI.toast('ordinary', 'routine'); });
    check('Routine toast suppressed', await page.locator('#toast').textContent() !== 'ordinary');
    await page.evaluate(() => UI.toast('交易失败：余额不足', true));
    check('Important toast preserved', await page.locator('#toast').textContent() === '交易失败：余额不足');
    await page.evaluate(() => { UI.showRecordBanner({ text: '纪录测试' }); Engine.state.banners = [{ id: 'settings-notice', content: '管理员公告', duration: 60 }]; UI.onBanners(); });
    await page.uncheck('[data-setting=records]');
    check('Record hidden but admin notice retained with correct offset', await page.evaluate(() => getComputedStyle(document.querySelector('#record-banner')).display === 'none' && document.querySelector('#notice-banner').classList.contains('show') && document.body.style.getPropertyValue('--banner-h') === '34px'));
    await page.keyboard.press('Escape');
    check('Escape closes and restores focus', await page.evaluate(() => !document.querySelector('#settings-dialog').open && document.activeElement.id === 'settings-btn'));
    await load();
    check('Preferences survive reload', await page.evaluate(() => PlayerSettings.get().font === 'clear' && PlayerSettings.get().textSize === 'large' && PlayerSettings.motion() === 'off' && !PlayerSettings.get().records));
    // Real canvas: static time stays fixed; animation resumes without remounting.
    await page.evaluate(() => { const el = document.createElement('div'); el.id = 'settings-scene'; el.style = 'position:fixed;left:0;top:150px;width:300px;height:160px'; document.body.appendChild(el); PxScene.mount(el, 'rapids'); });
    await page.waitForFunction(() => document.querySelector('#settings-scene').__pxscene.staticDrawn);
    const t = await page.evaluate(() => document.querySelector('#settings-scene').__pxscene.t);
    await page.evaluate(() => new Promise(resolve => { let n = 0; function tick() { if (++n === 8) resolve(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); }));
    check('Disabled decoration does not advance scene', await page.evaluate(t => document.querySelector('#settings-scene').__pxscene.t === t, t));
    await page.click('#settings-btn'); await page.selectOption('[data-setting=motion]', 'full');
    await page.waitForFunction(t => document.querySelector('#settings-scene').__pxscene.t > t, t);
    check('Full motion resumes existing scene', true);
    await page.evaluate(() => document.querySelector('#settings-scene').remove());
    for (const width of [1366, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      check('Large text dialog fits at ' + width, await page.evaluate(() => { const d = document.querySelector('#settings-dialog'), r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth + 1; }));
    }
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'shots/settings-mobile.png') });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({ path: path.join(__dirname, 'shots/settings-desktop.png') });
    await page.click('#settings-reset'); await page.click('#settings-reset-no');
    check('Cancel reset preserves choices', await page.evaluate(() => PlayerSettings.get().font === 'clear'));
    await page.click('#settings-reset'); await page.click('#settings-reset-yes');
    check('Reset restores defaults', await page.evaluate(() => PlayerSettings.get().font === 'pixel' && PlayerSettings.get().records && PlayerSettings.get().motion === 'system'));
    await page.evaluate(() => localStorage.setItem('fishing_preferences_v1', '{broken'));
    await load();
    check('Corrupt storage falls back safely', await page.evaluate(() => PlayerSettings.get().tips === 'all'));
    await page.evaluate(() => localStorage.setItem('fishing_preferences_v1', JSON.stringify({font:'injected',records:'false',motion:'invalid'})));
    await load();
    check('Invalid enum and boolean values rejected', await page.evaluate(() => PlayerSettings.get().font === 'pixel' && PlayerSettings.get().records && PlayerSettings.get().motion === 'system'));
    const other = await context.newPage(); await other.goto('http://settings.test/');
    await page.click('#settings-btn'); await page.selectOption('[data-setting=font]', 'clear');
    await other.waitForFunction(() => PlayerSettings.get().font === 'clear');
    check('Preferences synchronize across tabs', true);
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new Error('blocked'); }; });
    await page.selectOption('[data-setting=font]', 'pixel');
    check('Storage failure is visible and preference still applies', (await page.locator('#settings-status').textContent()).includes('无法保存') && await page.evaluate(() => PlayerSettings.get().font === 'pixel'));
    check('No page errors', errors.length === 0);
    console.log('通过 ' + count + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
