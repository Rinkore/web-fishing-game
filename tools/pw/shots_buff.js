// 验证：增益钓点栏（先通过管理员接口给钓点加增益）
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'buff_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));

  // 管理员接口给两个钓点加增益（服务器无管理员时首个登录管理后台的即为管理员）
  const reg = await p.evaluate(async (u, pw) => {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) });
    return r.json();
  }, user, 'test1234');
  console.log('admin login:', !!reg.token);
  const token = reg.token;
  for (const [gid, sid, type, val] of [['stillwater', 'dock', 'speed', 15], ['rapids', 'eddy', 'big', 8]]) {
    const r = await p.evaluate(async (t, gid, sid, type, val) => {
      const resp = await fetch('/api/admin/spot/buffs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, groundId: gid, spotId: sid, buffs: [{ type, value: val }] }),
      });
      return resp.json();
    }, token, gid, sid, type, val);
    console.log('set buff', gid, sid, r.ok);
  }
  await new Promise(r => setTimeout(r, 1500));
  await p.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));

  const chips = await p.$$eval('.pb-chip', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('增益栏条目:', JSON.stringify(chips));
  await p.screenshot({ path: 'buff_bar.png', clip: { x: 340, y: 640, width: 900, height: 260 } });

  // 点击增益条直达钓点
  await p.evaluate(() => {
    const c = [...document.querySelectorAll('.pb-chip')].find(x => x.textContent.includes('回水湾'));
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 1500));
  const active = await p.evaluate(() => ({
    spot: window.Engine.state.selected.spotId,
    active: window.Engine.state.fishing.active,
  }));
  console.log('点击增益条后:', JSON.stringify(active));
  console.log('JS 错误:', errors.length ? errors : '无');
  await b.close();
  process.exit(chips.length >= 2 && active.active ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
