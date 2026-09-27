'use strict';
// 港湾外壳 · 设计稿 v2 阶段 A：HUD / 内景面板 / 目录列表 / 路由 / 界面风格设置，
// 以及评审 2026-09-27 定稿的默认值（时段 05:00/07:30/17:30/19:30、过渡 45、固定夜晚、招牌常显、手机自动）。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('http://harbor.test/**', route => {
      const file = path.join(root, new URL(route.request().url()).pathname === '/' ? 'index.html' : new URL(route.request().url()).pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '') });
      return route.fulfill({ path: file });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // 这是前端渲染套件：后端请求全部打桩，只验证外壳与设置行为
    async function load() {
      await page.goto('http://harbor.test/');
      await page.evaluate(() => {
        Object.keys(window.Net || {}).forEach(k => { if (/^fetch/.test(k)) window.Net[k] = function () {}; });
        document.getElementById('auth').style.display = 'none';
        Engine.state.me = { name: 'tester', admin: false };
        Engine.state.features = {};
        UI.renderTopbar(); UI.renderNav(); UI.renderView();
        HarborShell.syncShell();
      });
    }

    await load();
    check('默认界面风格是经典：不接管外壳', await page.evaluate(() => !document.body.classList.contains('harbor-on') && document.getElementById('harbor').hidden));
    check('设置项「界面风格」默认经典', await page.evaluate(() => PlayerSettings.get().theme === 'classic'));
    check('评审默认时段 05:00 / 07:30 / 17:30 / 19:30', await page.evaluate(() => {
      const p = HarborShell.defaults.periods;
      return p.dawn === '05:00' && p.day === '07:30' && p.dusk === '17:30' && p.night === '19:30';
    }));
    check('评审默认过渡 45 分钟', await page.evaluate(() => HarborShell.defaults.blend === 45));
    check('评审默认固定模式=夜晚', await page.evaluate(() => HarborShell.defaults.fixed === 'night'));
    check('评审默认建筑招牌=始终显示', await page.evaluate(() => HarborShell.defaults.signs === 'always'));
    check('评审默认手机布局=自动', await page.evaluate(() => HarborShell.defaults.mobile === 'auto'));
    check('评审默认时刻模式=跟随本地时间', await page.evaluate(() => HarborShell.defaults.timeMode === 'clock'));
    check('00:00 落在夜晚', await page.evaluate(() => HarborShell.periodAt(0).id === 'night'));
    check('05:00 进入清晨，且处在过渡窗口内', await page.evaluate(() => { const i = HarborShell.periodAt(300); return i.id === 'dawn' && !!i.blend && i.blend[0] === 'night' && i.blend[1] === 'dawn'; }));
    check('06:00 是清晨的非过渡区', await page.evaluate(() => { const i = HarborShell.periodAt(360); return i.id === 'dawn' && i.blend === null; }));
    check('08:30 是白天', await page.evaluate(() => { const i = HarborShell.periodAt(510); return i.id === 'day' && i.blend === null; }));
    check('17:30 进入黄昏', await page.evaluate(() => HarborShell.periodAt(1050).id === 'dusk'));
    check('19:30 进入夜晚并处在过渡窗口内', await page.evaluate(() => { const i = HarborShell.periodAt(1170); return i.id === 'night' && !!i.blend && i.blend[0] === 'dusk'; }));
    check('23:00 是夜晚的非过渡区', await page.evaluate(() => { const i = HarborShell.periodAt(1380); return i.id === 'night' && i.blend === null; }));

    await page.evaluate(() => PlayerSettings.set('theme', 'harbor'));
    check('切到港湾后接管外壳', await page.evaluate(() => document.body.classList.contains('harbor-on') && !document.getElementById('harbor').hidden));
    // 外壳由 ui.js 的渲染出口驱动（renderNav → HarborShell.syncNav），登录/切页后无需额外调用
    check('renderNav 出口会驱动外壳接管与还原', await page.evaluate(() => {
      document.body.classList.remove('harbor-on'); document.getElementById('harbor').hidden = true;
      UI.renderNav();
      return document.body.classList.contains('harbor-on') && !document.getElementById('harbor').hidden;
    }));
    check('经典外壳被收起（顶栏与侧栏不占位）', await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display === 'none' && getComputedStyle(document.querySelector('.layout')).display === 'none'));
    check('#main 搬进内景面板，页面渲染器不变', await page.evaluate(() => document.getElementById('main').parentElement.id === 'h-pbody'));
    check('目录直接复用 renderNav 的 #nav（含后台排序与红标）', await page.evaluate(() => document.getElementById('nav').parentElement.id === 'h-dir-body' && document.querySelectorAll('#h-dir-body .nav-item[data-feature]').length >= 10));
    check('#player-status 搬进港湾 HUD', await page.evaluate(() => document.getElementById('player-status').parentElement.id === 'h-status'));
    check('时间牌显示当前时段的图标与时间', await page.evaluate(() => /🌅|☀️|🌇|🌙/.test(document.querySelector('#h-tchip .h-ticon').textContent) && /\d{2}:\d{2}/.test(document.querySelector('#h-tchip .h-tlabel').textContent)));
    check('港湾首页停在目录（内景面板未打开）', await page.evaluate(() => document.getElementById('h-panel').hidden && !document.getElementById('h-dirbox').hidden));
    // 目录是叠在场景上的浮层，HUD 是上下两条独立区域：两者不能互相遮挡，
    // 否则港湾首页点不到「出海钓鱼 / 背包」（这正是重构前踩到的坑）。
    check('港湾首页：目录打开时 HUD 仍可点', await page.evaluate(() => {
      const c = document.getElementById('h-cast').getBoundingClientRect();
      const top = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
      const sheet = document.querySelector('.h-sheet').getBoundingClientRect();
      return !!(top && top.closest && top.closest('#h-cast')) && sheet.top >= document.querySelector('.h-hud-top').getBoundingClientRect().bottom - 1;
    }));

    await page.click('.h-dir-body .nav-item[data-feature="workshop"]');
    await page.waitForFunction(() => !document.getElementById('h-panel').hidden).catch(() => {});
    check('目录进入工坊：面板打开、标题与面包屑正确', await page.evaluate(() => !document.getElementById('h-panel').hidden && document.getElementById('h-p-title').textContent === '工坊' && document.getElementById('h-p-crumb').textContent === '港湾 › 工坊'));
    check('进入内景后目录收起，占位场景让位给面板', await page.evaluate(() => document.getElementById('h-dirbox').hidden && getComputedStyle(document.getElementById('h-scene')).display === 'none'));
    check('进入内景会同步哈希路由', await page.evaluate(() => location.hash === '#/workshop'));

    await page.click('#h-back');
    check('「回港湾」收起面板并恢复目录', await page.evaluate(() => document.getElementById('h-panel').hidden && !document.getElementById('h-dirbox').hidden && location.hash === '#/'));

    await page.evaluate(() => { location.hash = '#/inventory'; });
    await page.waitForFunction(() => !document.getElementById('h-panel').hidden).catch(() => {});
    check('哈希深链直接打开内景（#/inventory）', await page.evaluate(() => UI.getView() === 'inventory' && document.getElementById('h-p-title').textContent === '背包'));

    await page.click('#h-cast');
    await page.waitForFunction(() => UI.getView() === 'fishing').catch(() => {});
    check('HUD 出海钓鱼按钮切到钓鱼页', await page.evaluate(() => UI.getView() === 'fishing' && document.getElementById('h-p-title').textContent === '钓鱼'));
    check('出海按钮副标题反映当前状态', await page.evaluate(() => document.getElementById('h-cast-sub').textContent.length > 0));

    await page.evaluate(() => PlayerSettings.set('theme', 'classic'));
    check('切回经典：外壳、#main、#nav 与顶栏状态全部还原', await page.evaluate(() => !document.body.classList.contains('harbor-on') && document.getElementById('harbor').hidden &&
      document.getElementById('main').parentElement.classList.contains('layout') &&
      document.getElementById('nav').parentElement.classList.contains('sidebar') &&
      document.getElementById('player-status').parentElement.classList.contains('topbar')));
    check('还原后 #player-status 仍在 .topbar-actions 之前（视觉顺序不变）', await page.evaluate(() => {
      const bar = document.querySelector('.topbar'), s = document.getElementById('player-status'), a = document.querySelector('.topbar-actions');
      return !!(s.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) && s.parentElement === bar;
    }));
    check('经典界面下顶栏重新可见', await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display !== 'none'));

    // 港湾里的 HUD 状态块（金币 → 集市、位置 → 钓鱼）要走内景面板，不能只在后台换页
    await page.evaluate(() => PlayerSettings.set('theme', 'harbor'));
    await page.click('#h-status .coins[data-view="mall"]');
    await page.waitForFunction(() => !document.getElementById('h-panel').hidden).catch(() => {});
    check('HUD 金币块打开集市内景', await page.evaluate(() => UI.getView() === 'mall' && document.getElementById('h-p-title').textContent === '商城'));
    await page.keyboard.press('l');
    check('L 键打开目录（列表模式）', await page.evaluate(() => !document.getElementById('h-dirbox').hidden));
    await page.keyboard.press('Escape');
    check('Esc 先收起目录再回港湾', await page.evaluate(() => document.getElementById('h-dirbox').hidden && !document.getElementById('h-panel').hidden));
    await page.click('#h-back');
    await page.evaluate(() => PlayerSettings.set('theme', 'classic'));

    for (const width of [1440, 880, 390]) {
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate(() => PlayerSettings.set('theme', 'harbor'));
      check('港湾外壳在 ' + width + ' 宽不溢出视口', await page.evaluate(() => { const r = document.getElementById('harbor').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }));
      await page.evaluate(() => PlayerSettings.set('theme', 'classic'));
    }
    await page.setViewportSize({ width: 390, height: 820 });
    await page.evaluate(() => PlayerSettings.set('theme', 'harbor'));
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'shots/harbor-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(__dirname, 'shots/harbor-desktop.png') });

    check('无页面错误', errors.length === 0);
    console.log('通过 ' + count + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
