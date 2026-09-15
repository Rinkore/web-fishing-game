// 验证：换钓点播放甩杆三帧（后摆→前挥→入水持竿），同点重绘不重播
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'cast_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));

  const fisherSrc = () => p.evaluate(() => {
    const f = document.querySelector('.pn-fisher');
    return f ? f.src.split('/').pop() : null;
  });
  const clickSpot = (name) => p.evaluate((n) => {
    const el = [...document.querySelectorAll('.px-node')].find(x => x.textContent.includes(n));
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  }, name);

  // 第一次开始钓鱼：应播 A → B → hold
  await clickSpot('老旧码头');
  await new Promise(r => setTimeout(r, 80));
  const f1 = await fisherSrc();
  await new Promise(r => setTimeout(r, 200));
  const f2 = await fisherSrc();
  await new Promise(r => setTimeout(r, 500));
  const f3 = await fisherSrc();
  console.log('开始钓鱼帧序列:', f1, '→', f2, '→', f3);
  // 换钓点：重新播放
  await clickSpot('深水区');
  await new Promise(r => setTimeout(r, 80));
  const f4 = await fisherSrc();
  await new Promise(r => setTimeout(r, 700));
  const f5 = await fisherSrc();
  console.log('换钓点帧序列:', f4, '→', f5);
  console.log('JS 错误:', errors.length ? errors : '无');
  const map = await p.$('.px-map');
  await p.screenshot({ path: 'cast_check.png', clip: await map.boundingBox() });
  await b.close();
  const ok = f1 === 'fisher_a.png' && f3 === 'fisher_hold.png' && f4 === 'fisher_a.png' && f5 === 'fisher_hold.png';
  process.exit(ok && !errors.length ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
