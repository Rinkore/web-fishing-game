'use strict';
// 港湾外壳 · 设计稿 v2 阶段 B：港湾场景（画布）、建筑热区与状态、告示板、罗盘与快捷键、手机全景、减少动效。
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
      UI.renderTopbar(); UI.renderNav(); UI.renderView();
      PlayerSettings.set('theme', 'harbor');
    });
    await page.waitForTimeout(300);
    const sceneRef = () => page.evaluate(() => { const c = document.querySelector('#h-scene canvas'); return c ? c.toDataURL() : ''; });

    // ---- 场景与缩放 ----
    check('港湾首页画出场景画布（480×240 原生像素）', await page.evaluate(() => { const c = document.querySelector('#h-scene canvas'); return !!c && c.width === 480 && c.height === 240; }));
    check('画布不是空白', await page.evaluate(() => { const c = document.querySelector('#h-scene canvas'), d = c.getContext('2d').getImageData(0, 0, 480, 240).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 480 * 240 * .9; }));
    check('桌面：整数倍缩放且整幅放得下', await page.evaluate(() => {
      const w = document.querySelector('.h-world'), s = document.getElementById('h-scene').getBoundingClientRect();
      const k = w.offsetWidth / 480; return Number.isInteger(k) && k >= 1 && w.offsetHeight === 240 * k && w.offsetWidth <= s.width && w.offsetHeight <= s.height;
    }));

    // ---- 热区 ----
    check('10 个建筑热区都是真按钮', await page.evaluate(() => document.querySelectorAll('#h-scene button.h-hot[data-place]').length === 10));
    check('热区有读屏名称（地点 + 内容）', await page.evaluate(() => /^工坊：装备成长/.test(document.querySelector('.h-hot[data-place=workshop]').getAttribute('aria-label'))));
    check('画布对读屏隐藏', await page.evaluate(() => document.querySelector('#h-scene canvas').getAttribute('aria-hidden') === 'true'));
    check('热区没有沾上全局按钮描边', await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.h-hot[data-place=inventory]')); return c.backgroundColor === 'rgba(0, 0, 0, 0)' && c.borderTopColor === 'rgba(0, 0, 0, 0)'; }));
    await page.click('.h-hot[data-place=workshop]');
    check('点工坊热区打开工坊内景', await page.evaluate(() => UI.getView() === 'workshop' && !document.getElementById('h-panel').hidden && location.hash === '#/workshop'));
    await page.click('#h-back');
    check('回港湾后焦点还给工坊热区', await page.evaluate(() => document.activeElement && document.activeElement.dataset.place === 'workshop'));

    // ---- 状态与徽标（读 renderNav 的 #nav，与经典侧栏同一套规则）----
    await page.evaluate(() => { Engine.state.mailUnread = 3; UI.renderNav(); });
    check('新邮件：邮筒热区出现数字徽标', await page.evaluate(() => { const b = document.querySelector('.h-hot[data-place=mail] .h-badge'); return !!b && b.textContent === '3'; }));
    check('徽标写进读屏名称', await page.evaluate(() => /3 条提醒/.test(document.querySelector('.h-hot[data-place=mail]').getAttribute('aria-label'))));
    check('新邮件：场景状态 mail = 3（邮筒小旗升起）', await page.evaluate(() => HarborShell.sceneState().mail === 3));
    const before = await sceneRef();
    await page.evaluate(() => { Engine.state.fishing.active = true; UI.renderNav(); });
    check('钓鱼中：场景状态与栈桥「钓」徽标', await page.evaluate(() => HarborShell.sceneState().fishing && document.querySelector('.h-hot[data-place=fishing] .h-badge').textContent === '钓'));
    await page.waitForTimeout(200);
    check('状态变化后场景重画', (await sceneRef()) !== before);

    await page.evaluate(() => { Engine.state.features = { workshop: false }; UI.renderNav(); });
    check('功能关闭：工坊热区显示锁定', await page.evaluate(() => document.querySelector('.h-hot[data-place=workshop]').classList.contains('locked') && HarborShell.sceneState().locked.workshop === true));
    await page.click('.h-hot[data-place=workshop]');
    check('锁定的建筑点了不进内景', await page.evaluate(() => document.getElementById('h-panel').hidden));
    await page.evaluate(() => { Engine.state.features = {}; UI.renderNav(); });
    check('功能恢复后解除锁定', await page.evaluate(() => !document.querySelector('.h-hot[data-place=workshop]').classList.contains('locked')));

    // ---- 告示板（v3 F3：改为内景面板，不再弹选择浮层） ----
    await page.click('.h-hot[data-place=board]');
    check('告示板直接打开内景面板，页签含五个子视图', await page.evaluate(() => {
      const panel = document.getElementById('h-panel');
      const tabs = document.querySelectorAll('#h-tabs button[role=tab]');
      // 告示板是一个地点 + 五个挂签页签；视图 id 是 board，首屏默认「图鉴」
      return !panel.hidden && tabs.length === 5 && UI.getView() === 'board';
    }));
    check('告示板内景面板显示「图鉴」为第一个选中页签', await page.evaluate(() => {
      const first = document.querySelector('#h-tabs button[role=tab]');
      return first && first.getAttribute('aria-selected') === 'true';
    }));
    await page.click('#h-back');

    // ---- 罗盘与快捷键 ----
    await page.locator('.h-hot[data-place=inventory]').focus();
    await page.keyboard.press('c');
    const menu = await page.evaluate(() => GameFeatures.orderedMenu((Engine.state.featureOrder || {}).menu).filter(id => GameData.NAV.some(n => n.id === id)));
    check('C 打开罗盘，条目按后台菜单顺序', await page.evaluate(m => !document.getElementById('h-compass').hidden && [...document.querySelectorAll('#h-ring .h-cmp-item span')].map(s => s.textContent).join('|') === m.map(id => GameData.NAV.find(n => n.id === id).name).join('|'), menu));
    check('罗盘打开后焦点落在第一个条目', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('h-cmp-item')));
    await page.keyboard.press('Escape');
    check('Esc 关闭罗盘，焦点回到打开前的位置', await page.evaluate(() => document.getElementById('h-compass').hidden && document.activeElement.dataset.place === 'inventory'));
    await page.keyboard.press('3');
    check('数字键 3 直达菜单第 3 项', await page.evaluate(m => UI.getView() === m[2] && !document.getElementById('h-panel').hidden, menu));
    await page.keyboard.press('Escape');
    check('Esc 从内景回港湾', await page.evaluate(() => document.getElementById('h-panel').hidden));
    await page.click('#h-compass-btn');
    await page.click('#h-ring .h-cmp-item:nth-of-type(2)');
    check('罗盘里点条目进入对应内景', await page.evaluate(m => UI.getView() === m[1] && document.getElementById('h-compass').hidden, menu));
    await page.click('#h-back');

    // ---- 减少动效：不再逐帧动画 ----
    await page.evaluate(() => PlayerSettings.set('motion', 'full'));
    const a1 = await sceneRef(); await page.waitForTimeout(400); const a2 = await sceneRef();
    check('完整动效：场景在动', a1 !== a2);
    await page.evaluate(() => PlayerSettings.set('motion', 'off'));
    await page.waitForTimeout(200);
    const b1 = await sceneRef(); await page.waitForTimeout(500); const b2 = await sceneRef();
    check('关闭动效：场景静止', b1 === b2);
    await page.evaluate(() => PlayerSettings.set('motion', 'system'));

    // ---- 手机：横向全景 ----
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    check('手机：整数倍缩放、画面比视口宽、可横向滑动', await page.evaluate(() => {
      const pan = document.querySelector('.h-pan'), w = document.querySelector('.h-world');
      return document.getElementById('h-scene').classList.contains('h-phone') && Number.isInteger(w.offsetWidth / 480) && pan.scrollWidth > pan.clientWidth;
    }));
    check('手机：打开时滚到栈桥附近', await page.evaluate(() => { const pan = document.querySelector('.h-pan'); return pan.scrollLeft > 0; }));
    check('手机：港湾不溢出视口', await page.evaluate(() => { const r = document.getElementById('harbor').getBoundingClientRect(); return r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }));
    check('手机：HUD 状态块排成一行', await page.evaluate(() => { const c = [...document.querySelectorAll('#h-status .meta')].map(e => e.getBoundingClientRect().top); return c.length > 1 && Math.max(...c) - Math.min(...c) < 4; }));
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'shots/harbor-b-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(__dirname, 'shots/harbor-b-desktop.png') });
    await page.evaluate(() => PlayerSettings.set('timeMode', 'day'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(__dirname, 'shots/harbor-b-day.png') });

    // v4 F5：经典界面已移除，港湾始终开启，不再测试切回经典
    check('无页面错误', errors.length === 0);
    console.log('通过 ' + count + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
