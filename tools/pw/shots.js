const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  // 桌面：开始钓鱼后的场景状态
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  await page.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'px2_' + Date.now().toString(36);
  await page.type('#auth-user', user);
  await page.type('#auth-pass', 'test1234');
  await page.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await page.type('#auth-pass2', 'test1234');
  await page.type('#auth-qq', '12345678');
  await page.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  // 点击「老旧码头」开始钓鱼
  await page.evaluate(() => {
    [...document.querySelectorAll('.spot-btn')].find(b => b.textContent.includes('老旧码头')).click();
  });
  await new Promise(r => setTimeout(r, 1500));
  const sceneState = await page.evaluate(() => document.querySelector('.px-scene').getAttribute('data-active'));
  console.log('钓鱼激活后场景 data-active =', sceneState);
  const sceneBox = await (await page.$('.px-scene')).boundingBox();
  await page.screenshot({ path: 'px_active.png', clip: { x: sceneBox.x - 10, y: sceneBox.y - 10, width: sceneBox.width + 20, height: sceneBox.height + 40 } });
  await page.close();

  // 手机端：登录页 + 钓鱼页
  const mob = await browser.newPage();
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  await mob.type('#auth-user', 'px_' + user);
  await mob.type('#auth-pass', 'test1234');
  await mob.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await mob.type('#auth-pass2', 'test1234');
  await mob.type('#auth-qq', '12345678');
  await mob.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  await mob.screenshot({ path: 'px_mobile.png' });
  const mobErr = await mob.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1);
  console.log('手机端无横向溢出:', mobErr);
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
