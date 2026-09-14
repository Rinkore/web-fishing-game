/*
 * 真实浏览器渲染验证（无需人眼）：
 *  - 新增页面均可正常渲染、无页面错误
 *  - 布局度量：面板撑满内容区（消除右侧空白）、动态框体已放大
 *  - 交易页在真实 Chrome 中勾选不被重绘重置
 * 运行： node tests/ui-layout.test.js
 */
'use strict';
const { chromium } = require('playwright-core');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8171;
const D_DATA = require(path.join(ROOT, 'frontend', 'js', 'data.js'));
// 浏览器可执行文件：优先 CHROME_PATH 环境变量，否则用系统默认安装位置
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0; const failed = [];
function check(n, c, extra) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failed.push(n); console.log('  FAIL  ' + n + (extra ? ' -> ' + extra : '')); } }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function login(page, token) {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('fishing_token', t), token);
  await page.reload({ waitUntil: 'load' });
  await sleep(700);
}
const clickNav = async (page, name) => {
  await page.evaluate(n => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    if (b) b.click();
  }, name);
  await sleep(450);
};

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-test-'));


(async () => {
  const srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await sleep(1000);
  let browser;
  try {
    const rs = await post('/api/register', { username: 'lay_seller', password: 'abcd1234', name: '布局卖家' });
    const rb = await post('/api/register', { username: 'lay_buyer', password: 'abcd1234', name: '布局买家' });
    const tokS = rs.data.token, tokB = rb.data.token;

    await post('/api/dev/seed', { token: tokS, inventory: { crucian: 12, carp: 6, koi: 2, lure: 4 }, coins: 2400 });
    // 给卖家发一个带负词条的组件实例（用于验证装备后负词条显示为红色）
    const NEG_COMP = D_DATA.instanceId('reel_turbo', 'rare', [{ type: 'speed', value: 30 }, { type: 'big', value: -8 }]);
    await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: NEG_COMP } });
    const catches = [
      { id: 'koi', name: '黄金锦鲤', rarity: 'rare', size: 88.5 },
      { id: 'catfish', name: '巨型鲶鱼', rarity: 'big', size: 210.4 },
      { id: 'tuna', name: '黄金枪鱼', rarity: 'big', size: 287.2 },
      { id: 'crucian', name: '鲫鱼', rarity: 'common', size: 32.6 },
      { id: 'bass', name: '湖王鲈鱼', rarity: 'big', size: 164.8 },
      { id: 'pearl', name: '深海珍珠贝', rarity: 'rare', size: 34.1 },
    ];
    for (const c of catches) {
      await post('/api/dev/catch', { token: tokS, size: c.size, item: { kind: 'fish', rarity: c.rarity, id: c.id, name: c.name, size: c.size }, ground: '落日海湾', spot: '礁石区' });
    }
    await post('/api/market/list', { token: tokS, id: 'crucian', qty: 5, price: 26 });
    await sleep(80);
    await post('/api/market/list', { token: tokS, id: 'carp', qty: 3, price: 44 });
    // 一个组件实例挂单（用于市集词条筛选验证）；买家持有一个带 钓速+20 的组件
    const compId = D_DATA.instanceId('reel_electric', 'common', [{ type: 'speed', value: 20 }]);
    await post('/api/dev/catch', { token: tokB, item: { kind: 'component', id: compId } });
    await post('/api/market/list', { token: tokB, id: compId, qty: 1, price: 500, hours: 6 });

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p1 = await ctx.newPage();
    const p2 = await ctx.newPage();
    const errs = [];
    [p1, p2].forEach(p => p.on('pageerror', e => errs.push('pageerror: ' + e.message)));

    await login(p1, tokS);
    await login(p2, tokB);

    section('新增页面渲染');
    check('登录后 10 个已实现入口可见', (await p1.$$('#nav .nav-item:not(.locked)')).length === 10);
    check('2 个占位入口锁定', (await p1.$$('#nav .nav-item.locked')).length === 2);

    // —— 钓鱼页：已移除背包，渔获日志与左栏底部对齐 ——
    await clickNav(p1, '钓鱼');
    check('钓鱼页不再显示背包模块', (await p1.$$('.fish-live .inventory, .content .inventory')).length === 0);
    check('钓鱼页仍有渔获日志', (await p1.$$('.fish-live .catch-log')).length === 1);
    const align = await p1.evaluate(() => {
      const left = document.querySelector('.content > .fish-select');
      const right = document.querySelector('.content > .fish-live');
      const log = document.querySelector('.fish-live .catch-log');
      if (!left || !right || !log) return { ok: false };
      const lb = left.getBoundingClientRect(), rb = right.getBoundingClientRect(), gb = log.getBoundingClientRect();
      return { ok: true, leftBottom: lb.bottom, rightBottom: rb.bottom, logBottom: gb.bottom };
    });
    check('左右两栏底边对齐（右栏日志随左栏高度撑满）', align.ok && Math.abs(align.leftBottom - align.rightBottom) < 3,
      JSON.stringify(align));
    // 日志填满右栏到底部（不再被下方背包挤到半空；差值仅为面板内边距）
    check('渔获日志填满至右栏底部', align.ok && align.logBottom > align.rightBottom - 30, JSON.stringify(align));

    // —— 系统商店 ——
    await clickNav(p1, '系统商店');
    check('系统商店渲染出价格卡片', (await p1.$$('.shop-card')).length >= 15, String((await p1.$$('.shop-card')).length));
    check('商店卡片显示动态价格与百分比', /当前 \d+%/.test(await p1.textContent('.sc-pct')));
    check('商店页展示我的背包', (await p1.$$('.inventory .inv-row')).length > 0);
    check('背包行含出售按钮', (await p1.$$('.inventory .mini.primary-mini')).length > 0);

    // —— 钓竿配置：装备走子页面（弹窗），页面下方不再有装备模块；负词条红色 ——
    await clickNav(p1, '钓竿配置');
    check('钓竿配置页下方不再有内嵌装备模块', (await p1.$$('.bd-equip-panel, .panel > .bde-head')).length === 0);
    // 点 reel 部位的「装备组件」打开子页面
    await p1.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.bd-cell'));
      const cell = cells.find(c => c.querySelector('.bd-part') && /卷线器/.test(c.querySelector('.bd-part').textContent));
      const b = cell && Array.from(cell.querySelectorAll('button')).find(x => x.textContent.includes('装备组件'));
      if (b) b.click();
    });
    await sleep(400);
    check('点击装备组件弹出子页面（弹窗）', (await p1.$$('.modal-overlay .bd-equip-modal')).length === 1);
    check('子页面列出该部位组件卡片', (await p1.$$('.bd-equip-modal .bec-card')).length >= 1);
    // 装备带负词条的组件
    await p1.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card'));
      const card = cards.find(c => c.querySelector('.bec-aff.aff-neg'));
      const b = card && Array.from(card.querySelectorAll('button')).find(x => x.textContent.includes('装备'));
      if (b) b.click();
    });
    await sleep(900);
    // 弹窗应已关闭，主视图显示装备后的词条
    check('装备后子页面自动关闭', (await p1.$$('.modal-overlay')).length === 0);
    const negColor = await p1.evaluate(() => {
      const lines = Array.from(document.querySelectorAll('.bd-cell .af-line.aff-neg'));
      if (!lines.length) return { ok: false, why: 'no negative affix line' };
      const cs = getComputedStyle(lines[0]);
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(cs.color);
      const proxy = document.createElement('span');
      proxy.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#f87171';
      document.body.appendChild(proxy);
      const exp = getComputedStyle(proxy).color;
      proxy.remove();
      return { ok: true, color: cs.color, danger: exp, cls: lines[0].className, rgb: m ? [ +m[1], +m[2], +m[3] ] : null };
    });
    check('装备后负词条行存在', negColor.ok, JSON.stringify(negColor));
    check('装备后负词条显示为红色（未被 .on 正色覆盖）',
      negColor.ok && negColor.color === negColor.danger,
      JSON.stringify(negColor));

    // —— 开放市集 ——
    await clickNav(p1, '开放市集');
    // 购买市场默认只显示他人的挂单（本用例两条挂单均属卖家自己 → 0 行），切到「我的挂单」查看
    const mineTab = await p1.$$('.inv-cat');
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('我的挂单')); if (b) b.click(); });
    await sleep(300);
    check('市集渲染挂单行（我的挂单）', (await p1.$$('.mk-row')).length === 2, String((await p1.$$('.mk-row')).length));
    check('自己的挂单标记为 mine 并提供下架', (await p1.$$('.mk-row.mine')).length === 2);
    check('市集提示含 10% 税', (await p1.textContent('.panel h2')).includes('10%'));
    // 购买市场：组件挂单展示词条，且可按词条 + 数值筛选
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('购买市场')); if (b) b.click(); });
    await sleep(300);
    const buyRows = await p1.$$('.mk-row');
    check('购买市场显示他人的组件挂单', buyRows.length >= 1, String(buyRows.length));
    check('组件挂单行展示实例词条', (await p1.$$('.mk-row .mk-aff .inst-aff')).length >= 1);
    check('市集词条筛选控件存在', (await p1.$$('.aff-filter select')).length === 1 && (await p1.$$('.aff-filter .aff-num')).length === 2);
    // 选「钓速」并设最小 20 → 只剩钓速+20 的组件挂单
    await p1.selectOption('.aff-filter select', 'speed');
    await sleep(200);
    await p1.fill('.aff-filter .aff-num', '20');
    await p1.evaluate(() => { document.querySelectorAll('.aff-filter .aff-num')[0].dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(250);
    const filtered = await p1.$$('.mk-row');
    check('按词条+数值筛选后匹配到组件挂单', filtered.length === 1, String(filtered.length));
    // 筛选状态下收到市集广播重绘：下拉框不应被关闭（保持展开 / 保留选中值）
    const keepOpen = await p1.evaluate(() => {
      const sel = document.querySelector('.aff-filter select');
      if (!sel) return { ok: false, why: 'no select' };
      sel.focus();
      sel.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      // 模拟 SSE market 广播触发的重绘
      window.UI.refreshAll('market');
      return { ok: true, value: sel.value, stillFocused: document.activeElement === sel };
    });
    await sleep(200);
    const afterBroadcast = await p1.evaluate(() => {
      const sel = document.querySelector('.aff-filter select');
      return { exists: !!sel, value: sel ? sel.value : null, focused: document.activeElement === sel };
    });
    check('广播重绘时词条下拉未被关闭（筛选控件仍在且选中值保留）',
      keepOpen.ok && afterBroadcast.exists && afterBroadcast.value === 'speed', JSON.stringify({ keepOpen, afterBroadcast }));
    check('广播重绘时下拉保持焦点（不被打断）', afterBroadcast.focused === true, JSON.stringify(afterBroadcast));
    await p1.evaluate(() => { const b = document.querySelector('.aff-filter .bf-cat'); if (b && b.textContent.includes('清除')) b.click(); });
    await sleep(250);

    // —— 系统商店：出售数量控制条（全局生效） ——
    await clickNav(p1, '系统商店');
    check('商店有出售数量控制条', (await p1.$$('.shop-qtybar')).length === 1);
    check('数量控制条含加减与输入框', (await p1.$$('.shop-qtybar .sqb-btn')).length === 2 && (await p1.$$('.shop-qtybar .sqb-num')).length === 1);
    await p1.fill('.shop-qtybar .sqb-num', '3');
    await p1.evaluate(() => { document.querySelector('.shop-qtybar .sqb-num').dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);
    const sellLabels = await p1.$$eval('.shop-card .mini', els => els.map(e => e.textContent));
    check('出售按钮按设定数量显示', sellLabels.some(t => /出售 \d+ 个/.test(t)), JSON.stringify(sellLabels.slice(0, 3)));
    // 切页再回来，数量应保留（全局生效直到被修改）
    await clickNav(p1, '背包');
    await clickNav(p1, '系统商店');
    const qtyKept = await p1.inputValue('.shop-qtybar .sqb-num');
    check('出售数量跨页面保留（全局生效）', qtyKept === '3', qtyKept);

    // —— 鱼类图鉴 ——
    await clickNav(p1, '鱼类图鉴');
    const cells = await p1.$$('.codex-cell');
    const got = await p1.$$('.codex-cell.got');
    check('图鉴渲染全部条目', cells.length === 75, String(cells.length));
    check('图鉴已解锁钓到的鱼', got.length >= 6, String(got.length) + ' 已解锁');
    check('图鉴汇总显示收集进度', /\d+ \/ \d+/.test(await p1.textContent('.codex-summary')));
    check('组件图鉴卡展示底材词缀与数值范围', (await p1.$$('.codex-cell.k-component .cx-pool')).length > 0);

    // —— 渔获记录 ——
    await clickNav(p1, '渔获记录');
    check('渔获记录渲染全场纪录卡片', (await p1.$$('.record-cell.with-rec')).length >= 6, String((await p1.$$('.record-cell.with-rec')).length));
    check('全场最大置顶显示 287.2cm（黄金枪鱼）', (await p1.textContent('.record-hero')).includes('287.2'));
    const smallCells = await p1.$$('.record-cell.small-fish');
    check('小鱼纪录渲染卡片', smallCells.length >= 1);
    check('小鱼纪录卡片标注可点查看前十小', (await p1.textContent('.record-cell.small-fish')).includes('前十小'));
    // 点小鱼卡片 → 弹出前十小弹窗
    await p1.evaluate(() => { const c = document.querySelector('.record-cell.small-fish'); if (c) c.click(); });
    await sleep(500);
    check('点击小鱼纪录弹出前十小弹窗', (await p1.textContent('.modal-head .modal-title')).includes('前十小'));
    const sfModal = await p1.evaluate(() => {
      const sizes = Array.from(document.querySelectorAll('#records-modal-body .top10-size')).map(e => parseFloat(e.textContent));
      return { sizes: sizes, sortedAsc: sizes.every((v, i) => i === 0 || sizes[i - 1] <= v) };
    });
    check('前十小弹窗按体型升序排列', sfModal.sizes.length >= 1 && sfModal.sortedAsc, JSON.stringify(sfModal));
    await p1.evaluate(() => { const b = document.querySelector('.modal-close'); if (b) b.click(); });
    await sleep(200);
    // 点大鱼卡片 → 弹出前十大
    await p1.evaluate(() => { const c = document.querySelector('.record-cell.with-rec:not(.small-fish)'); if (c) c.click(); });
    await sleep(500);
    check('点击大鱼纪录弹出前十大弹窗', (await p1.textContent('.modal-head .modal-title')).includes('前十大'));
    await p1.evaluate(() => { const b = document.querySelector('.modal-close'); if (b) b.click(); });
    await sleep(200);
    // 破纪录横幅：调用 showRecordBanner 应出现 5 秒
    await p1.evaluate(() => window.UI.showRecordBanner({ who: '测试甲', name: '黄金枪鱼', size: 999.9 }));
    await sleep(200);
    const bannerOn = await p1.evaluate(() => {
      const b = document.getElementById('record-banner');
      return b && b.classList.contains('show') && b.textContent.includes('999.9');
    });
    check('破纪录横幅显示且含纪录信息', bannerOn === true);

    // —— 渔场动态：布局度量 ——
    await clickNav(p1, '渔场动态');
    const m = await p1.evaluate(() => {
      const content = document.querySelector('.content');
      const panel = document.querySelector('.panel.wide');
      const counts = document.querySelector('.ground-counts');
      const feed = document.querySelector('.feed-big');
      const cs = getComputedStyle(content);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      return {
        contentInner: content.clientWidth - pad,
        panelW: panel.getBoundingClientRect().width,
        countBoxes: counts ? counts.children.length : 0,
        feedH: feed ? feed.getBoundingClientRect().height : 0,
        feedMaxH: feed ? getComputedStyle(feed).maxHeight : '',
        cols: document.querySelector('.ground-cols') ? getComputedStyle(document.querySelector('.ground-cols')).gridTemplateColumns : '',
      };
    });
    // 面板应几乎撑满内容区（右侧不再留大片空白）
    check('面板宽度撑满内容区（右侧空白 < 2px）', Math.abs(m.contentInner - m.panelW) < 2,
      'contentInner=' + m.contentInner.toFixed(1) + ' panel=' + m.panelW.toFixed(1));
    check('各渔场人数卡片齐全（3 普通 + 1 活动 + 全服）', m.countBoxes === 5, String(m.countBoxes));
    check('动态框体已放大（max-height 560px）', m.feedMaxH === '560px', m.feedMaxH);
    check('动态框体实际高度 >= 380px（放大的框体）', m.feedH >= 380, m.feedH.toFixed(1));
    check('渔场动态两栏布局生效', /px/.test(m.cols) && m.cols.split(' ').length === 2, m.cols);

    // 每个渔场显示人数：渔场动态页用 .gc-box，钓鱼页的钓场卡片用 .gc-cnt
    const boxTexts = await p1.$$eval('.gc-box .gcb-num', els => els.map(e => e.textContent.trim()));
    check('渔场动态页列出每个渔场的人数', boxTexts.length === 5 && boxTexts.every(t => /\d+人/.test(t)), JSON.stringify(boxTexts));
    await clickNav(p1, '钓鱼');
    const cntTexts = await p1.$$eval('.gc-cnt', els => els.map(e => e.textContent.trim()));
    check('钓场列表每个渔场显示人数', cntTexts.length === 3 && cntTexts.every(t => /人/.test(t)), JSON.stringify(cntTexts));
    await clickNav(p1, '渔场动态');

    // —— 在线交易：真实 Chrome 内勾选不被重置 ——
    section('在线交易（真实 Chrome）');
    await clickNav(p2, '在线交易');
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('钓鱼'));
      if (b) b.click();
    });
    await sleep(300);
    await p1.click('.spot-btn');          // 让 p1 处于钓鱼中 → 持续触发 players/grounds/feed 广播
    await sleep(400);
    await clickNav(p1, '在线交易');

    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.invite-row .mini')).find(x => x.textContent.includes('邀请'));
      if (b) b.click();
    });
    await sleep(800);
    await p2.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('接受邀请'));
      if (b) b.click();
    });
    await sleep(900);
    await clickNav(p1, '在线交易');
    check('交易界面出现物品选择器', (await p1.$$('.trade-picker')).length === 1);

    // 勾选并等待若干秒，让钓鱼产生的 players/grounds/feed 广播持续冲刷
    await p1.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      const cb = r.querySelector('input[type=checkbox]');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const qi = r.querySelector('input.tp-qty');
      qi.value = '2'; qi.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(4000);   // > 一个钓鱼周期（3s），期间必有多次广播
    const afterBurst = await p1.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      if (!r) return null;
      return { checked: r.querySelector('input[type=checkbox]').checked, qty: r.querySelector('input.tp-qty').value };
    });
    check('持续广播 4s 后勾选仍保持（核心缺陷已修复）', !!afterBurst && afterBurst.checked === true, JSON.stringify(afterBurst));
    check('持续广播 4s 后数量仍为 2', !!afterBurst && afterBurst.qty === '2', JSON.stringify(afterBurst));

    // 提交并使用 UI 确认
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-picker .mini')).find(x => x.textContent.includes('更新我的提供'));
      if (b) b.click();
    });
    await sleep(900);
    check('提交后「我的提供」显示所选物品', (await p1.textContent('.trade-side.mine')).includes('黄金锦鲤'));
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('确认交易'));
      if (b) b.click();
    });
    await sleep(900);
    check('点击确认后按钮变为「已确认」', (await p1.textContent('.trade-actions')).includes('已确认'), await p1.textContent('.trade-actions'));
    check('确认状态同步到对方视图', (await p2.textContent('.trade-side:not(.mine)')).includes('已确认'), await p2.textContent('.trade-side:not(.mine)'));

    // —— 滚动位置保持（SSE 广播重绘不再把长列表拽回顶部）——
    section('重绘滚动保持');
    await clickNav(p1, '渔获记录');
    const scrollInfo = await p1.evaluate(async () => {
      const content = document.querySelector('.content'); // #main 的滚动容器
      if (!content) return { ok: false, why: 'no .content' };
      content.scrollTop = 150;
      const before = content.scrollTop;
      if (!window.UI || !window.UI.renderView) return { ok: false, why: 'no renderView' };
      window.UI.renderView(); // 等价于一次 SSE 广播触发的整页重绘
      await new Promise(r => setTimeout(r, 80));
      const content2 = document.querySelector('.content');
      return { ok: true, scrollable: content2.scrollHeight > content2.clientHeight, before: before, after: content2 ? content2.scrollTop : -1 };
    });
    check('渔获记录页可滚动', scrollInfo.ok && scrollInfo.scrollable && scrollInfo.before > 0, JSON.stringify(scrollInfo));
    check('重绘后滚动位置保持（不回滚到顶部）', scrollInfo.ok && scrollInfo.after === scrollInfo.before, JSON.stringify(scrollInfo));

    // —— 反馈意见页 ——
    section('反馈意见页');
    await clickNav(p1, '反馈意见');
    check('反馈页渲染提交框与冷却状态', (await p1.$$('.fb-input')).length === 1 && (await p1.$$('.fb-banner')).length === 1);
    check('反馈页有类型选择按钮', (await p1.$$('.fb-kinds .inv-cat')).length === 4);
    // 提交一条反馈
    await p1.fill('.fb-input', '浏览器自动化提交的测试反馈');
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.feedback-panel .primary')).find(x => x.textContent.includes('提交反馈')); if (b) b.click(); });
    await sleep(900);
    check('提交后进入冷却状态', (await p1.textContent('.fb-banner')).includes('冷却'));
    check('我的反馈历史出现记录', (await p1.$$('.fb-history .fb-item')).length >= 1);
    check('冷却中提供花金币结束 CD 按钮', (await p1.$$('.fb-banner .mini')).length === 1);

    // —— 版本守卫：本地与服务器版本一致时不触发刷新 ——
    section('版本守卫');
    const verCheck = await p1.evaluate(async () => {
      if (!window.Net || !window.Net.guardVersion) return { ok: false, why: 'no guardVersion' };
      const reloaded = await window.Net.guardVersion();
      return { ok: true, reloaded: reloaded, local: window.GameData.VERSION };
    });
    check('版本一致时不触发整页刷新', verCheck.ok && verCheck.reloaded === false, JSON.stringify(verCheck));

    // 移动端窄屏
    section('窄屏自适应');
    const p3 = await ctx.newPage();
    await p3.setViewportSize({ width: 420, height: 860 });
    await login(p3, tokS);
    await clickNav(p3, '渔场动态');
    const mob = await p3.evaluate(() => {
      const cols = document.querySelector('.ground-cols');
      const counts = document.querySelector('.ground-counts');
      const sidebar = document.querySelector('.sidebar');
      const nav = document.querySelector('#nav');
      const cs = getComputedStyle(sidebar);
      return {
        cols: getComputedStyle(cols).gridTemplateColumns.split(' ').length,
        countCols: getComputedStyle(counts).gridTemplateColumns.split(' ').length,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
        sidebarPos: cs.position,
        sidebarBottom: cs.bottom,
        navRow: getComputedStyle(nav).flexDirection,
        bodyPadBottom: parseFloat(getComputedStyle(document.body).paddingBottom) || 0,
      };
    });
    check('窄屏下渔场动态合并为单栏', mob.cols === 1, String(mob.cols));
    check('窄屏下无横向溢出', mob.overflowX === false, String(mob.overflowX));
    // 手机专属排版：侧栏转为固定底部标签栏，内容留出底部空间
    check('手机端侧栏改为固定底部标签栏', mob.sidebarPos === 'fixed' && mob.sidebarBottom === '0px', JSON.stringify(mob));
    check('手机端导航为横向标签', mob.navRow === 'row', mob.navRow);
    check('手机端内容区为底部标签栏留白', mob.bodyPadBottom >= 40, String(mob.bodyPadBottom));
    // 每个已实现页面在手机端都能渲染且无横向溢出
    const mobileViews = ['钓鱼', '钓竿配置', '背包', '系统商店', '开放市集', '鱼类图鉴', '渔获记录', '反馈意见'];
    let mobBad = null;
    for (const v of mobileViews) {
      await clickNav(p3, v);
      const bad = await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      if (bad) { mobBad = v; break; }
    }
    check('手机端各页面均无横向溢出', mobBad === null, mobBad ? ('溢出页：' + mobBad) : '');

    check('全程无页面错误', errs.length === 0, errs.join(' | '));

  } catch (e) {
    console.log('TEST ERROR: ' + e.message + '\n' + e.stack);
    fail++;
  } finally {
    if (browser) await browser.close();
    srv.kill();
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n============================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) console.log('失败项：\n  - ' + failed.join('\n  - '));
    console.log(fail === 0 ? 'UI LAYOUT TESTS PASS' : 'UI LAYOUT TESTS FAILED');
    console.log('============================');
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 150);
  }
})();
