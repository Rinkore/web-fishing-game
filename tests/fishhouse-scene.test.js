'use strict';
// 渔屋独立场景测试：#fishhouse 与 #harbor 同级，进入/退出、物件点击、键盘、深链
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route('http://harbor.test/**', route => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '') });
      return route.fulfill({ path: file });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://harbor.test/');
    await page.evaluate(() => {
      Object.keys(window.Net || {}).forEach(k => { if (/^fetch/.test(k)) window.Net[k] = function () {}; });
      document.getElementById('auth').style.display = 'none';
      Engine.state.me = { name: 'tester', admin: false };
      Engine.state.features = {};
      Engine.state.house = { hours: 0, capacityHours: 24 };
      UI.renderTopbar(); UI.renderNav(); UI.renderView();
      HarborShell.syncShell();
    });
    await page.waitForTimeout(300);

    // ---- 渔屋独立场景：house-art.js 和 harbor.js 协作 ----
    check('HouseArt 渲染器已加载', await page.evaluate(() => !!window.HouseArt && !!window.HouseArt.makeLayers));
    check('HouseArt 定义了五个物件热区', await page.evaluate(() => window.HouseArt.DRAW_ORDER.length === 5));
    check('渔屋物件顺序：yard / breeding / pet / role / rod', await page.evaluate(() => {
      const keys = window.HouseArt.DRAW_ORDER;
      return keys[0] === 'yard' && keys[1] === 'breeding' && keys[2] === 'pet' && keys[3] === 'role' && keys[4] === 'rod';
    }));
    check('#fishhouse 初始隐藏，#harbor 可见', await page.evaluate(() =>
      document.getElementById('fishhouse').hidden === true && document.getElementById('harbor').hidden === false));

    // 打开渔屋（#/house），应进入独立场景，不直接开抽屉
    await page.evaluate(() => { location.hash = '#/house'; });
    await page.waitForTimeout(250);
    check('进入渔屋后场景可见', await page.evaluate(() => document.getElementById('fishhouse').hidden === false));
    // #fishhouse 是与 #harbor 同级的固定定位覆盖层：#harbor 不隐藏，由上层遮住。
    check('#fishhouse 覆盖在港湾之上', await page.evaluate(() => {
      const fh = document.getElementById('fishhouse');
      return getComputedStyle(fh).position === 'fixed' && getComputedStyle(fh).zIndex !== 'auto';
    }));
    check('body 标记 fishhouse-on', await page.evaluate(() => document.body.classList.contains('fishhouse-on')));
    check('屋内面板初始收起', await page.evaluate(() => document.getElementById('fh-panel').hidden === true));
    check('屋内画布存在且尺寸为 480×240', await page.evaluate(() => {
      const cv = document.querySelector('#fishhouse .h-house canvas');
      return !!cv && cv.width === 480 && cv.height === 240;
    }));
    check('五个物件热区按钮存在', await page.evaluate(() => document.querySelectorAll('#fishhouse .h-hot[data-house]').length === 5));
    check('#main 已移入 fh-pbody', await page.evaluate(() =>
      document.getElementById('fh-pbody').querySelector('#main') !== null));
    check('URL 为 #/house', await page.evaluate(() => location.hash === '#/house'));

    // 点击第一个物件（晒场）打开面板
    await page.click('#fishhouse .h-hot[data-house="yard"]');
    await page.waitForTimeout(250);
    check('点击物件后面板打开', await page.evaluate(() => document.getElementById('fh-panel').hidden === false));
    check('面板内是 #main 内容', await page.evaluate(() =>
      document.getElementById('fh-pbody').querySelector('#main') !== null));
    check('URL 更新为带页签序号', await page.evaluate(() => location.hash === '#/house/0'));
    check('标题显示「渔屋 · 晒场」', await page.evaluate(() => document.getElementById('fh-p-title').textContent.indexOf('晒场') > 0));
    check('面包屑显示「渔屋 › 晒场」', await page.evaluate(() => document.getElementById('fh-p-crumb').textContent.indexOf('晒场') > 0));
    check('对应物件热区标记为 active', await page.evaluate(() =>
      document.querySelector('#fishhouse .h-hot[data-house="yard"]').classList.contains('active')));

    // 点「回屋里」关面板
    await page.click('#fh-back');
    await page.waitForTimeout(250);
    check('点击「回屋里」后面板收起', await page.evaluate(() => document.getElementById('fh-panel').hidden === true));
    check('URL 回到 #/house', await page.evaluate(() => location.hash === '#/house'));
    check('active 标记已移除', await page.evaluate(() =>
      !document.querySelector('#fishhouse .h-hot[data-house="yard"]').classList.contains('active')));

    // 点另一个物件（宠物）切换面板内容
    await page.click('#fishhouse .h-hot[data-house="pet"]');
    await page.waitForTimeout(250);
    check('切换物件后面板重新打开', await page.evaluate(() => document.getElementById('fh-panel').hidden === false));
    check('URL 更新为宠物页签', await page.evaluate(() => location.hash === '#/house/2'));
    check('宠物热区标记为 active', await page.evaluate(() =>
      document.querySelector('#fishhouse .h-hot[data-house="pet"]').classList.contains('active')));
    check('晒场热区不再 active', await page.evaluate(() =>
      !document.querySelector('#fishhouse .h-hot[data-house="yard"]').classList.contains('active')));

    // Esc 逐层退出：先关面板，再回港湾
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('首次 Esc 关面板', await page.evaluate(() => document.getElementById('fh-panel').hidden === true));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('再次 Esc 回港湾', await page.evaluate(() =>
      location.hash === '#/' && document.getElementById('fishhouse').hidden === true));
    check('body 标记 fishhouse-on 已移除', await page.evaluate(() => !document.body.classList.contains('fishhouse-on')));

    // 深链 #/house/1 直接打开繁育面板
    await page.evaluate(() => { location.hash = '#/house/1'; });
    await page.waitForTimeout(300);
    check('深链进入时面板直接打开', await page.evaluate(() => document.getElementById('fh-panel').hidden === false));
    check('深链定位到繁育物件', await page.evaluate(() =>
      document.querySelector('#fishhouse .h-hot[data-house="breeding"]').classList.contains('active')));

    // 键盘快捷键 3 = 宠物（第三个物件）
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await page.keyboard.press('3');
    await page.waitForTimeout(250);
    check('数字键 3 打开宠物', await page.evaluate(() =>
      document.querySelector('#fishhouse .h-hot[data-house="pet"]').classList.contains('active')));

    // 晒场满仓红标
    await page.evaluate(() => { Engine.state.house.hours = 24; HarborShell.syncShell(); });
    await page.waitForTimeout(150);
    check('晒场满仓时显示红标', await page.evaluate(() => {
      const badge = document.querySelector('#fishhouse .h-hot[data-house="yard"] .h-badge');
      return !!badge && badge.textContent === '!';
    }));

    // 热区按物件名渲染挂签
    check('热区挂签渲染物件名', await page.evaluate(() => {
      const sign = document.querySelector('#fishhouse .h-hot[data-house="rod"] .h-sign');
      return !!sign && sign.textContent.indexOf('钓竿') >= 0;
    }));

    // 手机端面板全宽
    await page.setViewportSize({ width: 390, height: 820 });
    await page.waitForTimeout(200);
    const panelWidth = await page.evaluate(() => {
      const p = document.getElementById('fh-panel');
      return p ? p.getBoundingClientRect().width : 0;
    });
    check('手机端面板全屏（宽度 >= 370）', panelWidth >= 370);

    check('没有 JS 错误', errors.length === 0);
    console.log('\n✓ 渔屋独立场景：' + count + ' 项检查通过');
    if (errors.length) console.log('JS errors:', errors);
  } finally { await browser.close(); }
})().catch(e => { console.error('✗ FAIL:', e); process.exit(1); });
