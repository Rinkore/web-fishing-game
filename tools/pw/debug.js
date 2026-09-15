const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'icon_test_' + Date.now().toString(36);
  await page.type('#auth-user', user);
  await page.type('#auth-pass', 'test1234');
  const tabRegister = await page.$('[data-tab="register"]');
  if (tabRegister) await page.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await page.type('#auth-pass2', 'test1234');
  await page.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  const st = await page.evaluate(() => ({
    authShown: getComputedStyle(document.getElementById('auth')).display !== 'none',
    mainHtml: document.getElementById('main').innerHTML.slice(0, 200),
    navItems: [...document.querySelectorAll('.nav-item')].map(b => b.textContent.trim()),
    toast: (document.getElementById('toast') || {}).textContent || '',
  }));
  console.log(JSON.stringify(st, null, 2));
  console.log('errors:', errors);
  await page.screenshot({ path: 'debug.png' });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
