// 验证：宝匣合成 / 渔获记录 / 钓竿配置 贴图
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
  const user = 'ico_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));

  // 先钓一会儿鱼攒记录
  await p.evaluate(() => {
    const n = [...document.querySelectorAll('.px-node')].find(x => x.textContent.includes('老旧码头'));
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 7000));

  const nav = async (name) => {
    await p.evaluate((n) => [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(n)).click(), name);
    await new Promise(r => setTimeout(r, 900));
  };
  const countImgs = async (sel) => p.$$eval(sel, els => els.filter(i => i.complete && i.naturalWidth > 0).length);

  await nav('宝匣合成');
  console.log('宝匣图标:', await countImgs('.cc-icon'));
  await p.screenshot({ path: 'pg_chest.png' });

  await nav('渔获记录');
  console.log('记录鱼图:', await countImgs('.rc-icon,.rh-icon,.rec-icon'));
  await p.screenshot({ path: 'pg_records.png' });

  await nav('钓竿配置');
  console.log('钓竿图标:', await countImgs('.bd-icon'));
  await p.screenshot({ path: 'pg_bd.png' });

  console.log('404:', broken.length ? broken : '无', '| JS 错误:', errors.length ? errors : '无');
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
