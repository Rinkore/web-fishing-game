// 截图验证新增页面：系统商店 / 开放市集 / 在线交易 / 鱼类图鉴 / 大鱼记录 / 渔场动态
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8161;
const OUT = path.join(ROOT, 'tests', 'shots');
// 浏览器可执行文件：优先 CHROME_PATH 环境变量，否则用系统默认安装位置
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function post(p, body) {
  return new Promise(res => {
    const data = JSON.stringify(body);
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    r.write(data); r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login(page, token) {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('fishing_token', t), token);
  await page.reload({ waitUntil: 'load' });
  await sleep(700);
}

const clickNav = async (page, name) => {
  await page.evaluate(n => {
    const find = () => Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    let b = find();
    if (!b) { const more = document.querySelector('.nav-more'); if (more) { more.click(); b = find(); } }
    if (b) b.click();
  }, name);
  await sleep(400);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1' }) });
  await sleep(1000);
  let browser;
  try {
    const rs = await post('/api/register', { username: 'shot_seller', password: 'abcd1234', name: '截图卖家', qq: '10016' });
    const rb = await post('/api/register', { username: 'shot_buyer', password: 'abcd1234', name: '截图买家', qq: '10017' });
    const tokS = rs.data.token, tokB = rb.data.token;

    // 预置卖家库存 + 渔获（填充图鉴 / 大鱼榜）
    await post('/api/dev/seed', { token: tokS, inventory: { crucian: 12, carp: 6, koi: 2, lure: 4 }, coins: 2400 });
    const catches = [
      { id: 'koi', name: '黄金锦鲤', rarity: 'rare', size: 88.5 },
      { id: 'catfish', name: '巨型鲶鱼', rarity: 'big', size: 210.4 },
      { id: 'tuna', name: '黄金枪鱼', rarity: 'big', size: 287.2 },
      { id: 'crucian', name: '鲫鱼', rarity: 'common', size: 32.6 },
      { id: 'bass', name: '湖王鲈鱼', rarity: 'big', size: 164.8 },
      { id: 'pearl', name: '深海珍珠贝', rarity: 'rare', size: 34.1 },
    ];
    for (const c of catches) {
      await post('/api/dev/catch', {
        token: tokS, size: c.size,
        item: { kind: 'fish', rarity: c.rarity, id: c.id, name: c.name, size: c.size },
        ground: '落日海湾', spot: '礁石区',
      });
      await sleep(60);
    }
    // 市集挂单
    await post('/api/market/list', { token: tokS, id: 'crucian', qty: 5, price: 26 });
    await sleep(60);
    await post('/api/market/list', { token: tokS, id: 'carp', qty: 3, price: 44 });
    await sleep(60);
    await post('/api/market/list', { token: tokB, id: 'lure', qty: 2, price: 15 });

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1340, height: 900 } });
    const p1 = await ctx.newPage();
    const p2 = await ctx.newPage();
    const errs = [];
    [p1, p2].forEach(p => p.on('pageerror', e => errs.push('pageerror: ' + e.message)));

    await login(p1, tokS);   // 卖家
    await login(p2, tokB);   // 买家
    await sleep(400);

    // 让卖家在钓点里（渔场动态度量人数）
    await p1.click('.spot-btn');
    await sleep(500);

    await clickNav(p1, '渔场动态');
    await p1.screenshot({ path: path.join(OUT, '20-ground.png') });
    console.log('20-ground.png');

    await clickNav(p1, '系统商店');
    await p1.screenshot({ path: path.join(OUT, '21-shop.png') });
    console.log('21-shop.png');

    await clickNav(p1, '开放市集');
    await p1.screenshot({ path: path.join(OUT, '22-market.png') });
    console.log('22-market.png');

    await clickNav(p1, '鱼类图鉴');
    await p1.screenshot({ path: path.join(OUT, '23-codex.png') });
    console.log('23-codex.png');

    await clickNav(p1, '渔获记录');
    await p1.screenshot({ path: path.join(OUT, '24-records.png') });
    console.log('24-records.png');

    // ---- 在线交易：p1 邀请 p2，p2 接受 ----
    await clickNav(p1, '在线交易');
    await p1.screenshot({ path: path.join(OUT, '25-trade-invite.png') });
    console.log('25-trade-invite.png');

    const invited = await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.invite-row .mini')).find(x => x.textContent.includes('邀请'));
      if (!b) return false; b.click(); return true;
    });
    console.log('invite clicked:', invited);
    await sleep(700);

    await clickNav(p2, '在线交易');
    await sleep(500);
    await p2.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('接受邀请'));
      if (b) b.click();
    });
    await sleep(900);

    // p1 选物品
    await clickNav(p1, '在线交易');
    await sleep(500);
    const sel = await p1.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tp-row'));
      const r = rows.find(x => x.textContent.includes('黄金锦鲤')) || rows[0];
      if (!r) return null;
      const cb = r.querySelector('input[type=checkbox]');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      return r.textContent.trim();
    });
    console.log('selected:', sel);
    await p1.screenshot({ path: path.join(OUT, '26-trade-select.png') });
    console.log('26-trade-select.png');

    // p1 再选一个并提交
    await p1.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tp-row'));
      const r = rows.find(x => x.textContent.includes('反光假饵'));
      if (!r) return;
      const cb = r.querySelector('input[type=checkbox]');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const b = Array.from(document.querySelectorAll('.trade-picker .mini')).find(x => x.textContent.includes('更新我的提供'));
      if (b) b.click();
    });
    await sleep(900);
    await p1.screenshot({ path: path.join(OUT, '27-trade-offer.png') });
    console.log('27-trade-offer.png');

    // p1 确认 → 展示「已确认」态
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('确认交易'));
      if (b) b.click();
    });
    await sleep(800);
    await p1.screenshot({ path: path.join(OUT, '28-trade-confirmed.png') });
    console.log('28-trade-confirmed.png');

    // 移动端窄屏验证
    const p3 = await ctx.newPage();
    await p3.setViewportSize({ width: 430, height: 860 });
    await login(p3, tokS);
    await clickNav(p3, '鱼类图鉴');
    await p3.screenshot({ path: path.join(OUT, '29-mobile-codex.png'), fullPage: true });
    console.log('29-mobile-codex.png');

    console.log('PAGE_ERRORS: ' + JSON.stringify(errs));
  } catch (e) {
    console.log('SHOT ERROR: ' + e.message.split('\n')[0]);
    console.log(e.stack);
  } finally {
    if (browser) await browser.close();
    srv.kill();
    try { fs.rmSync(path.join(ROOT, 'backend', 'data'), { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(0), 250);
  }
})();
