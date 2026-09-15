// 全面验证：登录页 / 近岸地图(含激活钓鱼) / 出海页签 / 图鉴页
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  const broken = [];
  p.on('response', r => { if (r.status() === 404 && !r.url().includes('favicon')) broken.push(r.url().split('/').pop()); });
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000));
  await p.screenshot({ path: 'v2_login.png' });

  const user = 'v2_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  await p.screenshot({ path: 'v2_map.png' });

  // 点击码头开始钓鱼 -> 渔夫标记应出现
  await p.evaluate(() => {
    const n = [...document.querySelectorAll('.px-node')].find(x => x.textContent.includes('老旧码头'));
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 1800));
  const st = await p.evaluate(() => ({
    active: window.Engine.state.fishing.active,
    fisher: !!document.querySelector('.pn-fisher'),
    navIcons: document.querySelectorAll('.nav-ico').length,
  }));
  console.log('钓鱼激活:', JSON.stringify(st));
  await p.screenshot({ path: 'v2_active.png' });

  // 出海页签
  await p.evaluate(() => [...document.querySelectorAll('.px-map-tab')].find(t => t.textContent.includes('出海')).click());
  await new Promise(r => setTimeout(r, 600));
  await p.screenshot({ path: 'v2_voyage.png' });

  // 图鉴页
  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('图鉴')).click());
  await new Promise(r => setTimeout(r, 900));
  await p.screenshot({ path: 'v2_codex.png' });

  console.log('404:', broken.length ? broken : '无', '| JS 错误:', errors.length ? errors : '无');
  await b.close();
  process.exit(st.active && st.fisher && !errors.length && !broken.length ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
