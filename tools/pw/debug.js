const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2' });
  const user = 'dbg' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  const info = await p.evaluate(() => ({
    bar: !!document.querySelector('.px-grounds'),
    cards: document.querySelectorAll('.g-card').length,
    leftKids: [...document.querySelector('.fish-select').children].map(c => c.className),
  }));
  console.log(JSON.stringify(info, null, 2));
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
