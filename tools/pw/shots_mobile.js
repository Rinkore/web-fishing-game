const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2' });
  const user = 'pxm' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.tap('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.tap('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  await p.screenshot({ path: 'px_mobile.png' });
  const ok = await p.evaluate(() => ({
    authShown: getComputedStyle(document.getElementById('auth')).display !== 'none',
    overflow: document.body.scrollWidth > window.innerWidth + 1,
    scene: !!document.querySelector('.px-scene'),
  }));
  console.log(JSON.stringify(ok));
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
