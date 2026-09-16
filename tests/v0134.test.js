/*
 * v0.13.4 体验修复回归（纯真实 Chrome + HTTP，可独立运行）：
 *   ① 渔场动态玩家列表：限高可下滑（在线人数多时不把页面拉长）+ 输入即筛选（不再需要回车），
 *      且每秒一次的列表重绘不会把输入框的焦点/已输入的文字冲掉
 *   ② 交易子窗口：右上角 ✕ 与窗口下方红底「撤回邀请」按钮都会真的撤回服务端会话
 *      （只关窗口不撤回的话，同一对玩家只允许一个活跃会话 → 双方都再也发不出邀请）
 *   ③ 市集成成交进「📜 日志 · ✅ 交易」（原来只推通用 notice，会落进「系统」分类），
 *      并展示物品属性与组件词条数值
 *   ④ 日志保留策略：只有高频的「渔获 / 系统」各截断到 300 条，交易 / 纪录长期保留可回查
 * 运行： node tests/v0134.test.js
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
const PORT = 8196;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0134-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

// 浏览器可执行文件：优先 CHROME_PATH，否则自动探测 Chrome / Edge
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
// 轮询取值：成立即返回该值（不要用固定 sleep 赌广播到达）
async function untilGet(fn, ok, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  for (;;) {
    const v = await fn().catch(() => null);
    if (ok(v)) return v;
    if (Date.now() >= deadline) return v;
    await sleep(60);
  }
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
const POST = (p, b) => req('POST', p, b);

async function login(page, token) {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('fishing_token', t), token);
  await page.reload({ waitUntil: 'load' });
  await sleep(800);
}
async function clickNav(page, name) {
  await page.evaluate(n => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    if (b) b.click();
  }, name);
  await untilGet(() => page.evaluate(n => {
    const a = document.querySelector('.nav-item.active');
    return !!a && a.textContent.includes(n) && !!document.getElementById('main').children.length;
  }, name), v => v === true, 6000);
}

let srv = null, browser = null;
(async () => {
  try { killTree({ pid: 0 }); } catch (e) {}
  // Windows 下被强杀可能留下占住端口的旧服务器，先清干净
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + PORT + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"], { stdio: 'ignore' });
  } catch (e) {}
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v134_a', password: 'abcd1234', name: '回归甲', qq: '20001' });
  const rB = await POST('/api/register', { username: 'v134_b', password: 'abcd1234', name: '回归乙', qq: '20002' });
  const tokA = rA.data.token, tokB = rB.data.token;

  browser = await chromium.launch({ executablePath: CHROME });
  const pA = await browser.newPage();
  const pB = await browser.newPage();
  await login(pA, tokA);
  await login(pB, tokB);
  await sleep(1500); // 等两边 SSE 建立、presence 上报（玩家列表靠服务器推送）

  // ---------------------------------------------------------------- ①
  section('① 渔场动态玩家列表：限高滚动 + 输入即筛选');
  await clickNav(pA, '渔场动态');
  await untilGet(() => pA.$$eval('.ground-cols .peeps', els => els.length), n => n === 1, 8000);
  const box = await untilGet(() => pA.evaluate(() => {
    const b = document.querySelector('.ground-cols .peeps');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { cls: b.className, maxH: cs.maxHeight, overflow: cs.overflowY, n: b.querySelectorAll('.peep').length };
  }), v => v && v.n >= 2, 12000);
  check('玩家列表限高可下滑（scroll5 + max-height + overflow:auto）',
    !!box && /scroll5/.test(box.cls) && box.maxH !== 'none' && box.overflow === 'auto', JSON.stringify(box));

  // 只发 input 事件，模拟真人打字（不按回车）
  await pA.click('.peep-search-input');
  await pA.type('.peep-search-input', '回归乙', { delay: 60 });
  const hit = await untilGet(() => pA.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.ground-cols .peeps .peep'));
    return { n: cards.length, txt: cards.map(c => c.textContent).join('|') };
  }), v => v && v.n === 1, 10000);
  check('输入即筛选（不按回车，列表实时收敛到 1 人）', !!hit && hit.n === 1, JSON.stringify(hit).slice(0, 200));
  check('筛选结果就是被搜的人', !!hit && hit.txt.indexOf('回归乙') >= 0, JSON.stringify(hit).slice(0, 200));
  const typed = await pA.evaluate(() => ({
    v: (document.querySelector('.peep-search-input') || {}).value,
    focused: /peep-search-input/.test((document.activeElement || {}).className || ''),
  }));
  check('列表每秒重绘后输入框仍保持焦点（否则第二个字就打不进去）', typed.focused === true, JSON.stringify(typed));
  check('列表每秒重绘后已输入的文字没被冲掉', typed.v === '回归乙', JSON.stringify(typed));
  await pA.fill('.peep-search-input', '');
  const back = await untilGet(() => pA.evaluate(() => document.querySelectorAll('.ground-cols .peeps .peep').length), n => n >= 2, 8000);
  check('清空关键词后列表恢复全量', back >= 2, String(back));

  // ---------------------------------------------------------------- ②
  section('② 交易子窗口：关闭即撤回邀请');
  const openTrade = async () => {
    await pA.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.ground-cols .peeps .peep'));
      const c = cards.find(x => x.textContent.indexOf('回归乙') >= 0) || cards[0];
      const b = c && Array.from(c.querySelectorAll('button')).find(x => x.textContent.indexOf('交易') >= 0);
      if (b) b.click();
    });
    return untilGet(() => pA.evaluate(() => {
      const m = document.querySelector('.trade-modal');
      if (!m) return null;
      const acts = m.querySelector('.trade-actions');
      return {
        centered: !!m.querySelector('.trade-actions.center'),
        btns: acts ? Array.from(acts.querySelectorAll('button')).map(b => ({ t: b.textContent.trim(), c: b.className })) : [],
        closeTitle: (m.querySelector('.modal-close') || {}).title || '',
      };
    }), v => v && v.btns.some(b => /撤回/.test(b.t)), 10000);
  };
  const ui = await openTrade();
  check('等待同意态：撤回按钮在窗口下方居中', !!ui && ui.centered, JSON.stringify(ui && ui.btns));
  check('撤回按钮标红底（danger-mini）', !!ui && ui.btns.some(b => /撤回/.test(b.t) && /danger-mini/.test(b.c)), JSON.stringify(ui && ui.btns));
  check('右上角 ✕ 提示「关闭＝撤回」', !!ui && /撤回/.test(ui.closeTitle), ui && ui.closeTitle);

  await pA.click('.trade-modal .modal-close');
  await sleep(800);
  const again = await POST('/api/trade/invite', { token: tokA, target: 'v134_b' });
  check('点 ✕ 关闭后服务端会话已撤回（可立刻重新邀请，不是 409 已有会话）',
    again.status === 200 && !!(again.data && again.data.ok), JSON.stringify(again));
  if (again.data && again.data.tradeId) await POST('/api/trade/cancel', { token: tokA, tradeId: again.data.tradeId });
  await sleep(400);
  await openTrade();
  await pA.click('.trade-modal .trade-actions.center .danger-mini');
  await sleep(800);
  const again2 = await POST('/api/trade/invite', { token: tokA, target: 'v134_b' });
  check('点下方红底撤回按钮后同样可重新邀请',
    again2.status === 200 && !!(again2.data && again2.data.ok), JSON.stringify(again2));
  if (again2.data && again2.data.tradeId) await POST('/api/trade/cancel', { token: tokA, tradeId: again2.data.tradeId });

  // ---------------------------------------------------------------- ③
  section('③ 市集成交进「交易」日志（含物品属性与组件数值）');
  const compId = D.instanceId('rod_carbon', 'rare', [{ type: 'speed', value: 18 }, { type: 'size', value: 3 }]);
  const compName = D.itemOf(compId).name;
  await POST('/api/dev/seed', { token: tokB, inventory: { crucian: 5, [compId]: 1 }, coins: 500 });
  const listed = await POST('/api/market/list', { token: tokB, id: compId, qty: 1, price: 100 });
  check('乙上架组件实例成功（' + compName + '）', listed.status === 200 && !!listed.data.listing, JSON.stringify(listed.data));
  const bought = await POST('/api/market/buy', { token: tokA, lid: listed.data.listing.lid });
  check('甲买入该组件成功', bought.status === 200, JSON.stringify(bought.data && bought.data.error));
  await sleep(1000);

  await clickNav(pA, '日志');
  await pA.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.inv-cats .inv-cat')).find(x => x.textContent.includes('交易'));
    if (b) b.click();
  });
  const log = await untilGet(() => pA.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.log-page .log-row')).map(r => r.textContent),
    tag: (document.querySelector('.log-page .log-tag') || {}).textContent || '',
    items: Array.from(document.querySelectorAll('.log-page .log-detail .log-item')).map(x => x.textContent),
    affs: Array.from(document.querySelectorAll('.log-page .log-detail .log-item-affs .inst-aff')).map(x => x.textContent),
  })), v => v && v.rows.length > 0, 8000);
  check('市集买入流水落在「✅ 交易」分类（不再混进「系统」）',
    /市集买入/.test((log.rows || []).join('|')) && /交易/.test(log.tag), JSON.stringify(log.rows).slice(0, 240));
  check('交易日志带物品明细行（方向 + 物品名 + 品质）',
    (log.items || []).length > 0 && (log.items || []).join('|').indexOf(compName.split(' ').pop()) >= 0, JSON.stringify(log.items).slice(0, 200));
  check('明细里显示组件词条数值（+18% 钓速 / +3% 体型）',
    (log.affs || []).join('|').indexOf('+18%') >= 0 && (log.affs || []).join('|').indexOf('+3%') >= 0, JSON.stringify(log.affs));
  check('明细里标出组件部位（竿身 / 配件 / 饰品 …）',
    /竿身|配件|饰品|线组|卷线器|钩|饵/.test((log.items || []).join('|')), JSON.stringify(log.items).slice(0, 200));

  // ---------------------------------------------------------------- ④
  section('④ 日志保留：渔获 / 系统各 300 条，交易 / 纪录长期保留');
  // 日志键 = fishing_log_<小写账号 key>；先保留已有流水，再前置超量日志
  const logKey = 'fishing_log_v134_a';
  const seededN = await pA.evaluate(k => {
    const mk = (kind, n, tag) => Array.from({ length: n }, (_, i) => ({ t: Date.now() - i * 1000 - 60000, kind: kind, msg: tag + i }));
    const old = JSON.parse(localStorage.getItem(k) || '[]');
    const arr = mk('catch', 400, '渔获').concat(mk('system', 350, '系统')).concat(mk('trade', 5, '交易')).concat(mk('record', 3, '纪录')).concat(old);
    localStorage.setItem(k, JSON.stringify(arr));
    return arr.length;
  }, logKey);
  check('预置日志（渔获 400 / 系统 350 / 交易 5 / 纪录 3 + 已有流水）', seededN >= 758, String(seededN));
  await pA.reload({ waitUntil: 'load' });
  await sleep(900);
  await pA.evaluate(() => window.UI.addLog('catch', '触发一次截断')); // 任意一条新日志都会触发一次清理
  const after = await pA.evaluate(k => {
    const arr = JSON.parse(localStorage.getItem(k) || '[]');
    const c = {};
    arr.forEach(e => { c[e.kind] = (c[e.kind] || 0) + 1; });
    const sys = arr.filter(e => e.kind === 'system').map(e => e.msg);
    return { c: c, droppedOldest: sys.indexOf('系统349') < 0, keptNewest: sys.indexOf('系统0') >= 0,
      mktKept: arr.filter(e => e.kind === 'trade').some(e => /市集买入/.test(e.msg)) };
  }, logKey);
  check('渔获 / 系统各自截断到 300 条', after.c.catch === 300 && after.c.system === 300, JSON.stringify(after.c));
  check('交易 / 纪录日志不受 300 上限影响', after.c.trade >= 6 && after.c.record === 3, JSON.stringify(after.c));
  check('截断丢掉的是最旧的那批', after.droppedOldest === true && after.keptNewest === true, JSON.stringify(after));
  check('市集流水重载后仍在（可长期回查）', after.mktKept === true, JSON.stringify(after.c));

  await browser.close(); browser = null;
  killTree(srv); srv = null;
  console.log('\n' + '='.repeat(60));
  console.log('v0.13.4 回归测试小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败项：\n' + failed.map(f => '  - ' + f).join('\n'));
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试异常：', e);
  if (browser) browser.close().catch(() => {});
  if (srv) killTree(srv);
  process.exit(1);
});
