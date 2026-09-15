// 验证：装配器双滑块
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });
  const user = 'ab_' + Date.now().toString(36);
  await p.type('#auth-user', user);
  await p.type('#auth-pass', 'test1234');
  await p.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await p.type('#auth-pass2', 'test1234');
  await p.type('#auth-qq', '12345678');
  await p.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));
  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('钓竿配置')).click());
  await new Promise(r => setTimeout(r, 900));
  await p.evaluate(() => { const b = document.querySelector('.ab-open-btn'); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 900));
  const stats = await p.evaluate(() => ({
    rows: document.querySelectorAll('.ab-row').length,
    minSliders: document.querySelectorAll('.ab-range-min').length,
    maxSliders: document.querySelectorAll('.ab-range-max').length,
    numInputs: document.querySelectorAll('.ab-row .ab-num').length,
  }));
  console.log(JSON.stringify(stats));
  // 拖下限滑块超过上限 → 上限应被推上去
  const push = await p.evaluate(() => {
    const row = document.querySelectorAll('.ab-row')[0];
    const maxS = row.querySelector('.ab-range-max');
    maxS.value = '5'; maxS.dispatchEvent(new Event('input', { bubbles: true }));
    const minS = row.querySelector('.ab-range-min');
    minS.value = '8'; minS.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      minInp: row.querySelectorAll('.ab-num')[0].value,
      maxInp: row.querySelectorAll('.ab-num')[1].value,
      maxSlider: maxS.value,
    };
  });
  console.log('推挤测试（min=40 拖过 max=30 → max 应被推为 40）:', JSON.stringify(push));
  await p.screenshot({ path: 'ab_dual.png' });
  console.log('JS 错误:', errors.length ? errors : '无');
  await b.close();
  process.exit(stats.minSliders === stats.rows && stats.maxSliders === stats.rows && push.maxInp === '8' ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
