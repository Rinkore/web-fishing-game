'use strict';
/*
 * Wiki 静态构建：检查源文件后复制到 dist/wiki。
 * 用法：npm run wiki:build
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'frontend', 'wiki');
const DIST = path.join(ROOT, 'dist', 'wiki');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (e) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  });
}
function count(dir) {
  let n = 0;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.isDirectory()) n += count(path.join(dir, e.name));
    else n++;
  });
  return n;
}

const sync = spawnSync(process.execPath, [path.join(__dirname, 'sync-versions.js')], { stdio: 'inherit' });
if (sync.status !== 0) process.exit(sync.status || 1);
const check = spawnSync(process.execPath, [path.join(__dirname, 'check.js')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status);
fs.rmSync(DIST, { recursive: true, force: true });
copyDir(SRC, DIST);
console.log('PASS Wiki 构建完成：' + count(DIST) + ' 个文件 → dist/wiki');
