'use strict';
/*
 * Wiki 静态检查：本地链接、必需文件、脚本语法。
 * 用法：npm run wiki:check
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'frontend', 'wiki');
const REQUIRED = [
  'index.html', 'items/index.html', 'grounds/index.html', 'guides/index.html', 'updates/index.html', 'search/index.html',
  'css/wiki.css', 'js/content.js', 'js/core.js', 'js/pages.js',
  'tools/build.html', 'tools/build.js', 'tools/smelt.html', 'tools/smelt.js', 'tools/tool.css',
];

function walk(dir, out) {
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}
function rel(p) { return path.relative(SRC, p).replace(/\\/g, '/'); }
function fail(message) { console.error('FAIL ' + message); process.exitCode = 1; }
function attr(source, name) {
  const re = new RegExp(name + '=["\']([^"\']+)["\']', 'ig');
  const out = [];
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

if (!fs.existsSync(SRC)) { fail('frontend/wiki 不存在'); process.exit(process.exitCode || 1); }
REQUIRED.forEach(function (f) {
  if (!fs.existsSync(path.join(SRC, f))) fail('缺少必需文件 ' + f);
});

const files = walk(SRC);
const htmlFiles = files.filter(function (f) { return /\.html$/i.test(f); });
const jsFiles = files.filter(function (f) { return /\.js$/i.test(f); });
if (!htmlFiles.length) fail('没有 HTML 页面');
if (!jsFiles.length) fail('没有 JavaScript 文件');

htmlFiles.forEach(function (file) {
  const source = fs.readFileSync(file, 'utf8');
  const base = path.dirname(file);
  [].concat(attr(source, 'href'), attr(source, 'src')).forEach(function (target) {
    if (/^(https?:|mailto:|data:|#)/i.test(target)) return;
    const clean = target.split('#')[0].split('?')[0];
    if (!clean) return;
    const resolved = clean.startsWith('/')
      ? path.join(ROOT, 'frontend', clean)
      : path.resolve(base, clean);
    if (!fs.existsSync(resolved)) fail(rel(file) + ' 断链 ' + target);
  });
  const scripts = attr(source, 'src').filter(function (x) { return !/^(https?:|data:)/i.test(x); });
  const connected = source.includes('/api/version?profile=wiki') || scripts.some(function (src) {
    const file = src.startsWith('/') ? path.join(ROOT, 'frontend', src) : path.resolve(base, src);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('/api/version?profile=wiki');
  });
  if (!connected) fail(rel(file) + ' 未连接规则快照接口');
});

jsFiles.forEach(function (file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(rel(file) + ' 语法错误：' + (r.stderr || '').trim());
});
const serveFile = path.join(ROOT, 'frontend', 'serve.js');
const serveCheck = spawnSync(process.execPath, ['--check', serveFile], { encoding: 'utf8' });
if (serveCheck.status !== 0) fail('frontend/serve.js 语法错误：' + (serveCheck.stderr || '').trim());

const passed = !process.exitCode;
console.log((passed ? 'PASS' : 'FAIL') + ' Wiki 静态检查：' + htmlFiles.length + ' 个页面，' + (jsFiles.length + 1) + ' 个脚本');
if (!passed) process.exit(1);
