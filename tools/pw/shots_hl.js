const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'hl_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  await p.evaluate(() => {
    const n = [...document.querySelectorAll('.px-node')].find(x => x.textContent.includes('深水区'));
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 1500));
  const st = await p.evaluate(() => ({
    onCards: [...document.querySelectorAll('.g-card.on')].map(c => c.textContent.replace(/\s+/g, ' ').trim().slice(0, 12)),
    active: window.Engine.state.fishing.active,
  }));
  console.log(JSON.stringify(st));
  const el = await p.$('.fish-select');
  await p.screenshot({ path: 'hl.png', clip: await el.boundingBox() });
  console.log('JS 错误:', errors.length ? errors : '无');
  await b.close();
  process.exit(st.onCards.length === 1 && /静水湖/.test(st.onCards[0]) ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
