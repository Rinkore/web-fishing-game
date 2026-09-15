// 验证：图鉴材料页新贴图
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  const broken = [];
  p.on('response', r => { if (r.status() === 404 && !r.url().includes('favicon')) broken.push(r.url().split('/').slice(-2).join('/')); });
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'mat_' + Date.now().toString(36);
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
  await p.evaluate(() => [...document.querySelectorAll('.inv-cat')].find(x => x.textContent.includes('材料')).click());
  await new Promise(r => setTimeout(r, 600));
  const stats = await p.evaluate(() => {
    const icons = [...document.querySelectorAll('.codex-cell .cx-icon')];
    return {
      cells: document.querySelectorAll('.codex-cell').length,
      icons: icons.length,
      broken: icons.filter(i => !i.complete || i.naturalWidth === 0).length,
      names: [...document.querySelectorAll('.codex-cell .cx-name')].map(e => e.textContent),
    };
  });
  console.log(JSON.stringify(stats));
  await p.screenshot({ path: 'mats.png' });
  console.log('404:', broken.length ? broken : '无', '| JS 错误:', errors.length ? errors : '无');
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
