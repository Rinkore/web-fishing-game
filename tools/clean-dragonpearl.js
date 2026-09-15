#!/usr/bin/env node
/*
 * 清理记录里的「龙宫宝珠」（v0.11 起它已从渔获改为材料）
 * ---------------------------------------------------------------------------
 * 背景：龙宫宝珠早期被登记成渔获（稀有鱼），于是它进了各类**鱼类榜单**：
 *       大鱼榜 / 小鱼纪录 / 全服前十大 / 前十小 / 全场最大，以及玩家账号里的
 *       「自动售出」单鱼规则。v0.11 把它改成了材料，这些残留数据已经没有意义：
 *       榜单里挂着一颗珠子、全场最大是一条「鱼」，自动售出规则永远不可能触发。
 *
 * 清理内容（幂等，可反复运行）：
 *   1. records.json：bigRecords / smallRecords / topCatches / topSmall 里的龙宫宝珠条目；
 *      若 globalMax（全场最大）就是它，则按清理后的各鱼种最大纪录**重新计算**全场最大；
 *   2. accounts/*.json：自动售出里针对龙宫宝珠的单鱼规则（rec.autoSell.fish.dragonpearl）；
 *   3. 可选 --codex：连账号图鉴里的龙宫宝珠条目一起去掉（默认保留——它现在是材料，
 *      图鉴里留着「已获得 N 次」并不算错，按需再删）。
 *   默认先整目录备份到 <数据目录>-backup-pearl-<时间戳>。
 *
 * 用法：
 *   node tools/clean-dragonpearl.js                # 自动定位数据目录，备份后清理
 *   node tools/clean-dragonpearl.js --dry-run      # 只报告将要做的改动
 *   node tools/clean-dragonpearl.js --codex        # 同时清掉账号图鉴里的条目
 *   node tools/clean-dragonpearl.js --data <目录>
 *   node tools/clean-dragonpearl.js --no-backup
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PEARL_ID = 'dragonpearl';
const PEARL_NAME = '龙宫宝珠';

const argv = process.argv.slice(2);
let dataDir = '';
let dryRun = false;
let backup = true;
let withCodex = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run' || a === '-n') dryRun = true;
  else if (a === '--no-backup') backup = false;
  else if (a === '--codex') withCodex = true;
  else if (a === '--data' || a === '-d') dataDir = argv[++i] || '';
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*/, '')); process.exit(0); }
  else { console.error('未知参数：' + a); process.exit(2); }
}
function defaultDataDir() {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  const base = fs.existsSync(docs) ? docs : home;
  return path.join(base, 'web-fishing-game');
}
if (!dataDir) dataDir = process.env.FISHING_DATA_DIR ? path.resolve(process.env.FISHING_DATA_DIR) : defaultDataDir();
dataDir = path.resolve(dataDir);
if (!fs.existsSync(dataDir)) { console.error('数据目录不存在：' + dataDir); process.exit(2); }

const RECORDS_FILE = path.join(dataDir, 'records.json');
const ACCOUNTS_DIR = path.join(dataDir, 'accounts');

const report = { records: {}, globalMax: false, autoSell: 0, codex: 0, accounts: 0 };
function log(m) { console.log(m); }
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8') || 'null'); } catch (e) { return null; } }
function writeJson(fp, obj) { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); }
function keysWithPearl(map) {
  return Object.keys(map || {}).filter(function (k) { return k === PEARL_ID; });
}
// 从各鱼种最大纪录里重建「全场最大」（record = { id, name, size, who, t }）
function rebuildGlobalMax(bigRecords) {
  let best = null;
  Object.keys(bigRecords || {}).forEach(function (id) {
    const r = bigRecords[id];
    if (!r || typeof r.size !== 'number') return;
    if (!best || r.size > best.size) best = r;
  });
  return best;
}

log('🎣 清理记录中的「' + PEARL_NAME + '」');
log('   数据目录：' + dataDir);
log('   模式：' + (dryRun ? '演练（不写盘）' : '实际清理'));

