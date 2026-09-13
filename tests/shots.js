// 真实 Chromium 截图验证登录/注册界面
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8131;
const OUT = path.join(ROOT, 'tests', 'shots');
// 浏览器可执行文件：优先 CHROME_PATH 环境变量，否则用系统默认安装位置
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }) });
  await new Promise(r => setTimeout(r, 900));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });

    // 1) 登录界面
    await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, '01-login.png') });
    console.log('shot 01-login.png');

    // 2) 注册 tab
    await page.click('#tab-register');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '02-register.png') });
    console.log('shot 02-register.png');

    // 3) 真实注册并进入游戏
    const uname = 'demouser' + Math.floor(Math.random() * 1000);
    await page.fill('#auth-user', uname);
    await page.fill('#auth-pass', 'abcd1234');
    await page.fill('#auth-name', '演示钓手');
    await page.click('#auth-submit');
    await page.waitForTimeout(900);
    const overlayHidden = await page.evaluate(() => document.getElementById('auth').style.display === 'none');
    console.log('注册后进入游戏:', overlayHidden);
    await page.screenshot({ path: path.join(OUT, '03-in-game.png') });
    console.log('shot 03-in-game.png');

    // 4) 选点开始钓鱼
    await page.click('.spot-btn');
    await page.waitForTimeout(200);
    await page.click('.fish-ctrl .primary');
    await page.waitForTimeout(3600);
    await page.screenshot({ path: path.join(OUT, '04-fishing.png') });
    console.log('shot 04-fishing.png');

    // 5) 钓竿 BD 视图
    await page.click('#nav .nav-item:nth-child(2)');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '05-bd.png') });
    console.log('shot 05-bd.png');

    // 6) 锁定入口点击提示
    await page.click('#nav .nav-item.locked');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '06-locked-toast.png') });
    console.log('shot 06-locked-toast.png');

    // 控制台错误检查
    console.log('PAGE_ERRORS: ' + JSON.stringify(consoleErrors));
    console.log('RESULT: ' + (overlayHidden && consoleErrors.length === 0 ? 'OK' : 'CHECK'));
  } catch (e) {
    console.log('SHOT ERROR: ' + e.message.split('\n')[0]);
  } finally {
    if (browser) await browser.close();
    srv.kill();
    try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(0), 200);
  }
})();
