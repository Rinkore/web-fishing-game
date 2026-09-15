#!/usr/bin/env node
/*
 * 存档修复脚本（v0.11「大鱼品质」修复专用 · 仅此版本需要）
 * ---------------------------------------------------------------------------
 * 背景：v0.11 修正了把「大鱼」当成第五种品质的错误，同时把钓竿的「大鱼概率」词缀
 *       改名为「技巧」（词缀短码 big → skl）。两项都只落在**存档里的组件实例签名**上：
 *       服务端的启动迁移会自动处理能被它扫到的字段，但如果你跳版本升级、或想先把存档
 *       备份/校对一遍（例如直接改过账号文件、市集挂单里还挂着旧签名的组件），用本脚本。
 *
 * 修复内容（幂等，可反复运行）：
 *   1. 账号：背包键、当前装配(bd)、钓竿槽位里的组件实例签名 → 规范签名
 *      （旧短码 big+8 → skl+8；词条乱序 → 按底材池顺序重排），并刷新缓存的名称/词缀/品质；
 *   2. 市集挂单：物品 id 与显示名；
 *   3. 经济域：清理已不存在物品的供需/价格历史/交易流水键（如旧版本遗留的键）；
 *   4. 报告每一项改动；默认先整目录备份到 <数据目录>-backup-v011-<时间戳>。
 *
 * 用法：
 *   node tools/fix-save-v011.js                 # 自动定位数据目录（与服务器同一规则），备份后修复
 *   node tools/fix-save-v011.js --dry-run       # 只报告将要做的改动，不写盘、不备份
 *   node tools/fix-save-v011.js --data <目录>    # 指定数据目录
 *   node tools/fix-save-v011.js --no-backup     # 跳过备份（不推荐）
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

// ---- 参数 ----
const argv = process.argv.slice(2);
let dataDir = '';
let dryRun = false;
let backup = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run' || a === '-n') dryRun = true;
  else if (a === '--no-backup') backup = false;
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

const ACCOUNTS_DIR = path.join(dataDir, 'accounts');
const MARKET_FILE = path.join(dataDir, 'market.json');
const ECONOMY_FILE = path.join(dataDir, 'economy.json');

// ---- 报告 ----
const report = { accounts: 0, inventory: 0, bd: 0, rodSlots: 0, listings: 0, economy: 0, unresolved: [] };
function log(msg) { console.log(msg); }

// ---- 工具 ----
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8') || 'null'); } catch (e) { return null; } }
function writeJson(fp, obj) { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); }
// 任意物品 id → 规范签名（含整竿标识：每个配件都会一起规范化）；鱼/材料/宝匣原样返回
function canon(id) {
  const s = String(id == null ? '' : id);
  if (D.isInstance(s)) return D.normalizeItemId(s);
  if (D.isRodSet(s)) return D.normalizeRodSetId(s);
  return s;
}
// 用当前目录刷新组件槽位的展示缓存（名称/词缀/品质），顺带把 compId 规范化
function fixSlot(slot) {
  if (!slot || typeof slot !== 'object' || !slot.compId) return false;
  const before = slot.compId;
  const meta = D.componentOf(before);
  if (!meta) { report.unresolved.push(before); return false; }
  const changed = meta.id !== before || slot.name !== meta.name || slot.rare !== meta.quality ||
    JSON.stringify(slot.affixes || []) !== JSON.stringify(meta.affixes);
  slot.compId = meta.id;
  slot.name = meta.name;
  slot.affixes = meta.affixes;
  slot.rare = meta.quality;
  return changed;
}

log('🎣 存档修复（v0.11 大鱼品质 / 技巧词缀）');
log('   数据目录：' + dataDir);
log('   模式：' + (dryRun ? '演练（不写盘）' : '实际修复'));

// ---- 备份 ----
if (!dryRun && backup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = dataDir.replace(/[\\/]$/, '') + '-backup-v011-' + stamp;
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

// ---- 1) 账号文件 ----
if (fs.existsSync(ACCOUNTS_DIR)) {
  fs.readdirSync(ACCOUNTS_DIR).filter(function (f) { return f.endsWith('.json'); }).forEach(function (f) {
    const fp = path.join(ACCOUNTS_DIR, f);
    const rec = readJson(fp);
    if (!rec || typeof rec !== 'object') return;
    report.accounts++;
    let dirty = false;

    // 1.1 背包：键规范化后合并（同一件在旧键与新键下会合并计数）
    if (rec.inventory && typeof rec.inventory === 'object') {
      const next = {};
      let invChanged = false;
      Object.keys(rec.inventory).forEach(function (id) {
        const nid = canon(id);
        if (nid !== id) invChanged = true;
        next[nid] = (next[nid] || 0) + rec.inventory[id];
      });
      if (invChanged) { report.inventory++; rec.inventory = next; dirty = true; }
    }
    // 1.2 当前装配
    if (rec.bd && typeof rec.bd === 'object') {
      Object.keys(rec.bd).forEach(function (part) {
        if (fixSlot(rec.bd[part])) { report.bd++; dirty = true; }
      });
    }
    // 1.3 钓竿槽位：整根钓竿的每个部位
    if (Array.isArray(rec.rodSlots)) {
      let slotDirty = false;
      rec.rodSlots.forEach(function (sl) {
        if (!sl || typeof sl !== 'object' || !sl.bd) return;
        Object.keys(sl.bd).forEach(function (part) {
          if (fixSlot(sl.bd[part])) slotDirty = true;
        });
      });
      if (slotDirty) { report.rodSlots++; dirty = true; }
    }
    if (dirty) {
      if (!dryRun) writeJson(fp, rec);
      log('   · ' + f + (dirty ? ' → 已修复' : ''));
    }
  });
}

// ---- 2) 市集挂单 ----
if (fs.existsSync(MARKET_FILE)) {
  const mk = readJson(MARKET_FILE);
  if (mk && Array.isArray(mk.listings)) {
    let dirty = false;
    mk.listings.forEach(function (l) {
      if (!l || !l.id) return;
      const nid = canon(l.id);
      const name = D.isRodSet(nid) ? l.name : D.itemName(nid);
      void name;
      if (nid !== l.id || (name && name !== l.name && !D.isRodSet(nid))) {
        l.id = nid;
        if (name && !D.isRodSet(nid)) l.name = name;
        report.listings++;
        dirty = true;
      }
    });
    if (dirty && !dryRun) writeJson(MARKET_FILE, mk);
    if (dirty) log('   · market.json → 已修复 ' + report.listings + ' 条挂单');
  }
}

// ---- 3) 经济域：清理已不存在物品的键 ----
if (fs.existsSync(ECONOMY_FILE)) {
  const eco = readJson(ECONOMY_FILE);
  if (eco && typeof eco === 'object') {
    const ECO = {};
    D.allItems().forEach(function (it) { if (it.kind === 'fish' || it.kind === 'material') ECO[it.id] = 1; });
    let dirty = false;
    ['shopSales', 'priceLog', 'tradeLog'].forEach(function (key) {
      const m = eco[key];
      if (!m || typeof m !== 'object') return;
      Object.keys(m).forEach(function (id) {
        if (!ECO[id]) { delete m[id]; report.economy++; dirty = true; }
      });
    });
    if (dirty && !dryRun) writeJson(ECONOMY_FILE, eco);
    if (dirty) log('   · economy.json → 清理 ' + report.economy + ' 个失效物品键');
  }
}

// ---- 报告 ----
log('');
log('📋 修复汇总' + (dryRun ? '（演练，未写盘）' : ''));
log('   账号文件      ：' + report.accounts + ' 个');
log('   背包签名规范化：' + report.inventory + ' 个账号');
log('   当前装配修复  ：' + report.bd + ' 个槽位');
log('   钓竿槽位修复  ：' + report.rodSlots + ' 根');
log('   市集挂单修复  ：' + report.listings + ' 条');
log('   经济失效键清理：' + report.economy + ' 个');
if (report.unresolved.length) {
  log('   ⚠ 无法解析的组件（已保留原样，请人工确认）：' + report.unresolved.slice(0, 10).join('、') +
    (report.unresolved.length > 10 ? ' 等 ' + report.unresolved.length + ' 个' : ''));
}
log('');
log(report.inventory + report.bd + report.rodSlots + report.listings + report.economy === 0
  ? '✅ 存档无需修复（已经是 v0.11 规范格式）。'
  : (dryRun ? 'ℹ️ 以上为将要做的改动，去掉 --dry-run 即会实际写入。' : '✅ 修复完成，重启服务器即可生效。'));
