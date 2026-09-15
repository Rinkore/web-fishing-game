// 用 Edge 无头浏览器验证图鉴贴图渲染
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });

  // 注册或登录测试账号
  const user = 'icon_test_' + Date.now().toString(36);
  await page.type('#auth-user', user);
  await page.type('#auth-pass', 'test1234');
  // 若当前是登录 tab 且账号不存在会报错，先尝试注册
  const tabRegister = await page.$('[data-tab="register"]');
  if (tabRegister) await page.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await page.type('#auth-pass2', 'test1234');
  await page.type('#auth-qq', '12345678');
  await page.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2000));
  // 如果还在 auth（可能已存在，切回登录重试）
  const authVisible = await page.$eval('#auth', el => getComputedStyle(el).display !== 'none').catch(() => false);
  if (authVisible) {
    await page.click('[data-tab="login"]');
    await new Promise(r => setTimeout(r, 300));
    await page.click('#auth-submit');
    await new Promise(r => setTimeout(r, 2000));
  }

  // 进入图鉴视图
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('图鉴'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 800));

  const stats = await page.evaluate(() => {
    const icons = document.querySelectorAll('.codex-cell .cx-icon');
    const cells = document.querySelectorAll('.codex-cell');
    const broken = [...icons].filter(i => !i.complete || i.naturalWidth === 0);
    return { cells: cells.length, icons: icons.length, broken: broken.length, brokenSrc: broken.map(i => i.src.split('/').pop()) };
  });
  console.log('图鉴卡片:', stats.cells, '| 贴图 img:', stats.icons, '| 加载失败:', stats.broken, stats.brokenSrc);
  await page.screenshot({ path: 'codex_view.png', fullPage: false });

  // 点开一条鱼的详情弹窗
  await page.evaluate(() => document.querySelector('.codex-cell').click());
  await new Promise(r => setTimeout(r, 500));
  const detailIcon = await page.evaluate(() => {
    const img = document.querySelector('.codex-detail .cd-icon');
    return img ? { src: img.src.split('/').pop(), ok: img.complete && img.naturalWidth > 0 } : null;
  });
  console.log('详情弹窗贴图:', JSON.stringify(detailIcon));
  await page.screenshot({ path: 'codex_detail.png' });

  console.log('JS 错误:', errors.length ? errors : '无');
  await browser.close();
  process.exit(stats.broken || (errors.length ? 1 : 0));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
