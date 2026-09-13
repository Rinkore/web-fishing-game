/*
 * 网页钓鱼小游戏 - 多人服务器（零第三方依赖 · 全部处理逻辑在服务端）
 * 架构：前端仅展示；钓鱼循环/掷骰/词缀加成/资产结算/钓竿配置全部由本服务器权威执行。
 *   - 账号系统：注册 / 登录 / 会话（token）；密码 salt+sha256，落盘 backend/data/users.json
 *   - 钓鱼循环：POST /api/fishing/start|stop；服务器定时器掷骰，经 SSE 定向推送渔获与权威资产
 *   - 钓竿配置：POST /api/bd/set（校验组件目录），钓速变化即时重置钓鱼循环
 *   - 实时联机：GET /events (SSE) 广播在线玩家、渔场人数、动态、市集、交易
 *   - 系统商店 / 开放市集 / 在线交易 / 图鉴 / 大鱼榜
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
const DATA_DIR = path.join(ROOT, 'data');
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

// ---- 全局世界状态（商店价格 / 市集挂单 / 大鱼榜 / 价格历史） ----
let world = { shopSales: {}, listings: [], listingSeq: 1, bigRecords: {}, priceLog: {}, tradeLog: {}, marketLog: [] };

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
function fishIntervalOf(bd) {
  const eff = bdEffectsOf(bd);
  return Math.max(800, Math.round(FISH_INTERVAL_BASE * (1 - Math.min(60, eff.speed) / 100)));
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
// 体型随机：偏向小值；体型加成放大结果但不越过上限的 1.3 倍
function rollSizeOf(range, eff) {
  let v = range[0] + (range[1] - range[0]) * Math.pow(Math.random(), 1.6);
  if (eff.size > 0) v = Math.min(range[1] * 1.3, v * (1 + eff.size / 100));
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
  rec.codex[item.id] = cx;

  let recordEvent = null;
  if (FISH_ID_SET[item.id] && item.size != null && item.size > 0) {
    const cur = world.bigRecords[item.id];
    if (!cur || item.size > cur.size) {
      world.bigRecords[item.id] = { id: item.id, name: itemName(item.id), size: Math.round(item.size * 10) / 10, who: rec.name, t: Date.now() };
      recordEvent = world.bigRecords[item.id];
    }
  }

  const entry = { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null };
  feed.unshift(entry); if (feed.length > 60) feed.pop();
  broadcast({ type: 'feed', entry: entry });

  // 近期渔获（大鱼/稀有/组件）：更新 presence 并广播给所有人
  const p = players.get(key);
  if (p && (item.rarity === 'big' || item.rarity === 'rare' || item.kind === 'component')) {
    p.recent = item.size ? (item.name + ' ' + item.size + 'cm') : item.name;
    sendPlayersAll();
  }
  saveUsers();
  if (recordEvent) {
    saveWorld();
    broadcastRecords();
    broadcast({ type: 'feed', entry: { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null, record: true } });
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
  doServerCatch(rec, key, found.ground, found.spot, bdEffectsOf(rec.bd), false);
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
  const interval = fishIntervalOf(users[key].bd);
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

function basePrice(id) { return ITEM_PRICE[id] || 10; }
function itemName(id) { return ITEM_NAME[id] || id; }

// ---- 动态收购价（服务器权威 · 单乘数模型）----
// 每个物品维护一个价格乘数 m ∈ [0.4, 2.0]，实际价 = 基准价 × m：
//   售出：m 每件除以 1.15（成比例下压——2 倍价卖一件回到 1.74 倍，不会一键跌回原价）；
//   闲置：m 以 1 小时时间常数向 2.0 指数回升（长期无人供应缓慢涨价，最高翻倍）。
// 涨跌共用同一个乘数，状态连续、无跳变。
const PRICE_FLOOR = 0.4;
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
  };
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
function broadcastRecords() { broadcast({ type: 'records', records: world.bigRecords }); }

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
    if (!key) { res.write('data: ' + JSON.stringify({ type: 'init', you: null, players: [], feed: [] }) + '\n\n'); req.on('close', function () {}); return; }
    clients.add(res);
    clientOwners.set(res, key);
    const id = key;
    const rec = users[key];
    const existing = players.get(id);
    players.set(id, { id: id, name: rec.name, status: 'idle', groundId: null, spotId: null, recent: null, fishing: null });
    res.write('data: ' + JSON.stringify({
      type: 'init', you: id, players: Array.from(players.values()), feed: feed,
      shop: shopSnapshot(), market: world.listings, records: world.bigRecords,
      grounds: groundCounts(), trade: myTradeView(id),
      codex: rec.codex || {}, catchCount: rec.catchCount || 0,
    }) + '\n\n');
    sendPlayersAll();
    const hb = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', function () {
      clients.delete(res); clientOwners.delete(res); clearInterval(hb);
      stopFishingSession(id); // 断线即停竿：钓鱼循环是服务器权威的，人走竿收
      if (players.has(id)) { players.delete(id); sendPlayersAll(); }
      // 玩家掉线：其进行中的交易自动取消
      const t = tradeOfPlayer(id);
      if (t) {
        t.cancelled = true; t.closed = true;
        broadcastTrade(t);
        trades.delete(t.id);
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
          interval = fishIntervalOf(rec.bd);
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
        const fee = Math.ceil(price * qty * 0.01); // 上架费：定价总额的 1%，下架不退
        if (rec.coins < fee) return apiResp(res, 400, { error: '金币不足（需上架费 ' + fee + '）' });
        invAdd(rec, id, -qty);
        rec.coins -= fee;
        const listing = { lid: world.listingSeq++, seller: key, sellerName: rec.name, id: id, name: itemName(id), qty: qty, price: price, t: Date.now() };
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
    return apiResp(res, 200, { records: world.bigRecords });
  }

  // ---- 静态文件（集成模式托管 frontend；纯 API 模式返回 404） ----
  if (!STATIC_DIR) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('API only'); return; }
  if (p.startsWith('/data/')) { res.writeHead(403); res.end('Forbidden'); return; }
  const rel = p === '/' ? '/index.html' : p;
  const fp = path.normalize(path.join(STATIC_DIR, rel));
  if (!fp.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log('🎣 钓鱼 API 服务器已启动: http://localhost:' + PORT);
  if (STATIC_DIR) console.log('   集成模式：前端已托管 → http://localhost:' + PORT + '/  （' + STATIC_DIR + '）');
  else console.log('   纯 API 模式：未托管静态前端（前后端分离部署）');
  console.log('   注册/登录后可开始；多开浏览器标签 = 多真实玩家。');
});
