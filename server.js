/*
 * 网页钓鱼小游戏 - 多人服务器（零第三方依赖）
 * 功能：
 *   - 账号系统：注册 / 登录 / 会话（token）；密码用 salt+sha256 哈希，落盘 data/users.json
 *   - 资料持久化：coins / inventory / bd / name / codex / records 随账号保存
 *   - 实时联机：GET /events (SSE) 广播在线玩家、各渔场人数、全服动态、市集、交易
 *   - 系统商店：按累计售出量动态调价，随时间缓慢回升
 *   - 开放市集：玩家挂单买卖，10% 交易税
 *   - 在线交易：以物易物，双方确认，任一方改动即取消确认（3s 冷却）
 *   - 鱼类图鉴 / 大鱼记录
 * 运行： node server.js   （默认端口 8080，可用 PORT 环境变量覆盖）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORLD_FILE = path.join(DATA_DIR, 'world.json');

const players = new Map();   // id(=username) -> presence
const feed = [];             // { t, who, item, ground, spot }
const clients = new Set();   // SSE response 对象
const sessions = new Map();  // token -> username(lowercased)
let users = {};

// ---- 全局世界状态（商店价格 / 市集挂单 / 大鱼榜） ----
let world = { shopSales: {}, listings: [], listingSeq: 1, bigRecords: {} };

// ---- 在线交易会话 ----
// trade = { id, a:{key,name}, b:{key,name}, aItems:[{id,qty}], bItems:[], aOk, bOk, cooldownUntil, cancelled, createdAt }
const trades = new Map();
let tradeSeq = 1;
const TRADE_COOLDOWN = 3000;

// ---- 静态物品表（用于定价与校验，避免玩家伪造价格） ----
const ITEM_PRICE = {
  crucian: 8, carp: 12, grass: 15, white: 6, tilapia: 10,
  catfish: 120, bass: 150, tuna: 260, sturgeon: 320,
  koi: 400, pearl: 300, relic: 380,
  bait_pack: 5, rope: 4, lure: 7,
  comp_generic: 40,
};
const ITEM_NAME = {
  crucian: '鲫鱼', carp: '鲤鱼', grass: '草鱼', white: '白条', tilapia: '罗非鱼',
  catfish: '巨型鲶鱼', bass: '湖王鲈鱼', tuna: '黄金枪鱼', sturgeon: '远古巨鲟',
  koi: '黄金锦鲤', pearl: '深海珍珠贝', relic: '沉船宝匣残片',
  bait_pack: '诱饵包', rope: '耐磨绳', lure: '反光假饵',
  comp_generic: '钓竿组件（默认）',
};
// 大鱼榜只统计鱼类（含普通/大鱼/稀有）
const FISH_ID_SET = {
  crucian: 1, carp: 1, grass: 1, white: 1, tilapia: 1,
  catfish: 1, bass: 1, tuna: 1, sturgeon: 1, koi: 1, pearl: 1, relic: 1,
};

function basePrice(id) { return ITEM_PRICE[id] || 10; }
function itemName(id) { return ITEM_NAME[id] || id; }

// 动态收购价：售出量越多越低（下限 40%），并随时间缓慢回升
const PRICE_MIN_RATIO = 0.4;    // 最低价 = 基准价 * 0.4
const PRICE_RECOVER_PER_SEC = 0.002; // 每秒回升枯竭量的 0.2%

function currentPrice(id) {
  const base = basePrice(id);
  const s = world.shopSales[id];
  if (!s || !s.count) return base;
  // 先把“冷却时间”折算成衰减
  const elapsed = (Date.now() - (s.lastTs || Date.now())) / 1000;
  const decayed = Math.max(0, (s.debt || 0) - elapsed * PRICE_RECOVER_PER_SEC * base);
  const ratio = Math.max(PRICE_MIN_RATIO, 1 - decayed * 0.06);
  return Math.max(1, Math.round(base * ratio));
}
// 售出时累积“价格债务”，使价格下滑
function registerSale(id, qty) {
  const s = world.shopSales[id] || { count: 0, debt: 0, lastTs: Date.now() };
  const elapsed = (Date.now() - (s.lastTs || Date.now())) / 1000;
  s.debt = Math.max(0, (s.debt || 0) - elapsed * PRICE_RECOVER_PER_SEC * basePrice(id));
  s.count += qty;
  s.debt += qty;
  s.lastTs = Date.now();
  world.shopSales[id] = s;
}

function loadUsers() { try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '{}'); } catch (e) { users = {}; } }
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {} }
function loadWorld() { try { world = Object.assign(world, JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8') || '{}')); } catch (e) {} }
function saveWorld() { try { fs.writeFileSync(WORLD_FILE, JSON.stringify(world, null, 2)); } catch (e) {} }
loadUsers();
loadWorld();

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
function apiResp(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
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
  Object.keys(ITEM_PRICE).forEach(function (id) { out[id] = { base: basePrice(id), price: currentPrice(id) }; });
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

  // ---- 保存资料 ----
  if (p === '/api/profile' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = d.token && sessions.get(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      const rec = users[key];
      if (d.coins != null) rec.coins = d.coins;
      if (d.inventory) rec.inventory = d.inventory;
      if (d.bd) rec.bd = d.bd;
      if (d.name) rec.name = d.name;
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
    players.set(id, { id: id, name: rec.name, status: 'idle', groundId: existing ? existing.groundId : null, spotId: existing ? existing.spotId : null, recent: existing ? existing.recent : null });
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

  // ---- 上报状态（需登录） ----
  if (p === '/presence' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = d.token && sessions.get(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      const id = key; const rec = users[key];
      const ex = players.get(id) || { id: id, name: rec.name };
      ex.name = rec.name;
      ex.status = d.status || 'idle';
      ex.groundId = d.groundId !== undefined ? d.groundId : ex.groundId;
      ex.spotId = d.spotId !== undefined ? d.spotId : ex.spotId;
      // recent 三态：
      //   recentClear=true → 显式清空（离开钓点）
      //   recent=<名字>    → 更新记录
      //   都不传           → 保持原值（避免普通状态上报抹掉大鱼记录）
      if (d.recentClear) ex.recent = null;
      else if (d.recent !== undefined) ex.recent = d.recent || null;
      players.set(id, ex);
      sendPlayersAll();
      apiResp(res, 200, { ok: true });
    });
    return;
  }

  // ---- 上报渔获（需登录，服务器解析账号名广播） ----
  // 服务器权威：在此直接入库（图鉴 + 背包），并回推 assets/codex 给本人
  if (p === '/catch' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = d.token && sessions.get(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      const rec = users[key];
      const who = rec.name;
      const itemId = d.item && d.item.id;
      if (!itemId) return apiResp(res, 400, { error: '缺少物品' });

      // 背包：服务器侧直接入库，客户端无需再自行同步库存
      invAdd(rec, itemId, 1);

      // 图鉴：记录个人钓到的每种鱼的数量与首次时间
      rec.codex = rec.codex || {};
      rec.catchCount = (rec.catchCount || 0) + 1;
      const cx = rec.codex[itemId] || { count: 0, first: Date.now() };
      cx.count += 1;
      rec.codex[itemId] = cx;

      // 大鱼榜：仅鱼类，按体型记录全服最大
      let recordEvent = null;
      const rawSize = d.item && d.item.size != null ? d.item.size : d.size;
      const size = Number(rawSize);
      if (FISH_ID_SET[itemId] && isFinite(size) && size > 0) {
        const cur = world.bigRecords[itemId];
        if (!cur || size > cur.size) {
          world.bigRecords[itemId] = { id: itemId, name: itemName(itemId), size: Math.round(size * 10) / 10, who: who, t: Date.now() };
          recordEvent = world.bigRecords[itemId];
        }
      }

      const entry = { t: Date.now(), who: who, item: d.item, ground: d.ground, spot: d.spot, size: isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null };
      if (entry.item) { feed.unshift(entry); if (feed.length > 60) feed.pop(); broadcast({ type: 'feed', entry: entry }); }
      saveUsers();
      if (recordEvent) { saveWorld(); broadcastRecords(); broadcast({ type: 'feed', entry: { t: Date.now(), who: who, item: entry.item, ground: entry.ground, spot: entry.spot, size: entry.size, record: true } }); }

      // 回推权威资产与图鉴（带 seq，用于客户端账本对账）
      sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, seq: Number(d.seq) || 0 });
      sendTo(key, { type: 'codex', codex: rec.codex, catchCount: rec.catchCount });

      apiResp(res, 200, { ok: true, codex: cx, record: recordEvent });
    });
    return;
  }

  // ---- 系统商店：查询价格 / 出售物品 ----
  if (p === '/shop' && req.method === 'GET') {
    return apiResp(res, 200, shopSnapshot());
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
        registerSale(id, qty);
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
        invAdd(rec, id, -qty);
        const listing = { lid: world.listingSeq++, seller: key, sellerName: rec.name, id: id, name: itemName(id), qty: qty, price: price, t: Date.now() };
        world.listings.push(listing);
        saveUsers(); saveWorld();
        broadcastMarket();
        apiResp(res, 200, { ok: true, listing: listing, inventory: rec.inventory });
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

  // ---- 静态文件（禁止访问 data/） ----
  if (p.startsWith('/data/')) { res.writeHead(403); res.end('Forbidden'); return; }
  const rel = p === '/' ? '/index.html' : p;
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log('🎣 钓鱼多人服务器已启动: http://localhost:' + PORT);
  console.log('   注册/登录后可开始；多开浏览器标签 = 多真实玩家。');
});
