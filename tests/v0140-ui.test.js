/*
 * v0.14.0 界面回归（浏览器实测）
 * 覆盖：
 *   · 闪动修复：资产广播（上鱼）不再整页重建 —— 背包页签 / 收购卡片 / 限购面板 / 市集右栏的
 *     按钮都是同一个 DOM 节点，数量仍就地刷新
 *   · 收购卡片体型档小按钮（大型 +50% / 巨型 +150%）：文案带百分比、没量时灰掉、点击按档位卖且含加成
 *   · 批量出售窗口：一般 / 大型 / 巨型 三条通道各可填数量，一次确认按通道逐笔卖出
 *   · 鱼类暂时不能上市集：背包行出「上架暂停」而不是「上架」，市集右栏也没有鱼类分类
 *   · 走势图数值：柱子悬停给「时间 · 价格」，左侧价格刻度、下方起止时间与基准价
 *   · 自动售出「体型档」开关：默认关，点开后服务端状态同步
 * 运行： node tests/v0140-ui.test.js（需要 CHROME_PATH 或本机 Chrome/Edge）
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 */
'use strict';
const { chromium } = require('playwright-core');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8250;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0140ui-test-'));
const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== [' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + ' ==='); }
const T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
async function until(fn, ok, timeout) {
  const dl = Date.now() + (timeout || 10000);
  for (;;) { const v = await fn().catch(() => null); if (ok(v)) return v; if (Date.now() >= dl) return v; await sleep(80); }
}
function req(method, p, body) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}
const GET = p => req('GET', p), POST = (p, b) => req('POST', p, b);
const FISH = 'crucian';                       // 鲫鱼：基准体型上限 35cm（>35 且 ≤63 大型、>63 巨型）
const SIZE_L = 50, SIZE_G = 999;
const fishCatch = (token, size) => POST('/api/dev/catch', size
  ? { token: token, item: { id: FISH, kind: 'fish', rarity: 'common', size: size } }
  : { token: token, item: { id: FISH, kind: 'fish', rarity: 'common' } });
const meOf = async () => (await GET('/api/me?token=' + tok)).data || {};
const bigOf = (me, id) => (me.bigfish && me.bigfish[id]) || null;
async function clickNav(page, name) {
  await until(() => page.evaluate(n => Array.from(document.querySelectorAll('.nav-item')).some(x => x.textContent.includes(n)), name), v => v === true, 30000);
  await page.evaluate(n => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n)); if (b) b.click(); }, name);
}
async function openMallTab(page, tab) {
  await clickNav(page, '商城');
  // ⚠️ tab 必须当参数传进浏览器上下文：写成 `() => document.querySelector('[data-malltab="' + tab + '"]')`
  // 会在页面里 ReferenceError → until 永远不满足、白等满超时（三处共浪费 60 秒）
  await until(() => page.evaluate(t => !!document.querySelector('[data-malltab="' + t + '"]'), tab), v => v === true, 15000);
  await page.evaluate(t => { const b = document.querySelector('[data-malltab="' + t + '"]'); if (b && !b.classList.contains('on')) b.click(); }, tab);
  await until(() => page.evaluate(t => {
    const b = document.querySelector('[data-malltab="' + t + '"]');
    return !!(b && b.classList.contains('on'));
  }, tab), v => v === true, 8000);
}
const openShop = page => openMallTab(page, 'shop');
// 点背包里某条鱼的某个按钮（按文本）
const clickRowBtn = (page, id, text) => page.evaluate(a => {
  const row = document.querySelector('#main .inv-page-row[data-id="' + a.id + '"]') ||
    document.querySelector('#main .inv-tier-row[data-id="' + a.id + '"]');
  if (!row) return false;
  const b = Array.from(row.querySelectorAll('button, .mini')).find(x => x.textContent.trim().indexOf(a.text) >= 0);
  if (!b) return false;
  b.click();
  return true;
}, { id: id, text: text });
const cardOf = (page, id) => page.evaluate(i => {
  const c = document.querySelector('.shop-card[data-id="' + i + '"]');
  if (!c) return null;
  const tiers = Array.from(c.querySelectorAll('.sc-tier-btn')).map(b => ({
    tier: b.getAttribute('data-tier'), text: b.textContent.trim(), off: b.disabled,
  }));
  return {
    sell: (c.querySelector('.sc-sell-btn') || {}).textContent || '',
    pct: (c.querySelector('.sc-pct') || {}).textContent || '',
    tiers: tiers,
  };
}, id);

