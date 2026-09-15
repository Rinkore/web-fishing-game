// 验证：图鉴钓点页出现霜月冰湖锁定卡
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'ice_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('图鉴')).click());
  await new Promise(r => setTimeout(r, 800));
  await p.evaluate(() => [...document.querySelectorAll('.inv-cat')].find(x => x.textContent.includes('钓点')).click());
  await new Promise(r => setTimeout(r, 600));
  const stats = await p.evaluate(() => ({
    cells: document.querySelectorAll('.codex-cell.k-spots').length,
    frost: !!([...document.querySelectorAll('.codex-cell.k-spots')].find(c => c.textContent.includes('霜月冰湖'))),
    frostIcon: (() => {
      const c = [...document.querySelectorAll('.codex-cell.k-spots')].find(c => c.textContent.includes('霜月冰湖'));
      const img = c && c.querySelector('.cx-icon');
      return img ? (img.complete && img.naturalWidth > 0 ? img.src.split('/').pop() : 'broken') : null;
    })(),
    tab: [...document.querySelectorAll('.inv-cat')].find(x => x.textContent.includes('钓点')).textContent.trim(),
  }));
  console.log(JSON.stringify(stats));
  await p.screenshot({ path: 'ice_codex.png' });
  console.log('JS 错误:', errors.length ? errors : '无');
  await b.close();
  process.exit(stats.frost && stats.frostIcon === 'frostmoon.png' ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
