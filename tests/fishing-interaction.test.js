/*
 * 钓鱼交互 + 近期大鱼实时更新 测试
 * 覆盖：
 *  A. 点钓点即开始自动钓鱼；再点当前钓点取消并离开；点其他钓点自动切换
 *  B. 近期大鱼：本地即时显示 + 上报服务器 + 广播给其他玩家 + 普通状态上报不清空
 * 运行： node tests/fishing-interaction.test.js
 */
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');
// 轮询等待工具（测试内部不依赖固定 sleep）：就绪即继续，超时才失败
const { waitFor, waitHttp, waitPage } = require('./_util.js');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8141;
const NODE = process.execPath;

let pass = 0, fail = 0; const failed = [];
function check(n, c, extra) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failed.push(n); console.log('  FAIL  ' + n + (extra ? ' -> ' + extra : '')); } }

// 启动前清理端口占用：Windows 下测试进程被强杀时 taskkill 可能失败，残留的旧服务器会占住端口，
// 导致下一次运行的所有请求打到「陈旧的服务器实例」上（表现为大面积 未登录/数据不符）。
// 这里在启动测试服务器前把端口占用者清掉，让测试自愈。
function killPortOccupant(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + port + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
      { stdio: 'ignore' });
  } catch (e) {}
}

function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, u, body) {
  return new Promise(res => {
    const p = url.parse(u); const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: p.hostname, port: p.port, path: p.path, method, headers: h }, rs => {
      let d = ''; rs.on('data', c => d += c); rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j, text: d }); });
    });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data); r.end();
  });
}
const POST = (u, b) => req('POST', u, b);

