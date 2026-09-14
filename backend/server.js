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
const os = require('os');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 9000;
const ROOT = __dirname;
// ---- 数据目录 ----
// 默认存到用户「文档」目录（Windows: %USERPROFILE%\Documents\web-fishing-game），
// 与程序文件分离，升级/覆盖安装不会丢存档；FISHING_DATA_DIR 可覆盖（测试用临时目录）。
function defaultDataDir() {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  const base = fs.existsSync(docs) ? docs : home; // 少数系统无 Documents（或尚未创建）时退回用户目录
  return path.join(base, 'web-fishing-game');
}
const DATA_DIR = process.env.FISHING_DATA_DIR ? path.resolve(process.env.FISHING_DATA_DIR) : defaultDataDir();
const LEGACY_DATA_DIR = path.join(ROOT, 'data'); // 旧版数据目录（项目内 backend/data）
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
// ---- 数据落盘拆分（v0.8）----
// 按域 + 按账号分文件：每次上鱼只重写该账号一个文件，市集/记录/经济/配置各自独立，
// 互不干扰、单文件损坏影响面最小。旧版 users.json / world.json 在启动时自动迁移。
//   accounts/<账号>.json  身份 + 金币 + 背包 + 钓竿配置 + 图鉴（每账号独立文件）
//   market.json           市集挂单与序号
//   records.json          大鱼榜 / 小鱼纪录 / 前十大
//   economy.json          商店供需乘数 / 价格历史 / 交易流水 / 市集成交
//   config.json           钓场钓点覆盖配置 / 通知等级 / 上钩公式
//   feedback.json         反馈意见列表 + 每人下次可提交时间
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
try { fs.mkdirSync(ACCOUNTS_DIR, { recursive: true }); } catch (e) {}
const MARKET_FILE = path.join(DATA_DIR, 'market.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const ECONOMY_FILE = path.join(DATA_DIR, 'economy.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
// 旧版单文件（仅用于首次自动迁移）
const LEGACY_USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEGACY_WORLD_FILE = path.join(DATA_DIR, 'world.json');

// 首次运行且默认数据目录为空时，把项目内旧数据目录整体拷贝到文档目录（保留旧目录作备份）
// 判断目录是否"已有真实数据"：必须存在实际文件（accounts 目录本身可能只是启动时新建的空壳）
function dirHasData(d) {
  try {
    const acc = path.join(d, 'accounts');
    if (fs.existsSync(acc) && fs.readdirSync(acc).some(function (f) { return f.endsWith('.json'); })) return true;
    return ['users.json', 'world.json', 'market.json', 'records.json', 'economy.json', 'config.json', 'feedback.json']
      .some(function (f) { return fs.existsSync(path.join(d, f)); });
  } catch (e) { return false; }
}
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (ent) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else { try { fs.copyFileSync(s, d); } catch (e) {} }
  });
}
(function relocateLegacyData() {
  if (process.env.FISHING_DATA_DIR) return; // 显式指定数据目录时不搬迁
  if (dirHasData(DATA_DIR) || !dirHasData(LEGACY_DATA_DIR)) return;
  try {
    copyDirSync(LEGACY_DATA_DIR, DATA_DIR);
    console.log('[migrate] 数据目录已迁移到：' + DATA_DIR);
  } catch (e) { console.error('[migrate] 数据目录迁移失败：' + e.message); }
})();


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
let world = { shopSales: {}, listings: [], listingSeq: 1, bigRecords: {}, smallRecords: {}, topCatches: {}, topSmall: {}, globalMax: null, priceLog: {}, tradeLog: {}, marketLog: [], groundCfg: { spots: {}, grounds: {} }, notifyLevel: 'all', biteFormula: BITE_FORMULA_DEFAULT, doubleBase: 0, componentCfg: null, feedback: [], feedbackMeta: {}, bannerSeq: 1, banners: [], bannerCfg: {} };

// ---- 反馈意见 ----
// 默认每人每 24 小时可提交 1 条；花 10000 金币可立即结束 CD（下次可提交时间提前 24h）。
const FEEDBACK_CD_MS = 24 * 3600 * 1000;
const FEEDBACK_SKIP_COST = 10000;
const FEEDBACK_MAX_LEN = 1000;
const FEEDBACK_KEEP = 500; // 最多保留的历史反馈条数
// 反馈状态标识（玩家可见；管理员可改）
const FEEDBACK_STATUSES = { submitted: '已提交', accepted: '已受理', done: '已完成' };

// ---- 在线交易会话 ----
// trade = { id, a:{key,name}, b:{key,name}, aItems:[{id,qty}], bItems:[], aOk, bOk, cooldownUntil, cancelled, createdAt }
const trades = new Map();
let tradeSeq = 1;
const TRADE_COOLDOWN = 3000;

// ---- 游戏静态数据：与前端共用 frontend/js/data.js（UMD，单一来源） ----
const D = require(path.join(__dirname, '..', 'frontend', 'js', 'data.js'));

