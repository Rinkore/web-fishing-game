'use strict';
// 港湾外壳 · 设计稿 v2 阶段 C/D/E：时段设置（固定模式 / 时段编辑器 / 混合过渡）、
// 手机布局（横向全景 / 罗盘首页 / 自动）与「港湾成为默认界面风格」。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 820 } });
    // 固定浏览器本地时间到 19:00，让时段断言与真实时间、机器时区无关（19:00 在默认设置下是「黄昏」）
    await context.addInitScript(() => {
      const fixed = new Date(2026, 8, 28, 19, 0, 0).getTime(), RealDate = Date;
      function FakeDate() { return arguments.length ? new RealDate(...arguments) : new RealDate(fixed); }
      FakeDate.prototype = RealDate.prototype;
      FakeDate.now = function () { return fixed; };
      FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
      window.Date = FakeDate;
    });
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
      HarborShell.syncShell();
    });
    await page.waitForTimeout(300);
    const labelText = () => page.evaluate(() => document.querySelector('#h-tchip .h-tlabel').textContent);

    // ---- 阶段 E：港湾是默认界面风格 ----
    check('默认界面风格是港湾', await page.evaluate(() => PlayerSettings.get().theme === 'harbor' && document.body.classList.contains('harbor-on')));
    check('19:00 在默认时段里是黄昏', await page.evaluate(() => HarborShell.periodAt(19 * 60).id === 'dusk'));
    check('HUD 时间牌跟随本地时钟显示时刻', (await labelText()).indexOf('黄昏') === 0);

    // ---- 阶段 C：设置里的港湾时间 ----
    await page.evaluate(() => PlayerSettings.open());
    check('港湾风格下「港湾时间」整块可见', await page.evaluate(() => { const el = document.getElementById('settings-harbor-time'); return !el.hidden && getComputedStyle(el).display !== 'none'; }));
    // v4 F5：经典界面已移除，界面风格 select 不再存在于设置对话框，跳过切换测试
    check('切回港湾后设置块恢复', await page.evaluate(() => getComputedStyle(document.getElementById('settings-harbor-time')).display !== 'none'));

    // 固定模式：HUD 与画面都切到该时段，编辑器禁用
    await page.check('#settings-dialog input[name=timeMode][value=day]');
    await page.waitForTimeout(250);
    check('固定白天：HUD 写「固定白天」', await page.evaluate(() => document.querySelector('#h-tchip .h-tlabel').textContent === '固定白天' && document.querySelector('#h-tchip .h-ticon').textContent === '☀️'));
    check('固定白天：场景改用白天调色板', await page.evaluate(() => {
      const bg = getComputedStyle(document.querySelector('#h-scene .h-pan')).backgroundImage;
      return bg.indexOf('58, 134, 212') >= 0 || bg.indexOf('#3a86d4') >= 0;
    }));
    check('固定模式下时段编辑器被禁用', await page.evaluate(() => {
      const times = Array.prototype.slice.call(document.querySelectorAll('#settings-periods input[type=time]'));
      return times.length === 4 && times.every(i => i.disabled) && document.getElementById('settings-reset-periods').disabled;
    }));
    await page.check('#settings-dialog input[name=timeMode][value=clock]');
    await page.waitForTimeout(250);
    check('切回跟随时钟：时间牌恢复为时段 + 时刻', /^黄昏 \d{2}:\d{2}$/.test(await labelText()));

    // 时段编辑器：先写错（白天早于清晨）→ 报错且不落盘
    await page.fill('#settings-periods input[data-period=day]', '03:00');
    check('时段顺序错误：报错且不保存', await page.evaluate(() => document.getElementById('settings-harbor-err').textContent.length > 0 && PlayerSettings.get().periods.day === '07:30'));
    // 有效改动：夜晚提前到 18:30（距黄昏 60 分钟 ≥ 过渡 45），19:00 立刻变成夜晚
    await page.fill('#settings-periods input[data-period=night]', '18:30');
    await page.waitForTimeout(250);
    check('有效时段改动：落盘并让 HUD / 时段表立刻生效', await page.evaluate(() => PlayerSettings.get().periods.night === '18:30' && HarborShell.periodAt(19 * 60).id === 'night'));
    check('HUD 时间牌读的是玩家改过的时段', (await labelText()).indexOf('夜晚') === 0);
    // 过渡放大到 60 分钟后，45 分钟的间隔不再合法 → 报错且过渡不落盘
    await page.fill('#settings-periods input[data-period=night]', '18:15');
    await page.waitForTimeout(200);
    check('45 分钟间隔在 45 分钟过渡下仍然合法', await page.evaluate(() => PlayerSettings.get().periods.night === '18:15'));
    await page.selectOption('#settings-periods select[data-setting=blend]', '60');
    check('过渡放大到 60：间隔不足会报错且不保存', await page.evaluate(() => document.getElementById('settings-harbor-err').textContent.length > 0 && PlayerSettings.get().blend === 45));
    await page.click('#settings-reset-periods');
    check('「恢复默认」把时段与过渡一起还原', await page.evaluate(() => {
      const p = PlayerSettings.get();
      return p.blend === 45 && p.periods.dawn === '05:00' && p.periods.day === '07:30' && p.periods.dusk === '17:30' && p.periods.night === '19:30';
    }));
    await page.evaluate(() => document.getElementById('settings-dialog').close());
    await page.waitForTimeout(200);

    // ---- 阶段 D：手机布局 ----
    await page.evaluate(() => PlayerSettings.set('mobile', 'panorama'));
    await page.waitForTimeout(250);
    check('手机 + 横向全景：场景可见、没有罗盘首页', await page.evaluate(() => {
      return !document.getElementById('harbor').classList.contains('h-compass-home') &&
        document.getElementById('h-scene').classList.contains('h-phone') &&
        getComputedStyle(document.getElementById('h-scene')).display !== 'none' &&
        getComputedStyle(document.getElementById('h-home')).display === 'none';
    }));
    await page.evaluate(() => PlayerSettings.set('mobile', 'compass'));
    await page.waitForTimeout(300);
    check('选「罗盘首页」后无需 resize 就切换过去', await page.evaluate(() => document.getElementById('harbor').classList.contains('h-compass-home') && getComputedStyle(document.getElementById('h-home')).display !== 'none'));
    check('罗盘首页时隐藏滚动场景（省电）', await page.evaluate(() => getComputedStyle(document.getElementById('h-scene')).display === 'none'));
    check('地点磁贴与目录条目一一对应', await page.evaluate(() => {
      const tiles = document.querySelectorAll('#h-home-tiles .h-home-tile');
      return tiles.length === GameData.NAV.length && Array.prototype.every.call(tiles, b => b.getAttribute('aria-label').length > 0);
    }));
    check('条带画布画出了场景中段', await page.evaluate(() => {
      const c = document.getElementById('h-strip'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      return n > c.width * c.height * .9;
    }));
    await page.evaluate(() => {
      const tile = Array.prototype.find.call(document.querySelectorAll('#h-home-tiles .h-home-tile'), b => b.textContent.indexOf('工坊') >= 0);
      tile.click();
    });
    await page.waitForFunction(() => !document.getElementById('h-panel').hidden).catch(() => {});
    check('点磁贴进入对应内景', await page.evaluate(() => UI.getView() === 'workshop' && document.getElementById('h-p-title').textContent === '工坊'));
    await page.click('#h-back');
    await page.waitForTimeout(250);
    check('回港湾后仍在罗盘首页', await page.evaluate(() => document.getElementById('harbor').classList.contains('h-compass-home') && document.getElementById('h-panel').hidden));
    // 放宽到桌面宽度：必须立刻回到整幅场景，不能卡在罗盘首页
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForTimeout(400);
    check('放大到桌面后回到全景场景（不卡在罗盘首页）', await page.evaluate(() => {
      return !document.getElementById('harbor').classList.contains('h-compass-home') &&
        getComputedStyle(document.getElementById('h-scene')).display !== 'none' &&
        getComputedStyle(document.getElementById('h-home')).display === 'none';
    }));
    // 自动 + 减少动效 = 罗盘首页（省电）
    await page.setViewportSize({ width: 390, height: 820 });
    await page.evaluate(() => { PlayerSettings.set('mobile', 'auto'); PlayerSettings.set('motion', 'reduced'); });
    await page.waitForTimeout(300);
    check('自动 + 减少动效：改用罗盘首页', await page.evaluate(() => document.getElementById('harbor').classList.contains('h-compass-home')));
    await page.evaluate(() => PlayerSettings.set('motion', 'system'));
    await page.waitForTimeout(300);
    check('恢复完整动效：自动布局回到横向全景', await page.evaluate(() => !document.getElementById('harbor').classList.contains('h-compass-home') && document.getElementById('h-scene').classList.contains('h-phone')));

    check('无页面错误', errors.length === 0);
    console.log('通过 ' + count + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
