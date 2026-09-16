/*
 * 缺陷回归测试（针对用户上报的 5 个问题）
 *   1. 在线交易：勾选物品后立刻被全部取消选中
 *   2. 鱼类图鉴不能解锁
 *   3. 全服大鱼榜一直无数据
 *   4. 开放市集必须整单购买（需支持自定义数量）
 *   5. 开放市集的物品卖出后卖家收不到钱
 * 运行： node tests/bugfix.test.js
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');
// 轮询等待工具（测试内部不依赖固定 sleep）：就绪即继续，超时才失败
const { waitFor, waitHttp, waitPage } = require('./_util.js');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8151;
const NODE = process.execPath;

let pass = 0, fail = 0; const failed = [];
function check(n, c, extra) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failed.push(n); console.log('  FAIL  ' + n + (extra ? ' -> ' + extra : '')); } }
function section(t) { console.log('\n=== ' + t + ' ==='); }
// 启动前清理端口占用：Windows 下测试进程被强杀时 taskkill 可能失败，残留的旧服务器会占住端口，
// 导致下一次运行的所有请求打到「陈旧的服务器实例」上（表现为大面积 未登录/数据不符）。
function killPortOccupant(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + port + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
      { stdio: 'ignore' });
  } catch (e) {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, u, body) {
  return new Promise(res => {
    const p = url.parse(u); const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: p.hostname, port: p.port, path: p.path, method, headers: h }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j, text: d }); });
    });
    r.on('error', () => res({ status: 0, data: null, text: '' }));
    if (data) r.write(data); r.end();
  });
}
const GET = u => req('GET', u);
const POST = (u, b) => req('POST', u, b);

function sse(token, sink) {
  const r = http.get('http://localhost:' + PORT + '/events?token=' + token, res => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) {
          try {
            const m = JSON.parse(line.slice(6));
            // perf-5/8 批量协议：batch 解包逐条；feedBatch（钓场分区 feed）展开为 feed 事件
            if (m && m.type === 'batch' && Array.isArray(m.list)) {
              for (const it of m.list) {
                if (it && it.type === 'feedBatch' && Array.isArray(it.list)) { for (const e2 of it.list) sink.push({ type: 'feed', entry: e2 }); }
                else sink.push(it);
              }
            }
            else if (m && m.type === 'feedBatch' && Array.isArray(m.list)) { for (const e2 of m.list) sink.push({ type: 'feed', entry: e2 }); }
            else sink.push(m);
          } catch (e) {}
        }
      }
    });
  });
  r.on('error', () => {});   // 服务器关闭时不抛出
  return r;
}

async function openPage(token) {
  const html = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push('jsdomError: ' + e.message));
  const dom = new JSDOM(html, { url: 'http://localhost:' + PORT + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = function (u, opts) {
    const full = u.startsWith('http') ? u : ('http://localhost:' + PORT + u);
    return new Promise((resolve, reject) => {
      const p = url.parse(full);
      const body = opts && opts.body ? opts.body : null;
      const h = Object.assign({}, (opts && opts.headers) || {});
      if (body) h['Content-Length'] = Buffer.byteLength(body);
      const r = http.request({ hostname: p.hostname, port: p.port, path: p.path, method: (opts && opts.method) || 'GET', headers: h }, rs => {
        let d = ''; rs.on('data', c => d += c);
        rs.on('end', () => resolve({ ok: rs.statusCode >= 200 && rs.statusCode < 300, status: rs.statusCode, json: () => Promise.resolve(JSON.parse(d || '{}')) }));
      });
      r.on('error', reject);
      if (body) r.write(body); r.end();
    });
  };
  const listeners = [];
  w.EventSource = function (u) {
    const self = this;
    this.onmessage = null; this.onerror = null;
    const r = http.get('http://localhost:' + PORT + u, res => {
      let buf = '';
      res.on('data', c => {
        buf += c.toString();
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (line && self.onmessage) { try { self.onmessage({ data: line.slice(6) }); } catch (e) {} }
        }
      });
    });
    r.on('error', () => {});
    listeners.push(r);
    this.close = function () { try { r.destroy(); } catch (e) {} };
  };
  if (token) w.localStorage.setItem('fishing_token', token);
  await new Promise(res => { if (w.document.readyState === 'complete') return res(); w.addEventListener('load', () => res()); setTimeout(res, 1500); });
  await sleep(500);
  return { dom, w, errs, listeners };
}

const navBtn = (w, name) => Array.from(w.document.querySelectorAll('.nav-item')).find(b => b.textContent.includes(name));
const tpRow = (w, name) => Array.from(w.document.querySelectorAll('.tp-row')).find(r => r.textContent.includes(name));

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-test-'));


(async () => {
  console.log('缺陷回归测试（5 个上报问题）');
  killPortOccupant(PORT);
  const srv = spawn(NODE, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  try {
    const rA = await POST('http://localhost:' + PORT + '/api/register', { username: 'fix_a', password: 'pass1234', name: '甲玩家', qq: '10002' });
    const rB = await POST('http://localhost:' + PORT + '/api/register', { username: 'fix_b', password: 'pass1234', name: '乙玩家', qq: '10003' });
    const tokA = rA.data.token, tokB = rB.data.token;

    // 监听双端广播
    const sinkA = [], sinkB = [];
    const cliA = sse(tokA, sinkA);
    const cliB = sse(tokB, sinkB);
    await sleep(400);

    // 为 A 预置库存（鲫鱼 10、鲤鱼 5），并留足金币
    await POST('http://localhost:' + PORT + '/api/dev/seed', { token: tokA, inventory: { crucian: 10, carp: 5 }, coins: 500 });

    // ============================================================
    section('【问题 3】全服大鱼榜无数据');
    // ============================================================
    const recBefore = await GET('http://localhost:' + PORT + '/api/records');
    check('初始大鱼榜为空', recBefore.status === 200 && Object.keys(recBefore.data.records).length === 0);

    // 客户端会在 /catch 里带上 item.size
    await POST('http://localhost:' + PORT + '/api/dev/catch', {
      token: tokA, size: 95.5,
      item: { kind: 'fish', rarity: 'rare', id: 'koi', name: '黄金锦鲤', size: 95.5 },
      ground: '落日海湾', spot: '礁石区',
    });
    await sleep(300);
    const recAfter = await GET('http://localhost:' + PORT + '/api/records');
    const koi = recAfter.data.records && recAfter.data.records.koi;
    check('钓到鱼后大鱼榜写入纪录', !!koi, JSON.stringify(recAfter.data.records));
    check('纪录体型正确 95.5cm', !!koi && koi.size === 95.5, JSON.stringify(koi));
    check('纪录保持者 = 钓到者显示名', !!koi && koi.who === '甲玩家', JSON.stringify(koi));
    check('B 收到 records 广播', sinkB.some(m => m.type === 'records' && m.records.koi && m.records.koi.size === 95.5));

    // 更小的鱼不覆盖纪录
    await POST('http://localhost:' + PORT + '/api/dev/catch', { token: tokB, size: 30, item: { kind: 'fish', rarity: 'rare', id: 'koi', name: '黄金锦鲤', size: 30 }, ground: '静水湖', spot: '深水区' });
    await sleep(250);
    const rec2 = await GET('http://localhost:' + PORT + '/api/records');
    check('更小的鱼不覆盖纪录', rec2.data.records.koi.size === 95.5 && rec2.data.records.koi.who === '甲玩家');

    // 更大的鱼刷新纪录
    await POST('http://localhost:' + PORT + '/api/dev/catch', { token: tokB, size: 108.2, item: { kind: 'fish', rarity: 'rare', id: 'koi', name: '黄金锦鲤', size: 108.2 }, ground: '静水湖', spot: '深水区' });
    await sleep(250);
    const rec3 = await GET('http://localhost:' + PORT + '/api/records');
    check('更大的鱼刷新纪录', rec3.data.records.koi.size === 108.2 && rec3.data.records.koi.who === '乙玩家', JSON.stringify(rec3.data.records.koi));

    // 材料 / 组件不进大鱼榜
    await POST('http://localhost:' + PORT + '/api/dev/catch', { token: tokA, size: null, item: { kind: 'material', rarity: 'common', id: 'rope', name: '耐磨绳', size: null }, ground: '静水湖', spot: '芦苇浅滩' });
    await sleep(250);
    const rec4 = await GET('http://localhost:' + PORT + '/api/records');
    check('材料不进大鱼榜', !rec4.data.records.rope);

    // ============================================================
    section('【问题 2】鱼类图鉴不能解锁');
    // ============================================================
    const cx1 = await GET('http://localhost:' + PORT + '/api/codex?token=' + tokA);
    check('图鉴接口返回成功', cx1.status === 200);
    check('图鉴已解锁「黄金锦鲤」', !!(cx1.data.codex && cx1.data.codex.koi), JSON.stringify(cx1.data.codex));
    check('图鉴记录数量 >= 1', cx1.data.codex.koi.count >= 1);
    check('图鉴记录首次时间', typeof cx1.data.codex.koi.first === 'number' && cx1.data.codex.koi.first > 0);
    check('图鉴已解锁「耐磨绳」', !!(cx1.data.codex && cx1.data.codex.rope));
    check('累计渔获计数 > 0', cx1.data.catchCount > 0);
    check('B 的图鉴已解锁（各自独立）', (await GET('http://localhost:' + PORT + '/api/codex?token=' + tokB)).data.codex.koi.count === 2);
    check('A 收到 codex 定向推送', sinkA.some(m => m.type === 'codex' && m.codex && m.codex.koi));
    check('A 收到 assets 定向推送（渔获入库）', sinkA.some(m => m.type === 'assets' && m.inventory && m.inventory.koi));

    // /catch 不再整包覆盖库存，而是服务器侧累加
    const meA = await GET('http://localhost:' + PORT + '/api/me?token=' + tokA);
    check('渔获在服务器侧入库（koi +1）', meA.data.inventory.koi === 1, JSON.stringify(meA.data.inventory));
    check('预置库存未被渔获覆盖（crucian 仍为 10）', meA.data.inventory.crucian === 10, JSON.stringify(meA.data.inventory));

    // ============================================================
    section('【问题 4/5】市集自定义数量购买 + 卖家收款');
    // ============================================================
    const beforeSeller = (await GET('http://localhost:' + PORT + '/api/me?token=' + tokA)).data;
    const beforeBuyer = (await GET('http://localhost:' + PORT + '/api/me?token=' + tokB)).data;
    check('卖家初始金币 500', beforeSeller.coins === 500, String(beforeSeller.coins));

    const listed = await POST('http://localhost:' + PORT + '/api/market/list', { token: tokA, id: 'crucian', qty: 10, price: 20 });
    check('上架 10 ×鲫鱼 @20 成功', listed.status === 200 && !!listed.data.listing);
    const lid = listed.data.listing.lid;
    check('上架费 1% 已收取（定价总额 200 → 费 2，500→498）', listed.data.fee === 2 && listed.data.coins === 498, JSON.stringify({ fee: listed.data.fee, coins: listed.data.coins }));
    check('上架后卖家库存扣减 10', listed.data.inventory.crucian === undefined || listed.data.inventory.crucian === 0, JSON.stringify(listed.data.inventory));

    // —— 部分购买 3 个 ——
    const buy1 = await POST('http://localhost:' + PORT + '/api/market/buy', { token: tokB, lid: lid, qty: 3 });
    check('支持自定义数量购买（qty=3）', buy1.status === 200, JSON.stringify(buy1.data));
    check('成交数量 = 3', buy1.data.qty === 3);
    check('买家支付 60', buy1.data.total === 60, String(buy1.data.total));
    check('买家金币 -60（500→440）', buy1.data.coins === 440, String(buy1.data.coins));
    check('买家入库 3 个', buy1.data.inventory.crucian === 3, JSON.stringify(buy1.data.inventory));

    await sleep(350);
    const sellerAfter1 = (await GET('http://localhost:' + PORT + '/api/me?token=' + tokA)).data;
    check('卖家收到货款（498 → 552，货款 54 = 60 − 10% 税 6）', sellerAfter1.coins === 552, String(sellerAfter1.coins));
    check('卖家收到 assets 定向推送（带最新金币）', sinkA.some(m => m.type === 'assets' && m.coins === 552), JSON.stringify(sinkA.filter(m => m.type === 'assets').slice(-1)));
    check('卖家收到售出通知 notice', sinkA.some(m => m.type === 'notice' && /售出/.test(m.msg || '')));

    const mk1 = await GET('http://localhost:' + PORT + '/api/records'); // 仅用于确保无异常
    void mk1;
    // 挂单未被整单移除，剩余 7
    const mkList = await POST('http://localhost:' + PORT + '/api/market/list', { token: tokA, id: 'carp', qty: 1, price: 5 });
    const carpLid = mkList.data.listing.lid;
    // 通过再次查询挂单列表（SSE market 快照）
    await sleep(200);
    const marketMsg = sinkB.filter(m => m.type === 'market').slice(-1)[0];
    const crucianListing = marketMsg && marketMsg.listings.find(l => l.lid === lid);
    check('部分购买后挂单仍在（剩余 7）', !!crucianListing && crucianListing.qty === 7, JSON.stringify(crucianListing));
    await POST('http://localhost:' + PORT + '/api/market/cancel', { token: tokA, lid: carpLid });
    const afterCancel = (await GET('http://localhost:' + PORT + '/api/me?token=' + tokA)).data;
    check('下架不退上架费（carp 挂单费 1，仍为 551）', afterCancel.coins === 551, String(afterCancel.coins));

    // —— 购买数量超过剩余 → 夹取为剩余值 ——
    const over = await POST('http://localhost:' + PORT + '/api/market/buy', { token: tokB, lid: lid, qty: 999 });
    check('购买数量超过剩余时夹取为剩余（7）', over.status === 200 && over.data.qty === 7, JSON.stringify(over.data));
    await sleep(250);
    const marketMsg2 = sinkB.filter(m => m.type === 'market').slice(-1)[0];
    check('整单买走后挂单被移除', !marketMsg2.listings.some(l => l.lid === lid));

    const sellerAfter2 = (await GET('http://localhost:' + PORT + '/api/me?token=' + tokA)).data;
    check('卖家第二笔也收到钱（551 + 126 = 677，税 14）', sellerAfter2.coins === 677, String(sellerAfter2.coins));
    const buyerAfter2 = (await GET('http://localhost:' + PORT + '/api/me?token=' + tokB)).data;
    check('买家累计扣款（440 - 140 = 300）', buyerAfter2.coins === 300, String(buyerAfter2.coins));
    check('买家共入库 10 个', buyerAfter2.inventory.crucian === 10, JSON.stringify(buyerAfter2.inventory));

    // —— 关键回归：瘦客户端不得回传资产（coins/inventory 以服务器推送为唯一来源） ——
    const netSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'net.js'), 'utf8');
    check('客户端网络层不再上报 coins（防覆盖收入）', !/coins\s*:/.test(netSrc), (netSrc.match(/.{0,40}coins\s*:.{0,40}/) || ['']).join(''));
    check('客户端网络层不再上报 inventory', !/inventory\s*:/.test(netSrc));
    await POST('http://localhost:' + PORT + '/api/profile', { token: tokA, name: '甲玩家' });
    const sellerAfterSync = (await GET('http://localhost:' + PORT + '/api/me?token=' + tokA)).data;
    check('自动保存后卖家金币不被清零（仍为 677）', sellerAfterSync.coins === 677, String(sellerAfterSync.coins));

    // 不能买自己的挂单
    await POST('http://localhost:' + PORT + '/api/dev/seed', { token: tokA, inventory: { crucian: 5 } });
    const selfList = await POST('http://localhost:' + PORT + '/api/market/list', { token: tokA, id: 'crucian', qty: 2, price: 3 });
    check('自持物品可上架（用于自购校验；上架费 ceil(0.06)=1）', selfList.status === 200 && !!selfList.data.listing && selfList.data.fee === 1, JSON.stringify(selfList.data));
    check('不能购买自己的挂单被拒', (await POST('http://localhost:' + PORT + '/api/market/buy', { token: tokA, lid: selfList.data.listing.lid })).status === 400);
    await POST('http://localhost:' + PORT + '/api/market/cancel', { token: tokA, lid: selfList.data.listing.lid });

    // ============================================================
    section('【问题 1】在线交易勾选被重置');
    // ============================================================
    // A 预置库存（鲫鱼 10、鲤鱼 5）用于交易选取
    await POST('http://localhost:' + PORT + '/api/dev/seed', { token: tokA, inventory: { crucian: 10, carp: 5 } });

    const A = await openPage(tokA);
    const w = A.w;
    check('A 页面加载无异常', A.errs.length === 0, A.errs.join(' | '));
    check('A 自动登录成功', w.document.getElementById('auth').style.display === 'none');

    // 进入在线交易页
    const navTrade = navBtn(w, '在线交易');
    check('存在「在线交易」入口', !!navTrade);
    navTrade.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(200);
    check('交易页显示其他在线玩家供邀请', w.document.querySelector('.invite-row') && w.document.querySelector('.invite-row').textContent.includes('乙玩家'),
      w.document.getElementById('main').textContent.slice(0, 120));

    // A 邀请 B，B 通过接口接受
    const inv = await POST('http://localhost:' + PORT + '/api/trade/invite', { token: tokA, target: 'fix_b' });
    check('发起交易邀请成功', inv.status === 200 && !!inv.data.tradeId, JSON.stringify(inv.data));
    const tid = inv.data.tradeId;
    await POST('http://localhost:' + PORT + '/api/trade/respond', { token: tokB, tradeId: tid, accept: true });
    await sleep(500);

    check('A 进入交易界面（显示对方提供栏）', !!w.document.querySelector('.trade-sides'), w.document.getElementById('main').textContent.slice(0, 160));
    check('A 看到物品选择器', !!w.document.querySelector('.trade-picker'));

    // —— 勾选物品 ——
    const row = tpRow(w, '鲫鱼');
    check('选择器列出「鲫鱼」', !!row);
    const cb = row.querySelector('input[type=checkbox]');
    const qi = row.querySelector('input.tp-qty');
    cb.checked = true;
    cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    qi.value = '2';
    qi.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('勾选后数量输入框可用', qi.disabled === false);

    // ① 背景广播（feed/players/grounds）不得重绘交易主区 —— 这是最初的现象来源
    w.UI.refreshAll('feed');
    w.UI.refreshAll('players');
    w.UI.refreshAll('grounds');
    await sleep(60);
    let row2 = tpRow(w, '鲫鱼');
    check('背景广播后勾选仍保持', row2 && row2.querySelector('input[type=checkbox]').checked === true);
    check('背景广播后数量仍为 2', row2 && row2.querySelector('input.tp-qty').value === '2');

    // ② 强制整页重绘（模拟交易状态更新）后勾选也必须保持 —— 覆盖草稿状态机制
    w.UI.refreshAll('trade');
    await sleep(60);
    let row3 = tpRow(w, '鲫鱼');
    check('强制整页重绘后勾选仍保持（草稿状态跨重绘）', row3 && row3.querySelector('input[type=checkbox]').checked === true,
      row3 ? row3.outerHTML.slice(0, 140) : 'no row');
    check('强制整页重绘后数量仍为 2', row3 && row3.querySelector('input.tp-qty').value === '2');

    // 再勾一个鲤鱼
    const rowCarp = tpRow(w, '鲤鱼');
    const cbCarp = rowCarp.querySelector('input[type=checkbox]');
    cbCarp.checked = true;
    cbCarp.dispatchEvent(new w.Event('change', { bubbles: true }));
    w.UI.refreshAll('trade');
    await sleep(60);
    const rowCarp2 = tpRow(w, '鲤鱼');
    check('多选后重绘仍保持两项勾选', rowCarp2 && rowCarp2.querySelector('input[type=checkbox]').checked === true);

    // —— 提交我的提供 ——
    const applyBtn = Array.from(w.document.querySelectorAll('.trade-picker .mini')).find(b => b.textContent.includes('更新我的提供'));
    check('存在「更新我的提供」按钮', !!applyBtn);
    applyBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);

    const tMsg = sinkB.filter(m => m.type === 'trade' && m.trade.id === tid).slice(-1)[0];
    const aItems = tMsg && tMsg.trade.aItems;
    check('服务器已接收我方提供的物品', Array.isArray(aItems) && aItems.length === 2, JSON.stringify(aItems));
    check('鲫鱼 ×2 已提交', !!aItems && aItems.some(i => i.id === 'crucian' && i.qty === 2), JSON.stringify(aItems));
    check('鲤鱼 ×1 已提交', !!aItems && aItems.some(i => i.id === 'carp' && i.qty === 1), JSON.stringify(aItems));
    check('提交后「我的提供」栏展示物品', w.document.querySelector('.trade-side.mine .ts-list').textContent.includes('鲫鱼'));

    // 客户端不再持有失效的草稿（服务器已确认）
    const rowAfter = tpRow(w, '鲫鱼');
    check('提交后勾选状态与服务端一致（仍为选中）', rowAfter && rowAfter.querySelector('input[type=checkbox]').checked === true);

    // ============================================================
    section('交易确认语义 + 3s 冷却');
    // ============================================================
    const cf1 = await POST('http://localhost:' + PORT + '/api/trade/confirm', { token: tokA, tradeId: tid });
    check('A 确认成功', cf1.status === 200 && cf1.data.ok === true);
    await sleep(200);
    let tv = sinkB.filter(m => m.type === 'trade' && m.trade.id === tid).slice(-1)[0].trade;
    check('A 已确认 aOk=true，交易未完成', tv.aOk === true && tv.bOk === false && !tv.done, JSON.stringify({ aOk: tv.aOk, bOk: tv.bOk, done: tv.done }));

    // A 改动物品 → 双方确认作废 + 冷却
    const set2 = await POST('http://localhost:' + PORT + '/api/trade/set', { token: tokA, tradeId: tid, items: [{ id: 'crucian', qty: 3 }] });
    check('改动物品请求成功', set2.status === 200);
    check('改动后进入冷却', set2.data.cooldownUntil > Date.now(), String(set2.data.cooldownUntil));
    await sleep(200);
    tv = sinkB.filter(m => m.type === 'trade' && m.trade.id === tid).slice(-1)[0].trade;
    check('任一方改动后双方确认被重置', tv.aOk === false && tv.bOk === false, JSON.stringify({ aOk: tv.aOk, bOk: tv.bOk }));
    check('冷却中确认被拒（429）', (await POST('http://localhost:' + PORT + '/api/trade/confirm', { token: tokA, tradeId: tid })).status === 429);

    // 等待冷却结束 → 双方确认 → 成交
    await sleep(3200);
    check('冷却结束后可确认', (await POST('http://localhost:' + PORT + '/api/trade/confirm', { token: tokA, tradeId: tid })).status === 200);
    // 先让 B 也放点东西
    await POST('http://localhost:' + PORT + '/api/trade/set', { token: tokB, tradeId: tid, items: [{ id: 'koi', qty: 1 }] });
    await sleep(3200);
    await POST('http://localhost:' + PORT + '/api/trade/confirm', { token: tokA, tradeId: tid });
    const cfB = await POST('http://localhost:' + PORT + '/api/trade/confirm', { token: tokB, tradeId: tid });
    check('双方确认后交易完成', cfB.status === 200 && cfB.data.done === true, JSON.stringify(cfB.data));

    const aFinal = await GET('http://localhost:' + PORT + '/api/me?token=' + tokA);
    const bFinal = await GET('http://localhost:' + PORT + '/api/me?token=' + tokB);
    check('A 换得出 B 的黄金锦鲤', aFinal.data.inventory.koi >= 1, JSON.stringify(aFinal.data.inventory));
    check('B 换得出 A 的鲫鱼 ×3', bFinal.data.inventory.crucian === 13, JSON.stringify(bFinal.data.inventory));
    check('交易本身免税（金币不变，含历次上架费后 A=676）', aFinal.data.coins === 676 && bFinal.data.coins === 300,
      aFinal.data.coins + '/' + bFinal.data.coins);

    cliA.destroy(); cliB.destroy();
    A.listeners.forEach(l => { try { l.destroy(); } catch (e) {} });

    // —— v0.11.7：畸形请求体不再打崩整个服务端 ——
    // 回归背景：JSON.parse('null') 是**成功**的（返回 null），此前只 catch 语法错误的解析代码
    // 紧接着读 d.token / d.username 就抛 TypeError → 未捕获 → 进程退出 → 所有玩家同一秒掉线
    // 且必须人工重启。本段就是那次崩溃的最小复现：灌完畸形请求后服务端必须还活着。
    section('进程健壮性 · 畸形请求体');
    function rawReq(method, u, raw) {
      return new Promise(res => {
        const p = url.parse(u);
        const data = raw == null ? null : String(raw);
        const h = { 'Content-Type': 'application/json' };
        if (data) h['Content-Length'] = Buffer.byteLength(data);
        const r = http.request({ hostname: p.hostname, port: p.port, path: p.path, method, headers: h }, rs => {
          let d = ''; rs.on('data', c => d += c);
          rs.on('end', () => res({ status: rs.statusCode, text: d }));
        });
        r.on('error', e => res({ status: 0, text: 'ERR ' + e.message }));
        if (data) r.write(data);
        r.end();
      });
    }
    const BASE = 'http://localhost:' + PORT;
    // 覆盖两类解析路径：走 auth() 的（31 个）与自行解析的（register/login/profile/fishing/*/autosell/admin-login）
    const nullTargets = [
      '/api/sell', '/api/market/list', '/api/market/buy', '/api/bd/set', '/api/chest/open',
      '/api/mall/buy', '/api/workshop/smelt', '/api/autosell', '/api/subscribe', '/api/profile',
      '/api/fishing/start', '/api/fishing/stop', '/api/rod/slot/buy',
      '/api/login', '/api/register', '/api/admin/login',
    ];
    const nullBad = [];
    for (const p of nullTargets) {
      const r = await rawReq('POST', BASE + p, 'null');
      if (r.status !== 400) nullBad.push(p + '→' + r.status);
    }
    check('POST body=null 一律 400（16 个端点，含 auth 与自行解析两条路径）', nullBad.length === 0, nullBad.join(', '));
    const primBad = [];
    for (const raw of ['1', '"x"', 'true', '3.14']) {
      const r = await rawReq('POST', BASE + '/api/sell', raw);
      if (r.status !== 400) primBad.push(raw + '→' + r.status);
    }
    check('POST body=裸标量 一律 400（同样会让读字段抛错）', primBad.length === 0, primBad.join(', '));
    // 核心断言：进程还活着，且仍能正常服务真实请求
    const aliveAfter = await GET(BASE + '/api/version');
    check('灌完畸形请求后服务端仍存活', aliveAfter.status === 200 && !!aliveAfter.data.version,
      JSON.stringify(aliveAfter.data).slice(0, 90));
    const tokA2 = (await POST(BASE + '/api/login', { username: 'fix_a', password: 'pass1234' })).data.token;
    const realAfter = await POST(BASE + '/api/fishing/stop', { token: tokA2 });
    check('畸形请求后正常请求照常处理（登录 + 业务接口 200）', realAfter.status === 200 && realAfter.data.ok === true,
      JSON.stringify(realAfter.data));
    // 源码级守护（防止以后被重构掉）
    const srvSrc = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
    const bodyObjBody = (srvSrc.match(/function bodyObj[\s\S]*?\n\}/) || [''])[0];
    check('请求体统一走 bodyObj 校验（无裸 JSON.parse(body)）',
      /function bodyObj\(body\)/.test(srvSrc) && (srvSrc.split('JSON.parse(body)').length - 1) === (bodyObjBody.split('JSON.parse(body)').length - 1),
      'guard=' + /function bodyObj\(body\)/.test(srvSrc));
    check('钓鱼循环全部带自愈保护',
      (srvSrc.match(/try \{ fishTick\(key\); \}/g) || []).length === (srvSrc.match(/fishTick\(key\);/g) || []).length &&
      (srvSrc.match(/fishTick\(key\);/g) || []).length >= 4,
      (srvSrc.match(/try \{ fishTick\(key\); \}/g) || []).length + '/' + (srvSrc.match(/fishTick\(key\);/g) || []).length);
    check('市集清扫与进程级异常兜底就位',
      /try \{ sweepExpiredListings\(\); \}/.test(srvSrc) &&
      /process\.on\('uncaughtException'/.test(srvSrc) && /process\.on\('unhandledRejection'/.test(srvSrc));

  } catch (e) {
    console.log('TEST ERROR: ' + e.message + '\n' + e.stack);
    fail++;
  } finally {
    srv.kill();
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n============================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) console.log('失败项：\n  - ' + failed.join('\n  - '));
    console.log(fail === 0 ? 'BUGFIX TESTS PASS' : 'BUGFIX TESTS FAILED');
    console.log('============================');
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 150);
  }
})();
