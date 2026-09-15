// 地图版钓鱼页验证：截图 + 点击节点开始钓鱼 + 状态检查
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'map_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  const mapInfo = await p.evaluate(() => ({
    map: !!document.querySelector('.px-map'),
    nodes: document.querySelectorAll('.px-node').length,
    regions: document.querySelectorAll('.px-region').length,
  }));
  console.log('地图信息:', JSON.stringify(mapInfo));
  await p.screenshot({ path: 'map_idle.png' });

  // 点击「老旧码头」节点开始钓鱼
  await p.evaluate(() => {
    const n = [...document.querySelectorAll('.px-node')].find(x => x.textContent.includes('老旧码头'));
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 1800));
  const st = await p.evaluate(() => ({
    active: window.Engine.state.fishing.active,
    hereNodes: document.querySelectorAll('.px-node.here').length,
    statusText: document.querySelector('.fish-state').textContent.slice(0, 30),
  }));
  console.log('点击后:', JSON.stringify(st));
  await p.screenshot({ path: 'map_active.png' });
  console.log('JS 错误:', errors.length ? errors : '无');
  await b.close();
  process.exit(mapInfo.nodes === 9 && st.active && st.hereNodes === 1 && errors.length === 0 ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
