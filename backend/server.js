/*
 * 网页钓鱼小游戏 - 多人服务器（零第三方依赖 · 全部处理逻辑在服务端）
 * 架构：前端仅展示；钓鱼循环/掷骰/词缀加成/资产结算/钓竿配置全部由本服务器权威执行。
 *   - 账号系统：注册 / 登录 / 会话（token）；密码 salt+sha256，落盘 backend/data/users.json
 *   - 钓鱼循环：POST /api/fishing/start|stop；服务器定时器掷骰，经 SSE 定向推送渔获与权威资产
 *   - 钓竿配置：POST /api/bd/set（校验组件目录），钓速变化即时重置钓鱼循环
 *   - 实时联机：GET /events (SSE) 广播在线玩家、渔场人数、动态、市集、交易
 *   - 系统商店 / 开放市集 / 在线交易 / 图鉴 / 大鱼榜
 *   - 管理后台：/api/admin/*（账号 admin 标志鉴权；服务器无管理员时首个登录后台的账号自动引导）
 *     配套页面 frontend/admin.html（5500 分离模式 / 9000 集成模式均可打开）
 *     功能：账号管理员授权 / 钓场钓点掉落池与增益 / 市集退回挂单 / 上钩判断公式 / 全服动态通知等级
 * 游戏数值目录：与前端共用 frontend/js/data.js（UMD，单一来源）
 * 运行： node backend/server.js   （默认端口 9000，可用 PORT 环境变量覆盖）
 * 前后端分离：
 *   - 本服务是纯 API + SSE，跨域已放行（CORS *），前端可部署到任意静态服务器；
 *   - 默认集成模式：若 ../frontend/index.html 存在则一并托管，单命令即可跑全栈；
 *   - STATIC_DIR 环境变量可指定其他前端目录，STATIC_DIR=none 强制纯 API 模式。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 9000;
const ROOT = __dirname;
// 数据目录：默认 backend/data；测试可用 FISHING_DATA_DIR 指到临时目录，避免跑测试清掉真实存档
const DATA_DIR = process.env.FISHING_DATA_DIR ? path.resolve(process.env.FISHING_DATA_DIR) : path.join(ROOT, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORLD_FILE = path.join(DATA_DIR, 'world.json');

// ---- 静态托管（前后端分离）----
// 默认自动托管 ../frontend（存在时）；STATIC_DIR=none 关闭；STATIC_DIR=路径 指定其他前端目录。
const STATIC_DIR = (process.env.STATIC_DIR === 'none') ? null
  : (process.env.STATIC_DIR
    || (fs.existsSync(path.join(__dirname, '..', 'frontend', 'index.html')) ? path.join(__dirname, '..', 'frontend') : null));

const players = new Map();   // id(=username) -> presence（可安全 JSON 广播）
const fishingTimers = new Map(); // username -> 钓鱼循环定时器（Node Timer，不可序列化，单独存放）
const feed = [];             // { t, who, item, ground, spot }
const clients = new Set();   // SSE response 对象
const sessions = new Map();  // token -> username(lowercased)
let users = {};

// ---- 全局世界状态（商店价格 / 市集挂单 / 大鱼榜 / 价格历史 / 管理配置） ----
// biteFormula：上钩判断公式（管理员可编辑）；groundCfg：钓场/钓点管理配置覆盖；notifyLevel：全服动态通知等级
const BITE_FORMULA_DEFAULT = 'min(98, 90 + speed * 0.15)';
let world = { shopSales: {}, listings: [], listingSeq: 1, bigRecords: {}, smallRecords: {}, topCatches: {}, priceLog: {}, tradeLog: {}, marketLog: [], groundCfg: { spots: {}, grounds: {} }, notifyLevel: 'all', biteFormula: BITE_FORMULA_DEFAULT };

// ---- 在线交易会话 ----
// trade = { id, a:{key,name}, b:{key,name}, aItems:[{id,qty}], bItems:[], aOk, bOk, cooldownUntil, cancelled, createdAt }
const trades = new Map();
let tradeSeq = 1;
const TRADE_COOLDOWN = 3000;

// ---- 游戏静态数据：与前端共用 frontend/js/data.js（UMD，单一来源） ----
const D = require(path.join(__dirname, '..', 'frontend', 'js', 'data.js'));

// 物品价格/名称表由共享目录派生（用于定价、市集与交易校验）
const ITEM_PRICE = {}, ITEM_NAME = {}, FISH_ID_SET = {};
D.allItems().forEach(function (it) {
  ITEM_PRICE[it.id] = it.price;
  ITEM_NAME[it.id] = it.name;
  if (it.kind === 'fish') FISH_ID_SET[it.id] = 1;
});

// ---- 服务端游戏引擎（钓鱼循环 / 掷骰 / 词缀加成：唯一权威，前端仅展示） ----
const FISH_INTERVAL_BASE = 3000; // 基础钓鱼间隔 ms

function bdEffectsOf(bd) {
  const eff = { speed: 0, big: 0, rare: 0, material: 0, size: 0, double: 0 };
  D.ROD_PARTS.forEach(function (part) {
    const comp = D.componentOf(bd && bd[part.key] && bd[part.key].compId);
    if (!comp) return;
    comp.affixes.forEach(function (a) { if (eff[a.type] != null) eff[a.type] += a.value; });
  });
  return eff;
}
function fishIntervalOf(eff) {
  return Math.max(800, Math.round(FISH_INTERVAL_BASE * (1 - Math.min(60, eff.speed) / 100)));
}
// 钓点增益并入总加成（管理员在后台为钓场/钓点配置，类别同词缀：speed/big/rare/material/size/double）
function mergedEffOf(bd, spot) {
  const eff = bdEffectsOf(bd);
  ((spot && spot.buffs) || []).forEach(function (b) {
    if (b && eff[b.type] != null) eff[b.type] += Number(b.value) || 0;
  });
  return eff;
}
// 大鱼/稀有/材料加成：按类别放大掉落池权重
function boostPoolOf(pool, eff) {
  if (!eff.big && !eff.rare && !eff.material) return pool;
  return pool.map(function (e) {
    const i = e.pick.indexOf(':');
    const type = e.pick.slice(0, i), id = e.pick.slice(i + 1);
    let mult = 1;
    if (type === 'fish') {
      const tier = D.fishTierOf(id);
      if (tier === 'big') mult = 1 + eff.big / 100;
      else if (tier === 'rare') mult = 1 + eff.rare / 100;
    } else if (type === 'material') mult = 1 + eff.material / 100;
    return { pick: e.pick, weight: e.weight * mult };
  });
}
function weightedPickOf(pool) {
  let total = 0; pool.forEach(function (e) { total += e.weight; });
  let r = Math.random() * total;
  for (const e of pool) { r -= e.weight; if (r <= 0) return e.pick; }
  return pool[pool.length - 1].pick;
}
// 体型随机：偏向小值；体型词缀可正可负，放大/缩小结果但正向不越过上限的 1.3 倍
function rollSizeOf(range, eff) {
  let v = range[0] + (range[1] - range[0]) * Math.pow(Math.random(), 1.6);
  if (eff.size !== 0) v = Math.min(range[1] * 1.3, v * (1 + eff.size / 100));
  return Math.round(v * 10) / 10;
}
function resolveItemAt(spot, eff) {
  const pick = weightedPickOf(boostPoolOf(spot.pool, eff));
  const i = pick.indexOf(':');
  const type = pick.slice(0, i), id = pick.slice(i + 1);
  if (type === 'fish') {
    for (const tier of ['common', 'big', 'rare']) {
      const f = D.FISH[tier].find(function (x) { return x.id === id; });
      if (f) return { kind: 'fish', rarity: f.rarity, id: f.id, name: f.name, size: f.size ? rollSizeOf(f.size, eff) : null };
    }
  }
  if (type === 'material') {
    const m = D.MATERIALS.find(function (x) { return x.id === id; });
    if (m) return { kind: 'material', rarity: m.rarity, id: m.id, name: m.name, size: null };
  }
  if (type === 'component') return D.rollComponent();
  return null;
}
function spotOf(groundId, spotId) {
  const g = D.GROUNDS.find(function (x) { return x.id === groundId; });
  if (!g) return null;
  const s = g.spots.find(function (x) { return x.id === spotId; }) || null;
  return s ? { ground: g, spot: s } : null;
}
// 单竿结算：掷骰 → 入库（背包/图鉴）→ 大鱼榜 → 全服动态 → 定向推送权威资产
function doServerCatch(rec, key, ground, spot, eff, noDouble) {
  const item = resolveItemAt(spot, eff);
  if (!item) return;
  invAdd(rec, item.id, 1);
  rec.codex = rec.codex || {};
  rec.catchCount = (rec.catchCount || 0) + 1;
  const cx = rec.codex[item.id] || { count: 0, first: Date.now() };
  cx.count += 1;
  // 记录个人最大/最小体型（图鉴详情展示）
  if (item.size != null) {
    if (cx.max == null || item.size > cx.max) cx.max = item.size;
    if (cx.min == null || item.size < cx.min) cx.min = item.size;
  }
  rec.codex[item.id] = cx;

  let recordEvent = null;
  let smallEvent = false;
  if (FISH_ID_SET[item.id] && item.size != null && item.size > 0) {
    const cur = world.bigRecords[item.id];
    if (!cur || item.size > cur.size) {
      world.bigRecords[item.id] = { id: item.id, name: itemName(item.id), size: Math.round(item.size * 10) / 10, who: rec.name, t: Date.now() };
      recordEvent = world.bigRecords[item.id];
    }
    // 全服前十大捕获（记录页点开查看）
    const top = (world.topCatches[item.id] = world.topCatches[item.id] || []);
    top.push({ size: Math.round(item.size * 10) / 10, who: rec.name, t: Date.now() });
    top.sort(function (a, b) { return b.size - a.size; });
    if (top.length > 10) top.length = 10;
    // 全服最小纪录
    const sm = world.smallRecords[item.id];
    if (!sm || item.size < sm.size) {
      world.smallRecords[item.id] = { id: item.id, name: itemName(item.id), size: Math.round(item.size * 10) / 10, who: rec.name, t: Date.now() };
      smallEvent = true;
    }
  }

  const entry = { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null };
  // 通知等级过滤：只影响全服动态（feed 广播/历史/近期渔获），钓者自己的定向推送不受影响
  const visible = feedVisible(item, recordEvent || smallEvent);
  if (visible) {
    feed.unshift(entry); if (feed.length > 60) feed.pop();
    broadcast({ type: 'feed', entry: entry });
  }

  // 近期渔获（大鱼/稀有/组件）：更新 presence 并广播给所有人
  const p = players.get(key);
  if (p && visible && (item.rarity === 'big' || item.rarity === 'rare' || item.kind === 'component')) {
    p.recent = item.size ? (item.name + ' ' + item.size + 'cm') : item.name;
    sendPlayersAll();
  }
  saveUsers();
  if (recordEvent || smallEvent) {
    saveWorld();
    broadcastRecords();
    if (recordEvent && feedVisible(item, true)) broadcast({ type: 'feed', entry: { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null, record: true } });
  }
  // 定向推送：本条渔获 + 权威资产/图鉴（前端不持账本）
  sendTo(key, { type: 'catch', entry: entry });
  sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
  // 双钓词缀：立即再结算一竿（不连锁）
  if (!noDouble && eff.double > 0 && Math.random() * 100 < eff.double) doServerCatch(rec, key, ground, spot, eff, true);
}
function fishTick(key) {
  const p = players.get(key);
  if (!p || !p.fishing) return;
  const rec = users[key];
  const found = spotOf(p.fishing.groundId, p.fishing.spotId);
  if (!found) { stopFishingSession(key); return; }
  const eff = mergedEffOf(rec.bd, found.spot);
  // 上钩判断：公式结果 = 本次上钩概率（%）；落空则本竿无收获，定时器继续下一竿
  if (Math.random() * 100 >= biteProbabilityOf(eff, fishIntervalOf(eff))) return;
  doServerCatch(rec, key, found.ground, found.spot, eff, false);
}
function startFishingSession(key, groundId, spotId) {
  const p = players.get(key);
  if (!p) return { error: '请先进入游戏（建立实时连接）' };
  const found = spotOf(groundId, spotId);
  if (!found) return { error: '钓点不存在' };
  if (found.ground.locked) return { error: '该钓场尚未开放' };
  // 定时器单独存放：presence 对象会被 JSON 广播，Node Timer 有循环引用不能挂上去
  const prev = fishingTimers.get(key);
  if (prev) clearInterval(prev);
  p.fishing = { groundId: groundId, spotId: spotId };
  p.status = 'fishing'; p.groundId = groundId; p.spotId = spotId;
  const interval = fishIntervalOf(mergedEffOf(users[key].bd, found.spot));
  fishingTimers.set(key, setInterval(function () { fishTick(key); }, interval));
  sendPlayersAll();
  return { interval: interval };
}
function stopFishingSession(key) {
  const t = fishingTimers.get(key);
  if (t) clearInterval(t);
  fishingTimers.delete(key);
  const p = players.get(key);
  if (p) { p.fishing = null; p.status = 'idle'; p.groundId = null; p.spotId = null; p.recent = null; }
  sendPlayersAll();
}

// 钓点增益变化：正在该钓点钓鱼的玩家按新加成重启循环（钓速即时生效）
function restartFishingAt(groundId, spotId) {
  players.forEach(function (p, key) {
    if (!p.fishing || p.fishing.groundId !== groundId || p.fishing.spotId !== spotId) return;
    const old = fishingTimers.get(key);
    if (old) clearInterval(old);
    const found = spotOf(groundId, spotId);
    const interval = fishIntervalOf(mergedEffOf(users[key].bd, found && found.spot));
    fishingTimers.set(key, setInterval(function () { fishTick(key); }, interval));
  });
}

// ---- 上钩判断公式（管理员可编辑 · 递归下降解析，不用 eval）----
// 每次抛竿掷骰时求值：结果 = 本次上钩概率（%）；未上钩则该竿无收获（定时器继续下一竿）。
// 可用变量：speed/big/rare/material/size/double（钓竿词缀 + 钓点增益，%）与 interval（抛竿间隔 ms）。
// 可用函数：min max floor ceil round abs clamp(x,lo,hi)。
const BITE_FUNCS = {
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
  clamp: function (x, lo, hi) { return Math.min(hi, Math.max(lo, x)); },
};
const BITE_VAR_NAMES = ['speed', 'big', 'rare', 'material', 'size', 'double', 'interval'];
// 解析器：每个语法节点返回 function(vars) -> number 的闭包；编译期即校验变量/函数名与语法
function compileFormula(src) {
  const s = String(src == null ? '' : src).trim();
  if (!s) return { error: '公式不能为空' };
  let i = 0;
  function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
  function parseExpr() {
    let f = parseTerm();
    for (;;) {
      ws();
      if (s[i] === '+') { i++; const a = f, b = parseTerm(); f = function (v) { return a(v) + b(v); }; }
      else if (s[i] === '-') { i++; const a = f, b = parseTerm(); f = function (v) { return a(v) - b(v); }; }
      else return f;
    }
  }
  function parseTerm() {
    let f = parseFactor();
    for (;;) {
      ws();
      if (s[i] === '*') { i++; const a = f, b = parseFactor(); f = function (v) { return a(v) * b(v); }; }
      else if (s[i] === '/') { i++; const a = f, b = parseFactor(); f = function (v) { return a(v) / b(v); }; }
      else if (s[i] === '%') { i++; const a = f, b = parseFactor(); f = function (v) { return a(v) % b(v); }; }
      else return f;
    }
  }
  function parseFactor() {
    ws();
    if (s[i] === '-') { i++; const a = parseFactor(); return function (v) { return -a(v); }; }
    if (s[i] === '+') { i++; return parseFactor(); }
    if (s[i] === '(') {
      i++;
      const a = parseExpr();
      ws();
      if (s[i] !== ')') throw new Error('缺少右括号');
      i++;
      return a;
    }
    const num = /^[0-9]*\.?[0-9]+/.exec(s.slice(i));
    if (num) { i += num[0].length; const n = parseFloat(num[0]); return function () { return n; }; }
    const idm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!idm) throw new Error('第 ' + (i + 1) + ' 个字符无法识别');
    const name = idm[0];
    i += name.length;
    ws();
    if (s[i] === '(') {
      const fn = BITE_FUNCS[name];
      if (!fn) throw new Error('未知函数：' + name);
      i++;
      const args = [];
      ws();
      if (s[i] !== ')') {
        for (;;) {
          args.push(parseExpr());
          ws();
          if (s[i] === ',') { i++; ws(); continue; }
          break;
        }
      }
      if (s[i] !== ')') throw new Error('函数 ' + name + ' 缺少右括号');
      i++;
      return function (v) { return fn.apply(null, args.map(function (a) { return a(v); })); };
    }
    if (BITE_VAR_NAMES.indexOf(name) < 0) throw new Error('未知变量：' + name);
    return function (v) { return Number(v[name]) || 0; };
  }
  try {
    const f = parseExpr();
    ws();
    if (i < s.length) throw new Error('第 ' + (i + 1) + ' 个字符起有多余内容');
    const probe = {};
    BITE_VAR_NAMES.forEach(function (n) { probe[n] = 1; });
    if (!isFinite(f(probe))) throw new Error('公式结果不是有限数');
    return { ok: true, fn: f };
  } catch (e) { return { error: e.message || '公式无效' }; }
}
let biteCompiledFn = null, biteCompiledSrc = null;
function biteProbabilityOf(eff, interval) {
  const src = String(world.biteFormula || '').trim();
  if (!src) return 100;
  if (biteCompiledSrc !== src) {
    const c = compileFormula(src);
    biteCompiledFn = c.ok ? c.fn : null;
    biteCompiledSrc = src;
  }
  if (!biteCompiledFn) return 100; // 公式无效时保底必上钩（正常保存路径已校验，不会走到）
  let p;
  try {
    p = biteCompiledFn({ speed: eff.speed || 0, big: eff.big || 0, rare: eff.rare || 0, material: eff.material || 0, size: eff.size || 0, double: eff.double || 0, interval: interval || 0 });
  } catch (e) { return 100; }
  if (!isFinite(p)) p = p > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, p));
}

// ---- 全服动态通知等级（管理员可调；只影响广播的 feed，钓者自己的 catch 推送不受影响）----
const NOTIFY_LEVELS = {
  all: '全部渔获（默认）',
  uncommon: '仅非普通：大鱼 / 稀有鱼 / 组件',
  offrange: '仅体型超出基准范围的鱼（超出该鱼基准 [最小,最大] 体型）',
  records: '仅破纪录时（全服最大 / 最小纪录）',
  none: '关闭：不向全服推送任何渔获动态',
};
function baseRangeOf(id) {
  for (const tier of ['common', 'big', 'rare']) {
    const f = D.FISH[tier].find(function (x) { return x.id === id; });
    if (f && f.size) return f.size;
  }
  return null;
}
function feedVisible(item, isRecord) {
  const lv = world.notifyLevel || 'all';
  if (lv === 'all') return true;
  if (lv === 'none') return false;
  if (lv === 'records') return !!isRecord;
  if (lv === 'uncommon') return item.kind === 'component' || (item.kind === 'fish' && item.rarity !== 'common');
  if (lv === 'offrange') {
    if (item.kind !== 'fish' || item.size == null) return false;
    const r = baseRangeOf(item.id);
    return !r || item.size > r[1] || item.size < r[0];
  }
  return true;
}

// ---- 钓场/钓点管理配置（管理后台编辑；覆盖存 world.groundCfg，启动时套用到共享目录）----
// spots 的 key 为 'groundId:spotId'；grounds 存 locked 等钓场级配置
function validatePoolEntries(list) {
  if (!Array.isArray(list)) return { error: '掉落池格式错误' };
  if (!list.length) return { error: '掉落池不能为空（至少保留 1 个条目）' };
  const out = [];
  for (const e of list) {
    const pick = String((e && e.pick) || '');
    const i = pick.indexOf(':');
    const type = i >= 0 ? pick.slice(0, i) : '';
    const id = i >= 0 ? pick.slice(i + 1) : '';
    const weight = Number(e && e.weight);
    if (type === 'fish') { if (!D.fishTierOf(id)) return { error: '未知鱼类：' + (id || pick) }; }
    else if (type === 'material') { if (!D.MATERIALS.some(function (m) { return m.id === id; })) return { error: '未知材料：' + (id || pick) }; }
    else if (type !== 'component') return { error: '无效的掉落条目：' + pick };
    if (!isFinite(weight) || weight < 0 || weight > 1000000) return { error: '权重需在 0 - 1000000 之间' };
    out.push({ pick: type === 'component' ? 'component:' : pick, weight: weight });
  }
  return { ok: true, pool: out };
}
function validateBuffList(list) {
  if (!Array.isArray(list)) return { error: '增益格式错误' };
  const out = [];
  for (const b of list) {
    const type = String((b && b.type) || '');
    if (!D.AFFIX_LABEL[type]) return { error: '未知增益类别：' + type };
    const value = Number(b && b.value);
    if (!isFinite(value) || value < -100 || value > 1000) return { error: '增益数值需在 -100 到 1000 之间' };
    out.push({ type: type, value: Math.round(value * 10) / 10 });
  }
  return { ok: true, buffs: out };
}
function applyGroundCfg() {
  const cfg = world.groundCfg || {};
  Object.keys(cfg.spots || {}).forEach(function (k) {
    const parts = k.split(':');
    const found = spotOf(parts[0], parts[1]);
    if (!found) return;
    if (cfg.spots[k].pool) found.spot.pool = cfg.spots[k].pool;
    if (cfg.spots[k].buffs) found.spot.buffs = cfg.spots[k].buffs;
  });
  Object.keys(cfg.grounds || {}).forEach(function (gid) {
    const g = D.GROUNDS.find(function (x) { return x.id === gid; });
    if (g && cfg.grounds[gid] && cfg.grounds[gid].locked != null) g.locked = !!cfg.grounds[gid].locked;
  });
}
function saveSpotCfg(groundId, spotId, patch) {
  world.groundCfg = world.groundCfg || {};
  world.groundCfg.spots = world.groundCfg.spots || {};
  const k = groundId + ':' + spotId;
  const cur = world.groundCfg.spots[k] || {};
  if (patch.pool) cur.pool = patch.pool;
  if (patch.buffs) cur.buffs = patch.buffs;
  world.groundCfg.spots[k] = cur;
  saveWorld();
}
// 钓场配置变化：向游戏端广播整份目录（图鉴产地/渔场页即时同步）
function broadcastGroundcfg() { broadcast({ type: 'groundcfg', grounds: D.GROUNDS }); }

// 顶号：使该账号所有旧会话失效并断开其实时连接（一个账号同时只允许一个在线窗口）
function kickUserSessions(key) {
  const dead = [];
  sessions.forEach(function (k, t) { if (k === key) dead.push(t); });
  dead.forEach(function (t) { sessions.delete(t); }); // 使旧 token 全部失效（顶号核心）
  stopFishingSession(key);
  const doomed = [];
  clientOwners.forEach(function (ownerKey, res) { if (ownerKey === key) doomed.push(res); });
  doomed.forEach(function (res) {
    clients.delete(res);
    clientOwners.delete(res);
    try { res.write('data: ' + JSON.stringify({ type: 'kicked', msg: '账号已在其他窗口登录' }) + '\n\n'); } catch (e) {}
    try { res.end(); } catch (e) {}
  });
  if (players.has(key)) { players.delete(key); sendPlayersAll(); }
  const t = tradeOfPlayer(key);
  if (t) { t.cancelled = true; t.closed = true; broadcastTrade(t); trades.delete(t.id); }
}

function basePrice(id) { return ITEM_PRICE[id] || 10; }
function itemName(id) { return ITEM_NAME[id] || id; }

// ---- 动态收购价（服务器权威 · 单乘数模型）----
// 每个物品维护一个价格乘数 m ∈ [0.4, 2.0]，实际价 = 基准价 × m：
//   售出：m 每件除以 1.15（成比例下压——2 倍价卖一件回到 1.74 倍，不会一键跌回原价）；
//   闲置：m 以 1 小时时间常数向 2.0 指数回升（长期无人供应缓慢涨价，最高翻倍）。
// 涨跌共用同一个乘数，状态连续、无跳变。
const PRICE_FLOOR = 0.4;
// ---- 市集挂单规则：每人最多同时 40 个挂单；时长 6/12/24 小时对应费率 1%/3%/5%，过期退物品不退费 ----
const MAX_LISTINGS_PER_PLAYER = 40;
const LIST_FEE_RATES = { 6: 0.01, 12: 0.03, 24: 0.05 };
const LISTING_TTL_MS_ENV = Number(process.env.LISTING_TTL_MS) || 0; // 测试用固定 TTL
const PRICE_CEIL = 2.0;
const SALE_DIVISOR = 0.0075;   // 每售 1 件，乘数除以 (1 + 0.0075)（约 -0.74%/件）
const RISE_TAU_MS = 3600000;   // 闲置回升时间常数：1 小时

// 当前乘数（含闲置增长；无状态计算，不写存储）
function currentMultiplier(s, now) {
  const idle = Math.max(0, now - (s.lastTs || now));
  const m0 = Math.min(PRICE_CEIL, Math.max(PRICE_FLOOR, s.m == null ? 1 : s.m));
  return Math.min(PRICE_CEIL, PRICE_CEIL - (PRICE_CEIL - m0) * Math.exp(-idle / RISE_TAU_MS));
}
function currentPrice(id) {
  const s = world.shopSales[id];
  if (!s) return basePrice(id);
  return Math.max(1, Math.round(basePrice(id) * currentMultiplier(s, Date.now())));
}
// 售出：压低乘数 + 统计交易量 + 记录价格点 + 交易流水（同账号一分钟内由前端合并展示）
function registerSale(id, qty, who, unit) {
  const s = world.shopSales[id] || { m: 1, lastTs: Date.now(), soldTotal: 0, soldToday: 0, day: null };
  const cur = currentMultiplier(s, Date.now());
  s.m = Math.max(PRICE_FLOOR, cur / Math.pow(1 + SALE_DIVISOR, qty));
  s.soldTotal = (s.soldTotal || 0) + qty;
  const day = new Date().toISOString().slice(0, 10);
  if (s.day !== day) { s.day = day; s.soldToday = 0; }
  s.soldToday += qty;
  s.lastTs = Date.now();
  world.shopSales[id] = s;
  world.tradeLog = world.tradeLog || {};
  const log = world.tradeLog[id] || (world.tradeLog[id] = []);
  log.push({ t: Date.now(), who: who || '?', qty: qty, unit: unit || currentPrice(id) });
  if (log.length > 200) log.splice(0, log.length - 200);
  recordPrice(id);
}
// 价格历史采样：售出即时记点 + 每分钟全量采样（捕捉无人供应时的缓慢上涨）
function recordPrice(id) {
  world.priceLog = world.priceLog || {};
  const log = world.priceLog[id] || (world.priceLog[id] = []);
  const p = currentPrice(id);
  const last = log[log.length - 1];
  if (!last || last.p !== p || Date.now() - last.t > 60000) log.push({ t: Date.now(), p: p });
  if (log.length > 360) log.splice(0, log.length - 360); // 保留 6 小时（每分钟一次）
}
setInterval(function () {
  Object.keys(ITEM_PRICE).forEach(recordPrice);
  try { saveWorld(); } catch (e) {}
}, 60000).unref();

function loadUsers() { try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '{}'); } catch (e) { users = {}; } }
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {} }
function loadWorld() { try { world = Object.assign(world, JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8') || '{}')); } catch (e) {} }
function saveWorld() { try { fs.writeFileSync(WORLD_FILE, JSON.stringify(world, null, 2)); } catch (e) {} }
loadUsers();
loadWorld();
// v0.7.0 组件编码 ID 迁移：背包 / 钓竿配置 / 挂单 / 商店统计里的旧组件 id 原位换新
(function migrateLegacyComponentIds() {
  let dirty = false;
  Object.keys(users).forEach(function (key) {
    const rec = users[key];
    if (rec.inventory) {
      const next = {};
      Object.keys(rec.inventory).forEach(function (id) {
        const nid = D.normalizeItemId(id);
        next[nid] = (next[nid] || 0) + rec.inventory[id];
      });
      if (JSON.stringify(next) !== JSON.stringify(rec.inventory)) { rec.inventory = next; dirty = true; }
    }
    if (rec.bd) {
      Object.keys(rec.bd).forEach(function (part) {
        const slot = rec.bd[part];
        if (!slot || !slot.compId) return;
        const comp = D.componentOf(slot.compId);
        if (comp && comp.id !== slot.compId) { slot.compId = comp.id; slot.name = comp.name; dirty = true; }
      });
    }
  });
  (world.listings || []).forEach(function (l) {
    const comp = D.componentOf(l.id);
    if (comp && comp.id !== l.id) { l.id = comp.id; dirty = true; }
  });
  ['shopSales', 'priceLog'].forEach(function (field) {
    const m = world[field] || {};
    Object.keys(m).forEach(function (id) {
      const comp = D.componentOf(id);
      if (comp && comp.id !== id) { m[comp.id] = m[id]; delete m[id]; dirty = true; }
    });
  });
  if (dirty) { saveUsers(); saveWorld(); console.log('[migrate] legacy component ids -> v0.7.0 coded ids'); }
})();
// 套用管理后台保存的钓场/钓点配置覆盖（掉落池 / 增益 / 锁定状态）
applyGroundCfg();
// 为所有物品补齐乘数状态（老档迁移：旧"供应压力"按 -1%/件 折算为初始乘数）
(function ensureSaleStats() {
  const day = new Date().toISOString().slice(0, 10);
  Object.keys(ITEM_PRICE).forEach(function (id) {
    const s = world.shopSales[id];
    if (!s) { world.shopSales[id] = { m: 1, lastTs: Date.now(), soldTotal: 0, soldToday: 0, day: day }; return; }
    if (s.m == null) {
      s.m = Math.max(PRICE_FLOOR, 1 - Math.min(0.6, (s.debt || 0) * 0.01));
      delete s.debt;
    }
    if (s.day !== day) { s.day = day; s.soldToday = s.soldToday || 0; }
  });
})();

function hashPw(pw, salt) { return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex'); }
function newToken() { return crypto.randomBytes(16).toString('hex'); }
function profileOf(key) {
  const rec = users[key];
  return {
    username: rec.username, name: rec.name, coins: rec.coins,
    inventory: rec.inventory || {}, bd: rec.bd || {},
    codex: rec.codex || {}, catchCount: rec.catchCount || 0,
    admin: !!rec.admin,
  };
}

// ---- 管理后台鉴权：token → 会话 → 账号须带 admin 标志 ----
function anyAdminExists() {
  return Object.keys(users).some(function (k) { return users[k].admin; });
}
function adminOf(token) {
  const key = token && sessions.get(token);
  const rec = key && users[key];
  return (rec && rec.admin) ? { key: key, rec: rec } : null;
}

function broadcast(obj) { const d = 'data: ' + JSON.stringify(obj) + '\n\n'; clients.forEach(function (r) { try { r.write(d); } catch (e) {} }); }
// 定向推送：只发给某个账号名（key）的 SSE 连接
function sendTo(key, obj) {
  const d = 'data: ' + JSON.stringify(obj) + '\n\n';
  clientOwners.forEach(function (ownerKey, res) { if (ownerKey === key) { try { res.write(d); } catch (e) {} } });
}
function sendPlayers() { broadcast({ type: 'players', players: Array.from(players.values()) }); }
function readBody(req, cb) { let b = ''; req.on('data', function (c) { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', function () { cb(b); }); }
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
function apiResp(res, status, obj) { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS)); res.end(JSON.stringify(obj)); }
function auth(req, res, body, cb) {
  let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
  const key = d.token && sessions.get(d.token);
  if (!key) return apiResp(res, 401, { error: '未登录' });
  cb(d, key);
}
function invAdd(rec, id, qty) { rec.inventory = rec.inventory || {}; rec.inventory[id] = (rec.inventory[id] || 0) + qty; if (rec.inventory[id] <= 0) delete rec.inventory[id]; }
function invHas(rec, id, qty) { return (rec.inventory && rec.inventory[id] || 0) >= qty; }

// ---- 商店 / 市集 / 大鱼榜 对外快照 ----
function shopSnapshot() {
  const out = {};
  Object.keys(ITEM_PRICE).forEach(function (id) {
    const s = world.shopSales[id] || {};
    out[id] = { base: basePrice(id), price: currentPrice(id), soldToday: s.soldToday || 0, soldTotal: s.soldTotal || 0 };
  });
  return out;
}
function broadcastShop() { broadcast({ type: 'shop', shop: shopSnapshot() }); }
function broadcastMarket() { broadcast({ type: 'market', listings: world.listings }); }

// 过期挂单清扫：物品退回卖家（上架费不退），广播市集变化
function sweepExpiredListings() {
  const now = Date.now();
  let changed = false;
  const keep = [];
  world.listings.forEach(function (l) {
    if (l.expireAt && l.expireAt <= now) {
      const seller = users[l.seller];
      if (seller) {
        invAdd(seller, l.id, l.qty);
        sendTo(l.seller, { type: 'assets', coins: seller.coins, inventory: seller.inventory });
        sendTo(l.seller, { type: 'notice', msg: '挂单过期：' + l.name + ' ×' + l.qty + ' 已退回背包（上架费不退）' });
      }
      changed = true;
    } else {
      keep.push(l);
    }
  });
  if (changed) {
    world.listings = keep;
    saveUsers();
    saveWorld();
    broadcastMarket();
  }
}
setInterval(function () { sweepExpiredListings(); }, 30 * 1000).unref();
function broadcastRecords() { broadcast({ type: 'records', records: world.bigRecords, small: world.smallRecords }); }

function groundCounts() {
  const map = {};
  players.forEach(function (p) { if (p.status === 'fishing' && p.groundId) map[p.groundId] = (map[p.groundId] || 0) + 1; });
  return map;
}
function broadcastGrounds() { broadcast({ type: 'grounds', counts: groundCounts(), total: players.size }); }
function sendPlayersAll() { sendPlayers(); broadcastGrounds(); }

// ---- 交易转发：只推给交易的两位参与者 ----
const clientOwners = new Map();   // SSE res -> username key
function tradeView(t) {
  return {
    id: t.id, a: t.a, b: t.b,
    aItems: t.aItems, bItems: t.bItems,
    aOk: t.aOk, bOk: t.bOk,
    accepted: !!t.accepted, cooldownUntil: t.cooldownUntil || 0,
    reason: t.reason || null, cancelled: !!t.cancelled, done: !!t.done,
  };
}
function broadcastTrade(t) {
  const view = tradeView(t);
  const msg = 'data: ' + JSON.stringify({ type: 'trade', trade: view }) + '\n\n';
  clientOwners.forEach(function (ownerKey, res) {
    if (ownerKey === t.a.key || ownerKey === t.b.key) { try { res.write(msg); } catch (e) {} }
  });
  // 若已关闭，通知对方更新（双方都会收到 cancelled/done）
}
// 找到某玩家当前的活跃交易
function tradeOfPlayer(key) {
  return Array.from(trades.values()).find(function (t) {
    return (t.a.key === key || t.b.key === key) && !t.done && !t.cancelled;
  }) || null;
}
function myTradeView(key) { const t = tradeOfPlayer(key); return t ? tradeView(t) : null; }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer(function (req, res) {
  // ---- CORS 预检（分离部署时，浏览器对跨域 POST 会先发 OPTIONS） ----
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const u = url.parse(req.url, true);
  const p = u.pathname;

  // ---- 注册 ----
  if (p === '/api/register' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '请求格式错误' }); }
      const username = (d.username || '').trim();
      const password = d.password || '';
      const name = (d.name || '').trim() || username;
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return apiResp(res, 400, { error: '用户名需为 3-20 位字母/数字/下划线' });
      if (password.length < 4) return apiResp(res, 400, { error: '密码至少 4 位' });
      const key = username.toLowerCase();
      if (users[key]) return apiResp(res, 409, { error: '用户名已存在' });
      const salt = crypto.randomBytes(8).toString('hex');
      users[key] = { username: username, salt: salt, pwHash: hashPw(password, salt), name: name, coins: 500, inventory: {}, bd: {}, codex: {}, catchCount: 0, createdAt: Date.now() };
      saveUsers();
      const token = newToken(); sessions.set(token, key);
      apiResp(res, 200, { token: token, profile: profileOf(key) });
    });
    return;
  }

  // ---- 登录 ----
  if (p === '/api/login' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '请求格式错误' }); }
      const key = (d.username || '').trim().toLowerCase();
      const rec = users[key];
      if (!rec || rec.pwHash !== hashPw(d.password || '', rec.salt)) return apiResp(res, 401, { error: '用户名或密码错误' });
      kickUserSessions(key); // 顶号：同账号旧会话全部失效
      const token = newToken(); sessions.set(token, key);
      apiResp(res, 200, { token: token, profile: profileOf(key) });
    });
    return;
  }

  // ---- 取自身资料 ----
  if (p === '/api/me' && req.method === 'GET') {
    const key = u.query.token && sessions.get(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录或会话失效' });
    return apiResp(res, 200, profileOf(key));
  }

  // ---- 保存显示名（资产/背包/配置一律由服务器维护，不再接受客户端上报） ----
  if (p === '/api/profile' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = d.token && sessions.get(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      const rec = users[key];
      if (d.name) rec.name = String(d.name).slice(0, 20);
      saveUsers();
      apiResp(res, 200, { ok: true });
    });
    return;
  }

  // ---- SSE 事件流（需登录） ----
  if (p === '/events' && req.method === 'GET') {
    const key = u.query.token && sessions.get(u.query.token);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 3000\n\n');
    if (!key) {
      res.write('data: ' + JSON.stringify({ type: 'kicked', msg: '登录已失效，请重新登录' }) + '\n\n');
      res.end();
      return;
    }
    clients.add(res);
    clientOwners.set(res, key);
    const id = key;
    const rec = users[key];
    const existing = players.get(id);
    players.set(id, { id: id, name: rec.name, status: 'idle', groundId: null, spotId: null, recent: null, fishing: null });
    res.write('data: ' + JSON.stringify({
      type: 'init', you: id, players: Array.from(players.values()), feed: feed,
      shop: shopSnapshot(), market: world.listings, records: world.bigRecords, small: world.smallRecords,
      grounds: groundCounts(), trade: myTradeView(id),
      codex: rec.codex || {}, catchCount: rec.catchCount || 0,
    }) + '\n\n');
    sendPlayersAll();
    const hb = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', function () {
      clearInterval(hb);
      const wasTracked = clientOwners.get(res) === id;
      clients.delete(res); clientOwners.delete(res);
      if (!wasTracked) return; // 该连接已被顶号流程接管，跳过清理
      stopFishingSession(id); // 断线即停竿：钓鱼循环是服务器权威的，人走竿收
      const stillLive = Array.from(clientOwners.values()).some(function (k) { return k === id; });
      if (!stillLive) {
        if (players.has(id)) { players.delete(id); sendPlayersAll(); }
        // 玩家掉线：其进行中的交易自动取消
        const t = tradeOfPlayer(id);
        if (t) {
          t.cancelled = true; t.closed = true;
          broadcastTrade(t);
          trades.delete(t.id);
        }
      }
    });
    return;
  }

  // ---- 开始钓鱼（服务器权威循环：掷骰/入库/广播都在服务端，前端只收结果） ----
  if (p === '/api/fishing/start' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = d.token && sessions.get(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      const r = startFishingSession(key, d.groundId, d.spotId);
      if (r.error) return apiResp(res, 400, { error: r.error });
      apiResp(res, 200, { ok: true, interval: r.interval });
    });
    return;
  }
  // ---- 停止钓鱼 ----
  if (p === '/api/fishing/stop' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = d.token && sessions.get(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      stopFishingSession(key);
      apiResp(res, 200, { ok: true });
    });
    return;
  }

  // ---- 钓竿配置：装备/卸下组件（服务器校验部位与组件目录，掷骰加成由此生效） ----
  if (p === '/api/bd/set' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const part = D.ROD_PARTS.find(function (x) { return x.key === d.part; });
        if (!part) return apiResp(res, 400, { error: '未知部位' });
        let comp = null;
        if (d.compId) {
          comp = D.componentOf(d.compId);
          if (!comp) return apiResp(res, 400, { error: '未知组件' });
          if (comp.part !== part.key) return apiResp(res, 400, { error: '组件与部位不匹配' });
          // 安装 = 使用组件道具：从背包消耗 1 件（卸下不返还）
          if (!invHas(rec, comp.id, 1)) return apiResp(res, 400, { error: '背包中没有该组件' });
        }
        rec.bd = rec.bd || {};
        rec.bd[part.key] = { compId: comp ? comp.id : null, name: comp ? comp.name : part.default.name, affixes: [], rare: null, isCharm: !!part.isCharm };
        if (comp) invAdd(rec, comp.id, -1);
        saveUsers();
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        // 钓速变化即时生效：正在钓鱼则按新间隔重启循环
        const pl = players.get(key);
        let interval = null;
        if (pl && pl.fishing) {
          const old = fishingTimers.get(key);
          if (old) clearInterval(old);
          const found = spotOf(pl.fishing.groundId, pl.fishing.spotId);
          interval = fishIntervalOf(mergedEffOf(rec.bd, found && found.spot));
          fishingTimers.set(key, setInterval(function () { fishTick(key); }, interval));
        }
        apiResp(res, 200, { ok: true, bd: rec.bd, effects: bdEffectsOf(rec.bd), interval: interval, inventory: rec.inventory });
      });
    });
    return;
  }

  // ---- 开发/测试辅助：仅 FISHING_DEV=1 时存在；正常部署（run.bat）不开启 ----
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/catch' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const itemId = d.item && d.item.id;
        if (!itemId) return apiResp(res, 400, { error: '缺少物品' });
        invAdd(rec, itemId, 1);
        rec.codex = rec.codex || {};
        rec.catchCount = (rec.catchCount || 0) + 1;
        const cx = rec.codex[itemId] || { count: 0, first: Date.now() };
        cx.count += 1;
        const dSize = Number(d.item && d.item.size != null ? d.item.size : d.size);
        if (isFinite(dSize) && dSize > 0) {
          if (cx.max == null || dSize > cx.max) cx.max = dSize;
          if (cx.min == null || dSize < cx.min) cx.min = dSize;
        }
        rec.codex[itemId] = cx;
        let recordEvent = null;
        const rawSize = d.item && d.item.size != null ? d.item.size : d.size;
        const size = Number(rawSize);
        if (FISH_ID_SET[itemId] && isFinite(size) && size > 0) {
          const cur = world.bigRecords[itemId];
          if (!cur || size > cur.size) {
            world.bigRecords[itemId] = { id: itemId, name: itemName(itemId), size: Math.round(size * 10) / 10, who: rec.name, t: Date.now() };
            recordEvent = world.bigRecords[itemId];
          }
          const topD = (world.topCatches[itemId] = world.topCatches[itemId] || []);
          topD.push({ size: Math.round(size * 10) / 10, who: rec.name, t: Date.now() });
          topD.sort(function (a, b) { return b.size - a.size; });
          if (topD.length > 10) topD.length = 10;
          const smD = world.smallRecords[itemId];
          if (!smD || size < smD.size) world.smallRecords[itemId] = { id: itemId, name: itemName(itemId), size: Math.round(size * 10) / 10, who: rec.name, t: Date.now() };
        }
        const entry = { t: Date.now(), who: rec.name, item: d.item, ground: d.ground, spot: d.spot, size: isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null };
        feed.unshift(entry); if (feed.length > 60) feed.pop();
        broadcast({ type: 'feed', entry: entry });
        saveUsers();
        if (recordEvent) { saveWorld(); broadcastRecords(); broadcast({ type: 'feed', entry: { t: Date.now(), who: rec.name, item: entry.item, ground: entry.ground, spot: entry.spot, size: entry.size, record: true } }); }
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, { ok: true, codex: cx, record: recordEvent });
      });
    });
    return;
  }
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/seed' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        if (d.inventory) rec.inventory = d.inventory;
        if (d.coins != null) rec.coins = d.coins;
        saveUsers();
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, { ok: true });
      });
    });
    return;
  }

  // ---- 系统商店：查询价格 / 出售物品 ----
  if (p === '/shop' && req.method === 'GET') {
    return apiResp(res, 200, shopSnapshot());
  }
  // 市集挂单快照（公开只读；前端进入市集页时按需拉取）
  if (p === '/api/market' && req.method === 'GET') {
    sweepExpiredListings();
    return apiResp(res, 200, { listings: world.listings });
  }
  // ---- 商品价格历史与交易量（公开只读；points 为每分钟一次的价格采样） ----
  if (p === '/api/shop/history' && req.method === 'GET') {
    const id = u.query.id;
    if (!ITEM_PRICE[id]) return apiResp(res, 404, { error: '未知物品' });
    const s = world.shopSales[id] || {};
    return apiResp(res, 200, {
      id: id, base: basePrice(id), price: currentPrice(id),
      soldToday: s.soldToday || 0, soldTotal: s.soldTotal || 0,
      points: (world.priceLog && world.priceLog[id]) || [],
      trades: ((world.tradeLog && world.tradeLog[id]) || []).slice(-120),
    });
  }
  if (p === '/api/sell' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const id = d.id; const qty = Math.max(1, Math.floor(Number(d.qty) || 1));
        if (!ITEM_PRICE[id]) return apiResp(res, 400, { error: '该物品无法出售' });
        if (!invHas(rec, id, qty)) return apiResp(res, 400, { error: '数量不足' });
        const unit = currentPrice(id);
        const gain = unit * qty;
        invAdd(rec, id, -qty);
        rec.coins += gain;
        registerSale(id, qty, rec.name, unit);
        saveUsers(); saveWorld();
        broadcastShop();
        apiResp(res, 200, { ok: true, unit: unit, gain: gain, coins: rec.coins, inventory: rec.inventory, shop: shopSnapshot() });
      });
    });
    return;
  }

  // ---- 开放市集：上架 / 购买 / 下架 ----
  if (p === '/api/market/list' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const id = d.id; const qty = Math.max(1, Math.floor(Number(d.qty) || 1));
        const price = Math.max(1, Math.floor(Number(d.price) || 0));
        if (!ITEM_PRICE[id]) return apiResp(res, 400, { error: '该物品不可上架' });
        if (!invHas(rec, id, qty)) return apiResp(res, 400, { error: '数量不足' });
        sweepExpiredListings();
        const myCount = world.listings.filter(function (l) { return l.seller === key; }).length;
        if (myCount >= MAX_LISTINGS_PER_PLAYER) return apiResp(res, 400, { error: '挂单数量已达上限（每人最多同时 ' + MAX_LISTINGS_PER_PLAYER + ' 个）' });
        const hours = [6, 12, 24].indexOf(Number(d.hours)) >= 0 ? Number(d.hours) : 6;
        const feeRate = LIST_FEE_RATES[hours];
        const fee = Math.ceil(price * qty * feeRate); // 上架费：定价总额 × 时长费率，下架不退
        if (rec.coins < fee) return apiResp(res, 400, { error: '金币不足（需上架费 ' + fee + '）' });
        invAdd(rec, id, -qty);
        rec.coins -= fee;
        const ttl = LISTING_TTL_MS_ENV || hours * 3600 * 1000;
        const listing = { lid: world.listingSeq++, seller: key, sellerName: rec.name, id: id, name: itemName(id), qty: qty, price: price, t: Date.now(), expireAt: Date.now() + ttl, hours: hours };
        world.listings.push(listing);
        saveUsers(); saveWorld();
        broadcastMarket();
        apiResp(res, 200, { ok: true, listing: listing, inventory: rec.inventory, fee: fee, coins: rec.coins });
      });
    });
    return;
  }
  if (p === '/api/market/buy' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        sweepExpiredListings();
        const rec = users[key];
        const idx = world.listings.findIndex(function (l) { return l.lid === d.lid; });
        if (idx < 0) return apiResp(res, 404, { error: '该挂单已不存在' });
        const l = world.listings[idx];
        if (l.seller === key) return apiResp(res, 400, { error: '不能购买自己的挂单' });
        // 支持部分购买：qty 缺省 = 整单
        let qty = Math.floor(Number(d.qty));
        if (!isFinite(qty) || qty <= 0) qty = l.qty;
        qty = Math.min(qty, l.qty);
        const total = l.price * qty;
        if (rec.coins < total) return apiResp(res, 400, { error: '金币不足（需 ' + total + '）' });
        const tax = Math.ceil(total * 0.10);          // 10% 交易税（由卖家承担）
        const sellerGain = total - tax;
        rec.coins -= total;
        invAdd(rec, l.id, qty);
        const seller = users[l.seller];
        if (seller) { seller.coins += sellerGain; }
        // 整单买走 → 移除挂单；否则扣减剩余数量
        if (qty >= l.qty) world.listings.splice(idx, 1);
        else l.qty -= qty;
        saveUsers(); saveWorld();
        // 市集成交流水（双方的历史订单查询用）
        world.marketLog = world.marketLog || [];
        world.marketLog.push({ t: Date.now(), buyer: key, buyerName: rec.name, seller: l.seller, sellerName: l.sellerName, id: l.id, name: l.name, qty: qty, price: l.price, total: total, tax: tax });
        if (world.marketLog.length > 300) world.marketLog.splice(0, world.marketLog.length - 300);
        broadcastMarket();
        // 卖家可能不在当前页面，必须主动推送权威资产，否则收不到钱
        if (seller) {
          sendTo(l.seller, { type: 'assets', coins: seller.coins, inventory: seller.inventory });
          sendTo(l.seller, { type: 'notice', msg: '市集售出：' + l.name + ' ×' + qty + '，入账 💰' + sellerGain + '（已扣 10% 税 ' + tax + '）' });
        }
        apiResp(res, 200, { ok: true, qty: qty, total: total, tax: tax, coins: rec.coins, inventory: rec.inventory });
      });
    });
    return;
  }
  // ---- 我的历史订单（市集成交记录：买入 + 卖出） ----
  if (p === '/api/market/history' && req.method === 'GET') {
    const key = u.query.token && sessions.get(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const mine = (world.marketLog || []).filter(function (m) { return m.buyer === key || m.seller === key; })
      .sort(function (a, b) { return b.t - a.t; });
    return apiResp(res, 200, { trades: mine.slice(0, 60) });
  }
  if (p === '/api/market/cancel' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const idx = world.listings.findIndex(function (l) { return l.lid === d.lid; });
        if (idx < 0) return apiResp(res, 404, { error: '该挂单已不存在' });
        const l = world.listings[idx];
        if (l.seller !== key) return apiResp(res, 403, { error: '只能下架自己的挂单' });
        const rec = users[key];
        invAdd(rec, l.id, l.qty);
        world.listings.splice(idx, 1);
        saveUsers(); saveWorld();
        broadcastMarket();
        apiResp(res, 200, { ok: true, inventory: rec.inventory });
      });
    });
    return;
  }

  // ---- 在线交易（以物易物，0% 税） ----
  if (p === '/api/trade/invite' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const target = String(d.target || '').toLowerCase();
        if (!users[target]) return apiResp(res, 404, { error: '对方不存在' });
        if (target === key) return apiResp(res, 400, { error: '不能与自己交易' });
        if (!players.has(target)) return apiResp(res, 400, { error: '对方不在线' });
        // 同一对玩家只保留一个活跃会话
        const exists = Array.from(trades.values()).find(function (t) {
          return (t.a.key === key && t.b.key === target) || (t.a.key === target && t.b.key === key);
        });
        if (exists) return apiResp(res, 409, { error: '已有进行中的交易' });
        const t = {
          id: 'T' + (tradeSeq++),
          a: { key: key, name: users[key].name },
          b: { key: target, name: users[target].name },
          aItems: [], bItems: [], aOk: false, bOk: false,
          cooldownUntil: 0, cancelled: false, done: false, createdAt: Date.now(),
        };
        trades.set(t.id, t);
        broadcastTrade(t);
        apiResp(res, 200, { ok: true, tradeId: t.id });
      });
    });
    return;
  }
  if (p === '/api/trade/respond' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const t = trades.get(d.tradeId);
        if (!t) return apiResp(res, 404, { error: '交易不存在' });
        if (t.a.key !== key && t.b.key !== key) return apiResp(res, 403, { error: '无权操作' });
        if (d.accept === false) {
          t.cancelled = true; t.closed = true;
          broadcastTrade(t);
          trades.delete(t.id);
          apiResp(res, 200, { ok: true, closed: true });
          return;
        }
        // 接受邀请 → 进入交易界面
        t.accepted = true;
        broadcastTrade(t);
        apiResp(res, 200, { ok: true });
      });
    });
    return;
  }
  // 修改自己提供的物品：任何一方改动 → 双方确认自动取消，并进入 3s 冷却
  if (p === '/api/trade/set' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const t = trades.get(d.tradeId);
        if (!t || t.done || t.cancelled) return apiResp(res, 404, { error: '交易不存在' });
        const side = t.a.key === key ? 'a' : (t.b.key === key ? 'b' : null);
        if (!side) return apiResp(res, 403, { error: '无权操作' });
        if (!t.accepted) return apiResp(res, 400, { error: '对方尚未接受邀请' });
        const items = Array.isArray(d.items) ? d.items : [];
        // 校验物品与数量
        const rec = users[key];
        const norm = [];
        for (const it of items) {
          const id = it.id; const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
          if (!id || !ITEM_PRICE[id] || qty <= 0) continue;
          if (!invHas(rec, id, qty)) return apiResp(res, 400, { error: '你没有足够的 ' + itemName(id) });
          norm.push({ id: id, qty: qty });
        }
        if (side === 'a') t.aItems = norm; else t.bItems = norm;
        // 任一方改动 → 双方确认作废 + 冷却
        if (t.aOk || t.bOk) { t.aOk = false; t.bOk = false; t.cooldownUntil = Date.now() + TRADE_COOLDOWN; t.reason = '物品已变更，确认已重置'; }
        broadcastTrade(t);
        apiResp(res, 200, { ok: true, cooldownUntil: t.cooldownUntil });
      });
    });
    return;
  }
  // 确认交易
  if (p === '/api/trade/confirm' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const t = trades.get(d.tradeId);
        if (!t || t.done || t.cancelled) return apiResp(res, 404, { error: '交易不存在' });
        const side = t.a.key === key ? 'a' : (t.b.key === key ? 'b' : null);
        if (!side) return apiResp(res, 403, { error: '无权操作' });
        if (!t.accepted) return apiResp(res, 400, { error: '对方尚未接受邀请' });
        if (t.cooldownUntil > Date.now()) return apiResp(res, 429, { error: '冷却中，请稍候', cooldownUntil: t.cooldownUntil });
        if (side === 'a') t.aOk = true; else t.bOk = true;
        // 双方都确认 → 执行交换
        if (t.aOk && t.bOk) {
          const ra = users[t.a.key], rb = users[t.b.key];
          // 二次校验，防并发
          const okA = t.aItems.every(function (it) { return invHas(ra, it.id, it.qty); });
          const okB = t.bItems.every(function (it) { return invHas(rb, it.id, it.qty); });
          if (!okA || !okB) {
            t.aOk = false; t.bOk = false; t.cooldownUntil = Date.now() + TRADE_COOLDOWN; t.reason = '物品不足，确认已重置';
            broadcastTrade(t);
            return apiResp(res, 400, { error: '物品不足，交易已重置' });
          }
          t.aItems.forEach(function (it) { invAdd(ra, it.id, -it.qty); invAdd(rb, it.id, it.qty); });
          t.bItems.forEach(function (it) { invAdd(rb, it.id, -it.qty); invAdd(ra, it.id, it.qty); });
          t.done = true;
          saveUsers();
          broadcastTrade(t);
          trades.delete(t.id);
          // 通知双方最新库存
          broadcast({ type: 'tradeDone', tradeId: t.id, a: { key: t.a.key, inventory: ra.inventory, coins: ra.coins }, b: { key: t.b.key, inventory: rb.inventory, coins: rb.coins } });
          return apiResp(res, 200, { ok: true, done: true });
        }
        broadcastTrade(t);
        apiResp(res, 200, { ok: true });
      });
    });
    return;
  }
  if (p === '/api/trade/cancel' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const t = trades.get(d.tradeId);
        if (!t) return apiResp(res, 404, { error: '交易不存在' });
        if (t.a.key !== key && t.b.key !== key) return apiResp(res, 403, { error: '无权操作' });
        t.cancelled = true; t.closed = true;
        broadcastTrade(t);
        trades.delete(t.id);
        apiResp(res, 200, { ok: true });
      });
    });
    return;
  }

  // ---- 图鉴 / 大鱼榜 ----
  if (p === '/api/codex' && req.method === 'GET') {
    const key = u.query.token && sessions.get(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const rec = users[key];
    return apiResp(res, 200, { codex: rec.codex || {}, catchCount: rec.catchCount || 0 });
  }
  if (p === '/api/records' && req.method === 'GET') {
    return apiResp(res, 200, { records: world.bigRecords, small: world.smallRecords });
  }
  // 某种鱼的全服前十大捕获记录（公开只读）
  if (p === '/api/records/top' && req.method === 'GET') {
    const fid = u.query.id;
    if (!FISH_ID_SET[fid]) return apiResp(res, 404, { error: '未知鱼类' });
    return apiResp(res, 200, { id: fid, name: itemName(fid), top: (world.topCatches && world.topCatches[fid]) || [] });
  }

  // ================================================================
  // ---- 管理后台 API（/api/admin/*）：账号须带 admin 标志 ----
  // 引导：服务器上没有任何管理员时，第一个通过后台登录的账号自动成为管理员。
  // ================================================================

  // ---- 管理后台登录（复用游戏账号密码；不顶号：不影响同一账号的游戏会话） ----
  if (p === '/api/admin/login' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = (d.username || '').trim().toLowerCase();
      const rec = users[key];
      if (!rec || rec.pwHash !== hashPw(d.password || '', rec.salt)) return apiResp(res, 401, { error: '用户名或密码错误' });
      if (!rec.admin) {
        if (anyAdminExists()) return apiResp(res, 403, { error: '该账号没有管理员权限' });
        rec.admin = true;
        saveUsers();
        console.log('🛡 管理员引导：服务器尚无管理员，账号 "' + rec.name + '" 已自动成为管理员');
      }
      const token = newToken(); sessions.set(token, key);
      apiResp(res, 200, { ok: true, token: token, username: rec.username, name: rec.name, admin: true });
    });
    return;
  }
  // ---- 会话校验（页面刷新后恢复登录态） ----
  if (p === '/api/admin/session' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    return apiResp(res, 200, { ok: true, username: a.rec.username, name: a.rec.name });
  }
  // ---- 概览统计 ----
  if (p === '/api/admin/overview' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    let fishingCount = 0;
    players.forEach(function (pl) { if (pl.status === 'fishing') fishingCount++; });
    return apiResp(res, 200, {
      ok: true,
      userCount: Object.keys(users).length,
      online: players.size,
      fishingCount: fishingCount,
      listings: world.listings.length,
      activeTrades: Array.from(trades.values()).filter(function (t) { return !t.done && !t.cancelled; }).length,
      notifyLevel: world.notifyLevel || 'all',
      biteFormula: world.biteFormula || BITE_FORMULA_DEFAULT,
      groundCount: D.GROUNDS.length,
      spotCount: D.GROUNDS.reduce(function (n, g) { return n + g.spots.length; }, 0),
    });
  }
  // ---- 账号列表（管理员授权数据源） ----
  if (p === '/api/admin/users' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const list = Object.keys(users).map(function (k) {
      const r = users[k];
      const pl = players.get(k);
      return {
        key: k, username: r.username, name: r.name,
        admin: !!r.admin, coins: r.coins || 0,
        catchCount: r.catchCount || 0,
        online: !!pl,
        fishing: (pl && pl.fishing) || null,
        createdAt: r.createdAt || null,
      };
    }).sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); });
    return apiResp(res, 200, { ok: true, users: list, me: a.key });
  }
  // ---- 设置/撤销账号的管理员权限（不能撤销自己，避免把自己锁在后台外） ----
  if (p === '/api/admin/users/setadmin' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '账号不存在' });
      const want = !!d.admin;
      if (target === a.key && !want) return apiResp(res, 400, { error: '不能撤销自己的管理员权限' });
      rec.admin = want;
      saveUsers();
      sendTo(target, { type: 'notice', msg: want ? '🛡 你已获得管理员权限，可打开管理后台（/admin.html）' : '你的管理员权限已被收回' });
      apiResp(res, 200, { ok: true, target: target, admin: want });
    });
    return;
  }
  // ---- 世界配置：钓场/钓点目录 + 当前设置（后台编辑器数据源） ----
  if (p === '/api/admin/world' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const fish = [];
    ['common', 'big', 'rare'].forEach(function (tier) {
      D.FISH[tier].forEach(function (f) { fish.push({ id: f.id, name: f.name, rarity: f.rarity, tier: tier, price: f.price, size: f.size || null }); });
    });
    return apiResp(res, 200, {
      ok: true,
      grounds: D.GROUNDS,
      catalog: { fish: fish, materials: D.MATERIALS },
      affixTypes: D.AFFIX_LABEL,
      notifyLevel: world.notifyLevel || 'all',
      notifyLevels: NOTIFY_LEVELS,
      biteFormula: world.biteFormula || BITE_FORMULA_DEFAULT,
    });
  }
  // ---- 钓点掉落池（种类 + 权重；保存后全服即时生效并广播游戏端） ----
  if (p === '/api/admin/spot/pool' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const found = spotOf(d.groundId, d.spotId);
      if (!found) return apiResp(res, 404, { error: '钓点不存在' });
      const v = validatePoolEntries(d.pool);
      if (v.error) return apiResp(res, 400, { error: v.error });
      found.spot.pool = v.pool;
      saveSpotCfg(d.groundId, d.spotId, { pool: v.pool });
      broadcastGroundcfg();
      apiResp(res, 200, { ok: true, pool: v.pool });
    });
    return;
  }
  // ---- 钓点增益（数值 + 类别；钓速增益即时重启受影响玩家的钓鱼循环） ----
  if (p === '/api/admin/spot/buffs' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const found = spotOf(d.groundId, d.spotId);
      if (!found) return apiResp(res, 404, { error: '钓点不存在' });
      const v = validateBuffList(d.buffs);
      if (v.error) return apiResp(res, 400, { error: v.error });
      found.spot.buffs = v.buffs;
      saveSpotCfg(d.groundId, d.spotId, { buffs: v.buffs });
      restartFishingAt(d.groundId, d.spotId);
      broadcastGroundcfg();
      apiResp(res, 200, { ok: true, buffs: v.buffs });
    });
    return;
  }
  // ---- 钓场开放/锁定（锁定时立即停掉该场所有钓鱼循环） ----
  if (p === '/api/admin/ground/lock' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const g = D.GROUNDS.find(function (x) { return x.id === d.groundId; });
      if (!g) return apiResp(res, 404, { error: '钓场不存在' });
      g.locked = !!d.locked;
      world.groundCfg = world.groundCfg || {};
      world.groundCfg.grounds = world.groundCfg.grounds || {};
      world.groundCfg.grounds[g.id] = Object.assign({}, world.groundCfg.grounds[g.id] || {}, { locked: !!d.locked });
      saveWorld();
      broadcastGroundcfg();
      if (g.locked) {
        players.forEach(function (pl, key) {
          if (pl.fishing && pl.fishing.groundId === g.id) {
            stopFishingSession(key);
            sendTo(key, { type: 'notice', msg: '钓场「' + g.name + '」已被管理员关闭，钓鱼已停止' });
          }
        });
      }
      apiResp(res, 200, { ok: true, groundId: g.id, locked: g.locked });
    });
    return;
  }
  // ---- 市集：退回挂单（物品退回卖家，上架费不退——与过期规则一致） ----
  if (p === '/api/admin/market/return' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      sweepExpiredListings();
      const idx = world.listings.findIndex(function (l) { return l.lid === d.lid; });
      if (idx < 0) return apiResp(res, 404, { error: '该挂单已不存在' });
      const l = world.listings[idx];
      world.listings.splice(idx, 1);
      const seller = users[l.seller];
      if (seller) {
        invAdd(seller, l.id, l.qty);
        saveUsers();
        sendTo(l.seller, { type: 'assets', coins: seller.coins, inventory: seller.inventory });
        sendTo(l.seller, { type: 'notice', msg: '管理员退回了你的挂单：' + l.name + ' ×' + l.qty + '（上架费不退）' });
      }
      saveWorld();
      broadcastMarket();
      apiResp(res, 200, { ok: true, returned: { lid: l.lid, id: l.id, name: l.name, qty: l.qty, seller: l.seller } });
    });
    return;
  }
  // ---- 设置：通知等级 / 上钩公式（validateOnly=true 只校验不保存；evalVars 附带试算） ----
  if (p === '/api/admin/settings' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const out = { ok: true };
      let formulaSrc = null;
      if (d.biteFormula != null) {
        formulaSrc = String(d.biteFormula).trim();
        const c = compileFormula(formulaSrc);
        if (c.error) return apiResp(res, 400, { error: '公式无效：' + c.error });
        if (!d.validateOnly) {
          world.biteFormula = formulaSrc;
          biteCompiledSrc = null; // 强制下次掷骰重新编译
        }
        out.biteFormula = formulaSrc;
      }
      if (d.notifyLevel != null) {
        if (!NOTIFY_LEVELS[d.notifyLevel]) return apiResp(res, 400, { error: '未知的通知等级' });
        if (!d.validateOnly) world.notifyLevel = d.notifyLevel;
        out.notifyLevel = d.notifyLevel;
      }
      if (!d.validateOnly) saveWorld();
      if (d.evalVars && formulaSrc != null) {
        const c2 = compileFormula(formulaSrc);
        if (c2.ok) {
          const vars = { speed: 0, big: 0, rare: 0, material: 0, size: 0, double: 0, interval: 3000 };
          Object.keys(d.evalVars).forEach(function (k) { if (k in vars) vars[k] = Number(d.evalVars[k]) || 0; });
          let prob = c2.fn(vars);
          if (!isFinite(prob)) prob = prob > 0 ? 100 : 0;
          out.prob = Math.min(100, Math.max(0, Math.round(prob * 10) / 10));
        }
      }
      apiResp(res, 200, out);
    });
    return;
  }

  // ---- 静态文件（集成模式托管 frontend；纯 API 模式返回 404） ----
  if (!STATIC_DIR) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('API only'); return; }
  if (p.startsWith('/data/')) { res.writeHead(403); res.end('Forbidden'); return; }
  const rel = p === '/' ? '/index.html' : p;
  const fp = path.normalize(path.join(STATIC_DIR, rel));
  if (!fp.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    // no-cache：每次重载都向服务器校验，避免版本更新后浏览器仍用旧 HTML 配新 JS
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log('🎣 钓鱼 API 服务器已启动: http://localhost:' + PORT);
  if (STATIC_DIR) console.log('   集成模式：前端已托管 → http://localhost:' + PORT + '/  （' + STATIC_DIR + '）');
  else console.log('   纯 API 模式：未托管静态前端（前后端分离部署）');
  console.log('   注册/登录后可开始；多开浏览器标签 = 多真实玩家。');
});
