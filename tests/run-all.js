/*
 * 前端浏览器套件一键运行（并行 + 轮询等待 + 超时 + 流式输出）
 * 用法： node tests/run-all.js
 *   环境变量：
 *     FISHING_TEST_JOBS    并行单元数（默认 = 套件数，上限 8）
 *     FISHING_TEST_TIMEOUT 单套件超时 ms（默认 480000）
 *     FISHING_TEST_ONLY    仅跑指定套件，逗号分隔（如 settings,smelt-workbench）
 *     FISHING_TEST_MODULES / NODE_PATH / CHROME_PATH 见下
 *
 * 这些套件只用真实浏览器渲染前端（页面内自带桩服务或 page.route 拦截），
 * 不启动任何后端进程。后端验证入口是 `npm test`（go test ./...）。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

// 套件清单：全部为前端渲染回归，互不占用端口
const ALL_SUITES = ['admin-interactions', 'desktop-zoom', 'inventory-pagination', 'mobile-layout', 'scene-performance', 'settings', 'smelt-workbench', 'social-friends', 'workshop-market-regression'];
const ONLY = (process.env.FISHING_TEST_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const SUITES = ONLY.length ? ALL_SUITES.filter(s => ONLY.indexOf(s) >= 0) : ALL_SUITES;

const UNIT_TIMEOUT = Number(process.env.FISHING_TEST_TIMEOUT) || 480000; // 8 分钟兜底
const EXIT_GRACE = 4000;  // 进程已退出但管道未关（残留子进程）时的宽限时间

// playwright-core 位置：优先环境变量，再退回项目同级的 fishing-test-modules
const SIBLING_MODULES = path.join(ROOT, '..', 'fishing-test-modules', 'node_modules');
const EXTRA_MODULES = process.env.FISHING_TEST_MODULES || process.env.NODE_PATH ||
  (fs.existsSync(SIBLING_MODULES) ? SIBLING_MODULES : '');

function detectBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return '';
}
const BROWSER = detectBrowser();

function killTree(pid) {
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch (e) {}
}

const UNITS = SUITES.slice();
const JOBS = Math.max(1, Math.min(UNITS.length || 1, Number(process.env.FISHING_TEST_JOBS) || (UNITS.length || 1)));

const t0 = Date.now();
let finished = 0;
const suiteResult = {};

function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }
function stamp() { return '[' + ((Date.now() - t0) / 1000).toFixed(1) + 's]'; }

const KEY_RE = /FAIL|Error|错误|异常|通过 \d+ 项|TEST ERROR|未捕获/;
const SUM_RE = /通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/;
const TAIL_MAX = 4000;
const LINES_MAX = 40;

function runUnit(u) {
  const file = path.join(__dirname, u + '.test.js');
  if (!fs.existsSync(file)) { onDone(u, { state: 'MISSING', pass: 0, fail: 0, ms: 0, lines: [] }); return; }

  const env = Object.assign({}, process.env);
  if (EXTRA_MODULES) env.NODE_PATH = EXTRA_MODULES;
  if (BROWSER) env.CHROME_PATH = BROWSER;

  const started = Date.now();
  console.log('▶ ' + stamp() + ' 启动 ' + u);
  const child = spawn(NODE, [file], { cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let tail = '';
  let pending = '';
  let done = false;
  let graceTimer = null;
  let settleTimer = null;

  function finish(state, extraFail) {
    if (done) return;
    done = true;
    if (graceTimer) clearTimeout(graceTimer);
    if (settleTimer) clearTimeout(settleTimer);
    clearTimeout(timeoutTimer);
    const m = tail.match(SUM_RE);
    const pass = m ? Number(m[1]) : 0;
    const fail = m ? Number(m[2]) : -1;
    const ok = state === 'EXIT' && fail === 0;
    onDone(u, {
      state: ok ? 'PASS' : (state === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL'),
      pass: pass, fail: fail === -1 ? (extraFail || 0) : fail, ms: Date.now() - started, lines: lines,
    });
  }

  function feed(chunk) {
    pending += chunk;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop();
    for (const l of parts) {
      if (KEY_RE.test(l)) {
        if (lines.length < LINES_MAX) lines.push(l.trim());
        console.log('  [' + u + '] ' + l.trim());
      }
      if (SUM_RE.test(l) && !done) {
        settleTimer = setTimeout(function () {
          if (done) return;
          killTree(child.pid);
          finish('EXIT', 0);
        }, 1500);
      }
    }
    tail = (tail + chunk).slice(-TAIL_MAX);
  }
  child.stdout.on('data', c => feed(c.toString()));
  child.stderr.on('data', c => feed(c.toString()));
  child.on('error', function () { finish('FAIL', 1); });
  child.on('exit', function () {
    graceTimer = setTimeout(function () { killTree(child.pid); finish('EXIT', 0); }, EXIT_GRACE);
  });
  child.on('close', function () { finish('EXIT', 0); });

  const timeoutTimer = setTimeout(function () {
    console.log('  [' + u + '] 超时 ' + fmtSec(UNIT_TIMEOUT) + '，终止进程树');
    killTree(child.pid);
    finish('TIMEOUT', 1);
  }, UNIT_TIMEOUT);
  timeoutTimer.unref && timeoutTimer.unref();
}

const queue = UNITS.slice();
let running = 0;
function onDone(u, r) {
  running--;
  const s = suiteResult[u] || (suiteResult[u] = { pass: 0, fail: 0, state: 'PASS', ms: 0, lines: [] });
  s.pass += r.pass || 0;
  s.fail += (r.fail > 0 ? r.fail : 0);
  s.ms = Math.max(s.ms, r.ms || 0);
  if (r.state !== 'PASS') s.state = r.state;
  if (r.lines && s.lines.length < LINES_MAX) s.lines.push.apply(s.lines, r.lines.slice(0, LINES_MAX - s.lines.length));
  const icon = r.state === 'PASS' ? '✔' : (r.state === 'TIMEOUT' ? '⏱' : '✗');
  console.log(icon + ' ' + stamp() + ' ' + u.padEnd(28) + r.state.padEnd(8) +
    '通过 ' + r.pass + ' 项，失败 ' + r.fail + ' 项 · ' + fmtSec(r.ms));
  finished++;
  pump();
  if (finished >= UNITS.length) summarize();
}
function pump() {
  while (queue.length && running < JOBS) {
    running++;
    runUnit(queue.shift());
  }
}

if (!UNITS.length) {
  console.log('没有匹配的套件：' + (process.env.FISHING_TEST_ONLY || ''));
  process.exit(1);
}
pump();

function summarize() {
  const wall = Date.now() - t0;
  console.log('\n============================');
  console.log('前端套件汇总（并行 ' + JOBS + ' 路 · 总耗时 ' + fmtSec(wall) + '）');
  console.log('============================');
  let totalPass = 0, allPass = true;
  SUITES.forEach(function (name) {
    const r = suiteResult[name] || { state: 'MISSING', pass: 0, fail: 0, ms: 0 };
    totalPass += r.pass || 0;
    if (r.state !== 'PASS') allPass = false;
    console.log('  ' + String(r.state).padEnd(8) + name.padEnd(30) + '通过 ' + r.pass + ' 项' +
      (r.fail ? '，失败 ' + r.fail + ' 项' : '') + ' · ' + fmtSec(r.ms));
  });
  console.log('  ------------------------------');
  console.log('  合计通过 ' + totalPass + ' 项 · 墙钟 ' + fmtSec(wall));
  SUITES.forEach(function (name) {
    const r = suiteResult[name];
    if (!r || r.state === 'PASS') return;
    const key = (r.lines || []).filter(l => /FAIL|Error|异常|TEST ERROR/.test(l)).slice(0, 12);
    console.log('\n----- ' + name + ' 失败明细 -----');
    console.log(key.length ? key.join('\n') : '(无关键行，退出状态 ' + r.state + ')');
  });
  console.log(allPass ? '\nALL SUITES PASS' : '\nSOME SUITES FAILED');
  console.log('============================');
  setTimeout(function () { process.exit(allPass ? 0 : 1); }, 100);
}
