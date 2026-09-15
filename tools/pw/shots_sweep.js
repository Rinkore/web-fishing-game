// 遍历所有导航页检查渲染 + 截图关键页
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'sweep_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  const pages = ['钓竿配置', '渔场动态', '背包', '宝匣合成', '系统商店', '开放市集', '渔获记录', '反馈意见', '日志'];
  for (const name of pages) {
    await p.evaluate((n) => {
      [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(n)).click();
    }, name);
    await new Promise(r => setTimeout(r, 700));
    const ok = await p.evaluate(() => document.getElementById('main').children.length > 0);
    console.log(name, ok ? 'OK' : 'EMPTY');
  }
  // 截图：钓竿配置 + 商店
  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('钓竿配置')).click());
  await new Promise(r => setTimeout(r, 700));
  await p.screenshot({ path: 'v2_bd.png' });
  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('系统商店')).click());
  await new Promise(r => setTimeout(r, 700));
  await p.screenshot({ path: 'v2_shop.png' });
  console.log('JS 错误:', errors.length ? errors : '无');
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
