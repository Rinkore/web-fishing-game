/*
 * v0.13.9 界面回归（浏览器实测）
 * 覆盖：
 *   · 连开宝匣不丢配件：并点/连点开箱后「客户端背包 === 服务端背包」，且消耗宝匣数与新增组件数一致
 *   · 过期库存快照被丢弃（连开丢件的直接机制：旧 HTTP 快照不得覆盖新状态）
 *   · 背包一般行只显示「普通量」（可用量），全预留的鱼不再画一般行、也不再冒出必然失败的「出售 1」
 *   · 收购卡片：全预留的鱼按钮变「仅体型档可卖」，不再点一次被服务端拒一次
 *   · 自动售出清单：按「已勾选物品合计」显示可卖合计 / 阈值 / 还差多少
 *   · 交易窗口：不再提供「体型档」筛选（那个筛选只会列出交易不了的大鱼），不可交易物品不列出
 * 运行： node tests/v0139-ui.test.js（需要 CHROME_PATH 或本机 Chrome/Edge）
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
const D = require(path.join(__dirname, '..', 'frontend', 'js', 'data.js'));

const ROOT = path.join(__dirname, '..');
const PORT = 8201;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0139ui-test-'));
const CHESTS = D.CHESTS || [];
const RANDOM_CHEST = CHESTS.find(c => c.mode === 'random') || CHESTS[0];   // Ⅰ 档：无确认框，点击即刻开箱

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
function section(t) { console.log('\n=== ' + t + ' ==='); }
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
const SSE_SEP = '\n\n', SSE_NL = '\n';
function sseListen(tok, sink) {
  const r = http.request({ hostname: 'localhost', port: PORT, path: '/events?token=' + encodeURIComponent(tok), method: 'GET' }, res => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf(SSE_SEP)) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split(SSE_NL).find(l => l.startsWith('data: '));
        if (!line) continue;
        try { const m = JSON.parse(line.slice(6)); (m && m.type === 'batch' && m.list ? m.list : [m]).forEach(x => sink && sink.push(x)); } catch (e) {}
      }
    });
  });
  r.on('error', () => {});
  r.end();
  return r;
}
let srv = null, browser = null;
let tok = null;
const meOf = async t => (await GET('/api/me?token=' + (t || tok))).data || {};
// 客户端背包（浏览器内）与服务器背包的对比：按 key→数量 归一化后整体比较
const normInv = inv => Object.keys(inv || {}).filter(k => (inv[k] || 0) > 0).sort().map(k => k + '=' + inv[k]).join(',');
const clientInv = page => page.evaluate(() => JSON.stringify(window.Engine.state.inventory || {}));
async function clickNav(page, name) {
  await until(() => page.evaluate(n => Array.from(document.querySelectorAll('.nav-item')).some(x => x.textContent.includes(n)), name), v => v === true, 30000);
  await page.evaluate(n => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n)); if (b) b.click(); }, name);
}
async function openWorkshop(page, tab) {
  await clickNav(page, '工坊');
  await until(() => page.evaluate(() => !!document.querySelector('[data-wstab]')), v => v === true, 20000);
  await page.evaluate(t => { const b = document.querySelector('[data-wstab="' + t + '"]'); if (b && !b.classList.contains('on')) b.click(); }, tab || 'open');
  await until(() => page.evaluate(() => !!document.querySelector('.chest-grid .chest-card')), v => v === true, 20000);
}
async function openShop(page) {
  await clickNav(page, '商城');
  await until(() => page.evaluate(() => !!document.querySelector('[data-malltab="shop"]')), v => v === true, 20000);
  await page.evaluate(() => { const b = document.querySelector('[data-malltab="shop"]'); if (b && !b.classList.contains('on')) b.click(); });
  await until(() => page.evaluate(() => !!document.querySelector('#shop-panel .shop-grid')), v => v === true, 20000);
}
const chestHave = (page, id) => page.evaluate(i => {
  const el = document.querySelector('.chest-bar [data-have="' + i + '"], .chest-card [data-have="' + i + '"]');
  return el ? Number(el.textContent) || 0 : -1;
}, id);
// 背包里组件的总件数（客户端）
const compCount = page => page.evaluate(() => {
  const inv = window.Engine.state.inventory || {};
  return Object.keys(inv).reduce((s, k) => s + (/^(?:mb|hd|ln|rl|hk|ch)_|#/.test(k) ? (inv[k] || 0) : 0), 0);
});
// 背包里「非宝匣/非残片」的组件件数（更稳：直接按 GameData 判定）
const compCount2 = page => page.evaluate(() => {
  const inv = window.Engine.state.inventory || {};
  let n = 0;
  Object.keys(inv).forEach(k => { const m = window.GameData.itemOf(k); if (m && m.kind === 'component') n += inv[k] || 0; });
  return n;
});
const openChestOf = (page, chestId) => page.evaluate(id => {
  const card = Array.from(document.querySelectorAll('.chest-grid .chest-card')).find(c => {
    const b = Array.from(c.querySelectorAll('.cc-acts button')).find(x => x.textContent.trim() === '开箱');
    return b && c.querySelector('[data-have="' + id + '"]');
  });
  if (!card) return false;
  const b = Array.from(card.querySelectorAll('.cc-acts button')).find(x => x.textContent.trim() === '开箱');
  b.click();
  return true;
}, chestId);
const closeResult = page => page.evaluate(() => { const b = document.querySelector('.chest-result-modal .cr-ok'); if (b) b.click(); });

async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v139ui_a', password: 'abcd1234', name: '界面甲', qq: '39201' });
  tok = rA.data.token;
  check('账号就绪', !!tok, JSON.stringify(rA.data));
  // 给足残片与金币，并预合成一批宝匣
  await POST('/api/dev/seed', { token: tok, inventory: { relic: 400 }, coins: 900000 });
  const crafted = await POST('/api/chest/craft', { token: tok, chestId: RANDOM_CHEST.id, qty: 8 });
  check('预合成 8 个「' + RANDOM_CHEST.name + '」', crafted.status === 200, JSON.stringify(crafted.data && crafted.data.error));

  browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
  const p1 = await browser.newPage();
  p1.on('pageerror', e => console.log('  PAGE-ERROR ' + (e && e.message)));
  p1.on('console', m => { if (m.type() === 'error') console.log('  CONSOLE-ERROR ' + m.text().slice(0, 200)); });
  await p1.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await p1.evaluate(t => localStorage.setItem('fishing_token', t), tok);
  await p1.reload({ waitUntil: 'load' });
  await sleep(900);
  await until(() => p1.evaluate(() => !!window.Engine && !!window.Engine.state.me), v => v === true, 30000);

  // ---------------- 连开宝匣 ----------------
  section('连开宝匣：并点 + 连点都不丢配件');
  await openWorkshop(p1, 'open');
  const before = { chest: await chestHave(p1, RANDOM_CHEST.id), comp: await compCount2(p1) };
  check('页面读到持有宝匣与组件数（前置）', before.chest >= 8, JSON.stringify(before));
  // ① 并点：同一帧内连点 3 次（旧版会发 3 笔并发请求，先发的旧快照后到 → 界面丢件）
  await p1.evaluate(id => { for (let i = 0; i < 3; i++) window.__openChestBurst = !!id; }, RANDOM_CHEST.id);
  for (let i = 0; i < 3; i++) await openChestOf(p1, RANDOM_CHEST.id);
  await sleep(2500);
  const srvInv1 = (await meOf()).inventory || {};
  const cliInv1 = JSON.parse(await clientInv(p1));
  check('并点 3 次后：客户端背包 === 服务端背包（不丢件）',
    normInv(cliInv1) === normInv(srvInv1),
    'srv=' + normInv(srvInv1) + ' | cli=' + normInv(cliInv1));
  const afterBurst = { chest: await chestHave(p1, RANDOM_CHEST.id), comp: await compCount2(p1) };
  check('消耗的宝匣数与新增组件数一致（每箱恰好 1 件）',
    (before.chest - afterBurst.chest) === (afterBurst.comp - before.comp) && (afterBurst.comp - before.comp) >= 1,
    JSON.stringify({ before: before, after: afterBurst }));
  // 关掉结果窗（并点最多留一个结果窗）
  await closeResult(p1);
  await sleep(300);

  // ② 连点：等结果窗出现就收下再开，连开 4 次
  const before2 = { chest: await chestHave(p1, RANDOM_CHEST.id), comp: await compCount2(p1) };
  for (let i = 0; i < 4; i++) {
    const ok = await openChestOf(p1, RANDOM_CHEST.id);
    if (!ok) break;
    await until(() => p1.evaluate(() => !!document.querySelector('.chest-result-modal')), v => v === true, 8000);
    await closeResult(p1);
    await sleep(250);
  }
  await sleep(800);
  const srvInv2 = (await meOf()).inventory || {};
  const cliInv2 = JSON.parse(await clientInv(p1));
  check('连开 4 次后：客户端背包 === 服务端背包（不丢件）',
    normInv(cliInv2) === normInv(srvInv2),
    'srv=' + normInv(srvInv2) + ' | cli=' + normInv(cliInv2));
  const afterSeq = { chest: await chestHave(p1, RANDOM_CHEST.id), comp: await compCount2(p1) };
  check('连开 4 次：宝匣少 4、组件多 4',
    (before2.chest - afterSeq.chest) === 4 && (afterSeq.comp - before2.comp) === 4,
    JSON.stringify({ before: before2, after: afterSeq }));

  // ---------------- 快照判新护栏 ----------------
  section('过期库存快照被丢弃（连开丢件的直接机制）');
  const guard = await p1.evaluate(() => {
    const S = window.Engine.state;
    const rev = Number(S.invRev) || 0;
    const snapshot = JSON.parse(JSON.stringify(S.inventory));
    // 模拟「先发的旧响应后到」：拿一份旧快照（少一件、rev 更小）去覆盖
    const stale = JSON.parse(JSON.stringify(snapshot));
    const someKey = Object.keys(snapshot).find(k => snapshot[k] > 0);
    stale[someKey] = snapshot[someKey] - 1;
    const staleSame = JSON.parse(JSON.stringify(stale));
    const staleRev = rev - 1;
    const appliedStale = window.Engine.applyInv(stale, staleRev);
    const afterStale = JSON.stringify(window.Engine.state.inventory) === JSON.stringify(snapshot);
    // 新快照（rev 更大）必须被采纳
    const fresh = JSON.parse(JSON.stringify(snapshot));
    fresh[someKey] = snapshot[someKey] + 1;
    const appliedFresh = window.Engine.applyInv(fresh, rev + 1);
    const afterFresh = (window.Engine.state.inventory[someKey] === snapshot[someKey] + 1) && (Number(window.Engine.state.invRev) === rev + 1);
    return { rev: rev, appliedStale: appliedStale, afterStale: afterStale, appliedFresh: appliedFresh, afterFresh: afterFresh, someKey: someKey, staleSame: !!staleSame };
  });
  check('旧 rev 快照被拒绝（背包保持不变）', guard.appliedStale === false && guard.afterStale === true, JSON.stringify(guard));
  check('新 rev 快照被采纳（rev 前进）', guard.appliedFresh === true && guard.afterFresh === true, JSON.stringify(guard));

  // ---------------- 背包一般行口径 ----------------
  section('背包：一般行 = 普通量（可用量），全预留的鱼不再画一般行');
  await POST('/api/dev/seed', { token: tok, inventory: { crucian: 3, carp: 0 } });
  await POST('/api/dev/catch', { token: tok, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 999 } });   // 巨型预留 1
  await sleep(700);
  await clickNav(p1, '背包');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .inv-page')), v => v === true, 15000);
  await sleep(400);
  // 期望值全部取自服务端（权威）：客户端与服务端必须一致（增量不与快照重复计数）
  const srv1 = await meOf();
  const tot1 = (srv1.inventory || {}).crucian || 0;
  const g1 = ((srv1.bigfish || {}).crucian || {}).G || 0;
  const avail1 = tot1 - g1;
  check('客户端背包 === 服务端背包（增量不与已含该增量的快照重复计数）',
    normInv(JSON.parse(await clientInv(p1))) === normInv(srv1.inventory),
    'srv=' + normInv(srv1.inventory) + ' | cli=' + normInv(JSON.parse(await clientInv(p1))));
  const rows = await p1.$$eval('#main .inv-page-row', els => els.map(e => ({
    id: e.getAttribute('data-id'), txt: e.textContent.replace(/\s+/g, ' ').trim(),
  })));
  const cru = rows.find(r => r.id === 'crucian') || { txt: '' };
  const cruG = rows.find(r => r.id === 'crucian@G') || { txt: '' };
  check('一般行显示可用量 ' + avail1 + '（总量 ' + tot1 + ' − 巨型预留 ' + g1 + '）',
    new RegExp('×' + avail1 + '(?![0-9])').test(cru.txt), cru.txt + ' | srv tot=' + tot1 + ' g=' + g1);
  check('旁边标出总量（总 ×' + tot1 + '）', new RegExp('总 ×' + tot1).test(cru.txt), cru.txt);
  check('巨型预留单独成行 ×' + g1, /巨型/.test(cruG.txt) && new RegExp('×' + g1 + '(?![0-9])').test(cruG.txt), cruG.txt);
  const hint = await p1.evaluate(() => (document.querySelector('#main .inv-reserved') || {}).textContent || '');
  check('概览标明「其中大型/巨型预留 ' + g1 + ' 件」', new RegExp('预留\\s*' + g1 + '\\s*件').test(hint.replace(/\s+/g, ' ')), hint);
  // 清零普通量：只剩巨型预留 → 一般行不再出现
  await POST('/api/dev/seed', { token: tok, inventory: { crucian: 0 } });
  await POST('/api/dev/catch', { token: tok, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 999 } });
  await sleep(1000);
  const srv2 = await meOf();
  const tot2 = (srv2.inventory || {}).crucian || 0;
  const g2 = ((srv2.bigfish || {}).crucian || {}).G || 0;
  check('全预留前置：服务端 总量 ' + tot2 + ' = 巨型预留 ' + g2 + '（可用量 0）', tot2 === g2 && tot2 > 0, JSON.stringify({ tot2: tot2, g2: g2 }));
  check('客户端背包仍与服务端一致', normInv(JSON.parse(await clientInv(p1))) === normInv(srv2.inventory),
    'srv=' + normInv(srv2.inventory) + ' | cli=' + normInv(JSON.parse(await clientInv(p1))));
  const rows2 = await p1.$$eval('#main .inv-page-row', els => els.map(e => e.getAttribute('data-id')));
  check('全预留（可用量 0）的鱼不再画「一般」行，只留体型档行',
    rows2.indexOf('crucian') < 0 && rows2.indexOf('crucian@G') >= 0, JSON.stringify(rows2));

  // ---------------- 收购卡片 ----------------
  section('收购卡片：纯预留的鱼不再给必然失败的「出售 N 个」');
  await openShop(p1);
  const cardInfo = await p1.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#shop-panel .shop-card')).find(c => /鲫鱼/.test((c.querySelector('.sc-name') || {}).textContent || ''));
    if (!card) return null;
    return { line: (card.querySelector('.sc-pct') || {}).textContent || '', btn: (card.querySelector('.mini') || {}).textContent || '' };
  });
  check('卡片标出可用量（持有 1（可用 0））', !!cardInfo && /可用 0/.test(cardInfo.line), JSON.stringify(cardInfo));
  check('按钮变为「仅体型档可卖」（点下去也不会再被服务端拒）', !!cardInfo && /仅体型档可卖/.test(cardInfo.btn), JSON.stringify(cardInfo));

  // ---------------- 自动售出清单合计文案 ----------------
  section('自动售出清单：按「已勾选物品合计」展示');
  await POST('/api/autosell', { token: tok, bulk: 'all', remove: true });
  // bigfish:{} 清掉上一步为测试种的巨型预留，否则鲫鱼的可卖余量会被预留吃掉
  await POST('/api/dev/seed', { token: tok, inventory: { crucian: 3, carp: 2 }, bigfish: {} });
  await POST('/api/autosell', { token: tok, id: 'crucian', minPct: '', minPrice: '' });   // 不看价格 → 计入合计
  await POST('/api/autosell', { token: tok, id: 'carp', minPct: '', minPrice: '' });
  // 规则是走 HTTP 直接写服务端的（不经过页面），刷新一次让页面拉到最新规则（等价于玩家重进商城）
  await p1.reload({ waitUntil: 'load' });
  await sleep(1200);
  await until(() => p1.evaluate(() => !!window.Engine && !!window.Engine.state.me), v => v === true, 20000);
  await openShop(p1);
  await sleep(400);
  const summary = await p1.evaluate(() => (document.getElementById('sa-state') || {}).textContent || '');
  check('右栏摘要显示「可卖合计 5 / 阈值 100（还差 95）」',
    /可卖合计 5 \/ 阈值 100/.test(summary), summary);
  await until(() => p1.evaluate(() => !!document.getElementById('sa-open-list')), v => v === true, 10000);
  await p1.evaluate(() => document.getElementById('sa-open-list').click());
  await until(() => p1.evaluate(() => !!document.getElementById('asl-list')), v => v === true, 10000);
  await sleep(400);
  const listCnt = await p1.evaluate(() => (document.getElementById('asl-count') || {}).textContent || '');
  check('清单顶部同样给出合计（已启用项数 + 可卖合计）',
    /已启用 2 项/.test(listCnt) && /可卖合计 5 \/ 阈值 100/.test(listCnt), listCnt);
  const rowTxt = await p1.evaluate(() => {
    const row = Array.from(document.querySelectorAll('#asl-list .as-row')).find(r => /鲫鱼/.test(r.textContent));
    return row ? row.textContent.replace(/\s+/g, ' ') : '';
  });
  check('行内不再出现「差 N 条成包」（打包是合计判定，逐件差额已无意义）', !/条成包/.test(rowTxt), rowTxt);
  await p1.evaluate(() => { const b = document.querySelector('#as-list-modal .modal-close'); if (b) b.click(); });
  await sleep(200);

  // ---------------- 交易窗口 ----------------
  section('交易窗口：不再提供体型档筛选、不列不可交易物品');
  // 让鲫鱼变成「全预留」（可用量 0）用于验证不可交易物品不列出；鲤鱼留 2 条可交易（否则列表为空、连页签都不渲染）
  await POST('/api/dev/seed', { token: tok, inventory: { crucian: 0, carp: 2 }, bigfish: {} });
  await POST('/api/dev/catch', { token: tok, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 999 } });
  await sleep(700);
  const rB = await POST('/api/register', { username: 'v139ui_b', password: 'abcd1234', name: '界面乙', qq: '39202' });
  const tokB = rB.data && rB.data.token;
  const bMsgs = []; const sseB = sseListen(tokB, bMsgs);
  await POST('/api/me?token=' + tokB);
  await sleep(500);
  // 交易会话可能被掉线/顶号打断（服务端会随连接断开自动取消）→ 允许重发邀请重试
  const readPicker = () => p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.tp-cats .inv-cat')).find(x => x.textContent.includes('鱼类'));
    if (!b) return null;
    b.click();
    return {
      subs: Array.from(document.querySelectorAll('.tp-subfilters .inv-subrow .sub-label')).map(e => e.textContent.trim()),
      ids: Array.from(document.querySelectorAll('.tp-rows .tp-row')).map(e => e.getAttribute('data-id')),
      st: { trade: !!window.Engine.state.trade, flash: window.Engine.state.tradeFlash || '' },
    };
  });
  let picker = null;
  for (let attempt = 0; attempt < 3 && !picker; attempt++) {
    const invite = await POST('/api/trade/invite', { token: tokB, target: 'v139ui_a' });
    if (attempt === 0) check('乙向甲发起交易邀请', invite.status === 200, JSON.stringify(invite.data));
    if (invite.status !== 200) { await sleep(800); continue; }
    await until(() => p1.evaluate(() => !!document.querySelector('.trade-modal, .trade-modal-body')), v => v === true, 15000);
    const acc = await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-modal button')).find(x => /接受|同意/.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    if (attempt === 0) check('接受按钮可点', acc === true);
    const got = await until(() => p1.evaluate(() => !!document.querySelector('.tp-cats')), v => v === true, 12000);
    if (!got) {
      console.log('  (第 ' + (attempt + 1) + ' 次：交易窗口状态 ' + JSON.stringify(await p1.evaluate(() => ({
        body: ((document.querySelector('.trade-modal-body') || {}).textContent || '(无窗口)').replace(/\s+/g, ' ').slice(0, 70),
        trade: window.Engine.state.trade ? { accepted: window.Engine.state.trade.accepted, cancelled: !!window.Engine.state.trade.cancelled, id: window.Engine.state.trade.id } : null,
        flash: window.Engine.state.tradeFlash || '',
      }))) + '，重试)');
      await sleep(600);
      continue;
    }
    const info = await readPicker();
    if (info && info.subs.length) picker = info;
    else { console.log('  (交易窗口在第 ' + (attempt + 1) + ' 次尝试中中断：' + JSON.stringify(info && info.st) + '，重试)'); await sleep(800); }
  }
  check('交易窗口鱼类只有「品质」（体型档筛选已移除）',
    !!picker && JSON.stringify(picker.subs) === '["品质"]', JSON.stringify(picker));
  check('不可交易的鱼（全预留）不在列表里', !!picker && picker.ids.indexOf('crucian') < 0, JSON.stringify(picker && picker.ids));
  try { sseB.destroy(); } catch (e) {}

  console.log('\nv0.13.9 界面回归小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败项：\n  - ' + failed.join('\n  - '));
}

main().catch(function (e) {
  fail++;
  console.log('\n  TEST ERROR  ' + (e && e.stack || e));
}).finally(async function () {
  try { if (browser) await browser.close(); } catch (e) {}
  try { if (srv) killTree(srv); } catch (e) {}
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
});
