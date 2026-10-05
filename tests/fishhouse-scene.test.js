'use strict';
// 渔屋场景化内景测试：480×240 屋内画面 + 点击物件打开右侧抽屉
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

    // ---- 渔屋场景化内景：house-art.js 和 harbor.js 协作 ----
    check('HouseArt 渲染器已加载', await page.evaluate(() => !!window.HouseArt && !!window.HouseArt.makeLayers));
    check('HouseArt 定义了五个物件热区', await page.evaluate(() => window.HouseArt.DRAW_ORDER.length === 5));
    check('渔屋物件顺序：yard / breeding / pet / role / rod', await page.evaluate(() => {
      const keys = window.HouseArt.DRAW_ORDER;
      return keys[0] === 'yard' && keys[1] === 'breeding' && keys[2] === 'pet' && keys[3] === 'role' && keys[4] === 'rod';
    }));

    // 打开渔屋（#/character），应该先进屋内场景，不直接开抽屉
    await page.evaluate(() => { location.hash = '#/character'; });
    await page.waitForTimeout(200);
    check('进入渔屋后面板打开', await page.evaluate(() => !document.getElementById('h-panel').hidden));
    check('渔屋场景模式已激活', await page.evaluate(() => document.getElementById('h-panel').classList.contains('h-house-mode')));
    check('抽屉初始收起（未打开功能）', await page.evaluate(() => !document.getElementById('h-panel').classList.contains('h-drawer-open')));
    check('屋内画布存在且可见', await page.evaluate(() => {
      const cv = document.querySelector('.h-house canvas');
      return cv && cv.width === 480 && cv.height === 240;
    }));
    check('五个物件热区按钮存在', await page.evaluate(() => document.querySelectorAll('.h-house .h-hot[data-house]').length === 5));
    check('木梁标题显示「渔屋」', await page.evaluate(() => document.getElementById('h-p-title').textContent === '渔屋'));
    check('返回按钮显示「回港湾」', await page.evaluate(() => document.getElementById('h-back').textContent === '↩ 回港湾'));
    check('页签挂签已隐藏', await page.evaluate(() => document.getElementById('h-tabs').innerHTML === ''));

    // 点击第一个物件（晒场）打开抽屉
    await page.click('.h-house .h-hot[data-house="yard"]');
    await page.waitForTimeout(200);
    check('点击物件后抽屉打开', await page.evaluate(() => document.getElementById('h-panel').classList.contains('h-drawer-open')));
    check('抽屉内是 #main 内容', await page.evaluate(() => {
      const pbody = document.getElementById('h-pbody');
      return pbody && pbody.querySelector('#main') !== null;
    }));
    check('URL 更新为带页签序号', await page.evaluate(() => location.hash === '#/character/0'));
    check('木梁标题显示「渔屋 · 晒场」', await page.evaluate(() => document.getElementById('h-p-title').textContent.indexOf('晒场') > 0));
    check('返回按钮变为「回屋里」', await page.evaluate(() => document.getElementById('h-back').textContent === '↩ 回屋里'));
    check('对应物件热区标记为 active', await page.evaluate(() => document.querySelector('.h-house .h-hot[data-house="yard"]').classList.contains('active')));

    // 点「回屋里」关抽屉
    await page.click('#h-back');
    await page.waitForTimeout(200);
    check('点击「回屋里」后抽屉收起', await page.evaluate(() => !document.getElementById('h-panel').classList.contains('h-drawer-open')));
    check('URL 回到 #/character', await page.evaluate(() => location.hash === '#/character'));
    check('木梁标题恢复为「渔屋」', await page.evaluate(() => document.getElementById('h-p-title').textContent === '渔屋'));
    check('返回按钮恢复为「回港湾」', await page.evaluate(() => document.getElementById('h-back').textContent === '↩ 回港湾'));
    check('active 标记已移除', await page.evaluate(() => !document.querySelector('.h-house .h-hot[data-house="yard"]').classList.contains('active')));

    // 点另一个物件（宠物）切换抽屉内容
    await page.click('.h-house .h-hot[data-house="pet"]');
    await page.waitForTimeout(200);
    check('切换物件后抽屉重新打开', await page.evaluate(() => document.getElementById('h-panel').classList.contains('h-drawer-open')));
    check('URL 更新为宠物页签', await page.evaluate(() => location.hash === '#/character/2'));
    check('宠物热区标记为 active', await page.evaluate(() => document.querySelector('.h-house .h-hot[data-house="pet"]').classList.contains('active')));
    check('晒场热区不再 active', await page.evaluate(() => !document.querySelector('.h-house .h-hot[data-house="yard"]').classList.contains('active')));

    // Esc 逐层退出：先关抽屉，再回港湾
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('首次 Esc 关抽屉', await page.evaluate(() => !document.getElementById('h-panel').classList.contains('h-drawer-open')));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('再次 Esc 回港湾', await page.evaluate(() => location.hash === '#/' && document.getElementById('h-panel').hidden));
    check('渔屋场景模式已退出', await page.evaluate(() => !document.getElementById('h-panel').classList.contains('h-house-mode')));

    // 深链 #/character/1 直接打开繁育抽屉
    await page.evaluate(() => { location.hash = '#/character/1'; });
    await page.waitForTimeout(200);
    check('深链进入时抽屉直接打开', await page.evaluate(() => document.getElementById('h-panel').classList.contains('h-drawer-open')));
    check('深链定位到繁育页签', await page.evaluate(() => document.querySelector('.h-house .h-hot[data-house="breeding"]').classList.contains('active')));

    // 键盘快捷键 3 = 宠物（第三个物件）
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    await page.keyboard.press('3');
    await page.waitForTimeout(200);
    check('数字键 3 打开宠物', await page.evaluate(() => document.querySelector('.h-house .h-hot[data-house="pet"]').classList.contains('active')));

    // 晒场满仓红标
    await page.evaluate(() => { Engine.state.house.hours = 24; HarborShell.syncShell(); });
    await page.waitForTimeout(100);
    check('晒场满仓时显示红标', await page.evaluate(() => {
      const badge = document.querySelector('.h-house .h-hot[data-house="yard"] .h-badge');
      return badge && badge.textContent === '!';
    }));

    // 手机端全屏抽屉
    await context.setViewportSize({ width: 390, height: 820 });
    await page.waitForTimeout(100);
    const drawerWidth = await page.evaluate(() => {
      const pbody = document.getElementById('h-pbody');
      return pbody ? pbody.getBoundingClientRect().width : 0;
    });
    check('手机端抽屉全屏（宽度 >= 370）', drawerWidth >= 370);

    check('没有 JS 错误', errors.length === 0);
    console.log('\n✓ 渔屋场景化内景：' + count + ' 项检查通过');
    if (errors.length) console.log('JS errors:', errors);
  } finally { await browser.close(); }
})().catch(e => { console.error('✗ FAIL:', e); process.exit(1); });
