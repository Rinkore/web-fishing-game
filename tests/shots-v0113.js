// v0.11.3 视觉验证：侧栏取消折叠 + 滚动条主题化 + 工坊熔炼残片保留 / 失败结算
// 运行： node tests/shots-v0113.js   （截图输出到 tests/shots/）
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8169;
const OUT = path.join(ROOT, 'tests', 'shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-shots-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

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
  await sleep(800);
}
const clickNav = async (page, name) => {
  await page.evaluate(n => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    if (b) b.click();
  }, name);
  await sleep(500);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  await sleep(1500);
  let browser;
  try {
    // 首个登录后台的账号会成为管理员：先注册一个后台账号拿到管理员 token，配置才能改
    await post('/api/register', { username: 'shot_v0113_admin', password: 'abcd1234', name: '截图管理员', qq: '10030' });
    const lgAdm = await post('/api/admin/login', { username: 'shot_v0113_admin', password: 'abcd1234' });
    const admTok = lgAdm.data && lgAdm.data.token;
    const rs = await post('/api/register', { username: 'shot_v0113', password: 'abcd1234', name: '残片测试', qq: '10031' });
    const tok = rs.data.token;
    console.log('管理员 token：', admTok ? 'ok' : 'FAILED ' + JSON.stringify(lgAdm.data));
    // 主件：海王遗匣风格的 神话 4 词条（池外突破词缀 rare/double）；副件：同部位（竿身）
    const mythicMain = D.instanceId('rod_bamboo', 'mythic', [
      { type: 'speed', value: 12 }, { type: 'size', value: 3 }, { type: 'rare', value: 5 }, { type: 'double', value: 9 },
    ]);
    const sub = D.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }]);
    const plainMain = D.instanceId('reel_turbo', 'rare', [{ type: 'speed', value: 30 }, { type: 'skill', value: -8 }]);
    const plainSub = D.instanceId('reel_magnetic', 'common', [{ type: 'material', value: -5 }]);
    await post('/api/dev/seed', {
      token: tok, coins: 500000,
      inventory: { [mythicMain]: 1, [sub]: 2, [plainMain]: 1, [plainSub]: 1, relic: 12, rope: 6 },
    });
    // 熔炼必定成功、补缀必定成功（便于截图展示「保留命中」）
    const cfgA = await post('/api/admin/smelt/config', { token: admTok, baseRate: 100, rateMax: 100, failPerMaterial: 0, extraRatePerMaterial: 100, extraRateMax: 100 });
    console.log('熔炼配置（必成功）：', JSON.stringify(cfgA.data && cfgA.data.smeltCfg ? { rate: cfgA.data.smeltCfg.baseRate, extra: cfgA.data.smeltCfg.extraRatePerMaterial } : cfgA.data));

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await login(page, tok);

    // ---------- 1. 侧栏：14 个入口全平铺 + 滚动条 ----------
    const navInfo = await page.evaluate(() => {
      const nav = document.getElementById('nav');
      const items = Array.from(nav.querySelectorAll('.nav-item')).map(x => ({
        t: x.textContent.trim(), h: Math.round(x.getBoundingClientRect().height),
      }));
      const cs = getComputedStyle(nav);
      return {
        count: items.length,
        names: items.map(x => x.t).join(' | '),
        more: nav.querySelectorAll('.nav-more').length,
        groups: nav.querySelectorAll('.nav-group').length,
        scrollH: nav.scrollHeight, clientH: nav.clientHeight,
        canScroll: nav.scrollHeight > nav.clientHeight + 1,
        ffColor: cs.scrollbarColor, ffWidth: cs.scrollbarWidth,
      };
    });
    console.log('侧栏：', JSON.stringify(navInfo, null, 1));
    await page.screenshot({ path: path.join(OUT, '50-nav-flat.png') });

    // 矮窗口（1000×560）：14 项放不下 → 导航区自己滚动，滚动条样式与主题一致
    await page.setViewportSize({ width: 1000, height: 560 });
    await sleep(400);
    const shortNav = await page.evaluate(() => {
      const nav = document.getElementById('nav');
      const thumb = getComputedStyle(nav, '::-webkit-scrollbar-thumb');
      const track = getComputedStyle(nav, '::-webkit-scrollbar-track');
      const bar = getComputedStyle(nav, '::-webkit-scrollbar');
      nav.scrollTop = nav.scrollHeight;   // 滚到底
      const last = nav.querySelectorAll('.nav-item');
      const lastBox = last.length ? last[last.length - 1].getBoundingClientRect() : null;
      const sideFoot = document.querySelector('.side-foot');
      return {
        canScroll: nav.scrollHeight > nav.clientHeight + 1,
        scrollTop: Math.round(nav.scrollTop),
        thumbBg: thumb.backgroundColor, thumbRadius: thumb.borderRadius, thumbClip: thumb.backgroundClip,
        trackBg: track.backgroundColor, barW: bar.width,
        sideFootVisible: !!sideFoot && sideFoot.getBoundingClientRect().bottom <= window.innerHeight + 1,
        lastItemBottom: lastBox ? Math.round(lastBox.bottom) : null,
        innerH: window.innerHeight,
        navColor: getComputedStyle(nav).scrollbarColor,
      };
    });
    console.log('矮窗口侧栏滚动：', JSON.stringify(shortNav));
    // 像素级取证：截取侧栏滚动条那一列，统计主要颜色 —— 应出现主题蓝 #2c4f74(44,79,116) 而非系统灰
    const navRect = await page.evaluate(() => {
      const n = document.getElementById('nav');
      n.scrollTop = n.scrollHeight / 2;   // 立刻滚动：覆盖式滚动条在滚动后才可见
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const barClip = { x: navRect.x + navRect.w - 9, y: navRect.y + 4, width: 9, height: Math.min(120, navRect.h - 8) };
    await page.evaluate(() => { const n = document.getElementById('nav'); n.scrollTop = n.scrollTop - 1; });
    const shot = await page.screenshot({ clip: barClip });
    const pixels = await page.evaluate(async b64 => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const cnt = {};
      for (let i = 0; i < d.length; i += 4) { const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2]; cnt[k] = (cnt[k] || 0) + 1; }
      return { size: cv.width + 'x' + cv.height, top: Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5) };
    }, shot.toString('base64'));
    console.log('滚动条像素取样：', JSON.stringify(pixels));
    await page.screenshot({ path: path.join(OUT, '51-nav-scrolled.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(300);

    // ---------- 2. 工坊熔炼：神话主件 → 残片入口 ----------
    await clickNav(page, '工坊');
    // 打开组件选择子页面（.bde-grid > .bec-card，点卡片里的 pickLabel 按钮）
    const pickComp = async (which, nameRe) => {
      await page.evaluate(l => {
        const b = Array.from(document.querySelectorAll('.ws-pick')).find(x => (x.getAttribute('data-pick') || '') === l);
        if (b) b.click();
      }, which);
      await sleep(600);
      const r = await page.evaluate(re => {
        const cards = Array.from(document.querySelectorAll('.bde-grid .bec-card'));
        const names = cards.map(c => c.querySelector('.bec-name').textContent.trim());
        const hit = cards.find(c => new RegExp(re).test(c.querySelector('.bec-name').textContent));
        if (!hit) return { ok: false, names };
        const btn = Array.from(hit.querySelectorAll('.bec-acts button')).find(b => !b.disabled);
        if (!btn) return { ok: false, names, disabled: true };
        btn.click();
        return { ok: true, names, picked: hit.querySelector('.bec-name').textContent.trim(), btn: btn.textContent };
      }, nameRe);
      await sleep(600);
      console.log('选择' + which + '：', JSON.stringify(r));
      return r;
    };
    await pickComp('main', '神话.*竹制短竿|竹制短竿');
    const mainChosen = await page.evaluate(() => {
      const t = document.querySelector('.ws-affs');
      return t ? t.textContent.replace(/\s+/g, ' ').slice(0, 120) : '';
    });
    console.log('主件词条按钮：', mainChosen);
    await pickComp('sub', '龙骨巨竿');
    // 选词条：主 speed / 副 skill
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ws-aff[data-which="main"]')).find(x => x.textContent.includes('钓速'));
      if (b) b.click();
    });
    await sleep(200);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ws-aff[data-which="sub"]')).find(x => x.textContent.includes('技巧'));
      if (b) b.click();
    });
    await sleep(300);
    const relicUi = await page.evaluate(() => {
      const row = document.getElementById('ws-relic-row');
      const box = document.getElementById('ws-relic-on');
      return { rowExists: !!row, checked: box && box.checked, qty: (document.getElementById('ws-relic-qty') || {}).value };
    });
    console.log('残片 UI（默认）：', JSON.stringify(relicUi));
    // 勾选残片并拉满到 10 片
    await page.evaluate(() => { const b = document.getElementById('ws-relic-on'); if (b && !b.checked) b.click(); });
    await sleep(400);
    const relicUi2 = await page.evaluate(() => {
      const q = document.getElementById('ws-relic-qty');
      return { qty: q && q.value, max: q && q.max, chance: (document.getElementById('ws-relic-chance') || {}).textContent };
    });
    console.log('残片 UI（勾选后）：', JSON.stringify(relicUi2));
    const scrollToBottom = async () => { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(250); };
    await scrollToBottom();
    // 布局自查：残片行不越出面板、页面无横向滚动
    const layout = await page.evaluate(() => {
      const row = document.querySelector('.ws-relic-row');
      const panel = document.querySelector('.ws-panel');
      const rr = row && row.getBoundingClientRect(), pr = panel && panel.getBoundingClientRect();
      const nav = document.getElementById('nav');
      return {
        rowInsidePanel: !!(rr && pr) && rr.right <= pr.right + 1 && rr.left >= pr.left - 1,
        rowW: rr ? Math.round(rr.width) : null, panelRight: pr ? Math.round(pr.right) : null,
        hOverflow: document.documentElement.scrollWidth - window.innerWidth,
        navClientW: Math.round(nav.clientWidth), navScrollW: Math.round(nav.scrollWidth),
      };
    });
    console.log('布局自查：', JSON.stringify(layout));
    await page.screenshot({ path: path.join(OUT, '52-smelt-relic.png'), fullPage: true });

    // 开始熔炼 → 确认 → 结果
    await page.evaluate(() => { const b = document.getElementById('ws-go'); if (b) b.click(); });
    await sleep(500);
    const confirmText = await page.evaluate(() => {
      const m = document.querySelector('.confirm-modal');
      return m ? m.textContent.replace(/\s+/g, ' ').slice(0, 300) : '';
    });
    console.log('确认弹窗：', confirmText);
    await page.screenshot({ path: path.join(OUT, '53-smelt-confirm.png') });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.confirm-modal .cf-actions button')).find(x => /开始熔炼/.test(x.textContent));
      if (b) b.click();
    });
    await sleep(900);
    const resultText = await page.evaluate(() => {
      const m = document.querySelector('.chest-result-modal');
      return m ? m.textContent.replace(/\s+/g, ' ').slice(0, 400) : '';
    });
    console.log('结果弹窗：', resultText);
    await page.screenshot({ path: path.join(OUT, '54-smelt-result.png') });
    await page.evaluate(() => { const b = document.querySelector('.chest-result-modal .cr-ok'); if (b) b.click(); });
    await sleep(300);

    // ---------- 3. 失败结算：主件失去选中词条 ----------
    const cfgB = await post('/api/admin/smelt/config', { token: admTok, baseRate: 0, failPerMaterial: 0, rateMin: 0 });
    console.log('熔炼配置（必失败）：', JSON.stringify(cfgB.data && cfgB.data.smeltCfg ? { rate: cfgB.data.smeltCfg.baseRate, min: cfgB.data.smeltCfg.rateMin } : cfgB.data));
    await post('/api/dev/seed', {
      token: tok, coins: 500000,
      inventory: { [plainMain]: 1, [plainSub]: 1, relic: 4 },
    });
    await page.reload({ waitUntil: 'load' });
    await sleep(900);
    await clickNav(page, '工坊');
    await pickComp('main', '涡轮卷线器');
    await pickComp('sub', '磁力刹车卷线器');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ws-aff[data-which="main"]')).find(x => x.textContent.includes('钓速'));
      if (b) b.click();
    });
    await sleep(200);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ws-aff[data-which="sub"]')).find(x => x.textContent.includes('材料'));
      if (b) b.click();
    });
    await sleep(300);
    await scrollToBottom();
    await page.screenshot({ path: path.join(OUT, '55-smelt-fail-before.png'), fullPage: true });
    const failPlan = await page.evaluate(() => {
      const p = document.getElementById('ws-preview');
      const go = document.getElementById('ws-go');
      return { preview: p ? p.textContent.replace(/\s+/g, ' ').slice(0, 260) : '', disabled: go && go.disabled };
    });
    console.log('失败场景预览：', JSON.stringify(failPlan));
    await page.evaluate(() => { const b = document.getElementById('ws-go'); if (b) b.click(); });
    await sleep(500);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.confirm-modal .cf-actions button')).find(x => /开始熔炼/.test(x.textContent));
      if (b) b.click();
    });
    await sleep(900);
    const failText = await page.evaluate(() => {
      const m = document.querySelector('.chest-result-modal');
      return m ? m.textContent.replace(/\s+/g, ' ').slice(0, 400) : '';
    });
    console.log('失败弹窗：', failText);
    await page.screenshot({ path: path.join(OUT, '56-smelt-fail-result.png') });

    console.log(errs.length ? ('页面错误：' + errs.join(' || ')) : '页面无错误');
  } catch (e) {
    console.error('截图脚本异常：', e);
  } finally {
    if (browser) await browser.close();
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  }
})();