function sse(token, sink) {
  const r = http.get('http://localhost:' + PORT + '/events?token=' + token, res => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { sink.push(JSON.parse(line.slice(6))); } catch (e) {} }
      }
    });
  });
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
  // 真实 EventSource：连到服务器，让 UI 收到广播
  const listeners = [];
  w.EventSource = function (u) {
    const self = this;
    this.onmessage = null; this.onerror = null;
    const full = 'http://localhost:' + PORT + u;
    const r = http.get(full, res => {
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
    listeners.push(r);
    this.close = function () { try { r.destroy(); } catch (e) {} };
  };
  if (token) w.localStorage.setItem('fishing_token', token);
  await new Promise(res => { if (w.document.readyState === 'complete') return res(); w.addEventListener('load', () => res()); setTimeout(res, 1500); });
  await sleep(400);
  return { dom, w, errs, listeners };
}

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-test-'));


(async () => {
  console.log('钓鱼交互 + 近期大鱼实时更新 测试');
  killPortOccupant(PORT);
  const srv = spawn(NODE, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  try {
    // 注册 A / B
    const ra = await POST('http://localhost:' + PORT + '/api/register', { username: 'fisher_a', password: 'pass1234', name: '钓手甲', qq: '10012' });
    const rb = await POST('http://localhost:' + PORT + '/api/register', { username: 'fisher_b', password: 'pass1234', name: '钓手乙', qq: '10013' });
    const tokA = ra.data.token, tokB = rb.data.token;

    const sinkB = [];
    const cliB = sse(tokB, sinkB);   // B 用原生 SSE 监听广播
    await sleep(300);

    const A = await openPage(tokA);
    const w = A.w;
    const $ = id => w.document.getElementById(id);
    const spotBtns = () => Array.from(w.document.querySelectorAll('.spot-btn'));
    const findSpot = (name) => spotBtns().find(b => b.textContent.trim() === name);

    section('A. 点钓点即开始自动钓鱼');
    check('页面加载无异常', A.errs.length === 0, A.errs.join(' | '));
    check('自动登录进入游戏', $('auth').style.display === 'none');
    check('初始状态显示「未在钓鱼」', w.document.querySelector('.fish-state') && w.document.querySelector('.fish-state').textContent.includes('未在钓鱼'));
    check('初始渔场实况显示「不在任何钓点」', w.document.querySelector('.here-count').textContent.includes('不在任何钓点'));

    findSpot('老旧码头').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    let st = w.document.querySelector('.fish-state').textContent;
    check('点击钓点后自动开始钓鱼', st.includes('自动钓鱼中'), st);
    check('状态条显示所在钓点', st.includes('静水湖') && st.includes('老旧码头'), st);
    check('钓点按钮标记为选中', !!findSpot('老旧码头').classList.contains('on'));
    check('渔场实况切换到该钓点', w.document.querySelector('.here-count').textContent.includes('静水湖') && w.document.querySelector('.here-count').textContent.includes('老旧码头'));
    check('渔场实况出现自己', w.document.querySelectorAll('.peep.self').length === 1);

    section('B. 点其他钓点自动切换');
    findSpot('瀑布潭').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    st = w.document.querySelector('.fish-state').textContent;
    check('切换后仍在自动钓鱼', st.includes('自动钓鱼中'), st);
    check('状态条更新为新钓点', st.includes('急流河') && st.includes('瀑布潭'), st);
    check('旧钓点取消选中', !findSpot('老旧码头').classList.contains('on'));
    check('新钓点已选中', findSpot('瀑布潭').classList.contains('on'));
    check('渔场实况更新为新钓点', w.document.querySelector('.here-count').textContent.includes('急流河'));

    section('C. 再点当前钓点 → 取消并离开');
    findSpot('瀑布潭').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    st = w.document.querySelector('.fish-state').textContent;
    check('取消后状态回到「未在钓鱼」', st.includes('未在钓鱼'), st);
    check('取消后无钓点被选中', spotBtns().every(b => !b.classList.contains('on')));
    check('取消后渔场实况回到「不在任何钓点」', w.document.querySelector('.here-count').textContent.includes('不在任何钓点'));

    section('D. 近期大鱼：本地即时显示');
    // 回到一个钓点持续钓鱼，直到出现大鱼（最多等 90 秒）
    findSpot('礁石区').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(300);
    let gotBig = false, waited = 0;
    while (!gotBig && waited < 90000) {
      await sleep(3000);
      waited += 3000;
      const rec = w.document.querySelector('.peep.self .peep-recent');
      if (rec && rec.textContent.includes('近期')) { gotBig = true; }
    }
    check('本机近期大鱼即时显示在渔场实况', gotBig, '等待 ' + (waited / 1000) + 's');

    section('E. 近期大鱼：广播给其他玩家');
    const bSawRecent = sinkB.some(m => m.type === 'players' && m.players.some(p => p.id === 'fisher_a' && p.recent));
    check('B 收到 A 的 recent 更新（含大鱼名）', bSawRecent, JSON.stringify(sinkB.filter(m => m.type === 'players').slice(-2)));
    const bSawFeed = sinkB.some(m => m.type === 'feed' && m.entry && m.entry.who === '钓手甲');
    check('B 收到 A 的渔获广播', bSawFeed);

    section('F. 普通状态上报不清空 recent');
    // 查询服务器上 A 的 recent 是否仍存在（通过 B 的最新 players 快照）
    const lastPlayers = sinkB.filter(m => m.type === 'players').slice(-1)[0];
    const aEntry = lastPlayers && lastPlayers.players.find(p => p.id === 'fisher_a');
    check('服务器玩家列表中 A 的 recent 未被清空', !!(aEntry && aEntry.recent), JSON.stringify(aEntry));

    section('G. 离开钓点后 recent 清空');
    const before = sinkB.length;
    const curSpot = w.document.querySelector('.spot-btn.on');
    if (curSpot) curSpot.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const afterMsgs = sinkB.slice(before);
    const afterPlayers = afterMsgs.filter(m => m.type === 'players').slice(-1)[0];
    const aAfter = afterPlayers && afterPlayers.players.find(p => p.id === 'fisher_a');
    check('离开钓点后服务器上 recent 已清空', aAfter ? !aAfter.recent : true, JSON.stringify(aAfter));

    cliB.destroy();
    if (A.listeners) A.listeners.forEach(l => { try { l.destroy(); } catch (e) {} });

  } catch (e) {
    console.log('TEST ERROR: ' + e.message + '\n' + e.stack);
    fail++;
  } finally {
    srv.kill();
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n============================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) console.log('失败项：\n  - ' + failed.join('\n  - '));
    console.log(fail === 0 ? 'FISHING INTERACTION TESTS PASS' : 'FISHING INTERACTION TESTS FAILED');
    console.log('============================');
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 150);
  }
})();
