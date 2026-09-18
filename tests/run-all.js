/*
 * 一键运行全部测试套件（并行 + 轮询等待 + 超时 + 流式输出）
 * 用法： node tests/run-all.js
 *   环境变量：
 *     FISHING_TEST_JOBS    并行单元数（默认 = 套件数，上限 16；本机核多可调高）
 *     FISHING_TEST_TIMEOUT 单套件超时 ms（默认 480000）
 *     FISHING_TEST_ONLY    仅跑指定套件，逗号分隔（如 e2e,admin）
 *     FISHING_TEST_SHARDS  套件分片数（如 ui-layout:2,admin:2），套件需支持 FISHING_TEST_SHARD
 *     FISHING_TEST_MODULES / NODE_PATH / CHROME_PATH 见下
 *
 * 设计要点：
 *  1) 各单元用不同端口与独立临时数据目录，互不干扰 → 可并行跑，总耗时约等于最慢的那个；
 *  2) 套件内部用「轮询条件 + 超时」，就绪即继续，不靠固定 sleep 拖时间；
 *  3) 结果即时输出：单元一结束立刻打印小结，不等其他单元；
 *  4) 日志只留关键行 + 有界尾巴（不再整份缓存），减少无谓的内存与解析开销；
 *  5) 进程退出后若句柄未释放（SSE/子进程），超时兜底 kill 进程树，绝不挂住。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

// 套件清单（端口互不相同，可安全并行）
// admin-ui 是从 ui-layout 拆出的后台页面场景：拆开后两者并行跑，墙钟不再被单个套件卡住。
const ALL_SUITES = ['e2e', 'auth-ui', 'fishing-interaction', 'bugfix', 'chest', 'v011', 'v013', 'v0134', 'v0135', 'v0136', 'v0138', 'v0138-ui', 'v0139', 'v0139-ui', 'v0140', 'v0140-ui', 'v0141', 'v0141-ui', 'v0161-ui', 'v0162', 'v0162-ui', 'scene-performance', 'inventory-pagination', 'mobile-layout', 'settings', 'mobile-trade-regression', 'desktop-zoom', 'features', 'ui-layout', 'admin', 'admin-ui'];
ALL_SUITES.push('smelt-workbench');
ALL_SUITES.push('wiki/wiki');
const ONLY = (process.env.FISHING_TEST_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const SUITES = ONLY.length ? ALL_SUITES.filter(s => ONLY.indexOf(s) >= 0) : ALL_SUITES;

// 分片：FISHING_TEST_SHARDS=ui-layout:2,admin:2 → 同一套件拆成 N 个并行单元
const SHARDS = {};
(process.env.FISHING_TEST_SHARDS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(function (kv) {
  const i = kv.lastIndexOf(':');
  if (i < 0) return;
  const n = Math.max(1, Math.min(8, Number(kv.slice(i + 1)) || 1));
  if (n > 1) SHARDS[kv.slice(0, i)] = n;
});

const UNIT_TIMEOUT = Number(process.env.FISHING_TEST_TIMEOUT) || 480000; // 8 分钟兜底
const EXIT_GRACE = 4000;  // 进程已退出但管道未关（残留子进程）时的宽限时间

// jsdom / playwright-core 位置：优先环境变量，再退回项目同级的 fishing-test-modules
const SIBLING_MODULES = path.join(ROOT, '..', 'fishing-test-modules', 'node_modules');
const EXTRA_MODULES = process.env.FISHING_TEST_MODULES || process.env.NODE_PATH ||
  (fs.existsSync(SIBLING_MODULES) ? SIBLING_MODULES : '');

// 真实浏览器（ui-layout）：优先 CHROME_PATH，否则自动探测 Chrome / Edge
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

// 并行单元：套件本身，或套件的一个分片
const UNITS = [];
SUITES.forEach(function (s) {
  const n = SHARDS[s] || 1;
  for (let i = 0; i < n; i++) UNITS.push({ suite: s, id: n > 1 ? s + '#' + (i + 1) + '/' + n : s, shard: n > 1 ? { i: i, n: n } : null });
});
const JOBS = Math.max(1, Math.min(UNITS.length, Number(process.env.FISHING_TEST_JOBS) || UNITS.length));

const t0 = Date.now();
let finished = 0;
// 套件级汇总（分片按套件合并）
const suiteResult = {};   // suite -> { pass, fail, state, ms, lines }

function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }
function stamp() { return '[' + ((Date.now() - t0) / 1000).toFixed(1) + 's]'; }

// 关键行判定：失败/异常/小结（一条合并正则，避免逐行多次匹配）
const KEY_RE = /FAIL|Error|错误|异常|通过 \d+ 项|TEST ERROR|未捕获/;
const SUM_RE = /通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/;
const TAIL_MAX = 4000;    // 每单元保留的日志尾巴（失败时兜底展示）
const LINES_MAX = 40;     // 每单元保留的关键行上限

// 单单元：流式输出 + 超时兜底 + 结果立即打印
function runUnit(u) {
  const file = path.join(__dirname, u.suite + '.test.js');
  if (!fs.existsSync(file)) { onDone(u, { state: 'MISSING', pass: 0, fail: 0, ms: 0, lines: [] }); return; }

  const env = Object.assign({}, process.env);
  if (EXTRA_MODULES) env.NODE_PATH = EXTRA_MODULES;
  if (BROWSER) env.CHROME_PATH = BROWSER;
  if (u.shard) { env.FISHING_TEST_SHARD = u.shard.i + '/' + u.shard.n; }

  const started = Date.now();
  console.log('▶ ' + stamp() + ' 启动 ' + u.id);
  const child = spawn(NODE, [file], { cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  // 只留关键行 + 有界尾巴：不再整份缓存日志
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

  // 流式：关键行立刻打印；小结行一到就安排收尾（进程若赖着不退就强杀）
  function feed(chunk) {
    pending += chunk;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop();               // 末段可能是半行，留到下一个 chunk
    for (const l of parts) {
      if (KEY_RE.test(l)) {
        if (lines.length < LINES_MAX) lines.push(l.trim());
        console.log('  [' + u.id + '] ' + l.trim());
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
    // 正常情况：exit 后管道很快 close。若子进程留下的孙进程占着管道，宽限后强制收尾。
    graceTimer = setTimeout(function () { killTree(child.pid); finish('EXIT', 0); }, EXIT_GRACE);
  });
  child.on('close', function () { finish('EXIT', 0); });

  const timeoutTimer = setTimeout(function () {
    console.log('  [' + u.id + '] ⏱ 超时 ' + fmtSec(UNIT_TIMEOUT) + '，终止进程树');
    killTree(child.pid);
    finish('TIMEOUT', 1);
  }, UNIT_TIMEOUT);
  timeoutTimer.unref && timeoutTimer.unref();
}

// 单元结束：立刻打印，并调度下一个待跑单元
const queue = UNITS.slice();
let running = 0;
function onDone(u, r) {
  running--;
  const s = suiteResult[u.suite] || (suiteResult[u.suite] = { pass: 0, fail: 0, state: 'PASS', ms: 0, lines: [] });
  s.pass += r.pass || 0;
  s.fail += (r.fail > 0 ? r.fail : 0);
  s.ms = Math.max(s.ms, r.ms || 0);
  if (r.state !== 'PASS') s.state = r.state;
  if (r.lines && s.lines.length < LINES_MAX) s.lines.push.apply(s.lines, r.lines.slice(0, LINES_MAX - s.lines.length));
  const icon = r.state === 'PASS' ? '✔' : (r.state === 'TIMEOUT' ? '⏱' : '✗');
  console.log(icon + ' ' + stamp() + ' ' + u.id.padEnd(20) + r.state.padEnd(8) +
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

pump();

function summarize() {
  const wall = Date.now() - t0;
  console.log('\n============================');
  console.log('测试套件汇总（并行 ' + JOBS + ' 路 · 总耗时 ' + fmtSec(wall) + '）');
  console.log('============================');
  let totalPass = 0, allPass = true;
  SUITES.forEach(function (name) {
    const r = suiteResult[name] || { state: 'MISSING', pass: 0, fail: 0, ms: 0 };
    totalPass += r.pass || 0;
    if (r.state !== 'PASS') allPass = false;
    console.log('  ' + String(r.state).padEnd(8) + name.padEnd(22) + '通过 ' + r.pass + ' 项' +
      (r.fail ? '，失败 ' + r.fail + ' 项' : '') + ' · ' + fmtSec(r.ms));
  });
  console.log('  ------------------------------');
  console.log('  合计通过 ' + totalPass + ' 项 · 墙钟 ' + fmtSec(wall));
  // 失败套件只打印关键行（不重复整份日志）
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
