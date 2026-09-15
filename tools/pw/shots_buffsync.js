// 验证：地图增益标签已删 + 当前钓点为增益点时下方一览同步高亮
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'bh_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));

  const before = await p.evaluate(() => ({
    mapTips: document.querySelectorAll('.pn-bufftip').length,
    chips: document.querySelectorAll('.pb-chip').length,
    chipsOn: document.querySelectorAll('.pb-chip.on').length,
  }));
  console.log('钓鱼前:', JSON.stringify(before));

  // 去增益钓点（老旧码头）
  await p.evaluate(() => {
    const n = [...document.querySelectorAll('.px-node')].find(x => x.textContent.includes('老旧码头'));
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 1500));
  const after = await p.evaluate(() => ({
    chipsOn: [...document.querySelectorAll('.pb-chip.on')].map(c => c.textContent.replace(/\s+/g, ' ').trim().slice(0, 20)),
    mapTips: document.querySelectorAll('.pn-bufftip').length,
    active: window.Engine.state.fishing.active,
  }));
  console.log('钓鱼中(老旧码头):', JSON.stringify(after));
  const el = await p.$('.fish-select');
  await p.screenshot({ path: 'buff_sync.png', clip: await el.boundingBox() });
  console.log('JS 错误:', errors.length ? errors : '无');
  await b.close();
  const ok = before.mapTips === 0 && before.chips >= 1 && before.chipsOn === 0 &&
    after.mapTips === 0 && after.chipsOn.length === 1 && /老旧码头/.test(after.chipsOn[0]) && after.active;
  process.exit(ok && !errors.length ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