// 物品价格/名称表由共享目录派生（用于定价、市集与交易校验）
//   ECO_PRICE：进入系统商店供需经济（有动态乘数与价格历史）的物品 —— 仅渔获与材料。
//   组件为固定价道具（实例价 = 底材基准价 × 品质倍率），不走供需乘数；名称表覆盖全部物品。
const ECO_PRICE = {}, ITEM_NAME = {}, FISH_ID_SET = {};
D.allItems().forEach(function (it) {
  ITEM_NAME[it.id] = it.name;
  if (it.kind === 'fish' || it.kind === 'material') ECO_PRICE[it.id] = it.price;
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
// 体型随机：偏向小值；体型词缀按百分比放大/缩小结果。
// 不再对加成结果设固定上限（旧版硬性封顶 range[1]*1.3，导致 +55% 体型也被压到 520cm）；
// 数值上限由底材体型范围与词缀本身决定。
function rollSizeOf(range, eff) {
  let v = range[0] + (range[1] - range[0]) * Math.pow(Math.random(), 1.6);
  if (eff.size) v = Math.max(1, v * (1 + eff.size / 100));
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
// ---- 排行榜工具 ----
// 每个玩家在单个榜单上只保留一条记录（大鱼榜取其最大、小鱼榜取其最小），再排序取前 10。
function upsertTop(list, entry, keepSmall) {
  const i = list.findIndex(function (x) { return x.who === entry.who; });
  if (i >= 0) {
    const worse = keepSmall ? entry.size >= list[i].size : entry.size <= list[i].size;
    if (worse) return; // 已有更优记录，忽略本次
    list[i] = entry;
  } else {
    list.push(entry);
  }
  list.sort(function (a, b) { return keepSmall ? a.size - b.size : b.size - a.size; });
  if (list.length > 10) list.length = 10;
}
// 单竿结算：掷骰 → 入库（背包/图鉴）→ 大鱼榜 → 全服动态 → 定向推送权威资产
function doServerCatch(rec, key, ground, spot, eff, noDouble) {
  const item = resolveItemAt(spot, eff);
  if (!item) return;
  invAdd(rec, item.id, 1);
  rec.codex = rec.codex || {};
  rec.catchCount = (rec.catchCount || 0) + 1;
  // 图鉴按「底材」登记（组件实例归入其底材条目），渔获/材料按自身 id 登记
  const codexId = item.kind === 'component' ? (item.baseId || item.id) : item.id;
  const cx = rec.codex[codexId] || { count: 0, first: Date.now() };
  cx.count += 1;
  // 记录个人最大/最小体型（图鉴详情展示）
  if (item.size != null) {
    if (cx.max == null || item.size > cx.max) cx.max = item.size;
    if (cx.min == null || item.size < cx.min) cx.min = item.size;
  }
  rec.codex[codexId] = cx;

  let recordEvent = null;
  let smallEvent = false;
  let globalRecord = null; // 全场最大纪录被破（用于顶部横幅）
  if (FISH_ID_SET[item.id] && item.size != null && item.size > 0) {
    const size = Math.round(item.size * 10) / 10;
    const cur = world.bigRecords[item.id];
    if (!cur || size > cur.size) {
      world.bigRecords[item.id] = { id: item.id, name: itemName(item.id), size: size, who: rec.name, t: Date.now() };
      recordEvent = world.bigRecords[item.id];
    }
    // 全场最大纪录（跨鱼种）：被破时返回新纪录，供顶部横幅滚动播报
    const gm = world.globalMax;
    if (!gm || size > gm.size) {
      world.globalMax = { id: item.id, name: itemName(item.id), size: size, who: rec.name, t: Date.now() };
      globalRecord = world.globalMax;
    }
    // 全服前十大捕获（记录页点开查看；每人只保留一条最大）
    const top = (world.topCatches[item.id] = world.topCatches[item.id] || []);
    upsertTop(top, { size: size, who: rec.name, t: Date.now() }, false);
    // 全服最小纪录
    const sm = world.smallRecords[item.id];
    if (!sm || size < sm.size) {
      world.smallRecords[item.id] = { id: item.id, name: itemName(item.id), size: size, who: rec.name, t: Date.now() };
      smallEvent = true;
    }
    // 全服前十小捕获（每人只保留一条最小）
    const topS = (world.topSmall[item.id] = world.topSmall[item.id] || []);
    upsertTop(topS, { size: size, who: rec.name, t: Date.now() }, true);
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
  saveAccount(key);
  if (recordEvent || smallEvent || globalRecord) {
    saveRecords();
    if (recordEvent || smallEvent) broadcastRecords();
    if (globalRecord) broadcast({ type: 'globalRecord', record: globalRecord });
    if (recordEvent && feedVisible(item, true)) broadcast({ type: 'feed', entry: { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null, record: true } });
  }
  // 定向推送：本条渔获 + 图鉴条目 + 权威资产（前端不持账本）
  sendTo(key, { type: 'catch', entry: entry });
  sendTo(key, { type: 'codex', codex: rec.codex, catchCount: rec.catchCount, entry: { id: codexId, name: itemName(codexId) } });
  sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
  // 双钓：见 doubleCountOf。基础上钩 1 条，按双钓概率连续追加，最多 3 条。
  const extra = doubleExtraOf(eff.double);
  for (let i = 0; i < extra; i++) doServerCatch(rec, key, ground, spot, eff, true);
}
// ---- 双钓概率 ----
// 叠加值 A（百分比点数，50% 写作 A=50）→ 实际每次追加概率 P = A / (A + 100) = 1 - 1/(1+A/100)。
// 判定：基础上钩 1 条；掷 < P 成功则额外 +1；若成功再掷 < P，成功再 +1；最多 3 条。
//   恰好 1 条 = 1-P，恰好 2 条 = P(1-P)，恰好 3 条 = P²，期望 E = 1 + P + P²。
// 若已有基础双钓率 B（世界配置 doubleBase，0..1），最终双钓概率 = 1 - (1-B)(1-P)。
function doubleProbOf(A) {
  const a = Math.max(0, Number(A) || 0);
  let p = a / (a + 100);
  const B = Math.max(0, Math.min(1, Number(world.doubleBase) || 0));
  if (B > 0) p = 1 - (1 - B) * (1 - p);
  return Math.max(0, Math.min(1, p));
}
// 本次抛竿实际追加的额外鱼数（0..2）
function doubleExtraOf(A) {
  const p = doubleProbOf(A);
  let extra = 0;
  if (Math.random() < p) {
    extra = 1;
    if (Math.random() < p) extra = 2;
  }
  return extra;
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
  saveConfig();
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

function basePrice(id) { return ECO_PRICE[id] || (D.itemOf(id).price || 10); }
function itemName(id) { return ITEM_NAME[id] || D.itemOf(id).name || id; }
// 物品是否可出售/上架：渔获、材料、组件实例、旧通用组件
function sellableOf(id) { return D.isSellable(id) || id === 'comp_generic'; }
// 单件成交价：经济物品随供需浮动；组件实例与旧通用组件为固定价
function unitPriceOf(id) { return ECO_PRICE[id] ? currentPrice(id) : (D.itemOf(id).price || 10); }

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
  Object.keys(ECO_PRICE).forEach(recordPrice);
  try { saveEconomy(); } catch (e) {}
}, 60000).unref();

// ---- 落盘原语（同步写、整文件重写；单账号/单域粒度） ----
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8') || 'null'); } catch (e) { return null; } }
function writeJson(fp, obj) { try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); } catch (e) { console.error('[save] ' + fp + ' 写入失败：' + e.message); } }
function safeKey(k) { return String(k).replace(/[^a-zA-Z0-9_.-]/g, '_'); } // 账号 key 已是小写字母数字下划线，这里再兜底
function accountFile(key) { return path.join(ACCOUNTS_DIR, safeKey(key) + '.json'); }

// ---- 账号：每账号一个文件 ----
function loadAccounts() {
  users = {};
  let files = [];
  try { files = fs.readdirSync(ACCOUNTS_DIR).filter(function (f) { return f.endsWith('.json'); }); } catch (e) {}
  files.forEach(function (f) {
    const rec = readJson(path.join(ACCOUNTS_DIR, f));
    if (rec && rec.username) users[String(rec.username).toLowerCase()] = rec;
  });
  // 首次运行且无账号文件：从旧版 users.json 迁移
  if (!files.length) {
    const old = readJson(LEGACY_USERS_FILE);
    if (old && typeof old === 'object') {
      users = old;
      saveAllAccounts();
      console.log('[migrate] users.json → accounts/（' + Object.keys(users).length + ' 个账号）');
    }
  }
}
function saveAccount(key) {
  const rec = users[key];
  if (!rec) return;
  writeJson(accountFile(key), rec);
}
function saveAllAccounts() {
  Object.keys(users).forEach(saveAccount);
}

// ---- 世界域：市集 / 记录 / 经济 / 配置 各自一个文件 ----
function loadDomain(file, keys) {
  const data = readJson(file);
  if (data && typeof data === 'object') keys.forEach(function (k) { if (data[k] !== undefined) world[k] = data[k]; });
}
function saveDomain(file, keys) {
  const out = {};
  keys.forEach(function (k) { out[k] = world[k]; });
  writeJson(file, out);
}
const MARKET_KEYS = ['listingSeq', 'listings'];
const RECORDS_KEYS = ['bigRecords', 'smallRecords', 'topCatches', 'topSmall', 'globalMax'];
const ECONOMY_KEYS = ['shopSales', 'priceLog', 'tradeLog', 'marketLog'];
const CONFIG_KEYS = ['groundCfg', 'notifyLevel', 'biteFormula', 'doubleBase', 'componentCfg', 'bannerSeq', 'banners', 'bannerCfg'];
// 反馈意见：items 列表 + meta（每账号下次可提交时间），单独一个文件
const FEEDBACK_KEYS = ['feedback', 'feedbackMeta'];
function loadMarket() { loadDomain(MARKET_FILE, MARKET_KEYS); }
function saveMarket() { saveDomain(MARKET_FILE, MARKET_KEYS); }
function loadRecords() { loadDomain(RECORDS_FILE, RECORDS_KEYS); }
function saveRecords() { saveDomain(RECORDS_FILE, RECORDS_KEYS); }
function loadEconomy() { loadDomain(ECONOMY_FILE, ECONOMY_KEYS); }
function saveEconomy() { saveDomain(ECONOMY_FILE, ECONOMY_KEYS); }
function loadConfig() { loadDomain(CONFIG_FILE, CONFIG_KEYS); }
function saveConfig() { saveDomain(CONFIG_FILE, CONFIG_KEYS); }
function loadFeedback() { loadDomain(FEEDBACK_FILE, FEEDBACK_KEYS); }
function saveFeedback() { saveDomain(FEEDBACK_FILE, FEEDBACK_KEYS); }
function saveWorld() { saveMarket(); saveRecords(); saveEconomy(); saveConfig(); saveFeedback(); }

function loadUsers() { loadAccounts(); }
function saveUsers() { saveAllAccounts(); }
// 世界加载：从拆分后的域文件读取；若域文件尚不存在则从旧版 world.json 迁移
function loadWorld() {
  const hasDomain = MARKET_FILE && fs.existsSync(MARKET_FILE);
  if (!fs.existsSync(MARKET_FILE) && !fs.existsSync(RECORDS_FILE) && !fs.existsSync(ECONOMY_FILE) && !fs.existsSync(CONFIG_FILE)) {
    const old = readJson(LEGACY_WORLD_FILE);
    if (old && typeof old === 'object') {
      world = Object.assign(world, old);
      saveWorld(); // 拆分落盘
      console.log('[migrate] world.json → market/records/economy/config.json');
      return;
    }
  }
  loadMarket(); loadRecords(); loadEconomy(); loadConfig(); loadFeedback();
  void hasDomain;
}
loadUsers();
loadWorld();
// v0.8 组件实例化迁移：旧编码组件 id（`部位_code值_…`）→ 实例签名；背包/钓竿配置/挂单原位换新。
// 同时清理经济域里遗留的组件键（组件实例改走固定价，不再进入供需/价格历史）。
(function migrateLegacyComponentIds() {
  let accountsDirty = false, marketDirty = false, econDirty = false;
  Object.keys(users).forEach(function (key) {
    const rec = users[key];
    if (rec.inventory) {
      const next = {};
      Object.keys(rec.inventory).forEach(function (id) {
        const nid = D.normalizeItemId(id);
        next[nid] = (next[nid] || 0) + rec.inventory[id];
      });
      if (JSON.stringify(next) !== JSON.stringify(rec.inventory)) { rec.inventory = next; accountsDirty = true; }
    }
    if (rec.bd) {
      Object.keys(rec.bd).forEach(function (part) {
        const slot = rec.bd[part];
        if (!slot || !slot.compId) return;
        const comp = D.componentOf(slot.compId);
        if (comp && (comp.id !== slot.compId || slot.name !== comp.name)) {
          slot.compId = comp.id; slot.name = comp.name; slot.affixes = comp.affixes; slot.rare = comp.quality;
          accountsDirty = true;
        }
      });
    }
  });
  (world.listings || []).forEach(function (l) {
    const nid = D.normalizeItemId(l.id);
    if (nid !== l.id) { l.id = nid; l.name = D.itemName(nid); marketDirty = true; }
  });
  ['shopSales', 'priceLog', 'tradeLog'].forEach(function (field) {
    const m = world[field] || {};
    Object.keys(m).forEach(function (id) {
      if (!ECO_PRICE[id]) { delete m[id]; econDirty = true; }
    });
  });
  if (accountsDirty) saveAllAccounts();
  if (marketDirty) saveMarket();
  if (econDirty) saveEconomy();
  if (accountsDirty || marketDirty || econDirty) console.log('[migrate] legacy component ids → v0.8 instance signatures');
})();

// 套用管理后台保存的钓场/钓点配置覆盖（掉落池 / 增益 / 锁定状态）
applyGroundCfg();
// 套用管理后台保存的组件生成配置（品质概率 / 词条数概率 / roll 模型 / 数值区间 / 修饰词规则）
if (D.setComponentCfg) D.setComponentCfg(world.componentCfg);
// 为所有经济物品补齐乘数状态（老档迁移：旧"供应压力"按 -1%/件 折算为初始乘数）
(function ensureSaleStats() {
  const day = new Date().toISOString().slice(0, 10);
  Object.keys(ECO_PRICE).forEach(function (id) {
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
    username: rec.username, name: rec.name, coins: rec.coins, qq: rec.qq || '',
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
  Object.keys(ECO_PRICE).forEach(function (id) {
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
  const sellers = {};
  world.listings.forEach(function (l) {
    if (l.expireAt && l.expireAt <= now) {
      const seller = users[l.seller];
      if (seller) {
        invAdd(seller, l.id, l.qty);
        sellers[l.seller] = 1;
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
    Object.keys(sellers).forEach(saveAccount);
    saveMarket();
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
      if (d.confirmPassword != null && String(d.confirmPassword) !== password) return apiResp(res, 400, { error: '两次输入的密码不一致' });
      // QQ 号必填：5-12 位数字
      const qq = String(d.qq == null ? '' : d.qq).trim();
      if (!qq) return apiResp(res, 400, { error: '请填写 QQ 号' });
      if (!/^[0-9]{5,12}$/.test(qq)) return apiResp(res, 400, { error: 'QQ 号需为 5-12 位数字' });
      const key = username.toLowerCase();
      if (users[key]) return apiResp(res, 409, { error: '用户名已存在' });
      const salt = crypto.randomBytes(8).toString('hex');
      users[key] = { username: username, salt: salt, pwHash: hashPw(password, salt), name: name, qq: qq, coins: 500, inventory: {}, bd: {}, codex: {}, catchCount: 0, createdAt: Date.now() };
      saveAccount(key);
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

  // ---- 登出：使该 token 失效并断开实时连接 ----
  if (p === '/api/logout' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { d = {}; }
      const token = d.token || u.query.token;
      const key = token && sessions.get(token);
      if (key) {
        sessions.delete(token);
        // 仅当该账号已无其他有效会话时，才断开实时连接并移除玩家
        const stillLive = Array.from(sessions.values()).some(function (k) { return k === key; });
        if (!stillLive) {
          stopFishingSession(key);
          const doomed = [];
          clientOwners.forEach(function (ownerKey, res) { if (ownerKey === key) doomed.push(res); });
          doomed.forEach(function (res) {
            clients.delete(res); clientOwners.delete(res);
            try { res.write('data: ' + JSON.stringify({ type: 'kicked', msg: '你已登出' }) + '\n\n'); } catch (e) {}
            try { res.end(); } catch (e) {}
          });
          if (players.has(key)) { players.delete(key); sendPlayersAll(); }
          const t = tradeOfPlayer(key);
          if (t) { t.cancelled = true; t.closed = true; broadcastTrade(t); trades.delete(t.id); }
        }
      }
      apiResp(res, 200, { ok: true });
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
      saveAccount(key);
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
      // 钓场目录（含管理后台保存的掉落池/增益/锁定覆盖）：新客户端连接时同步，
      // 否则前端会一直用 data.js 里的硬编码默认值，导致图鉴产地与实际掉落不符。
      groundCfg: D.GROUNDS,
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
        const prev = (rec.bd && rec.bd[part.key] && rec.bd[part.key].compId) || null;
        let comp = null;
        if (d.compId) {
          comp = D.componentOf(d.compId);
          if (!comp) return apiResp(res, 400, { error: '未知组件' });
          if (comp.part !== part.key) return apiResp(res, 400, { error: '组件与部位不匹配' });
          // 安装 = 从背包取用 1 件（卸下会原样放回背包，不再摧毁）
          if (!invHas(rec, comp.id, 1)) return apiResp(res, 400, { error: '背包中没有该组件' });
        }
        // 换下/卸下：把原先装备的组件放回背包
        if (prev && prev !== (comp ? comp.id : null)) invAdd(rec, prev, 1);
        rec.bd = rec.bd || {};
        rec.bd[part.key] = {
          compId: comp ? comp.id : null, name: comp ? comp.name : part.default.name,
          affixes: comp ? comp.affixes : [], rare: comp ? comp.quality : null, isCharm: !!part.isCharm,
        };
        if (comp) invAdd(rec, comp.id, -1);
        saveAccount(key);
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
        let itemId = d.item && d.item.id;
        if (!itemId) return apiResp(res, 400, { error: '缺少物品' });
        // 组件：规范化为实例签名（旧编码 id 会被升级）；渔获/材料保持不变
        itemId = D.normalizeItemId(itemId);
        const itemMeta = D.itemOf(itemId);
        invAdd(rec, itemId, 1);
        rec.codex = rec.codex || {};
        rec.catchCount = (rec.catchCount || 0) + 1;
        const codexId = itemMeta.kind === 'component' ? (itemMeta.baseId || itemId) : itemId;
        const cx = rec.codex[codexId] || { count: 0, first: Date.now() };
        cx.count += 1;
        const dSize = Number(d.item && d.item.size != null ? d.item.size : d.size);
        if (isFinite(dSize) && dSize > 0) {
          if (cx.max == null || dSize > cx.max) cx.max = dSize;
          if (cx.min == null || dSize < cx.min) cx.min = dSize;
        }
        rec.codex[codexId] = cx;
        let recordEvent = null;
        let smallEventDev = false;
        let globalRecordDev = null;
        const rawSize = d.item && d.item.size != null ? d.item.size : d.size;
        const size = Number(rawSize);
        if (FISH_ID_SET[itemId] && isFinite(size) && size > 0) {
          const rsize = Math.round(size * 10) / 10;
          const cur = world.bigRecords[itemId];
          if (!cur || rsize > cur.size) {
            world.bigRecords[itemId] = { id: itemId, name: itemName(itemId), size: rsize, who: rec.name, t: Date.now() };
            recordEvent = world.bigRecords[itemId];
          }
          const gm = world.globalMax;
          if (!gm || rsize > gm.size) {
            world.globalMax = { id: itemId, name: itemName(itemId), size: rsize, who: rec.name, t: Date.now() };
            globalRecordDev = world.globalMax;
          }
          upsertTop((world.topCatches[itemId] = world.topCatches[itemId] || []), { size: rsize, who: rec.name, t: Date.now() }, false);
          const smD = world.smallRecords[itemId];
          if (!smD || rsize < smD.size) {
            world.smallRecords[itemId] = { id: itemId, name: itemName(itemId), size: rsize, who: rec.name, t: Date.now() };
            smallEventDev = true;
          }
          upsertTop((world.topSmall[itemId] = world.topSmall[itemId] || []), { size: rsize, who: rec.name, t: Date.now() }, true);
        }
        const entry = { t: Date.now(), who: rec.name, item: Object.assign({}, d.item, { id: itemId }), ground: d.ground, spot: d.spot, size: isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null };
        feed.unshift(entry); if (feed.length > 60) feed.pop();
        broadcast({ type: 'feed', entry: entry });
        saveAccount(key);
        if (recordEvent || smallEventDev || globalRecordDev) {
          saveRecords();
          if (recordEvent || smallEventDev) broadcastRecords();
          if (globalRecordDev) broadcast({ type: 'globalRecord', record: globalRecordDev });
        }
        if (recordEvent) broadcast({ type: 'feed', entry: { t: Date.now(), who: rec.name, item: entry.item, ground: entry.ground, spot: entry.spot, size: entry.size, record: true } });
        sendTo(key, { type: 'codex', codex: rec.codex, catchCount: rec.catchCount, entry: { id: codexId, name: itemName(codexId) } });
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, { ok: true, codex: cx, record: recordEvent });
      });
    });
    return;
  }
  // 仅测试：模拟 n 次双钓判定，返回追加条数分布（验证 P=A/(A+100) 与最多 3 条）
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/doublecount' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      auth(req, res, body, function (d, key) {
        const A = Number(d.A) || 0;
        const n = Math.max(1, Math.min(200000, Number(d.n) || 1));
        const dist = { '1': 0, '2': 0, '3': 0, '4': 0 };
        let total = 0;
        for (let i = 0; i < n; i++) {
          const cnt = 1 + doubleExtraOf(A);
          dist[String(cnt)] = (dist[String(cnt)] || 0) + 1;
          total += cnt;
        }
        apiResp(res, 200, {
          ok: true, A: A, n: n, P: doubleProbOf(A), doubleBase: Number(world.doubleBase) || 0,
          dist: dist, mean: total / n,
          p1: dist['1'] / n, p2: dist['2'] / n, p3: dist['3'] / n,
        });
      });
    });
    return;
  }
  // 仅测试：直接掷一次体型（验证体型加成无固定上限）
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/rollsize' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      auth(req, res, body, function (d, key) {
        const range = Array.isArray(d.range) && d.range.length === 2 ? d.range : [150, 400];
        const eff = { size: Number(d.size) || 0 };
        const n = Math.max(1, Math.min(1000, Number(d.n) || 1));
        const out = [];
        for (let i = 0; i < n; i++) out.push(rollSizeOf(range, eff));
        apiResp(res, 200, { ok: true, rolls: out, max: Math.max.apply(null, out) });
      });
    });
    return;
  }
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/seed' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        if (d.inventory) {
          const next = {};
          Object.keys(d.inventory).forEach(function (id) { const nid = D.normalizeItemId(id); next[nid] = (next[nid] || 0) + Number(d.inventory[id] || 0); });
          rec.inventory = next;
        }
        if (d.coins != null) rec.coins = d.coins;
        saveAccount(key);
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
  // ---- 商品价格历史与交易量（公开只读；points 为每分钟一次的价格采样；仅经济物品） ----
  if (p === '/api/shop/history' && req.method === 'GET') {
    const id = u.query.id;
    if (!ECO_PRICE[id]) return apiResp(res, 404, { error: '未知物品' });
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
        if (!sellableOf(id)) return apiResp(res, 400, { error: '该物品无法出售' });
        if (!invHas(rec, id, qty)) return apiResp(res, 400, { error: '数量不足' });
        const unit = unitPriceOf(id);
        const gain = unit * qty;
        invAdd(rec, id, -qty);
        rec.coins += gain;
        // 仅经济物品（渔获/材料）影响供需乘数与价格历史；组件固定价，只加金币
        if (ECO_PRICE[id]) registerSale(id, qty, rec.name, unit);
        saveAccount(key); saveEconomy();
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
        const id = D.normalizeItemId(d.id); const qty = Math.max(1, Math.floor(Number(d.qty) || 1));
        const price = Math.max(1, Math.floor(Number(d.price) || 0));
        if (!sellableOf(id)) return apiResp(res, 400, { error: '该物品不可上架' });
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
        saveAccount(key); saveMarket();
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
        saveAccount(key);
        if (seller && l.seller !== key) saveAccount(l.seller);
        saveMarket();
        // 市集成交流水（双方的历史订单查询用）
        world.marketLog = world.marketLog || [];
        world.marketLog.push({ t: Date.now(), buyer: key, buyerName: rec.name, seller: l.seller, sellerName: l.sellerName, id: l.id, name: l.name, qty: qty, price: l.price, total: total, tax: tax });
        if (world.marketLog.length > 300) world.marketLog.splice(0, world.marketLog.length - 300);
        saveEconomy();
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
        saveAccount(key); saveMarket();
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
          const id = D.normalizeItemId(it.id); const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
          if (!id || !sellableOf(id) || qty <= 0) continue;
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
          saveAccount(t.a.key); saveAccount(t.b.key);
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

  // ---- 版本信息（公开只读）：前端启动时比对，版本不一致则强制刷新以清掉旧缓存 ----
  if (p === '/api/version' && req.method === 'GET') {
    return apiResp(res, 200, { version: D.VERSION, build: D.BUILD, componentCfg: D.getComponentCfg ? D.getComponentCfg() : null });
  }

  // ---- 反馈意见：查询 CD 状态 / 提交（默认 24h CD；可花 10000 金币立即结束 CD）----
  function feedbackStatusOf(key) {
    const meta = (world.feedbackMeta && world.feedbackMeta[key]) || {};
    const nextAt = meta.nextAt || 0;
    const now = Date.now();
    return { nextAt: nextAt, ready: now >= nextAt, remainingMs: Math.max(0, nextAt - now), skipCost: FEEDBACK_SKIP_COST };
  }
  if (p === '/api/feedback' && req.method === 'GET') {
    const key = u.query.token && sessions.get(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const rec = users[key];
    const mine = (world.feedback || []).filter(function (f) { return f.key === key; })
      .sort(function (a, b) { return b.t - a.t; }).slice(0, 20);
    return apiResp(res, 200, { status: feedbackStatusOf(key), mine: mine, coins: rec.coins });
  }
  if (p === '/api/feedback/submit' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const st = feedbackStatusOf(key);
        if (!st.ready) {
          return apiResp(res, 429, { error: '冷却中，' + Math.ceil(st.remainingMs / 60000) + ' 分钟后可再次提交（或花 ' + FEEDBACK_SKIP_COST + ' 金币立即结束冷却）', status: st });
        }
        const text = String(d.text || '').trim().slice(0, FEEDBACK_MAX_LEN);
        if (!text) return apiResp(res, 400, { error: '反馈内容不能为空' });
        const entry = { id: 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), t: Date.now(), key: key, name: rec.name, text: text, kind: String(d.kind || 'other').slice(0, 20), version: D.VERSION, status: 'submitted' };
        world.feedback = world.feedback || [];
        world.feedback.push(entry);
        if (world.feedback.length > FEEDBACK_KEEP) world.feedback.splice(0, world.feedback.length - FEEDBACK_KEEP);
        world.feedbackMeta = world.feedbackMeta || {};
        world.feedbackMeta[key] = { nextAt: Date.now() + FEEDBACK_CD_MS, lastAt: Date.now() };
        saveFeedback();
        // 有管理员在线则实时提醒
        Object.keys(users).forEach(function (k) { if (users[k].admin && players.has(k)) sendTo(k, { type: 'notice', msg: '📮 收到新反馈（' + rec.name + '）：' + text.slice(0, 40) }); });
        apiResp(res, 200, { ok: true, entry: entry, status: feedbackStatusOf(key) });
      });
    });
    return;
  }
  // 花 10000 金币立即结束 CD
  if (p === '/api/feedback/skip' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const st = feedbackStatusOf(key);
        if (st.ready) return apiResp(res, 400, { error: '当前不在冷却中，无需跳过' });
        if (rec.coins < FEEDBACK_SKIP_COST) return apiResp(res, 400, { error: '金币不足（需 ' + FEEDBACK_SKIP_COST + '）' });
        rec.coins -= FEEDBACK_SKIP_COST;
        world.feedbackMeta[key] = Object.assign({}, world.feedbackMeta[key] || {}, { nextAt: 0 });
        saveAccount(key); saveFeedback();
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, { ok: true, coins: rec.coins, status: feedbackStatusOf(key) });
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
    return apiResp(res, 200, { records: world.bigRecords, small: world.smallRecords, globalMax: world.globalMax || null });
  }
  // 某种鱼的全服前十大捕获记录 / 前十小（公开只读；kind=small 取小鱼榜）
  if (p === '/api/records/top' && req.method === 'GET') {
    const fid = u.query.id;
    if (!FISH_ID_SET[fid]) return apiResp(res, 404, { error: '未知鱼类' });
    const small = String(u.query.kind || '') === 'small';
    const list = small ? ((world.topSmall && world.topSmall[fid]) || []) : ((world.topCatches && world.topCatches[fid]) || []);
    return apiResp(res, 200, { id: fid, name: itemName(fid), kind: small ? 'small' : 'big', top: list });
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
        saveAccount(key);
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
      feedbackCount: (world.feedback || []).length,
    });
  }
  // ================================================================
  // ---- 横幅（管理后台发布，队列播放） ----
  // 玩家端启动时拉取队列，按顺序播放；图标闪烁可在 bannerCfg.blink 配置。
  // ================================================================
  if (p === '/api/banner' && req.method === 'GET') {
    return apiResp(res, 200, {
      banners: (world.banners || []).slice().sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); }),
      cfg: { blink: !!(world.bannerCfg && world.bannerCfg.blink), blinkTitle: (world.bannerCfg && world.bannerCfg.blinkTitle) || '📢 有新公告' },
      seq: world.bannerSeq || 1,
    });
  }
  if (p === '/api/admin/banner' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    return apiResp(res, 200, {
      ok: true,
      banners: (world.banners || []).slice().sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); }),
      cfg: Object.assign({ blink: false, blinkTitle: '📢 有新公告' }, world.bannerCfg || {}),
      seq: world.bannerSeq || 1,
    });
  }
  // 发布横幅：content + duration(秒)，可选 repeat(播放轮数，默认 1)
  if (p === '/api/admin/banner/add' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const content = String(d.content || '').trim().slice(0, 200);
      if (!content) return apiResp(res, 400, { error: '横幅内容不能为空' });
      const dur = Number(d.duration);
      if (!isFinite(dur) || dur < 1 || dur > 3600) return apiResp(res, 400, { error: '时长需在 1-3600 秒之间' });
      const banner = {
        id: 'bn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        seq: world.bannerSeq++, content: content, duration: Math.round(dur * 10) / 10,
        createdAt: Date.now(), by: a.rec.name,
      };
      world.banners = world.banners || [];
      world.banners.push(banner);
      saveConfig();
      broadcast({ type: 'banner', banners: world.banners, cfg: world.bannerCfg || {} });
      apiResp(res, 200, { ok: true, banner: banner });
    });
    return;
  }
  if (p === '/api/admin/banner/remove' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const before = (world.banners || []).length;
      world.banners = (world.banners || []).filter(function (b) { return b.id !== d.id; });
      if (world.banners.length === before) return apiResp(res, 404, { error: '横幅不存在' });
      saveConfig();
      broadcast({ type: 'banner', banners: world.banners, cfg: world.bannerCfg || {} });
      apiResp(res, 200, { ok: true });
    });
    return;
  }
  // 调整队列顺序：把某条上移/下移（dir=up|down）
  if (p === '/api/admin/banner/move' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const list = (world.banners || []).slice().sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); });
      const i = list.findIndex(function (b) { return b.id === d.id; });
      if (i < 0) return apiResp(res, 404, { error: '横幅不存在' });
      const j = d.dir === 'down' ? i + 1 : i - 1;
      if (j < 0 || j >= list.length) return apiResp(res, 400, { error: '已经在队列端点' });
      const t = list[i]; list[i] = list[j]; list[j] = t;
      list.forEach(function (b, idx) { b.seq = idx + 1; });
      world.banners = list;
      saveConfig();
      broadcast({ type: 'banner', banners: world.banners, cfg: world.bannerCfg || {} });
      apiResp(res, 200, { ok: true, banners: world.banners });
    });
    return;
  }
  // 图标闪烁配置
  if (p === '/api/admin/banner/cfg' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      world.bannerCfg = Object.assign({ blink: false, blinkTitle: '📢 有新公告' }, world.bannerCfg || {});
      if (d.blink != null) world.bannerCfg.blink = !!d.blink;
      if (d.blinkTitle != null) world.bannerCfg.blinkTitle = String(d.blinkTitle).slice(0, 40);
      saveConfig();
      broadcast({ type: 'banner', banners: world.banners || [], cfg: world.bannerCfg });
      apiResp(res, 200, { ok: true, cfg: world.bannerCfg });
    });
    return;
  }

  // ---- 反馈意见列表（管理员只读；按时间倒序） ----
  if (p === '/api/admin/feedback' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const list = (world.feedback || []).slice().sort(function (x, y) { return y.t - x.t; });
    return apiResp(res, 200, { ok: true, feedback: list, total: list.length, statuses: FEEDBACK_STATUSES });
  }
  // ---- 反馈状态：管理员标记（已提交 / 已受理 / 已完成） ----
  if (p === '/api/admin/feedback/status' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      if (!FEEDBACK_STATUSES[d.status]) return apiResp(res, 400, { error: '未知的反馈状态' });
      const item = (world.feedback || []).find(function (f) { return f.id === d.id; });
      if (!item) return apiResp(res, 404, { error: '反馈不存在' });
      item.status = d.status;
      item.statusAt = Date.now();
      item.statusBy = a.rec.name;
      saveFeedback();
      // 通知提交者（若在线）
      if (item.key) sendTo(item.key, { type: 'notice', msg: '你的反馈状态已更新为：' + FEEDBACK_STATUSES[d.status] });
      apiResp(res, 200, { ok: true, id: item.id, status: item.status });
    });
    return;
  }
  // ---- 账号列表（管理员授权数据源） ----
  if (p === '/api/admin/users' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const list = Object.keys(users).map(function (k) {
      const r = users[k];
      const pl = players.get(k);
      return {
        key: k, username: r.username, name: r.name, qq: r.qq || '',
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
      saveAccount(target);
      sendTo(target, { type: 'notice', msg: want ? '🛡 你已获得管理员权限，可打开管理后台（/admin.html）' : '你的管理员权限已被收回' });
      apiResp(res, 200, { ok: true, target: target, admin: want });
    });
    return;
  }
  // ---- 删除账号（管理员；需二次确认——前端传 confirm: true） ----
  if (p === '/api/admin/users/delete' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      if (!target || !users[target]) return apiResp(res, 404, { error: '账号不存在' });
      if (target === a.key) return apiResp(res, 400, { error: '不能删除自己的账号' });
      if (d.confirm !== true) return apiResp(res, 400, { error: '需要二次确认' });
      // 踢下线、清理该账号的挂单与交易
      kickUserSessions(target);
      world.listings = (world.listings || []).filter(function (l) { return l.seller !== target; });
      saveMarket();
      (world.feedback || []).forEach(function (f) { if (f.key === target) f.key = null; });
      delete users[target];
      try { fs.unlinkSync(accountFile(target)); } catch (e) {}
      saveFeedback();
      broadcastMarket();
      apiResp(res, 200, { ok: true, target: target });
    });
    return;
  }
  // ---- 账号快照：返回金币 + 背包（供管理后台展示与编辑） ----
  if (p === '/api/admin/users/snapshot' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const target = String(u.query.key || '').toLowerCase();
    const rec = users[target];
    if (!rec) return apiResp(res, 404, { error: '账号不存在' });
    return apiResp(res, 200, {
      ok: true, key: target, name: rec.name, username: rec.username, qq: rec.qq || '',
      coins: rec.coins || 0, inventory: rec.inventory || {},
      catchCount: rec.catchCount || 0, admin: !!rec.admin,
    });
  }
  // ---- 账号快照编辑：直接设置金币与背包（管理员） ----
  if (p === '/api/admin/users/snapshot' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '账号不存在' });
      if (d.inventory != null) {
        if (typeof d.inventory !== 'object') return apiResp(res, 400, { error: '背包格式错误' });
        const next = {};
        for (const rawId of Object.keys(d.inventory)) {
          const qty = Math.floor(Number(d.inventory[rawId]));
          if (!isFinite(qty) || qty <= 0) continue;
          const id = D.normalizeItemId(rawId);
          if (!sellableOf(id) && !D.componentBase(id)) return apiResp(res, 400, { error: '未知物品：' + rawId });
          next[id] = (next[id] || 0) + qty;
        }
        rec.inventory = next;
      }
      if (d.coins != null) {
        const c = Math.floor(Number(d.coins));
        if (!isFinite(c) || c < 0 || c > 1e12) return apiResp(res, 400, { error: '金币数无效' });
        rec.coins = c;
      }
      saveAccount(target);
      sendTo(target, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
      sendTo(target, { type: 'notice', msg: '管理员更新了你的资产快照' });
      apiResp(res, 200, { ok: true, key: target, coins: rec.coins, inventory: rec.inventory });
    });
    return;
  }
  // ---- 账号管理：改密码 / 改显示名 / 调整金币（管理员） ----
  if (p === '/api/admin/users/update' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '账号不存在' });
      const changed = [];
      if (d.password != null && String(d.password) !== '') {
        const pw = String(d.password);
        if (pw.length < 4) return apiResp(res, 400, { error: '密码至少 4 位' });
        rec.salt = crypto.randomBytes(8).toString('hex');
        rec.pwHash = hashPw(pw, rec.salt);
        changed.push('密码');
        // 改密后使该账号所有旧会话失效（强制重新登录），并断开实时连接
        kickUserSessions(target);
      }
      if (d.name != null && String(d.name).trim() !== '') {
        rec.name = String(d.name).trim().slice(0, 20);
        changed.push('显示名');
      }
      if (d.coins != null) {
        const c = Math.floor(Number(d.coins));
        if (!isFinite(c) || c < 0 || c > 1e12) return apiResp(res, 400, { error: '金币数无效' });
        rec.coins = c;
        changed.push('金币');
      }
      if (!changed.length) return apiResp(res, 400, { error: '没有需要修改的字段' });
      saveAccount(target);
      // 若该账号在线，推送最新资产/名称
      const pl = players.get(target);
      if (pl) { pl.name = rec.name; sendPlayersAll(); }
      sendTo(target, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
      sendTo(target, { type: 'notice', msg: '管理员修改了你的账号信息：' + changed.join(' / ') });
      apiResp(res, 200, { ok: true, target: target, changed: changed, name: rec.name, coins: rec.coins });
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
      catalog: { fish: fish, materials: D.MATERIALS, components: D.COMPONENT_BASES },
      affixTypes: D.AFFIX_LABEL,
      quality: D.QUALITY,
      notifyLevel: world.notifyLevel || 'all',
      notifyLevels: NOTIFY_LEVELS,
      biteFormula: world.biteFormula || BITE_FORMULA_DEFAULT,
      doubleBase: Number(world.doubleBase) || 0,
      componentCfg: D.getComponentCfg ? D.getComponentCfg() : null,
      componentDefaults: D.defaultComponentCfg ? D.defaultComponentCfg() : null,
      affixCodes: D.AFFIX_CODES,
    });
  }
  // ---- 组件生成配置：品质概率 / 词条数概率 / roll 模型 / 数值区间 / 修饰词规则 ----
  if (p === '/api/admin/component/config' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const cfg = {};
      if (d.qualityWeights != null) {
        if (typeof d.qualityWeights !== 'object') return apiResp(res, 400, { error: '品质概率格式错误' });
        const qw = {};
        ['common', 'rare', 'epic'].forEach(function (k) {
          const v = Number(d.qualityWeights[k]);
          if (!isFinite(v) || v < 0) return;
          qw[k] = v;
        });
        if (!Object.keys(qw).length) return apiResp(res, 400, { error: '品质概率至少需一项非负值' });
        cfg.qualityWeights = qw;
      }
      if (d.countWeights != null) {
        if (typeof d.countWeights !== 'object') return apiResp(res, 400, { error: '词条数概率格式错误' });
        const cw = {};
        ['common', 'rare', 'epic'].forEach(function (k) {
          const arr = d.countWeights[k];
          if (!Array.isArray(arr)) return;
          const out = arr.slice(0, 3).map(function (x) { return Math.max(0, Number(x) || 0); });
          if (out.length) cw[k] = out;
        });
        cfg.countWeights = cw;
      }
      if (d.rollModel != null) {
        if (['linear', 'normal', 'skew'].indexOf(d.rollModel) < 0) return apiResp(res, 400, { error: '未知的 roll 模型' });
        cfg.rollModel = d.rollModel;
      }
      if (d.affixRanges != null) {
        if (typeof d.affixRanges !== 'object') return apiResp(res, 400, { error: '数值区间格式错误' });
        const out = {};
        Object.keys(d.affixRanges).forEach(function (bid) {
          const base = D.componentBase(bid);
          if (!base) return;
          const types = d.affixRanges[bid];
          if (!types || typeof types !== 'object') return;
          const clean = {};
          Object.keys(types).forEach(function (t) {
            const r = types[t];
            if (!base.pool.some(function (p) { return p.type === t; })) return;
            if (!Array.isArray(r) || r.length !== 2) return;
            const mn = Number(r[0]), mx = Number(r[1]);
            if (!isFinite(mn) || !isFinite(mx) || mx < mn) return;
            clean[t] = [Math.round(mn), Math.round(mx)];
          });
          if (Object.keys(clean).length) out[bid] = clean;
        });
        cfg.affixRanges = out;
      }
      if (d.adjectiveRules != null) {
        if (!Array.isArray(d.adjectiveRules)) return apiResp(res, 400, { error: '修饰词规则格式错误' });
        const rules = [];
        for (const r of d.adjectiveRules.slice(0, 20)) {
          const name = String((r && r.name) || '').trim().slice(0, 12);
          if (!name) return apiResp(res, 400, { error: '修饰词名称不能为空' });
          const rule = { name: name };
          ['full', 'noNeg'].forEach(function (k) { if (r && r[k] != null) rule[k] = !!r[k]; });
          ['netMin', 'netMax', 'minAffixes', 'maxAffixes'].forEach(function (k) {
            if (r && r[k] != null && r[k] !== '') { const v = Number(r[k]); if (isFinite(v)) rule[k] = v; }
          });
          rules.push(rule);
        }
        cfg.adjectiveRules = rules;
      }
      // 合并到现有配置并套用
      const merged = Object.assign({}, D.getComponentCfg ? D.getComponentCfg() : {}, cfg);
      world.componentCfg = D.setComponentCfg(merged);
      saveConfig();
      apiResp(res, 200, { ok: true, componentCfg: world.componentCfg });
    });
    return;
  }
  // ---- 组件生成配置：恢复默认 ----
  if (p === '/api/admin/component/reset' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      world.componentCfg = D.setComponentCfg(null);
      saveConfig();
      apiResp(res, 200, { ok: true, componentCfg: world.componentCfg });
    });
    return;
  }
  // ---- 组件掉落实测（按当前配置采样，给管理后台预览概率分布） ----
  if (p === '/api/admin/component/simulate' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const n = Math.max(1, Math.min(200000, Number(d.n) || 20000));
      const qDist = { common: 0, rare: 0, epic: 0 };
      const cDist = { common: { 1: 0, 2: 0, 3: 0 }, rare: { 1: 0, 2: 0, 3: 0 }, epic: { 1: 0, 2: 0, 3: 0 } };
      const vals = {};
      for (let i = 0; i < n; i++) {
        const c = D.rollComponent();
        qDist[c.quality] = (qDist[c.quality] || 0) + 1;
        cDist[c.quality][c.affixes.length] = (cDist[c.quality][c.affixes.length] || 0) + 1;
        c.affixes.forEach(function (af) { vals[af.type] = vals[af.type] || { sum: 0, n: 0, min: 1e9, max: -1e9 }; const v = vals[af.type]; v.sum += af.value; v.n++; if (af.value < v.min) v.min = af.value; if (af.value > v.max) v.max = af.value; });
      }
      const affixStats = {};
      Object.keys(vals).forEach(function (t) { affixStats[t] = { mean: Math.round((vals[t].sum / vals[t].n) * 10) / 10, min: vals[t].min, max: vals[t].max }; });
      apiResp(res, 200, { ok: true, n: n, quality: qDist, count: cDist, affix: affixStats });
    });
    return;
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
      saveConfig();
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
        saveAccount(l.seller);
        sendTo(l.seller, { type: 'assets', coins: seller.coins, inventory: seller.inventory });
        sendTo(l.seller, { type: 'notice', msg: '管理员退回了你的挂单：' + l.name + ' ×' + l.qty + '（上架费不退）' });
      }
      saveMarket();
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
      // 基础双钓率 B（0..1）：叠加词缀双钓率 P 得最终双钓概率 1-(1-B)(1-P)
      if (d.doubleBase != null) {
        const b = Number(d.doubleBase);
        if (!isFinite(b) || b < 0 || b > 1) return apiResp(res, 400, { error: '基础双钓率需在 0 - 1 之间' });
        if (!d.validateOnly) world.doubleBase = b;
        out.doubleBase = b;
      }
      if (!d.validateOnly) saveConfig();
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
