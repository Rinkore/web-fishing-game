/*
 * 一键运行全部测试套件
 * 用法： node tests/run-all.js
 * （等价于依次运行 e2e / auth-ui / fishing-interaction / bugfix）
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const SUITES = ['e2e', 'auth-ui', 'fishing-interaction', 'bugfix', 'ui-layout'];

// jsdom / playwright-core 的安装位置。优先用已有的 NODE_PATH，
// 也可以用 FISHING_TEST_MODULES 显式指定；
// 都没设置时按 Node 常规规则解析（即装在项目 node_modules 里）。
const EXTRA_MODULES = process.env.FISHING_TEST_MODULES || process.env.NODE_PATH || '';

let allPass = true;
const summary = [];

SUITES.forEach(function (name) {
  const file = path.join(__dirname, name + '.test.js');
  if (!fs.existsSync(file)) { summary.push([name, 'MISSING', 0]); return; }
  const env = Object.assign({}, process.env);
  if (EXTRA_MODULES) env.NODE_PATH = EXTRA_MODULES;
  const r = spawnSync(NODE, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    env: env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  // 提取「通过 N 项，失败 M 项」
  const m = out.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/);
  const pass = m ? Number(m[1]) : 0;
  const fail = m ? Number(m[2]) : -1;
  const ok = r.status === 0 && fail === 0;
  if (!ok) {
    allPass = false;
    console.log('\n----- ' + name + ' 失败明细 -----');
    console.log(out.split(/\r?\n/).filter(l => /FAIL|Error|错误/.test(l)).join('\n'));
  }
  summary.push([name, ok ? 'PASS' : 'FAIL', pass, fail]);
});

console.log('\n============================');
console.log('测试套件汇总');
console.log('============================');
summary.forEach(function (s) {
  const [name, st, pass, fail] = s;
  console.log('  ' + String(st).padEnd(8) + name.padEnd(22) + '通过 ' + pass + ' 项' + (fail >= 0 ? '，失败 ' + fail + ' 项' : ''));
});
const totalPass = summary.reduce((a, s) => a + (s[2] || 0), 0);
console.log('  ------------------------------');
console.log('  合计通过 ' + totalPass + ' 项');
console.log(allPass ? 'ALL SUITES PASS' : 'SOME SUITES FAILED');
console.log('============================');
process.exit(allPass ? 0 : 1);
