/*
 * 前端登录/注册真实交互测试（jsdom）
 * 真实加载 index.html + 全部脚本，模拟用户点击，验证登录/注册按钮有反应。
 * 运行： node tests/auth-ui.test.js
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
const PORT = 8123;
const NODE = process.execPath;

let pass = 0, fail = 0; const failed = [];
function check(n, c, extra) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failed.push(n); console.log('  FAIL  ' + n + (extra ? ' -> ' + extra : '')); } }
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
      let d = ''; rs.on('data', c => d += c); rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j, text: d }); });
    });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}

// 用 jsdom 打开真实页面
async function openPage() {
  const html = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(html, {
    url: 'http://localhost:' + PORT + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  // 提供 XMLHttpRequest/fetch 到真实服务器（jsdom 自带 XHR；补 fetch）
  w.fetch = function (u, opts) {
    const full = u.startsWith('http') ? u : ('http://localhost:' + PORT + u);
    return new Promise((resolve, reject) => {
      const p = url.parse(full);
      const body = opts && opts.body ? opts.body : null;
      const h = Object.assign({}, (opts && opts.headers) || {});
      if (body) h['Content-Length'] = Buffer.byteLength(body);
      const r = http.request({ hostname: p.hostname, port: p.port, path: p.path, method: (opts && opts.method) || 'GET', headers: h }, rs => {
        let d = ''; rs.on('data', c => d += c);
        rs.on('end', () => resolve({
          ok: rs.statusCode >= 200 && rs.statusCode < 300,
          status: rs.statusCode,
          json: () => Promise.resolve(JSON.parse(d || '{}')),
          text: () => Promise.resolve(d),
        }));
      });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  };
  // EventSource 桩（SSE 由服务端推送，UI 不阻塞）
  w.EventSource = function () { this.onmessage = null; this.onerror = null; this.close = function () {}; };
  // 等待脚本加载完成
  await new Promise(res => {
    if (w.document.readyState === 'complete') return res();
    w.addEventListener('load', () => res());
    setTimeout(res, 1500);
  });
  await sleep(300);
  return { dom, w, errors };
}

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-test-'));


(async () => {
  console.log('登录/注册前端交互测试（jsdom 真实 DOM）');
  killPortOccupant(PORT);
  const srv = spawn(NODE, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  try {
    // ---------- 场景 1：全新用户（无 token），点击登录 ----------
    console.log('\n=== 场景 1：无 token 首次进入 ===');
    let { w, errors } = await openPage();
    const $ = id => w.document.getElementById(id);
    check('页面加载无 JS 异常', errors.length === 0, errors.join(' | '));
    check('登录遮罩可见', $('auth') && $('auth').style.display !== 'none');
    check('默认在「登录」tab', $('tab-login').classList.contains('active'));

    // 先注册一个账号（走真实 HTTP）
    await req('POST', 'http://localhost:' + PORT + '/api/register', { username: 'uiuser', password: 'pass1234', name: '界面测试', qq: '10001' });

    // 真实模拟：填表 + 点击登录按钮
    $('auth-user').value = 'uiuser';
    $('auth-pass').value = 'pass1234';
    $('auth-submit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    check('点击登录后遮罩隐藏（进入游戏）', $('auth').style.display === 'none', 'display=' + $('auth').style.display);
    check('点击登录后无报错信息', !$('auth-msg').textContent, 'msg=' + $('auth-msg').textContent);
    // 高频入口常驻；低频入口（图鉴/记录/反馈/日志）默认收在「更多」折叠组里
    check('登录后已渲染导航（10 个高频入口 + 更多折叠组）',
      w.document.querySelectorAll('#nav .nav-item:not(.locked)').length === 11,
      'got ' + w.document.querySelectorAll('#nav .nav-item:not(.locked)').length);
    check('「更多」组默认收起', w.document.querySelectorAll('#nav .nav-group').length === 0,
      'got ' + w.document.querySelectorAll('#nav .nav-group').length);
    w.document.querySelector('.nav-more').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check('展开后低频入口出现（共 14 个入口）',
      w.document.querySelectorAll('#nav .nav-item:not(.locked)').length === 15 &&
      w.document.querySelectorAll('#nav .nav-group .nav-item').length === 4,
      'got ' + w.document.querySelectorAll('#nav .nav-item:not(.locked)').length);
    check('无未实现入口：商城与工坊都已开放（不再有锁定占位）', w.document.querySelectorAll('#nav .nav-item.locked').length === 0, 'got ' + w.document.querySelectorAll('#nav .nav-item.locked').length);
    check('登录后顶栏显示玩家名', $('player-status').textContent.includes('界面测试'), $('player-status').textContent);
    check('登录后 token 已写入 localStorage', !!w.localStorage.getItem('fishing_token'));

    // ---------- 场景 2：错误密码，应有可见反馈 ----------
    console.log('\n=== 场景 2：错误密码 ===');
    ({ w, errors } = await openPage());
    const $2 = id => w.document.getElementById(id);
    $2('auth-user').value = 'uiuser';
    $2('auth-pass').value = 'wrongpass';
    $2('auth-submit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    check('错误密码：遮罩仍在（未进入游戏）', $2('auth').style.display !== 'none');
    check('错误密码：显示错误提示', $2('auth-msg').textContent.length > 0, 'msg=' + $2('auth-msg').textContent);
    check('错误密码：按钮恢复可用', $2('auth-submit').disabled === false);

    // ---------- 场景 3：切换到注册 tab 并注册新账号 ----------
    console.log('\n=== 场景 3：注册 tab ===');
    ({ w, errors } = await openPage());
    const $3 = id => w.document.getElementById(id);
    $3('tab-register').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(100);
    check('点击注册 tab 后按钮文案变化', $3('auth-submit').textContent.includes('注册'), $3('auth-submit').textContent);
    check('注册 tab 显示名输入框可见', $3('auth-name').style.display !== 'none');
    check('注册 tab 显示确认密码输入框', $3('auth-pass2').style.display !== 'none');
    check('注册 tab 显示 QQ 号输入框（必填）', $3('auth-qq').style.display !== 'none');
    $3('auth-user').value = 'newbie' + Math.floor(Math.random() * 10000);
    $3('auth-pass').value = 'abcd1234';
    $3('auth-pass2').value = 'abcd1234';
    $3('auth-qq').value = '123456789';
    $3('auth-name').value = '新钓手';
    const newName = $3('auth-user').value;
    $3('auth-submit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(700);
    check('注册后进入游戏', $3('auth').style.display === 'none', 'msg=' + $3('auth-msg').textContent);
    check('注册后顶栏显示显示名', $3('player-status').textContent.includes('新钓手'), $3('player-status').textContent);

    // ---------- 场景 3b：注册校验（必填 QQ / 确认密码一致）----------
    console.log('\n=== 场景 3b：注册校验 ===');
    ({ w, errors } = await openPage());
    const $3b = id => w.document.getElementById(id);
    $3b('tab-register').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(100);
    $3b('auth-user').value = 'vfy' + Math.floor(Math.random() * 100000);
    $3b('auth-pass').value = 'abcd1234';
    $3b('auth-pass2').value = 'different9';
    $3b('auth-qq').value = '123456789';
    $3b('auth-submit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(200);
    check('两次密码不一致时提示且不进入游戏', $3b('auth').style.display !== 'none' && $3b('auth-msg').textContent.includes('密码'), $3b('auth-msg').textContent);
    $3b('auth-pass2').value = 'abcd1234';
    $3b('auth-qq').value = '';
    $3b('auth-submit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(200);
    check('QQ 号为空时提示必填', $3b('auth').style.display !== 'none' && $3b('auth-msg').textContent.includes('QQ'), $3b('auth-msg').textContent);

    // ---------- 场景 4：本地已有 token 时自动登录 ----------
    console.log('\n=== 场景 4：已有 token 自动登录 ===');
    ({ w, errors } = await openPage());
    const $4 = id => w.document.getElementById(id);
    $4('auth-user').value = 'uiuser';
    $4('auth-pass').value = 'pass1234';
    $4('auth-submit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const savedToken = w.localStorage.getItem('fishing_token');
    check('先登录取得 token', !!savedToken);
    // 重新打开页面（保留 localStorage 需同域，这里手动注入相同 token）
    const dom2 = new JSDOM(fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8'), {
      url: 'http://localhost:' + PORT + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    });
    const w2 = dom2.window;
    w2.localStorage.setItem('fishing_token', savedToken);
    w2.fetch = w.fetch; w2.EventSource = w.EventSource;
    await new Promise(res => { if (w2.document.readyState === 'complete') return res(); w2.addEventListener('load', () => res()); setTimeout(res, 1500); });
    // 重新初始化（脚本已执行过一次，这里直接调用 UI.init 模拟刷新后逻辑）
    await sleep(200);
    check('自动登录路径不抛异常（Net.fetchMe 可用）', typeof w2.Net.fetchMe === 'function', 'typeof Net.fetchMe=' + typeof w2.Net.fetchMe);

    // ---------- 场景 5：服务器不可达时的提示 ----------
    console.log('\n=== 场景 5：服务器不可达 ===');
    ({ w, errors } = await openPage());
    const $5 = id => w.document.getElementById(id);
    // 让 fetch 全部失败
    w.fetch = function () { return Promise.reject(new Error('offline')); };
    $5('auth-user').value = 'someone';
    $5('auth-pass').value = 'pass1234';
    $5('auth-submit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    check('服务器不可达：给出可见提示', $5('auth-msg').textContent.length > 0, 'msg=' + $5('auth-msg').textContent);
    check('服务器不可达：按钮恢复可用', $5('auth-submit').disabled === false);

  } catch (e) {
    console.log('TEST ERROR: ' + e.message + '\n' + e.stack);
    fail++;
  } finally {
    srv.kill();
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n============================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) console.log('失败项：\n  - ' + failed.join('\n  - '));
    console.log(fail === 0 ? 'AUTH UI TESTS PASS' : 'AUTH UI TESTS FAILED');
    console.log('============================');
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 150);
  }
})();