let srv = null, browser = null, tok = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA, AUTOSELL_BATCH: '1' }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v140ui_a', password: 'abcd1234', name: '界面甲', qq: '39402' });
  tok = rA.data.token;
  check('账号就绪', !!tok, JSON.stringify(rA.data));
  // 底料：普通鲫鱼 + 一条巨型 + 一条大型 + 材料（材料用来验证上架入口仍在）
  await POST('/api/dev/seed', { token: tok, inventory: { crucian: 6, relic: 3 }, coins: 500000 });
  await fishCatch(tok, SIZE_G);
  await fishCatch(tok, SIZE_L);
  const me0 = await meOf();
  check('前置：持有普通量 + 大型 + 巨型', (me0.inventory[FISH] || 0) === 8 && bigOf(me0, FISH).L === 1 && bigOf(me0, FISH).G === 1,
    JSON.stringify({ inv: me0.inventory[FISH], bf: bigOf(me0, FISH) }));

  browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
  const p1 = await browser.newPage();
  p1.on('pageerror', e => console.log('  PAGE-ERROR ' + (e && e.message)));
  p1.on('console', m => { if (m.type() === 'error') console.log('  CONSOLE-ERROR ' + m.text().slice(0, 200)); });
  await p1.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await p1.evaluate(t => localStorage.setItem('fishing_token', t), tok);
  await p1.reload({ waitUntil: 'load' });
  await sleep(900);
  await until(() => p1.evaluate(() => !!window.Engine && !!window.Engine.state.me), v => v === true, 30000);

  // ---------------- 闪动修复 ----------------
  section('闪动修复：上鱼不再整页重建（按钮是同一个 DOM 节点）');
  await clickNav(p1, '背包');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .inv-page-tabs .inv-cat')), v => v === true, 20000);
  const invBefore = await p1.evaluate(() => {
    window.__tabSent = document.querySelector('#main .inv-page-tabs .inv-cat');
    window.__rowSent = document.querySelector('#main .inv-page-row[data-id="crucian"]');
    return {
      cnt: (document.querySelector('#main .inv-page-row[data-id="crucian"] .cnt') || {}).textContent || '',
      tabs: Array.from(document.querySelectorAll('#main .inv-page-tabs .inv-cat')).map(b => b.textContent.trim()),
    };
  });
  await fishCatch(tok);                        // 上一条普通鲫鱼：结构不变 → 应走就地补丁
  await sleep(1800);
  const invAfter = await p1.evaluate(() => ({
    tabSame: document.querySelector('#main .inv-page-tabs .inv-cat') === window.__tabSent,
    rowSame: document.querySelector('#main .inv-page-row[data-id="crucian"]') === window.__rowSent,
    cnt: (document.querySelector('#main .inv-page-row[data-id="crucian"] .cnt') || {}).textContent || '',
  }));
  check('背包：页签按钮仍是同一个 DOM 节点（没有整页重建）', invAfter.tabSame === true);
  check('背包：那一行也还是同一个节点（滚动 / 展开状态不会被冲掉）', invAfter.rowSame === true);
  check('背包：数量就地刷新（×' + invBefore.cnt.replace(/\D/g, '') + ' → ×' + invAfter.cnt.replace(/\D/g, '') + '）',
    invAfter.cnt !== invBefore.cnt, invBefore.cnt + ' -> ' + invAfter.cnt);

  await openShop(p1);
  await until(() => p1.evaluate(() => !!document.querySelector('.shop-card[data-id="' + 'crucian' + '"]')), v => v === true, 20000);
  const shopBefore = await p1.evaluate(() => {
    window.__cardSent = document.querySelector('.shop-card[data-id="crucian"] .sc-sell-btn');
    return (document.querySelector('.shop-card[data-id="crucian"] .sc-pct') || {}).textContent || '';
  });
  await fishCatch(tok);
  await sleep(1800);
  const shopAfter = await p1.evaluate(() => ({
    same: document.querySelector('.shop-card[data-id="crucian"] .sc-sell-btn') === window.__cardSent,
    pct: (document.querySelector('.shop-card[data-id="crucian"] .sc-pct') || {}).textContent || '',
  }));
  check('收购卡片：出售按钮仍是同一个 DOM 节点', shopAfter.same === true);
  check('收购卡片：持有 / 可用数字就地刷新', shopAfter.pct !== shopBefore, shopBefore + ' -> ' + shopAfter.pct);

  await openMallTab(p1, 'mall');
  const mallSent = await p1.evaluate(() => {
    window.__mallPanel = document.querySelector('#main .panel');
    return !!window.__mallPanel;
  });
  await fishCatch(tok);
  await sleep(1800);
  check('限购页：面板节点未被整页重建（金币条就地刷新）',
    (await p1.evaluate(() => !!window.__mallPanel && document.querySelector('#main .panel') === window.__mallPanel)) === true,
    String(mallSent));

  await openMallTab(p1, 'market');
  const mkSent = await p1.evaluate(() => {
    window.__mkSent = document.querySelector('.mkt-sell');
    return !!window.__mkSent;
  });
  await fishCatch(tok);
  await sleep(1800);
  check('市集页：右栏「我的背包」节点未被重建（多选上架不会弹回顶部）',
    (await p1.evaluate(() => !!window.__mkSent && document.querySelector('.mkt-sell') === window.__mkSent)) === true,
    String(mkSent));

  // ---------------- 收购卡片体型档小按钮 ----------------
  section('收购卡片：大型 +50% / 巨型 +150% 小按钮');
  await openShop(p1);
  await until(() => p1.evaluate(() => !!document.querySelector('.shop-card[data-id="crucian"] .sc-tier-btn')), v => v === true, 20000);
  const card = await cardOf(p1, FISH);
  check('卡片上有两个档位按钮（大型 / 巨型）', !!card && card.tiers.length === 2 &&
    card.tiers[0].tier === 'L' && card.tiers[1].tier === 'G', JSON.stringify(card && card.tiers));
  check('按钮文案写明加成百分比与可卖量（大型 +50% / 巨型 +150%）',
    !!card && /大型 \+50%/.test(card.tiers[0].text) && /巨型 \+150%/.test(card.tiers[1].text) &&
    /×1/.test(card.tiers[0].text) && /×1/.test(card.tiers[1].text), JSON.stringify(card && card.tiers));
  check('有量时按钮可用（未灰）', !!card && !card.tiers[0].off && !card.tiers[1].off);

  // 点「巨型 +150%」按档位卖掉：金币应含 +150% 加成
  const unitNow = (await GET('/shop')).data[FISH].price;
  const coinsBefore = (await meOf()).coins;
  await p1.evaluate(() => document.querySelector('.shop-card[data-id="crucian"] .sc-tier-btn[data-tier="G"]').click());
  await sleep(1200);
  const meAfterG = await meOf();
  const expectGain = unitNow + Math.round(unitNow * 1.5);
  check('点「巨型 +150%」按档位成交（+ ' + expectGain + '💰 = 单价 ' + unitNow + ' + 加成 ' + Math.round(unitNow * 1.5) + '）',
    meAfterG.coins === coinsBefore + expectGain, JSON.stringify({ coins: meAfterG.coins, before: coinsBefore, expect: expectGain }));
  check('巨型预留随之清空', !(bigOf(meAfterG, FISH) || {}).G, JSON.stringify(bigOf(meAfterG, FISH)));
  await sleep(600);
  const cardGone = await cardOf(p1, FISH);
  check('卖完后该档按钮变灰（与主按钮同一套「没量就灰」处理）',
    !!cardGone && cardGone.tiers[1].off === true && /巨型 \+150%/.test(cardGone.tiers[1].text), JSON.stringify(cardGone && cardGone.tiers[1]));

  // ---------------- 批量出售：三条通道 ----------------
  section('批量出售窗口：一般 / 大型 / 巨型 三条通道');
  await clickNav(p1, '背包');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .inv-page-row[data-id="crucian"]')), v => v === true, 20000);
  await fishCatch(tok, SIZE_G);                 // 再种一条巨型，凑齐三条通道
  await sleep(1500);
  const opened = await clickRowBtn(p1, FISH, '批量出售');
  check('背包行有「批量出售」入口并能打开', opened === true);
  await until(() => p1.evaluate(() => !!document.querySelector('.batch-sell-modal')), v => v === true, 10000);
  const chans = await p1.evaluate(() => Array.from(document.querySelectorAll('.batch-sell-modal .bs-chan')).map(r => ({
    tier: r.getAttribute('data-tier'), head: (r.querySelector('.bs-chan-head') || {}).textContent || '',
    num: (r.querySelector('input[type=number]') || {}).value, max: (r.querySelector('input[type=number]') || {}).max,
  })));
  check('窗口按通道列出（一般 / 大型 / 巨型 各一行）',
    chans.length === 3 && chans.map(c => c.tier).join(',') === 'N,L,G', JSON.stringify(chans));
  check('档位行写明加成与可卖量', /\+150%/.test(chans[2].head) && /可卖 ×1/.test(chans[2].head), JSON.stringify(chans[2].head));
  check('保留旧控件类名（首个通道仍是唯一的 .bs-num / .bs-range）',
    (await p1.$$('.batch-sell-modal .bs-num')).length === 1 && (await p1.$$('.batch-sell-modal .bs-range')).length === 1 &&
    (await p1.$$('.batch-sell-modal .bs-trend')).length === 1);
  // 只卖巨型一档：把另外两条通道清零
  await p1.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.batch-sell-modal .bs-chan'));
    rows.forEach(r => {
      const t = r.getAttribute('data-tier');
      const n = r.querySelector('input[type=number]');
      n.value = t === 'G' ? '1' : '0';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  const est = await p1.evaluate(() => (document.querySelector('#bs-est') || {}).textContent || '');
  check('合计只算已填的通道（含加成）', /共售出 1 个/.test(est), est);
  await p1.evaluate(() => document.querySelector('#bs-go').click());
  await until(() => p1.evaluate(() => !!document.querySelector('.confirm-modal .cf-ok')), v => v === true, 10000);
  const confirmTxt = await p1.evaluate(() => (document.querySelector('.confirm-modal') || {}).textContent || '');
  check('确认框只列已填的通道（巨型 ×1），不列被清零的通道',
    /巨型 ×1/.test(confirmTxt) && !/一般 ×/.test(confirmTxt) && !/大型 ×/.test(confirmTxt), confirmTxt.slice(0, 120));
  const unitB = (await GET('/shop')).data[FISH].price;
  const coinsB = (await meOf()).coins;
  await p1.evaluate(() => document.querySelector('.confirm-modal .cf-ok').click());
  await sleep(1500);
  const meB = await meOf();
  check('只卖掉巨型那一条（含 +150% 加成）',
    !(bigOf(meB, FISH) || {}).G && meB.coins === coinsB + unitB + Math.round(unitB * 1.5),
    JSON.stringify({ bf: bigOf(meB, FISH), coins: meB.coins, before: coinsB }));

  // ---------------- 鱼类暂时不能上市集 ----------------
  section('鱼类暂时不能上市集（背包与市集入口同步撤掉）');
  await clickNav(p1, '背包');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .inv-page-row[data-id="crucian"]')), v => v === true, 20000);
  const fishRow = await p1.evaluate(() => {
    const row = document.querySelector('#main .inv-page-row[data-id="crucian"]');
    return row ? Array.from(row.querySelectorAll('button, .mk-off')).map(b => b.textContent.trim()) : null;
  });
  check('鱼类行没有「上架」按钮，改成「上架暂停」提示',
    !!fishRow && !fishRow.some(t => t === '上架') && fishRow.some(t => t === '上架暂停'), JSON.stringify(fishRow));
  const matRow = await p1.evaluate(() => {
    const row = document.querySelector('#main .inv-page-row[data-id="relic"]');
    return row ? Array.from(row.querySelectorAll('button')).map(b => b.textContent.trim()) : null;
  });
  check('材料行的「上架」入口照旧', !!matRow && matRow.some(t => t === '上架'), JSON.stringify(matRow));
  const marketCats = await openMallTab(p1, 'market').then(() => p1.evaluate(() =>
    Array.from(document.querySelectorAll('.mkt-sell .mkt-cats .inv-cat')).map(b => b.textContent.trim())));
  check('市集右栏没有鱼类分类（鱼类不进上架列表）',
    !marketCats.some(t => t.indexOf('鱼类') >= 0) && !marketCats.some(t => t.indexOf('🐟') >= 0), JSON.stringify(marketCats));
  const mkHint = await p1.evaluate(() => {
    const h = document.querySelector('.mkt-sell .mk-off-hint');
    return h ? h.textContent : '';
  });
  check('市集右栏说明鱼类为何不能上架', /暂时不能上架/.test(mkHint), mkHint.slice(0, 80));
  const srvList = await POST('/api/market/list', { token: tok, id: FISH, qty: 1, price: 10, hours: 6 });
  check('服务端同样拒绝（前端隐藏之外还有一道）', srvList.status === 400, JSON.stringify(srvList.data));

  // ---------------- 走势图数值 ----------------
  section('价格走势图：柱子带时间与价格、坐标带刻度');
  // 用单价高的鱼（巨型鲶鱼 120💰）攒采样：低价鱼的现价取整后几次出售都不跳数，
  // 采样点要有 2 个以上才画图（recordPrice 只在价格变化或过了采样间隔时记点）
  await POST('/api/dev/seed', { token: tok, inventory: { crucian: 6, relic: 3, catfish: 12, bait_pack: 4 }, coins: 500000 });
  for (let i = 0; i < 4; i++) { await POST('/api/sell', { token: tok, id: 'catfish', qty: 1 }); await sleep(80); }
  const hist = await GET('/api/shop/history?id=catfish');
  check('前置：已有 ≥2 个价格采样点', ((hist.data || {}).points || []).length >= 2, String(((hist.data || {}).points || []).length));
  await openShop(p1);
  await until(() => p1.evaluate(() => !!document.querySelector('.shop-card[data-id="catfish"]')), v => v === true, 20000);
  await p1.evaluate(() => document.querySelector('.shop-card[data-id="catfish"]').click());
  await until(() => p1.evaluate(() => !!document.querySelector('.shop-modal .sd-spark')), v => v === true, 15000);
  const chart = await p1.evaluate(() => {
    const spark = document.querySelector('.shop-modal .sd-spark');
    const bars = Array.from(spark.querySelectorAll('i'));
    const y = Array.from(document.querySelectorAll('.shop-modal .sd-yaxis span')).map(s => s.textContent.trim());
    const x = (document.querySelector('.shop-modal .sd-xaxis') || {}).textContent || '';
    return { n: bars.length, tip: bars[bars.length - 1] ? bars[bars.length - 1].title : '', y: y, x: x };
  });
  check('每根柱子都有「时间 · 价格」提示', chart.n >= 2 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · \d+💰/.test(chart.tip), JSON.stringify(chart.tip));
  check('左侧标出最高 / 最低价格刻度', chart.y.length === 2 && /\d+💰/.test(chart.y[0]) && /\d+💰/.test(chart.y[1]), JSON.stringify(chart.y));
  check('下方标出起止时间与基准价', /\d{2}:\d{2}:\d{2}/.test(chart.x) && /基准 \d+💰/.test(chart.x), chart.x.slice(0, 120));
  await p1.evaluate(() => { const b = document.querySelector('.shop-modal .modal-close'); if (b) b.click(); });
  await sleep(300);

  // ---------------- 自动售出「体型档」开关 ----------------
  section('自动售出：体型档开关');
  await openShop(p1);
  await until(() => p1.evaluate(() => !!document.getElementById('sa-tier')), v => v === true, 20000);
  const sw0 = await p1.evaluate(() => {
    const c = document.getElementById('sa-tier');
    return {
      exists: !!c, checked: !!(c && c.checked),
      label: (c && c.parentElement.textContent) || '',
      hint: (c && c.parentElement.nextElementSibling && c.parentElement.nextElementSibling.textContent) || '',
    };
  });
  check('右栏有「体型档也自动售出」开关且默认关闭', sw0.exists && sw0.checked === false, JSON.stringify({ e: sw0.exists, c: sw0.checked }));
  check('开关文案写明加成（大型 +50% / 巨型 +150%）', /\+50%/.test(sw0.label) && /\+150%/.test(sw0.label), sw0.label.slice(0, 100));
  check('说明里写明动用顺序与「留大鱼」的默认口径',
    /普通量/.test(sw0.hint) && /大型/.test(sw0.hint) && /巨型/.test(sw0.hint) && /默认关闭/.test(sw0.hint), sw0.hint.slice(0, 120));
  await p1.evaluate(() => document.getElementById('sa-tier').click());
  await until(async () => ((await GET('/api/autosell?token=' + tok)).data || {}).tier === true, v => v === true, 10000);
  check('点开后服务端状态同步为「开」', ((await GET('/api/autosell?token=' + tok)).data || {}).tier === true);
  // 请求期间复选框是禁用态（防连点），回包后立刻解开——等它解开再断言
  await until(() => p1.evaluate(() => { const c = document.getElementById('sa-tier'); return !!(c && !c.disabled); }), v => v === true, 8000);
  const sw1 = await p1.evaluate(() => {
    const c = document.getElementById('sa-tier');
    return { checked: !!(c && c.checked), disabled: !!(c && c.disabled) };
  });
  check('界面复选框保持勾选、不再禁用', sw1.checked === true && sw1.disabled === false, JSON.stringify(sw1));
  const meTier = await meOf();
  check('/api/me 的规则里也带上开关（刷新页面后能还原）', !!(meTier.autoSell && meTier.autoSell.tier === true), JSON.stringify(meTier.autoSell));

  console.log('\nv0.14.0 界面回归小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) console.log('失败项：' + failed.join(' / '));
}
main().then(async () => {
  try { if (browser) await browser.close(); } catch (e) {}
  killTree(srv);
  process.exit(fail ? 1 : 0);
}).catch(async e => {
  console.error('TEST ERROR', e && e.stack || e);
  try { if (browser) await browser.close(); } catch (e2) {}
  killTree(srv);
  process.exit(1);
});