if (!dryRun && backup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = dataDir.replace(/[\\/]$/, '') + '-backup-pearl-' + stamp;
  fs.mkdirSync(bak, { recursive: true });
  (function copy(src, dst) {
    fs.readdirSync(src, { withFileTypes: true }).forEach(function (ent) {
      const s = path.join(src, ent.name), d = path.join(dst, ent.name);
      if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d); }
      else { try { fs.copyFileSync(s, d); } catch (e) {} }
    });
  })(dataDir, bak);
  log('   ✅ 已备份到：' + bak);
}

// ---- 1) records.json ----
if (fs.existsSync(RECORDS_FILE)) {
  const rec = readJson(RECORDS_FILE);
  if (rec && typeof rec === 'object') {
    let dirty = false;
    ['bigRecords', 'smallRecords', 'topCatches', 'topSmall'].forEach(function (key) {
      const map = rec[key];
      if (!map || typeof map !== 'object') return;
      const hit = keysWithPearl(map);
      if (!hit.length) return;
      hit.forEach(function (k) { delete map[k]; });
      report.records[key] = hit.length;
      dirty = true;
    });
    if (rec.globalMax && rec.globalMax.id === PEARL_ID) {
      const next = rebuildGlobalMax(rec.bigRecords);
      rec.globalMax = next || null;
      report.globalMax = true;
      dirty = true;
    }
    if (dirty && !dryRun) writeJson(RECORDS_FILE, rec);
    if (dirty) log('   · records.json → 已清理榜单条目');
  }
} else {
  log('   · records.json 不存在，跳过');
}

// ---- 2) 账号：自动售出规则（以及可选的图鉴条目）----
if (fs.existsSync(ACCOUNTS_DIR)) {
  fs.readdirSync(ACCOUNTS_DIR).filter(function (f) { return f.endsWith('.json'); }).forEach(function (f) {
    const fp = path.join(ACCOUNTS_DIR, f);
    const acc = readJson(fp);
    if (!acc || typeof acc !== 'object') return;
    report.accounts++;
    let dirty = false;
    if (acc.autoSell && acc.autoSell.fish && acc.autoSell.fish[PEARL_ID]) {
      delete acc.autoSell.fish[PEARL_ID];
      if (!Object.keys(acc.autoSell.fish).length) delete acc.autoSell.fish;
      report.autoSell++;
      dirty = true;
    }
    if (withCodex && acc.codex && acc.codex[PEARL_ID]) {
      delete acc.codex[PEARL_ID];
      report.codex++;
      dirty = true;
    }
    if (dirty && !dryRun) writeJson(fp, acc);
  });
}

// ---- 报告 ----
const recCount = Object.keys(report.records).reduce(function (n, k) { return n + report.records[k]; }, 0);
log('');
log('📋 清理汇总' + (dryRun ? '（演练，未写盘）' : ''));
log('   扫描账号             ：' + report.accounts + ' 个');
log('   榜单条目             ：' + recCount + ' 条' +
  (recCount ? '（' + Object.keys(report.records).map(function (k) { return k + ' ' + report.records[k]; }).join(' / ') + '）' : ''));
log('   全场最大被重置       ：' + (report.globalMax ? '是（已按各鱼种最大纪录重算）' : '否'));
log('   自动售出规则         ：' + report.autoSell + ' 条');
log('   图鉴条目             ：' + report.codex + ' 条' + (withCodex ? '' : '（未启用 --codex，默认保留）'));
log('');
if (recCount + report.autoSell + report.codex + (report.globalMax ? 1 : 0) === 0) {
  log('✅ 记录里没有「' + PEARL_NAME + '」残留，无需清理。');
} else {
  log(dryRun ? 'ℹ️ 以上为将要做的改动，去掉 --dry-run 即会实际写入。' : '✅ 清理完成，重启服务器即可生效。');
}
