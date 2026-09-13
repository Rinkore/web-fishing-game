// 截图验证：新的钓点点击交互与渔场实况
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8151;
const OUT = path.join(ROOT, 'tests', 'shots');
// 浏览器可执行文件：优先 CHROME_PATH 环境变量，否则用系统默认安装位置
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }) });
  await new Promise(r => setTimeout(r, 900));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const u = 'shot' + Math.floor(Math.random() * 10000);
    await page.click('#tab-register');
    await page.fill('#auth-user', u);
    await page.fill('#auth-pass', 'abcd1234');
    await page.fill('#auth-name', '截图钓手');
    await page.click('#auth-submit');
    await page.waitForTimeout(900);

    await page.screenshot({ path: path.join(OUT, '10-idle.png') });
    console.log('10-idle.png (未钓鱼)');

    // 点钓点 → 自动开始
    await page.click('.spot-btn');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '11-fishing-start.png') });
    const s1 = await page.textContent('.fish-state');
    console.log('11-fishing-start.png', JSON.stringify(s1.trim()));

    // 切换另一个钓点
    const btns = await page.$$('.spot-btn');
    if (btns.length > 1) { await btns[btns.length - 1].click(); await page.waitForTimeout(400); }
    await page.screenshot({ path: path.join(OUT, '12-switch-spot.png') });
    console.log('12-switch-spot.png', JSON.stringify((await page.textContent('.fish-state')).trim()));

    // 再点当前钓点 → 取消离开
    const cur = await page.$('.spot-btn.on');
    if (cur) { await cur.click(); await page.waitForTimeout(400); }
    await page.screenshot({ path: path.join(OUT, '13-cancelled.png') });
    console.log('13-cancelled.png', JSON.stringify((await page.textContent('.fish-state')).trim()));

    console.log('PAGE_ERRORS: ' + JSON.stringify(errs));
  } catch (e) {
    console.log('SHOT ERROR: ' + e.message.split('\n')[0]);
  } finally {
    if (browser) await browser.close();
    srv.kill();
    try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(0), 200);
  }
})();
