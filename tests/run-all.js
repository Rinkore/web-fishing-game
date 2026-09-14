/*
 * 一键运行全部测试套件（并行 + 轮询等待 + 超时 + 流式输出）
 * 用法： node tests/run-all.js
 *   环境变量：
 *     FISHING_TEST_JOBS    并行套件数（默认 = CPU 核数，最多 6）
 *     FISHING_TEST_TIMEOUT 单套件超时 ms（默认 480000）
 *     FISHING_TEST_ONLY    仅跑指定套件，逗号分隔（如 e2e,admin）
 *     FISHING_TEST_MODULES / NODE_PATH / CHROME_PATH 见下
 *
 * 设计要点（v0.10.0 重构）：
 *  1) 各套件用不同端口与独立临时数据目录，互不干扰 → 可并行跑，总耗时约等于最慢的那个；
 *  2) 不做固定 sleep：套件内部全部改为「轮询条件 + 超时」，就绪即继续；
 *  3) 结果流式输出：失败行与每套件小结一到就打印，不再等全部跑完；
 *  4) 进程退出后若句柄未释放（SSE/子进程），超时兜底 kill 进程树，绝不挂住。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

// 套件清单（端口互不相同，可安全并行）
const ALL_SUITES = ['e2e', 'auth-ui', 'fishing-interaction', 'bugfix', 'ui-layout', 'admin'];
const ONLY = (process.env.FISHING_TEST_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const SUITES = ONLY.length ? ALL_SUITES.filter(s => ONLY.indexOf(s) >= 0) : ALL_SUITES;

const JOBS = Math.max(1, Math.min(SUITES.length,
  Number(process.env.FISHING_TEST_JOBS) || Math.min(ALL_SUITES.length, os.cpus().length || 4)));
const SUITE_TIMEOUT = Number(process.env.FISHING_TEST_TIMEOUT) || 480000; // 8 分钟兜底
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

function killTree(pid) {
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch (e) {}
}

const t0 = Date.now();
const results = {};   // name -> { state, pass, fail, ms, out, detail }
let finished = 0;

function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }

// 单套件：流式输出 + 超时兜底 + 结果立即打印
function runSuite(name) {
  const file = path.join(__dirname, name + '.test.js');
  if (!fs.existsSync(file)) { onDone(name, { state: 'MISSING', pass: 0, fail: 0, ms: 0, out: '' }); return; }

  const env = Object.assign({}, process.env);
  if (EXTRA_MODULES) env.NODE_PATH = EXTRA_MODULES;
  const br = detectBrowser();
  if (br) env.CHROME_PATH = br;

  const started = Date.now();
  console.log('▶ 启动 ' + name);
  const child = spawn(NODE, [file], { cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let done = false;
  let exitInfo = null;
  let graceTimer = null;

  function finish(state, extraFail) {
    if (done) return;
    done = true;
    if (graceTimer) clearTimeout(graceTimer);
    clearTimeout(timeoutTimer);
    const m = out.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/);
    const pass = m ? Number(m[1]) : 0;
    const fail = m ? Number(m[2]) : -1;
    const ok = state === 'EXIT' && fail === 0;
    onDone(name, {
      state: ok ? 'PASS' : (state === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL'),
      pass: pass, fail: fail === -1 ? (extraFail || 0) : fail, ms: Date.now() - started, out: out,
    });
  }

  // 流式：把失败/异常/小结行立刻打出来（缩短"看不到进展"的时间）
  function feed(chunk) {
    out += chunk;
    const lines = chunk.split(/\r?\n/);
    for (const l of lines) {
      if (/FAIL|Error|错误|异常|通过 \d+ 项/.test(l)) console.log('  [' + name + '] ' + l.trim());
      // 已打印小结 = 测试逻辑跑完：若进程仍不退（残留句柄），短暂宽限后强制收尾
      if (/通过 \d+ 项，失败 \d+ 项/.test(l) && !done) {
        setTimeout(function () {
          if (done) return;
          killTree(child.pid);
          finish('EXIT', 0);
        }, 1500);
      }
    }
  }
  child.stdout.on('data', c => feed(c.toString()));
  child.stderr.on('data', c => feed(c.toString()));
  child.on('error', function () { finish('FAIL', 1); });
  child.on('exit', function (code, signal) {
    exitInfo = { code: code, signal: signal };
    // 正常情况：exit 后管道很快 close。若子进程留下的孙进程占着管道，宽限后强制收尾。
    graceTimer = setTimeout(function () {
      killTree(child.pid);
      finish('EXIT', 0);
    }, EXIT_GRACE);
  });
  child.on('close', function () { finish('EXIT', 0); });

  const timeoutTimer = setTimeout(function () {
    console.log('  [' + name + '] ⏱ 超时 ' + fmtSec(SUITE_TIMEOUT) + '，终止进程树');
    killTree(child.pid);
    finish('TIMEOUT', 1);
  }, SUITE_TIMEOUT);
  timeoutTimer.unref && timeoutTimer.unref();
  void exitInfo;
}

// 每套件结束时立刻打印小结，并调度下一个待跑套件
const queue = SUITES.slice();
function onDone(name, r) {
  results[name] = r;
  finished++;
  const icon = r.state === 'PASS' ? '✔' : (r.state === 'TIMEOUT' ? '⏱' : '✗');
  console.log(icon + ' ' + name.padEnd(20) + r.state.padEnd(8) + '通过 ' + r.pass + ' 项，失败 ' + r.fail + ' 项 · ' + fmtSec(r.ms));
  pump();
}
function pump() {
  while (queue.length && running < JOBS) {
    const name = queue.shift();
    running++;
    runSuite(name);
  }
  if (finished >= SUITES.length) summarize();
}
let running = 0;
// runSuite 内部异步，这里在 onDone 时递减
const origDone = onDone;
onDone = function (name, r) { running--; origDone(name, r); };
pump();

function summarize() {
  console.log('\n============================');
  console.log('测试套件汇总（并行 ' + JOBS + ' 路 · 总耗时 ' + fmtSec(Date.now() - t0) + '）');
  console.log('============================');
  let totalPass = 0, allPass = true;
  SUITES.forEach(function (name) {
    const r = results[name] || { state: 'MISSING', pass: 0, fail: 0, ms: 0 };
    totalPass += r.pass || 0;
    if (r.state !== 'PASS') allPass = false;
    console.log('  ' + String(r.state).padEnd(8) + name.padEnd(22) + '通过 ' + r.pass + ' 项' +
      (r.fail >= 0 ? '，失败 ' + r.fail + ' 项' : '') + ' · ' + fmtSec(r.ms));
  });
  console.log('  ------------------------------');
  console.log('  合计通过 ' + totalPass + ' 项');
  // 失败套件只打印关键行（不重复整份日志）
  SUITES.forEach(function (name) {
    const r = results[name];
    if (!r || r.state === 'PASS') return;
    const key = (r.out || '').split(/\r?\n/).filter(l => /FAIL|Error|异常|TEST ERROR/.test(l)).slice(0, 12);
    console.log('\n----- ' + name + ' 失败明细 -----');
    console.log(key.length ? key.join('\n') : '(无关键行，退出状态 ' + r.state + ')');
  });
  console.log(allPass ? '\nALL SUITES PASS' : '\nSOME SUITES FAILED');
  console.log('============================');
  setTimeout(function () { process.exit(allPass ? 0 : 1); }, 100);
}
