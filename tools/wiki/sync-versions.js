'use strict';
/*
 * 从根目录 VERSIONS.md 同步主线版本表到 Wiki 静态内容。
 * 用法：node tools/wiki/sync-versions.js
 * 生成文件：frontend/wiki/content/versions.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'VERSIONS.md');
const TARGET = path.join(ROOT, 'frontend', 'wiki', 'content', 'versions.json');

function parseVersions(markdown) {
  return markdown.split(/\r?\n/).map(function (line) {
    const m = /^\|\s*(v[0-9][0-9.]*)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    return m ? { version: m[1], date: m[2], summary: m[3].replace(/\*\*/g, '') } : null;
  }).filter(Boolean);
}

const versions = parseVersions(fs.readFileSync(SOURCE, 'utf8'));
if (!versions.length) throw new Error('VERSIONS.md 中没有解析到版本记录');
const data = { source: 'VERSIONS.md', count: versions.length, versions: versions };
fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('PASS 已同步 ' + versions.length + ' 条版本记录 → frontend/wiki/content/versions.json');