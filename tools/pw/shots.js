// 截图：全部页签（含材料/组件/钓点）+ 组件详情弹窗
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:9000/', { waitUntil: 'networkidle2', timeout: 30000 });

  const user = 'demo2_' + Date.now().toString(36);
  await page.type('#auth-user', user);
  await page.type('#auth-pass', 'test1234');
  await page.click('[data-tab="register"]');
  await new Promise(r => setTimeout(r, 300));
  await page.type('#auth-pass2', 'test1234');
  await page.type('#auth-qq', '12345678');
  await page.click('#auth-submit');
  await new Promise(r => setTimeout(r, 2500));

  await page.evaluate(() => {
    [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('图鉴')).click();
  });
  await new Promise(r => setTimeout(r, 600));

  const clickTab = async (label) => {
    await page.evaluate((l) => {
      [...document.querySelectorAll('.inv-cat')].find(b => b.textContent.includes(l)).click();
    }, label);
    await new Promise(r => setTimeout(r, 700));
  };

  // 统计各页签贴图加载情况
  const report = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.codex-cell .cx-icon')];
    const broken = imgs.filter(i => !i.complete || i.naturalWidth === 0);
    return { total: imgs.length, broken: broken.length, brokenSrc: broken.map(i => i.src.split('/').slice(-2).join('/')) };
  });
  console.log('「全部」页签:', JSON.stringify(report));

  await clickTab('材料');
  await page.screenshot({ path: 'shot_materials.png' });
  await clickTab('组件');
  await page.screenshot({ path: 'shot_components.png' });

  // 组件详情弹窗（海王徽记）
  await page.evaluate(() => {
    [...document.querySelectorAll('.codex-cell')].find(c => c.textContent.includes('海王徽记')).click();
  });
  await new Promise(r => setTimeout(r, 500));
  const det = await page.evaluate(() => {
    const img = document.querySelector('.codex-detail .cd-icon');
    return img ? { src: img.src.split('/').pop(), ok: img.complete && img.naturalWidth > 0 } : null;
  });
  console.log('组件详情贴图:', JSON.stringify(det));
  await page.screenshot({ path: 'shot_comp_detail.png' });
  await page.evaluate(() => document.querySelector('.modal-close').click());
  await new Promise(r => setTimeout(r, 300));

  await clickTab('钓点');
  const spotReport = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.codex-cell .cx-icon')];
    const broken = imgs.filter(i => !i.complete || i.naturalWidth === 0);
    return { total: imgs.length, broken: broken.length };
  });
  console.log('钓点页签:', JSON.stringify(spotReport));
  await page.screenshot({ path: 'shot_spots.png' });

  console.log('JS 错误:', errors.length ? errors : '无');
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
