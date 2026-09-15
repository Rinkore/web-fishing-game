// 验证：地图渔夫标记可见性（含激活钓鱼状态）
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1.5 });
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'fsh_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  await p.evaluate(() => {
    const n = [...document.querySelectorAll('.px-node')].find(x => x.textContent.includes('老旧码头'));
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 1500));
  const info = await p.evaluate(() => {
    const f = document.querySelector('.pn-fisher');
    if (!f) return { exists: false };
    const r = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    return {
      exists: true, loaded: f.complete && f.naturalWidth > 0,
      w: r.width, h: r.height, x: Math.round(r.x), y: Math.round(r.y),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex,
    };
  });
  console.log(JSON.stringify(info));
  const map = await p.$('.px-map');
  await p.screenshot({ path: 'fisher_check.png', clip: await map.boundingBox() });
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
