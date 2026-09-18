/*
 * 网页钓鱼小游戏 - 多人服务器（零第三方依赖 · 全部处理逻辑在服务端）
 * 架构：前端仅展示；钓鱼循环/掷骰/词缀加成/资产结算/钓竿配置全部由本服务器权威执行。
 *   - 账号系统：注册 / 登录 / Cookie / Bearer 会话；新密码使用 scrypt，存档在用户文档目录
 *   - 钓鱼循环：POST /api/fishing/start|stop；服务器定时器掷骰，经 SSE 定向推送渔获与权威资产
 *   - 钓竿配置：POST /api/bd/set（校验组件目录），钓速变化即时重置钓鱼循环
 *   - 实时联机：GET /events (SSE) 广播在线玩家、渔场人数、动态、市集、交易
 *   - 系统商店 / 开放市集 / 在线交易 / 图鉴 / 大鱼榜
 *   - 管理后台：/api/admin/*（账号 admin 标志鉴权；管理员只能在本机控制台初始化，后台登录需要 TOTP）
 *     配套页面 frontend/admin.html（5500 分离模式 / 9000 集成模式均可打开）
 *     功能：账号管理员授权 / 钓场钓点掉落池与增益 / 市集退回挂单 / 上钩判断公式 / 全服动态通知等级
 * 游戏数值目录：与前端共用 frontend/js/data.js（UMD，单一来源）
 * 运行： node backend/server.js   （默认端口 9000，可用 PORT 环境变量覆盖）
 * 前后端分离：
 *   - 本服务是纯 API + SSE，跨域仅接受 ALLOWED_ORIGINS 精确白名单，推荐同源部署；
 *   - 默认集成模式：若 ../frontend/index.html 存在则一并托管，单命令即可跑全栈；
 *   - STATIC_DIR 环境变量可指定其他前端目录，STATIC_DIR=none 强制纯 API 模式。
 */
'use strict';
const http = require('http');
const Security = require('./security');
const Transport = require('./transport-security');
const MarketPage = require('./market-page');
const Registration = require('./registration-guard');
const Features = require('../frontend/js/features.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');

// 端口优先级：PORT 环境变量 > --port=xxxx / --port xxxx 命令行参数 > 默认 9000
const _portArg = (function () {
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.indexOf('--port=') === 0) return a.split('=')[1];
    if (a === '--port' && process.argv[i + 1]) return process.argv[i + 1];
  }
  return null;
})();
const PORT = process.env.PORT || _portArg || 9000;
// 9001 is exclusively for the same-host HTTPS proxy, regardless of BIND_HOST.
const BIND_HOST = Number(PORT) === 9001 ? '127.0.0.1' : (process.env.BIND_HOST || undefined);
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
//   stats.json            服务器统计采样（后台概览热力图：在线/钓鱼/挂单/交易，分钟样本 24h + 小时样本 30 天）
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
try { fs.mkdirSync(ACCOUNTS_DIR, { recursive: true }); } catch (e) {}
const MARKET_FILE = path.join(DATA_DIR, 'market.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const ECONOMY_FILE = path.join(DATA_DIR, 'economy.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');   // v0.16.0：管理操作审计日志
const ADMIN_KEYS = ['adminLog'];                        // admin.json 里持久化的键（审计日志）
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
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


// ---- 进程级异常兜底 ----
// 服务端是所有玩家的单点：任何未捕获异常（定时器回调 / socket 事件里抛的 TypeError）都会让
// Node 直接退出，全服同时掉线且必须人工重启。这里记录堆栈后**保持存活**：抛错的那一次操作
// 会丢失（例如某一竿未结算），但其余玩家、在线连接与世界数据不受影响——
// 取舍是「局部丢一次结算」优于「全服下线等重启」。修复 1/2 已从源头堵住已知的两类抛错。
process.on('uncaughtException', function (e) {
  console.error('[uncaughtException] ' + ((e && e.stack) || e));
});
process.on('unhandledRejection', function (e) {
  console.error('[unhandledRejection] ' + ((e && e.stack) || e));
});

// ---- 静态托管（前后端分离）----
// 默认自动托管 ../frontend（存在时）；STATIC_DIR=none 关闭；STATIC_DIR=路径 指定其他前端目录。
const STATIC_DIR = (process.env.STATIC_DIR === 'none') ? null
  : (process.env.STATIC_DIR
    || (fs.existsSync(path.join(__dirname, '..', 'frontend', 'index.html')) ? path.join(__dirname, '..', 'frontend') : null));

const players = new Map();   // id(=username) -> presence（可安全 JSON 广播）
const fishingTimers = new Map(); // username -> 钓鱼循环定时器（Node Timer，不可序列化，单独存放）
const feed = [];             // { t, who, item, ground, spot }
const clients = new Set();   // SSE response 对象
// 会话：tokenHash -> { key, exp }。**落盘只存 token 的 SHA-256**，文件泄露不等于拿到可用凭据。
// 落盘的意义：服务器重启（升级 / 崩溃）后登录态仍在，客户端带着本地 token 自动登录、
// SSE 自动重连，不必让玩家重新输密码——配合前端的版本强刷就是「无感热更新」。
const SESSION_TTL_MS = Transport.GAME_TTL; // 游戏会话固定 24 小时；管理会话固定 30 分钟
const sessions = new Map();
function tokenHash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
// ---- 性能修复(perf-2)：会话落盘防抖 ----
// 原实现每次登录/登出都同步重写整份 sessions.json（O(会话数)），高并发注册登录时放大 IO。
// 现在合并到 2s 窗口批量落盘；紧急路径（会话过期清理）走同一管道。
let sessionsDirty = false;
let sessionsFlushTimer = null;
function saveSessions() {
  sessionsDirty = true;
  if (!sessionsFlushTimer) sessionsFlushTimer = setTimeout(function () {
    sessionsFlushTimer = null;
    if (sessionsDirty) { sessionsDirty = false; saveSessionsNow(); }
  }, 2000);
}
function saveSessionsNow() {
  const out = {};
  const now = Date.now();
  sessions.forEach(function (v, h) { if (v && v.exp > now) out[h] = { k: v.key, e: v.exp, m: v.adminMfa === true, v: 2 }; });
  writeJson(SESSIONS_FILE, { tokens: out });
}
function loadSessions() {
  const data = readJson(SESSIONS_FILE);
  const now = Date.now();
  const tokens = (data && data.tokens) || {};
  Object.keys(tokens).forEach(function (h) {
    const v = tokens[h];
    if (!v || v.v !== 2 || !v.k || !(v.e > now)) return; // 旧长期会话与过期会话不载入
    sessions.set(h, { key: v.k, exp: Math.min(v.e, Date.now() + (v.m === true ? Transport.ADMIN_TTL : SESSION_TTL_MS)), adminMfa: v.m === true });
  });
}
function sessionSet(token, key, adminMfa = false) {
  sessions.set(tokenHash(token), { key: key, adminMfa: adminMfa, exp: Date.now() + (adminMfa ? Transport.ADMIN_TTL : SESSION_TTL_MS) });
  saveSessions();
}
function sessionGet(token) {
  if (typeof token !== 'string' || !token || token.length > 256) return null;
  const h = tokenHash(token);
  const v = sessions.get(h);
  if (!v) return null;
  if (!(v.exp > Date.now())) { sessions.delete(h); saveSessions(); return null; }
  // 滑动续期：剩余不足一半时才写盘，避免每次请求都落一次文件
  // Sessions have a fixed lifetime; admin sessions must reauthenticate after 30 minutes.
  return v.key;
}
function sessionDelete(token) {
  if (!token) return;
  sessions.delete(tokenHash(token));
  saveSessions();
}
let users = {};

// ---- 全局世界状态（商店价格 / 市集挂单 / 大鱼榜 / 价格历史 / 管理配置） ----
// biteFormula：上钩判断公式（管理员可编辑）；groundCfg：钓场/钓点管理配置覆盖；notifyLevel：全服动态通知等级
// 默认公式：基础 90% + 「技巧」词缀（技巧是上钩率公式里的一个变量，钩率提示一律不写死在代码里）。
// 没有任何技巧词缀时，公式退化成平值 90%，与旧版默认行为一致。
const BITE_FORMULA_DEFAULT = 'clamp(90 + skill, 0, 100)';
let world = { shopSales: {}, listings: [], listingSeq: 1, bigRecords: {}, smallRecords: {}, topCatches: {}, topSmall: {}, globalMax: null, rank: null, lastRec: null, priceLog: {}, tradeLog: {}, marketLog: [], groundCfg: { spots: {}, grounds: {}, spotPos: {} }, notifyLevel: 'all', biteFormula: BITE_FORMULA_DEFAULT, doubleBase: 0, componentCfg: null, fishCfg: null, feedback: [], feedbackMeta: {}, bannerSeq: 1, banners: [], bannerCfg: {}, feedbackCfg: {}, castCfg: {}, priceCfg: {}, dropCfg: {}, priceOv: {}, economyLog: [], chestCfg: {}, mallCfg: null, smeltCfg: null, recordsCfg: null, rareK: null, autoSellCfg: {}, snapshotCfg: null, wikiConfigRevision: 1, statMin: [], statHour: [], statPeak: { online: 0, t: 0 } };

// ---- 宝匣（沉船打捞）----
// 档位配方与品质权重写在 frontend/js/data.js 的 CHESTS（与组件底材/词缀池同一份目录，前后端共用）；
// 这里只放运行期可调项：突破保底次数（0 = 关闭）。改动即生效并落盘 config.json。
const CHEST_PITY_MAX = 50;
// 合成成本上限：残片 / 金币（防止手改配置文件把成本写到天文数字后前端输入框溢出）
const CHEST_COST_RELIC_MAX = 9999;
const CHEST_COST_COINS_MAX = 100000000;
function chestCfgOf() {
  const c = world.chestCfg || {};
  const raw = Number(c.pityN);
  return {
    // 0 / 空 / 非法 / 越界一律按「关闭」处理，绝不让脏值把保底放大到无意义
    pityN: (isFinite(raw) && raw >= 1 && raw <= CHEST_PITY_MAX) ? Math.floor(raw) : 0,
    // 成本覆盖（只列被改过的档位；未列为出厂值）
    costs: D.chestCostOverrides(),
  };
}
// 把后台保存的宝匣成本套用到共享目录（启动时与每次保存后都必须调用一次）
function applyChestCostCfg() { return D.applyChestCosts(world.chestCfg && world.chestCfg.costs); }

// ---- 渔获记录贴图（全场最大鱼图标的缩放 / 偏移）----
// 玩家端「🎁 渔获记录」页顶部那张大贴图：scale 为相对原始尺寸的百分比，x/y 为像素偏移。
const RECORDS_SCALE_MIN = 50;
const RECORDS_SCALE_MAX = 500;
const RECORDS_OFFSET_MIN = -400;
const RECORDS_OFFSET_MAX = 400;
const RECORDS_DEFAULTS = { scale: 175, x: 0, y: 0 };  // 175% = v0.11 起的默认大小（原 140×84 → 245×147）
function recordsCfgOf() {
  const c = world.recordsCfg || {};
  const clamp = function (v, lo, hi, dft) {
    const n = Number(v);
    return isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n))) : dft;
  };
  return {
    scale: clamp(c.scale, RECORDS_SCALE_MIN, RECORDS_SCALE_MAX, RECORDS_DEFAULTS.scale),
    x: clamp(c.x, RECORDS_OFFSET_MIN, RECORDS_OFFSET_MAX, RECORDS_DEFAULTS.x),
    y: clamp(c.y, RECORDS_OFFSET_MIN, RECORDS_OFFSET_MAX, RECORDS_DEFAULTS.y),
  };
}

// ---- 商城（每日限购）----
// 商品校验上限：避免手改配置/接口把价格与限购写到溢出的量级
const MALL_PRICE_MAX = 100000000;
const MALL_LIMIT_MAX = 9999;
const MALL_MAX_ITEMS = 200;
// 官方金币直购：商品 / 金币价 / 每日限购数 / 刷新时间全部由管理后台配置（world.mallCfg）。
// 限购按「刷新时间」划分周期：rec.mall = { key: 周期开始日, bought: { 物品id: 已购数 } }，
// 惰性重置——读到时 key 与当前周期不一致就当没买过，不需要任何定时器。
const MALL_MAX_QTY = 99; // 单次购买上限（与商店/宝匣一致，避免误点清空金币）
function mallItemView(e) {
  const id = String((e && e.id) || '');
  if (!id) return null;
  const it = D.itemOf(id);
  if (!it || it.kind === 'unknown') return null;
  const price = Math.max(0, Math.floor(Number(e.price) || 0));
  const limit = Math.max(0, Math.floor(Number(e.limit) || 0)); // 0 = 不限购
  return { id: id, name: it.name, kind: it.kind, rarity: it.rarity || 'common', price: price, limit: limit };
}
function mallCfgOf() {
  const c = (world.mallCfg && typeof world.mallCfg === 'object') ? world.mallCfg : {};
  const dft = D.defaultMallCfg();
  const raw = Array.isArray(c.items) ? c.items : dft.items;
  const items = [];
  const seen = {};
  raw.forEach(function (e) {
    const v = mallItemView(e);
    if (!v || seen[v.id]) return;
    seen[v.id] = 1;
    items.push(v);
  });
  const rt = D.parseRefreshTime(c.refreshTime) ? String(c.refreshTime) : dft.refreshTime;
  return { refreshTime: rt, items: items };
}
// 后台保存的商品列表校验（物品有效性 / 价格与限购范围 / 去重）
function validateMallItems(list) {
  if (!Array.isArray(list)) return { error: '商品列表格式错误' };
  if (list.length > MALL_MAX_ITEMS) return { error: '商品最多 ' + MALL_MAX_ITEMS + ' 项' };
  const out = [], seen = {};
  for (const e of list) {
    const id = String((e && e.id) || '').trim();
    if (!id) return { error: '商品物品不能为空' };
    if (seen[id]) return { error: '商品重复：' + id };
    const it = D.itemOf(id);
    if (!it || it.kind === 'unknown') return { error: '未知物品：' + id };
    if (it.kind === 'rod') return { error: '整根钓竿不能上商城（请用组件实例或材料）' };
    const rawPrice = Number((e && e.price));
    const price = Math.floor(rawPrice);
    if (!isFinite(rawPrice) || price < 0 || price > MALL_PRICE_MAX) return { error: '「' + it.name + '」金币价需为 0 - ' + MALL_PRICE_MAX + ' 的整数' };
    const rawLimit = Number((e && e.limit) || 0);
    const limit = Math.floor(rawLimit);
    if (!isFinite(rawLimit) || limit < 0 || limit > MALL_LIMIT_MAX) return { error: '「' + it.name + '」每日限购需为 0 - ' + MALL_LIMIT_MAX + '（0 = 不限购）' };
    seen[id] = 1;
    out.push({ id: id, price: price, limit: limit });
  }
  return { ok: true, items: out };
}
// 某账号在当前周期内已购数量（惰性重置：周期变了就返回空表）
function mallBoughtOf(rec, cycleKey) {
  const m = rec && rec.mall;
  if (!m || m.key !== cycleKey) return {};
  return (m.bought && typeof m.bought === 'object') ? m.bought : {};
}
function mallView(rec) {
  const cfg = mallCfgOf();
  const cyc = D.mallCycleOf(cfg.refreshTime, Date.now());
  const bought = mallBoughtOf(rec, cyc.key);
  const items = cfg.items.map(function (it) {
    const n = Math.max(0, Math.floor(Number(bought[it.id]) || 0));
    const remain = it.limit > 0 ? Math.max(0, it.limit - n) : null;
    return {
      id: it.id, name: it.name, kind: it.kind, rarity: it.rarity, price: it.price, limit: it.limit,
      bought: n, remain: remain, soldOut: remain === 0,
      have: invCountOf(rec, it.id),
    };
  });
  return {
    ok: true, refreshTime: cfg.refreshTime, cycleKey: cyc.key,
    nextRefreshAt: cyc.nextAt, coins: rec.coins || 0, items: items,
  };
}

// ---- 工坊 · 熔炼 ----
// 纯规则校验、区间、概率与结果掷骰都在 frontend/js/data.js：服务端正式接口与 Wiki 模拟器共用同一实现。
// 服务端只补充登录态、背包、装备锁定和金币校验，并负责权威资产结算。
function smeltCfgOf() { return D.getSmeltCfg(); }
function planSmelt(rec, d) {
  const plan = D.smeltPlanOf(d);
  if (plan.error) return plan;
  const needMain = plan.mainId === plan.subId ? 2 : 1;
  if (!invHas(rec, plan.mainId, needMain)) {
    const lock = rodLockError(rec, plan.mainId, needMain);
    if (lock) return { error: lock };
    return { error: plan.mainId === plan.subId ? '主副组件相同，背包里需要 2 件' : '背包中没有该主组件' };
  }
  if (plan.mainId !== plan.subId && !invHas(rec, plan.subId, 1)) {
    const lock = rodLockError(rec, plan.subId, 1);
    if (lock) return { error: lock };
    return { error: '背包中没有该副组件' };
  }
  if (plan.pearl && !invHas(rec, D.SMELT_PEARL, 1)) {
    return { error: '没有' + itemName(D.SMELT_PEARL) + '（加入宝珠可让词条 roll 两次取靠近区间边界的值）' };
  }
  for (const e of plan.materials) {
    if (!invHas(rec, e.id, e.qty)) {
      return { error: '材料不足：' + itemName(e.id) + ' 需要 ' + e.qty + ' 个，当前 ' + invCountOf(rec, e.id) + ' 个' };
    }
  }
  if (plan.relics > 0 && !invHas(rec, plan.relicId, plan.relics)) {
    return { error: itemName(plan.relicId) + '不足（需 ' + plan.relics + ' 片，当前 ' + invCountOf(rec, plan.relicId) + ' 片）' };
  }
  if ((rec.coins || 0) < plan.gold) {
    return { error: '金币不足（需 ' + plan.gold + '，当前 ' + Math.round(rec.coins || 0) + '）' };
  }
  return plan;
}
// 部位名（错误提示与界面文案共用）
function partNameOf(key) {
  const p = D.ROD_PARTS.find(function (x) { return x.key === key; });
  return p ? p.name : String(key || '?');
}
// 某账号在某档位上的「连续未突破」计数（惰性读取，0 表示没有记录）
// 部位名（错误提示与界面文案共用）
function partNameOf(key) {
  const p = D.ROD_PARTS.find(function (x) { return x.key === key; });
  return p ? p.name : String(key || '?');
}
// ---- 工坊 · 重铸 ----
// 用「龙宫宝珠」给**宝匣产出的神话件**重 roll 词条数值（词条类型与条数不变）。
// 只允许神话品质：全游戏只有海王遗匣产出神话件（后台掉落权重刻意不含 mythic），
// 因此神话品质就是「宝匣产出」这一身份的判据；工坊熔炼保留主件品质，熔出来的神话件同样可重铸。
// v0.16.0 改版：
//   · 材料从沉船宝匣残片改为龙宫宝珠，基础消耗由后台「⚒ 工坊配置」的「重铸基础消耗」决定（默认 1 颗）；
//   · 额外投入宝珠可把重铸**指定到某一条词条**：第 n 条词条额外消耗 n 颗宝珠（选中的那条才重 roll，
//     其余词条原样保留）；不指定时重 roll 全部词条（旧行为）。
function planRecast(rec, id, affixIdx) {
  const cfg = smeltCfgOf();
  const meta = D.componentOf(id);
  if (!meta || !D.isInstance(id)) return { error: '请选择一件已生成的组件' };
  if (!D.canRecast(meta)) {
    return { error: '只有宝匣产出的神话组件可以重铸（当前：' + meta.qualityName + '品质）' };
  }
  if (!invHas(rec, meta.id, 1)) {
    const lock = rodLockError(rec, meta.id, 1);
    return { error: lock || '背包中没有该组件' };
  }
  const pearlId = D.SMELT_PEARL;
  const pearlBase = Math.max(0, Math.floor(Number(cfg.recastPearl) || 0));
  // 目标词条：非数字 / 负数 / 越界 → 视为「不指定」，避免把脏参数静默当成第 1 条
  let target = -1;
  if (affixIdx != null && affixIdx !== '' && affixIdx !== false) {
    const t = Math.floor(Number(affixIdx));
    if (!isFinite(t)) return { error: '指定的词条无效' };
    if (t < 0) return { error: '指定的词条无效' };
    if (t >= (meta.affixes || []).length) return { error: '指定的词条不存在（该组件只有 ' + meta.affixes.length + ' 条词条）' };
    target = t;
  }
  const pearlExtra = D.recastPearlExtra(target);
  const pearlNeed = pearlBase + pearlExtra;
  // v0.16.3：手续费按**消耗的宝珠数**计（后台配的是每颗宝珠的金币），不是每次一个固定价
  const goldNeed = D.recastGoldFor(pearlNeed);
  const pearlHave = invCountOf(rec, pearlId);
  if (pearlHave < pearlNeed) {
    return { error: itemName(pearlId) + '不足（需 ' + pearlNeed + ' 颗' +
      (pearlExtra > 0 ? '：基础 ' + pearlBase + ' + 指定第 ' + (target + 1) + ' 条词条 ' + pearlExtra : '') +
      '，当前 ' + pearlHave + ' 颗）' };
  }
  if ((rec.coins || 0) < goldNeed) return { error: '金币不足（需 ' + goldNeed + '，当前 ' + Math.round(rec.coins || 0) + '）' };
  return {
    ok: true, cfg: cfg, meta: meta, target: target,
    pearlId: pearlId, pearlBase: pearlBase, pearlExtra: pearlExtra, pearlNeed: pearlNeed, pearlHave: pearlHave,
    gold: goldNeed, materials: [{ id: pearlId, name: itemName(pearlId), need: pearlNeed, have: pearlHave }],
  };
}

function chestPityOf(rec, chestId) {
  return (rec && rec.chestPity && Number(rec.chestPity[chestId])) || 0;
}

// ---- 反馈意见 ----
// CD 时长（小时）与跳过费用（金币）可由管理后台配置（落盘 config.json）；默认 24 小时 / 10000 金币。
const FEEDBACK_CD_DEFAULT_HOURS = 24;
const FEEDBACK_SKIP_COST_DEFAULT = 10000;
const FEEDBACK_MAX_LEN = 1000;
const FEEDBACK_KEEP = 500; // 最多保留的历史反馈条数
// 取当前生效的 CD 毫秒 / 跳过费用（未配置时用默认）
function feedbackCdMs() {
  const h = Number(world.feedbackCfg && world.feedbackCfg.cdHours);
  const hours = (isFinite(h) && h >= 0) ? h : FEEDBACK_CD_DEFAULT_HOURS;
  return Math.round(hours * 3600 * 1000);
}
function feedbackSkipCost() {
  const c = Number(world.feedbackCfg && world.feedbackCfg.skipCost);
  return (isFinite(c) && c >= 0) ? Math.floor(c) : FEEDBACK_SKIP_COST_DEFAULT;
}
// 反馈状态标识（玩家可见；管理员可改）
// v0.16.0：新增「已拒绝」状态（不采纳的反馈，可附说明；不发放奖励）
const FEEDBACK_STATUSES = { submitted: '已提交', accepted: '已受理', done: '已完成', rejected: '已拒绝' };

// ---- 钓竿存档 / 槽位 ----
// 槽位上限 8 根；第 1 个槽位免费（即当前装备的这根），之后按 ROD_SLOT_PRICES 顺序购买。
// 槽位保存的是整根钓竿（各部位组件实例）并可命名；已保存钓竿的配件被锁定，
// 不可单独出售/上架/以物易物（背包余量不足时给出明确原因），但整根钓竿可在市集出售。
const ROD_SLOT_MAX = 8;
const ROD_SLOT_PRICES = [10000, 50000, 100000, 200000, 400000, 800000, 1600000]; // 购买第 2..8 个槽位的价格
const ROD_NAME_MAX = 12;
function rodSlotCountOf(rec) {
  const n = Math.floor(Number(rec && rec.rodSlotsCount) || 1);
  return Math.max(1, Math.min(ROD_SLOT_MAX, n));
}
function nextRodSlotPrice(rec) {
  const n = rodSlotCountOf(rec);
  return n >= ROD_SLOT_MAX ? null : ROD_SLOT_PRICES[n - 1];
}
function rodSlotsOf(rec) {
  if (!Array.isArray(rec.rodSlots)) rec.rodSlots = [];
  while (rec.rodSlots.length < ROD_SLOT_MAX) rec.rodSlots.push(null);
  return rec.rodSlots;
}
// 已购买范围内的第一个空槽位（-1 = 已满）
function freeRodSlotOf(rec) {
  const slots = rodSlotsOf(rec);
  const n = rodSlotCountOf(rec);
  for (let i = 0; i < n; i++) {
    if (!slots[i] || !Object.keys(rodPartsOfBd(slots[i].bd)).length) return i;
  }
  return -1;
}
// 当前使用的槽位（-1 = 当前装配的是散件，不属于任何槽位）
function rodActiveSlotOf(rec) {
  const i = Math.floor(Number(rec && rec.rodActiveSlot));
  if (!isFinite(i) || i < 0) return -1;
  const sl = rodSlotsOf(rec)[i];
  return (sl && Object.keys(rodPartsOfBd(sl.bd)).length) ? i : -1;
}
// 把整根钓竿放进空槽位（市集买入 / 下架退回）；没有空槽位时返回 -1
function stashRodToSlot(rec, rodId, nameHint) {
  const parts = D.rodPartsOf ? D.rodPartsOf(rodId) : null;
  if (!parts) return -1;
  const idx = freeRodSlotOf(rec);
  if (idx < 0) return -1;
  const bd = {};
  D.ROD_PARTS.forEach(function (p) {
    const cid = parts[p.key];
    if (!cid) return;
    const meta = D.componentOf(cid);
    bd[p.key] = { compId: cid, name: meta ? meta.name : cid, affixes: meta ? meta.affixes : [], rare: meta ? meta.quality : 'common', isCharm: !!p.isCharm };
  });
  rodSlotsOf(rec)[idx] = { name: String(nameHint || '').trim().slice(0, ROD_NAME_MAX), bd: bd, t: Date.now() };
  return idx;
}
function rodPartsOfBd(bd) {
  const out = {};
  D.ROD_PARTS.forEach(function (p) { const c = bd && bd[p.key] && bd[p.key].compId; if (c) out[p.key] = c; });
  return out;
}
// 装戴内容变化时，同步回「使用中」的槽位（槽位与当前钓竿始终一致，避免快照过期导致误锁或复制）
function syncActiveRodSlot(rec) {
  const as = rodActiveSlotOf(rec);
  if (as < 0) return;
  rodSlotsOf(rec)[as].bd = JSON.parse(JSON.stringify(rec.bd || {}));
  rodSlotsOf(rec)[as].t = Date.now();
}

// 各组件实例被「当前装备 + 已保存钓竿」占用的件数（用于锁定提示与校验）
function rodUsageOf(rec) {
  const used = {};
  function add(bd) {
    D.ROD_PARTS.forEach(function (p) {
      const cid = bd && bd[p.key] && bd[p.key].compId;
      if (cid) used[cid] = (used[cid] || 0) + 1;
    });
  }
  add(rec.bd);
  const active = rodActiveSlotOf(rec);
  rodSlotsOf(rec).forEach(function (sl, i) {
    if (i === active) return; // 使用中的槽位：其配件就是当前装戴的那一份，不重复计入
    if (sl && sl.bd) add(sl.bd);
  });
  return used;
}
// 出售/上架/交易前的钓竿锁定校验：背包余量够就放行；不够且被钓竿占用 → 明确报错
function rodLockError(rec, id, qty) {
  const have = (rec.inventory && rec.inventory[id]) || 0;
  if (have >= qty) return null;
  const used = rodUsageOf(rec)[id];
  if (used) return '该配件已锁定在钓竿上（占用 ' + used + ' 件），背包可交易余量不足，请先卸下或删除对应钓竿';
  return null;
}
// 整根钓竿退回：优先整体放进空槽位；没有空槽位时拆散进背包（并返回方式，便于提示）
function deliverRodBack(rec, rodId, nameHint) {
  const hint = String(nameHint || '').replace(/\s*·?\s*整根钓竿（\d+ 件）$/, '').trim().slice(0, ROD_NAME_MAX);
  const at = stashRodToSlot(rec, rodId, hint);
  if (at >= 0) return { mode: 'slot', slot: at, count: 0 };
  return { mode: 'inventory', slot: -1, count: deliverRodToInventory(rec, rodId) };
}
// 整根钓竿的组件发到背包（市集成交 / 下架 / 过期退回）
function deliverRodToInventory(rec, rodId) {
  const parts = D.rodPartsOf ? D.rodPartsOf(rodId) : null;
  if (!parts) return 0;
  let n = 0;
  Object.keys(parts).forEach(function (k) { invAdd(rec, parts[k], 1); n++; });
  return n;
}
function rodSlotView(rec) {
  const active = rodActiveSlotOf(rec);
  return rodSlotsOf(rec).map(function (sl, i) {
    if (!sl) return null;
    const parts = rodPartsOfBd(sl.bd);
    if (!Object.keys(parts).length) return null; // 空装配不算一根钓竿
    const rodId = D.rodSetId(parts);
    const meta = rodId ? D.rodMeta(rodId) : null;
    return {
      slot: i, name: sl.name || '', parts: parts, rodId: rodId,
      count: Object.keys(parts).length,
      affixes: meta ? meta.affixes : [], price: meta ? meta.price : 0,
      active: i === active,
    };
  });
}

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

// ---- 体型档（v0.13.6）：上钩时按渔获长度与鱼种默认最大体型（size[1]）判定 ----
//   超出默认最大值 0~80% → 大型（L）；超出 80% 以上 → 巨型（G）。
//   大型/巨型鱼在背包中「单独存放」（账号 bigfish 预留计数，普通出售/上架/交易不可动用），
//   售出时按售出当时的系统收购价额外加金币：大型 +50%、巨型 +150%（不新增收购项，行情照常记账）。
const FISH_SIZE_MAX = {};
D.allItems().forEach(function (it) { if (it.kind === 'fish' && it.size) FISH_SIZE_MAX[it.id] = it.size[1]; });
const SIZE_TIER_BONUS = { L: 0.5, G: 1.5 };   // 售出额外金币比例（按单件收购价）
function sizeTierOf(id, size) {
  const max = FISH_SIZE_MAX[id];
  if (!max || !(size > 0)) return null;
  if (size > max * 1.8) return 'G';
  if (size > max) return 'L';
  return null;
}
function tierNameOf(t) { return t === 'G' ? '巨型' : t === 'L' ? '大型' : ''; }
function bigfishOf(rec, id) {
  rec.bigfish = rec.bigfish || {};
  return rec.bigfish[id] || (rec.bigfish[id] = { L: 0, G: 0 });
}
// 预留计数减一档：减到 0 时把该物品（以及两档都为 0 时的条目）删掉，
// 与 invAdd 的「减到 0 就删键」保持一致——否则背包里会堆积 {L:0,G:0} 残键（v0.13.9）
function bigfishDropOf(rec, id, tier, qty) {
  const bf = bigfishOf(rec, id);
  bf[tier] = Math.max(0, (bf[tier] || 0) - qty);
  if (!bf.L && !bf.G) delete rec.bigfish[id];
  return bf;
}
// 按背包总量夹紧预留（管理后台直接覆写 inventory 后可能出现预留 > 持有）：
// 超出部分从高到低削掉，返回被削掉的件数（0 = 没动）
function bigfishClampTo(rec, id) {
  const bf = rec.bigfish && rec.bigfish[id];
  if (!bf) return;
  let have = invCountOf(rec, id);
  const take = function (t) {
    const v = bf[t] || 0;
    const keep = Math.max(0, Math.min(v, have));
    have -= keep;
    bf[t] = keep;
    return v - keep;
  };
  const cut = take('G') + take('L');
  if (!bf.L && !bf.G) delete rec.bigfish[id];
  return cut;
}
// 大型/巨型预留数：占用背包里同名鱼的数量（普通通道不可动用）
function bigReservedOf(rec, id) {
  const bf = rec.bigfish && rec.bigfish[id];
  return bf ? ((bf.L || 0) + (bf.G || 0)) : 0;
}
// 「普通」可用量 = 背包总量 − 大型/巨型预留（出售/上架/交易的普通通道都按这个数校验）
function invAvailOf(rec, id) { return Math.max(0, invCountOf(rec, id) - bigReservedOf(rec, id)); }

// ---- 服务端游戏引擎（钓鱼循环 / 掷骰 / 词缀加成：唯一权威，前端仅展示） ----
// 抛竿间隔：基础值 + 最短值 + 全服钓速加成/上限均可由管理后台配置（world.castCfg，落盘 config.json）。
// 钓速（词缀 + 钓点增益 + 全服加成）只影响「抛竿间隔」：间隔 = 基础 × (1 - 有效钓速/100)，不低于最短值；
// 上钩率由后台公式（biteFormula）单独决定，默认是平值 90%，不再随钓速变化（旧版默认公式把两者混在一起）。
const CAST_BASE_DEFAULT = 3000; // 基础抛竿间隔 ms
const CAST_MIN_DEFAULT = 800;   // 抛竿间隔下限 ms
const CAST_SPEED_BONUS_DEFAULT = 0;   // 全服钓速加成（百分比点，可为负）
const CAST_SPEED_CAP_DEFAULT = 80;    // 有效钓速上限（%），防止间隔被压到 0
function castBaseMs() {
  const v = Number(world.castCfg && world.castCfg.baseMs);
  return (isFinite(v) && v >= 200) ? v : CAST_BASE_DEFAULT;
}
function castMinMs() {
  const v = Number(world.castCfg && world.castCfg.minMs);
  return (isFinite(v) && v >= 100) ? v : CAST_MIN_DEFAULT;
}
function castSpeedBonus() {
  const v = Number(world.castCfg && world.castCfg.speedBonus);
  return (isFinite(v) && v >= -100 && v <= 500) ? v : CAST_SPEED_BONUS_DEFAULT;
}
function castSpeedCap() {
  const v = Number(world.castCfg && world.castCfg.speedCap);
  return (isFinite(v) && v >= 0 && v <= 100) ? v : CAST_SPEED_CAP_DEFAULT;
}
// 共享计算入参：服务端正式路径与 Wiki 模拟器都传这份规则给 frontend/js/data.js。
// 不把 world 整包传下去，避免把内部状态或敏感配置误暴露给公开页面。
function simulationRulesOf() {
  return {
    cast: { baseMs: castBaseMs(), minMs: castMinMs(), speedBonus: castSpeedBonus(), speedCap: castSpeedCap() },
    biteFormula: String(world.biteFormula || BITE_FORMULA_DEFAULT),
    doubleBase: Number(world.doubleBase) || 0,
  };
}
// 以下函数保留原名，便于现有调用点继续工作；实现统一委托 data.js，避免服务端与 Wiki 各写一套公式。
// 共享计算实现位于 frontend/js/data.js；服务端只组装当前规则。
function bdEffectsOf(bd) { return D.rodEffectsOf(bd); }
function intervalFor(rec, spot) { return D.castIntervalOf(rec && rec.bd, spot, simulationRulesOf()); }
function castInfoOf(rec, spot) { return D.castInfoOf(rec && rec.bd, spot, simulationRulesOf()); }
function spotSpeedOf(spot) { return D.spotSpeedOf(spot); }
function spotBiteRateOf(spot) { return D.spotBiteRateOf(spot); }
function mergedEffOf(bd, spot) { return D.mergedEffectsOf(bd, spot); }

function rareK() { return D.rareKOf({ k: world.rareK }); }
function rareMultOf(eff) { return D.rareCommonMult(eff && eff.rare, rareK()); }
// 掉落池条目是否属于「普通品质」：渔获看档位（tier=common），材料看其自身品质（rarity=common）。
// 组件条目单独处理（品质在抽中之后才 roll，见 componentCommonProb）。
function pickIsCommon(pick) {
  const i = pick.indexOf(':');
  const type = pick.slice(0, i), id = pick.slice(i + 1);
  if (type === 'fish') return D.fishTierOf(id) === 'common';
  if (type === 'material') {
    const m = D.MATERIALS.find(function (x) { return x.id === id; });
    return !!(m && m.rarity === 'common');
  }
  return false;
}
// 组件条目生成后可能是任意品质，且品质在「抽中之后」才 roll。为了让「普通品质权重 × mult」
// 在期望意义上精确成立，组件条目的权重按「生成结果为普通的概率」缩放：
//   有效系数 = P(普通) × mult + (1 − P(普通))
// 这样普通件占比下降的幅度与其它普通条目一致，而史诗/神话部分完全不受影响。
function componentCommonProb() {
  const w = (D.getComponentCfg && D.getComponentCfg().qualityWeights) || null;
  if (!w) return 0;
  let total = 0, common = 0;
  Object.keys(w).forEach(function (k) {
    const v = Math.max(0, Number(w[k]) || 0);
    total += v;
    if (k === 'common') common += v;
  });
  return total > 0 ? common / total : 0;
}
// 大鱼/稀有/材料加成：按类别放大掉落池权重；后台「产出倍率」dropCfg 同层叠加（全局 × 分类，组件只吃全局）
// v0.13：普通品质条目（普通鱼 / 材料 / 组件的普通品质部分）额外乘以稀有度系数 K/(K+R)。
function boostPoolOf(pool, eff) {
  const hasBoost = !!(eff.rare || eff.material);
  const commonMult = rareMultOf(eff);
  if (!hasBoost && dropCfgIsDefault() && commonMult >= 1) return pool;
  const dc = dropCfg();
  const compMult = componentCommonProb() * commonMult + (1 - componentCommonProb());
  return pool.map(function (e) {
    const i = e.pick.indexOf(':');
    const type = e.pick.slice(0, i), id = e.pick.slice(i + 1);
    const cm = pickIsCommon(e.pick) ? commonMult : 1;
    let mult = dc.global / 100;
    if (type === 'fish') {
      const tier = D.fishTierOf(id);
      if (tier === 'big') mult *= dc.big / 100;   // 大鱼档只看后台产出倍率（dc.big，即「大鱼季」），增益里没有大鱼概率这一类
      else if (tier === 'rare') mult *= (dc.rare / 100) * (1 + eff.rare / 100);
      else mult *= dc.common / 100 * cm;
    } else if (type === 'material') mult *= (dc.material / 100) * (1 + eff.material / 100) * cm;
    else if (type === 'component') mult *= compMult;
    return { pick: e.pick, weight: e.weight * mult };
  });
}
function weightedPickOf(pool) {
  let total = 0; pool.forEach(function (e) { total += e.weight; });
  let r = Math.random() * total;
  for (const e of pool) { r -= e.weight; if (r <= 0) return e.pick; }
  return pool[pool.length - 1].pick;
}
// 体型随机：按后台配置的 roll 模型在基准区间内取值（默认正态，中段最常见）；体型词缀按百分比放大/缩小结果。
// 不再对加成结果设固定上限（旧版硬性封顶 range[1]*1.3，导致 +55% 体型也被压到 520cm）；
// 数值上限由底材体型范围与词缀本身决定。
function rollSizeOf(range, eff, modelOverride) {
  const model = modelOverride || (D.getFishCfg && D.getFishCfg().sizeModel) || 'normal';
  let v = range[0] + (range[1] - range[0]) * D.rollRatio(model);
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
// 前十榜更新判定：返回 { changed, rank, full }（changed = 该玩家新进榜或成绩被刷新；
// full = 入榜前榜单已经满员——「挤进已有榜单」才算真正的榜位变动，空榜第一次上榜不算）
function upsertTopRanked(list, entry, keepSmall) {
  const prev = list.find(function (x) { return x.who === entry.who; }) || null;
  const wasFull = list.length >= 10;
  upsertTop(list, entry, keepSmall);
  const changed = !prev || (keepSmall ? entry.size < prev.size : entry.size > prev.size);
  const rank = list.findIndex(function (x) { return x.who === entry.who; }) + 1;
  return { changed: changed, rank: rank, full: wasFull, top: keepSmall ? 'small' : 'big' };
}

// ---- 日榜 / 周榜分桶（v0.13.8）----
// 记录页的排行榜支持「日榜 / 周榜 / 总榜」：总榜沿用 topCatches / topSmall（全服历史前十），
// 日榜与周榜按时间桶现算——每次入榜的渔获同时写进「当天」与「本周」两个桶，桶内各留前十。
// 桶按时间滚动淘汰（日 8 天 / 周 5 周），所以文件体积有上界，不会随运营时长无限膨胀。
const RANK_KEEP_DAYS = 8, RANK_KEEP_WEEKS = 5, RANK_MAX = 10;
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dayKeyOf(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
// 周键 = 该周周一的日期（周一为一周起点，字符串排序即时间排序）
function weekKeyOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayKeyOf(d.getTime());
}
function rankBuckets() {
  if (!world.rank || typeof world.rank !== 'object') world.rank = { day: {}, week: {} };
  if (!world.rank.day) world.rank.day = {};
  if (!world.rank.week) world.rank.week = {};
  return world.rank;
}
function pruneRanks() {
  const b = rankBuckets();
  const cutD = dayKeyOf(Date.now() - RANK_KEEP_DAYS * 86400000);
  Object.keys(b.day).forEach(function (k) { if (k < cutD) delete b.day[k]; });
  const cutW = weekKeyOf(Date.now() - RANK_KEEP_WEEKS * 7 * 86400000);
  Object.keys(b.week).forEach(function (k) { if (k < cutW) delete b.week[k]; });
}
// 入桶：同一条渔获同时写进日桶与周桶（各留前十最大 / 前十小）。
// 返回**当日**两个榜的名次信息（v0.13.8：横幅的前十播报按「每日前十」口径 ——
// 历史前十太难进、横幅几乎不出声；当日榜人人有机会，且与记录页默认的日榜一致）。
function rankPut(fishId, size, who, ts) {
  const b = rankBuckets();
  const dayKey = dayKeyOf(ts);
  const dayBucket = (b.day[dayKey] = b.day[dayKey] || {});
  const cell = (dayBucket[fishId] = dayBucket[fishId] || { big: [], small: [] });
  if (!Array.isArray(cell.big)) cell.big = [];
  if (!Array.isArray(cell.small)) cell.small = [];
  const bigRes = upsertTopRanked(cell.big, { size: size, who: who, t: ts }, false);
  const smallRes = upsertTopRanked(cell.small, { size: size, who: who, t: ts }, true);
  // 周桶（记录页「周榜」用；只存不播报）
  const wkBucket = (b.week[weekKeyOf(ts)] = b.week[weekKeyOf(ts)] || {});
  const wcell = (wkBucket[fishId] = wkBucket[fishId] || { big: [], small: [] });
  if (!Array.isArray(wcell.big)) wcell.big = [];
  if (!Array.isArray(wcell.small)) wcell.small = [];
  upsertTopRanked(wcell.big, { size: size, who: who, t: ts }, false);
  upsertTopRanked(wcell.small, { size: size, who: who, t: ts }, true);
  pruneRanks();
  return {
    big: (bigRes.changed && bigRes.full) ? bigRes.rank : 0,
    small: (smallRes.changed && smallRes.full) ? smallRes.rank : 0,
  };
}
// 取某个时间桶的榜（range='day'|'week'）；无该鱼种记录时返回空数组
function rankListOf(range, fishId, small) {
  const b = rankBuckets();
  const key = range === 'day' ? dayKeyOf(Date.now()) : weekKeyOf(Date.now());
  const bucket = (b[range] || {})[key] || {};
  const cell = bucket[fishId];
  if (!cell) return [];
  return (small ? cell.small : cell.big) || [];
}
function rankLabelOf(range) {
  const now = Date.now();
  return range === 'day' ? ('日榜 · ' + dayKeyOf(now)) : (range === 'week' ? ('周榜 · ' + weekKeyOf(now) + ' 当周') : '总榜 · 历史前十');
}
// 全场最大：删纪录后需要重算（不存缓存，直接从各鱼种最大纪录里取最高）
function recomputeGlobalMax() {
  let best = null;
  const m = world.bigRecords || {};
  Object.keys(m).forEach(function (id) { const r = m[id]; if (r && (!best || r.size > best.size)) best = r; });
  return best;
}
// 删除某个鱼种（或全部）的纪录：最大 / 最小 / 前十大 / 前十小 / 日周榜桶，并同步全场最大与最新播报
function deleteRecords(fishId) {
  const all = !fishId;
  const n = { big: 0, small: 0, top: 0, topSmall: 0, rank: 0 };
  const hit = function (id) { return all || id === fishId; };
  if (world.bigRecords) Object.keys(world.bigRecords).forEach(function (id) { if (hit(id)) { delete world.bigRecords[id]; n.big++; } });
  if (world.smallRecords) Object.keys(world.smallRecords).forEach(function (id) { if (hit(id)) { delete world.smallRecords[id]; n.small++; } });
  if (world.topCatches) Object.keys(world.topCatches).forEach(function (id) { if (hit(id)) { delete world.topCatches[id]; n.top++; } });
  if (world.topSmall) Object.keys(world.topSmall).forEach(function (id) { if (hit(id)) { delete world.topSmall[id]; n.topSmall++; } });
  const b = rankBuckets();
  ['day', 'week'].forEach(function (scope) {
    Object.keys(b[scope]).forEach(function (k) {
      const bucket = b[scope][k];
      Object.keys(bucket).forEach(function (id) { if (hit(id)) { delete bucket[id]; n.rank++; } });
      if (!Object.keys(bucket).length) delete b[scope][k];
    });
  });
  if (!world.globalMax || hit(world.globalMax.id)) world.globalMax = recomputeGlobalMax();
  if (world.lastRec && hit(world.lastRec.id)) world.lastRec = null;
  return n;
}
// ---- 单条纪录的读写（v0.14.1 后台纪录管理）----
// 取某个鱼种某个榜的**活引用**（日/周/总 × 最大/最小）：range='all' 用历史总榜，
// day/week 用当前时间桶。返回 null = 该榜没有条目。调用方 splice 后自己收尾空容器。
function boardListRef(range, id, small) {
  if (range === 'all') {
    const m = small ? world.topSmall : world.topCatches;
    return (m && m[id]) || null;
  }
  const b = rankBuckets();
  const key = range === 'week' ? weekKeyOf(Date.now()) : dayKeyOf(Date.now());
  const cell = ((b[range] || {})[key] || {})[id];
  if (!cell) return null;
  return (small ? cell.small : cell.big) || null;
}
// 删掉一条后收尾：总榜空了删鱼种键；日/周桶该鱼种空了删格、桶空了删桶（与 deleteRecords 同口径）
function dropEmptyBoard(range, id, small) {
  if (range === 'all') {
    const m = small ? world.topSmall : world.topCatches;
    if (m && m[id] && !(m[id] || []).length) delete m[id];
    return;
  }
  const b = rankBuckets();
  const key = range === 'week' ? weekKeyOf(Date.now()) : dayKeyOf(Date.now());
  const bucket = (b[range] || {})[key];
  if (!bucket) return;
  const cell = bucket[id];
  if (cell && !(cell.big || []).length && !(cell.small || []).length) delete bucket[id];
  if (!Object.keys(bucket).length) delete b[range][key];
}
// 按「钓者 + 尺寸」把一条渔获从该鱼种的**全部**榜单里抹掉（作弊 / 误录一条时用）：
// 同一条渔获同时躺在日桶、周桶与历史总榜里，只删其中一个榜会留下另一半。命中该鱼的
// 「最大 / 最小纪录」头衔时连头衔一起清（全场最大随之重算）。返回被清掉的条数。
function purgeEntryEverywhere(id, who, size) {
  const n = { boards: 0, big: 0, small: 0 };
  const eq = function (x) { return !!x && String(x.who) === String(who) && Number(x.size) === Number(size); };
  const strip = function (list) {
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i--) if (eq(list[i])) { list.splice(i, 1); n.boards++; }
  };
  strip(world.topCatches && world.topCatches[id]);
  strip(world.topSmall && world.topSmall[id]);
  const b = rankBuckets();
  ['day', 'week'].forEach(function (scope) {
    Object.keys(b[scope] || {}).forEach(function (k) {
      const bucket = b[scope][k];
      const cell = bucket && bucket[id];
      if (!cell) return;
      strip(cell.big); strip(cell.small);
      if (!(cell.big || []).length && !(cell.small || []).length) delete bucket[id];
      if (!Object.keys(bucket).length) delete b[scope][k];
    });
  });
  if (eq(world.bigRecords[id])) { delete world.bigRecords[id]; n.big = 1; }
  if (eq(world.smallRecords[id])) { delete world.smallRecords[id]; n.small = 1; }
  if (n.big && world.globalMax && world.globalMax.id === id) world.globalMax = recomputeGlobalMax();
  return n;
}
// 榜单播报文案（全部鱼种 / 全部榜单）：按重要性取一条播报
//   1 全场最大纪录被破 · 2 该鱼种最大/最小纪录 · 3 当日「最大」前十更新 · 4 当日「最小」前十更新
//   （3/4 是**当日**榜：挤进今天的前十就播报，历史总榜只进记录页，不驱动横幅）
function boardAnnouncement(o) {
  if (o.globalMax) return { level: 1, text: '🎉 全场最大纪录被破！' + o.who + ' 钓到 ' + o.name + ' ' + o.size + 'cm' };
  if (o.record) return { level: 2, text: '🏆 ' + o.name + ' 全服最大纪录刷新：' + o.who + ' ' + o.size + 'cm' };
  if (o.small) return { level: 2, text: '🏆 ' + o.name + ' 全服最小纪录刷新：' + o.who + ' ' + o.size + 'cm' };
  if (o.topBig) return { level: 3, text: '📊 ' + o.name + ' 今日前十大更新：' + o.who + ' ' + o.size + 'cm（第 ' + o.topBig + ' 名）' };
  if (o.topSmall) return { level: 4, text: '📊 ' + o.name + ' 今日前十小更新：' + o.who + ' ' + o.size + 'cm（第 ' + o.topSmall + ' 名）' };
  return null;
}
// 上鱼通告横幅等级（bannerCfg.catchLevel，横幅管理页可配）：
//   gmax   = 仅全服最大最小（全场最大纪录被破）
//   gmax10 = 全服最大最小 + 前十（大/小榜）
//   fish   = 全服所有鱼类最大最小（每种鱼的最大/最小纪录）
//   fish10 = 全服所有鱼类最大最小 + 前十（默认，原行为）
function bannerCatchAllowed(level) {
  const mode = (world.bannerCfg && world.bannerCfg.catchLevel) || 'fish10';
  if (level === 1) return true;
  if (mode === 'gmax') return false;
  if (mode === 'gmax10') return level === 3 || level === 4;
  if (mode === 'fish') return level === 2;
  return true;
}
// 单竿结算：掷骰 → 入库（背包/图鉴）→ 大鱼榜 → 全服动态 → 定向推送权威资产
// ---- perf-8：feed 广播瘦身 ----
// item 全量（组件的词缀/底材/重量等）只有钓者本人需要；全服动态渲染只用到
// name/rarity/size/kind/quality，瘦身可省 40-70% 单条字节。
function slimFeedEntry(e) {
  const it = e.item || {};
  return {
    t: e.t, who: e.who, ground: e.ground, spot: e.spot, size: e.size, record: e.record,
    item: { id: it.id, name: it.name, kind: it.kind, rarity: it.rarity, size: it.size, quality: it.quality, tier: it.tier },
  };
}
function doServerCatch(rec, key, ground, spot, eff, noDouble) {
  const item = resolveItemAt(spot, eff);
  if (!item) return;
  invAdd(rec, item.id, 1);
  // v0.13.6 体型档：超出鱼种默认最大体型 → 大型/巨型，单独预留计数（背包标签行/筛选项的数据源）
  const sizeTier = sizeTierOf(item.id, item.size);
  if (sizeTier) bigfishOf(rec, item.id)[sizeTier] += 1;
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
  // 图鉴最高体型档：普通=铜 / 大型=银 / 巨型=金（只升不降）
  if (sizeTier && cx.tier !== 'G') cx.tier = sizeTier;
  rec.codex[codexId] = cx;
  if (sizeTier) item.tier = sizeTier; // 渔获日志/动态条目带档位标记

  let recordEvent = null;
  let smallEvent = false;
  let globalRecord = null; // 全场最大纪录被破（用于顶部横幅）
  let topBigRank = 0, topSmallRank = 0; // 当日榜名次（>0 = 挤进今天的前十，用于横幅播报）
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
    // 全服前十大捕获（历史总榜，记录页「总榜」用）——只记榜不驱动横幅（横幅走当日榜，见下）
    const top = (world.topCatches[item.id] = world.topCatches[item.id] || []);
    upsertTopRanked(top, { size: size, who: rec.name, t: Date.now() }, false);
    // 全服最小纪录
    const sm = world.smallRecords[item.id];
    if (!sm || size < sm.size) {
      world.smallRecords[item.id] = { id: item.id, name: itemName(item.id), size: size, who: rec.name, t: Date.now() };
      smallEvent = true;
    }
    // 全服前十小捕获（历史总榜，同上）
    const topS = (world.topSmall[item.id] = world.topSmall[item.id] || []);
    upsertTopRanked(topS, { size: size, who: rec.name, t: Date.now() }, true);
    // v0.13.8：日/周榜分桶，并取**当日**前十名次用于横幅播报（历史前十太难进 → 横幅几乎不出声）
    const dayRank = rankPut(item.id, size, rec.name, Date.now());
    topBigRank = dayRank.big;
    topSmallRank = dayRank.small;
    saveRecordsSoon();
  }

  const entry = { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null };
  // 通知等级过滤：只影响全服动态（feed 广播/历史/近期渔获），钓者自己的定向推送不受影响
  const visible = feedVisible(item, recordEvent || smallEvent);
  if (visible) {
    feed.unshift(entry); if (feed.length > 60) feed.pop();
    // perf-8：瘦身 + 钓场分区——词缀细节等 feed 渲染用不到，只推给本钓场的玩家
    broadcast({ type: 'feed', entry: slimFeedEntry(entry) }, ground.id);
  }

  // 近期渔获（非普通渔获/组件）：更新 presence 并广播给所有人
  const p = players.get(key);
  if (p && visible && (item.kind === 'component' || (item.kind === 'fish' && item.rarity !== 'common'))) {
    p.recent = item.size ? (item.name + ' ' + item.size + 'cm') : item.name;
    // perf-8d：recent 更新不再每竿都触发 presence 广播——高钓速下几乎每个玩家每秒
    // 都有 recent 变化 → 每秒数千条 upsert 扇出给全部连接（3200 人实测 ~1.4Gbps 主源）。
    // 改为每玩家 10 秒最多标记一次脏（「最近渔获」标签延迟 ≤10s 无感知）；
    // 真实状态变化（开始/停止钓鱼、掉线、换钓点）仍走各自路径即时广播。
    const nowMs = Date.now();
    if (!p._recentBcastAt || nowMs - p._recentBcastAt > 10000) { p._recentBcastAt = nowMs; sendPlayersAll(); }
  }
  saveAccount(key);
  // 任意榜单更新（全场最大 / 该鱼种纪录 / 前十大 / 前十小）都向上方横幅播报（覆盖所有鱼种）
  const board = boardAnnouncement({
    who: rec.name, name: itemName(item.id), size: (item.size != null ? (Math.round(item.size * 10) / 10) : null),
    globalMax: !!globalRecord, record: !!recordEvent, small: !!smallEvent, topBig: topBigRank, topSmall: topSmallRank,
  });
  if (board && bannerCatchAllowed(board.level)) broadcast({ type: 'globalRecord', record: Object.assign({}, globalRecord || { id: item.id, name: itemName(item.id), size: item.size, who: rec.name, t: Date.now() }, { key: key, text: board.text, level: board.level }) });
  if (board) {
    // v0.13.8：记录页顶部展示「当前最新播报的鱼」——横幅那条播报同步存一份，
    // 随 /api/records 下发（recordsDirty 广播会触发前端重新拉取，无需刷新页面）。
    world.lastRec = {
      id: item.id, name: itemName(item.id),
      size: (item.size != null ? (Math.round(item.size * 10) / 10) : null),
      who: rec.name, t: Date.now(), level: board.level, text: board.text, global: !!globalRecord,
    };
    markRecordsDirty();
  }
  if (recordEvent || smallEvent || globalRecord) {
    saveRecords();
    if (recordEvent || smallEvent) markRecordsDirty();
    if (recordEvent && feedVisible(item, true)) broadcast({ type: 'feed', entry: slimFeedEntry({ t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null, record: true }) }, ground.id);
  }
  // 定向推送：本条渔获 + 图鉴条目 + 权威资产（前端不持账本）
  // perf-8c：热路径增量推送——原来每竿全量发 codex + inventory（codex 还在两个事件里
  // 重复出现），机器人钓上千条后每竿 ~20KB，是 5000 人时 ~1.2Gbps 带宽的主要来源。
  // 改为 codexAdd 只发新条目、assets 只发金币+背包增量；全量替换保留给登录/交易/商店等低频路径。
  sendTo(key, { type: 'catch', entry: entry });
  sendTo(key, { type: 'codexAdd', id: codexId, name: itemName(codexId), add: 1, mx: cx.max, mn: cx.min, tier: cx.tier || null, catchCount: rec.catchCount });
  const invDelta = {}; invDelta[item.id] = 1;
  // bigAdd：大型/巨型预留增量（与背包增量同拍下发，前端合并进 bigfish）
  let bigDelta = null;
  if (sizeTier) { bigDelta = {}; bigDelta[item.id] = {}; bigDelta[item.id][sizeTier] = 1; }
  sendTo(key, { type: 'assets', coins: rec.coins, catchCount: rec.catchCount, invAdd: invDelta, bigAdd: bigDelta });
  // 组件订阅提醒：命中玩家订阅条件时定向推送（双钓追加的组件同样逐条判定）
  maybeSendSubAlert(rec, key, item);
  // 双钓：见 doubleCountOf。基础上钩 1 条，按双钓概率连续追加，最多 3 条。
  const extra = doubleExtraOf(eff.double);
  for (let i = 0; i < extra; i++) doServerCatch(rec, key, ground, spot, eff, true);
  // 自动售出：本竿（含双钓）钓到的鱼若满足规则，按系统行情立即卖出（资产/通知由 autoSellCheck 推送）
  try { autoSellCheck(key); } catch (e) {}
}
// ---- 双钓概率 ----
// 叠加值 A（百分比点数，50% 写作 A=50）→ 实际每次追加概率 P = A / (A + 100) = 1 - 1/(1+A/100)。
// 判定：基础上钩 1 条；掷 < P 成功则额外 +1；若成功再掷 < P，成功再 +1；最多 3 条。
//   恰好 1 条 = 1-P，恰好 2 条 = P(1-P)，恰好 3 条 = P²，期望 E = 1 + P + P²。
// 若已有基础双钓率 B（世界配置 doubleBase，0..1），最终双钓概率 = 1 - (1-B)(1-P)。
function doubleProbOf(A) { return D.doubleProbOf(A, Number(world.doubleBase) || 0); }
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
  if (Features.blocked(world.features, 'fishing.cast')) return;
  const p = players.get(key);
  if (!p || !p.fishing) return;
  const rec = users[key];
  const found = spotOf(p.fishing.groundId, p.fishing.spotId);
  if (!found) { stopFishingSession(key, { forget: true }); return; }
  const eff = mergedEffOf(rec.bd, found.spot);
  // 上钩判断：钓点独立上鱼率优先，否则用全服公式；落空则本竿无收获，定时器继续下一竿
  if (Math.random() * 100 >= biteProbabilityOf(eff, intervalFor(rec, found.spot), found.spot)) return;
  doServerCatch(rec, key, found.ground, found.spot, eff, false);
}
function startFishingSession(key, groundId, spotId, opts) {
  if (Features.blocked(world.features, 'fishing.cast')) return { error: Features.message(world.features, 'fishing.cast') };
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
  const interval = intervalFor(users[key], found.spot);
  fishingTimers.set(key, setInterval(function () { try { fishTick(key); } catch (e) { console.error('[fishTick] ' + key + ' 抛错（跳过本竿，服务继续）: ' + ((e && e.stack) || e)); } }, interval));
  rememberFishingSpot(key, groundId, spotId);
  // opts.silent：重连续钓时由 /events 一次性下发 init，无需再单独广播一次 presence
  if (!(opts && opts.silent)) sendPlayersAll();
  return { interval: interval };
}

// ---- 离线钓点（重连自动续钓）----
// 记下「上次没主动收竿的钓点」并落盘：断线 / 顶号 / 服务器重启都不丢，
// 客户端重连（含服务端更新后的自动强刷）即据此接着钓。
// 只有玩家主动离开钓点才清除（点当前钓点取消 → /api/fishing/stop）。
function rememberFishingSpot(key, groundId, spotId) {
  const rec = users[key];
  if (!rec) return;
  const last = rec.lastFishing;
  if (last && last.groundId === groundId && last.spotId === spotId) return; // 值没变就别写盘
  rec.lastFishing = { groundId: groundId, spotId: spotId, at: Date.now() };
  saveAccount(key);
}
function forgetFishingSpot(key) {
  const rec = users[key];
  if (!rec || !rec.lastFishing) return;
  delete rec.lastFishing;
  saveAccount(key);
}
// 建连时续钓：钓点被删除 / 钓场被锁定或限时关窗 → 直接忘掉，不反复重试。
// 返回 { interval, castInfo, groundId, spotId } 供 init 下发：钓点必须一起带回，
// 前端才能把「我在哪钓鱼」直接写回展示状态（perf-9 后 presence 只发给登记过列表
// 视口的连接，钓鱼页不登记，等 presence 会一直显示「不在任何钓点」）。
function resumeFishingSpot(key) {
  const rec = users[key];
  const last = rec && rec.lastFishing;
  if (!last) return null;
  const found = spotOf(last.groundId, last.spotId);
  if (!found || found.ground.locked) { forgetFishingSpot(key); return null; }
  const r = startFishingSession(key, last.groundId, last.spotId, { silent: true });
  if (r.error) { forgetFishingSpot(key); return null; }
  return { interval: r.interval, castInfo: castInfoOf(rec, found.spot),
    groundId: last.groundId, spotId: last.spotId };
}

// opts.forget：玩家主动收竿/离开钓点 → 忘掉离线钓点。
// 断线、顶号、关服等被动路径不传该标志，钓点保留给下次重连续钓。
function stopFishingSession(key, opts) {
  const t = fishingTimers.get(key);
  if (t) clearInterval(t);
  fishingTimers.delete(key);
  const p = players.get(key);
  if (p) { p.fishing = null; p.status = 'idle'; p.groundId = null; p.spotId = null; p.recent = null; }
  if (opts && opts.forget) forgetFishingSpot(key);
  sendPlayersAll();
}

// 钓点增益变化：正在该钓点钓鱼的玩家按新加成重启循环（钓速即时生效）
function restartFishingAt(groundId, spotId) {
  players.forEach(function (p, key) {
    if (!p.fishing || p.fishing.groundId !== groundId || p.fishing.spotId !== spotId) return;
    const old = fishingTimers.get(key);
    if (old) clearInterval(old);
    const found = spotOf(groundId, spotId);
    const interval = intervalFor(users[key], found && found.spot);
    fishingTimers.set(key, setInterval(function () { try { fishTick(key); } catch (e) { console.error('[fishTick] ' + key + ' 抛错（跳过本竿，服务继续）: ' + ((e && e.stack) || e)); } }, interval));
  });
}

// 抛竿间隔配置变化：所有正在钓鱼的玩家按新间隔重启循环（钓速加成仍在共享 castIntervalOf 内叠加）
function restartAllFishing() {
  players.forEach(function (p, key) {
    if (!p.fishing) return;
    const found = spotOf(p.fishing.groundId, p.fishing.spotId);
    if (!found) { stopFishingSession(key); return; }
    const old = fishingTimers.get(key);
    if (old) clearInterval(old);
    const interval = intervalFor(users[key], found.spot);
    fishingTimers.set(key, setInterval(function () { try { fishTick(key); } catch (e) { console.error('[fishTick] ' + key + ' 抛错（跳过本竿，服务继续）: ' + ((e && e.stack) || e)); } }, interval));
  });
}

// ---- 上钩判断公式（管理员可编辑 · 递归下降解析，不用 eval）----
// 每次抛竿掷骰时求值：结果 = 本次上钩概率（%）；未上钩则该竿无收获（定时器继续下一竿）。
// 可用变量：speed/skill/rare/material/size/double（钓竿词缀 + 钓点增益，%）与 interval（抛竿间隔 ms）。
//   skill = 「技巧」词缀合计，是提升上钩率的主参数——**钩率提示只由这里的公式决定**，
//   代码里不写死「技巧 = +X% 上钩率」这类文案，后台随时可以改公式（默认 clamp(90 + skill,0,100)）。
//   big = 旧「大鱼概率」变量，v0.11 起组件不再产出、v0.13.3 起增益也没有这一类了；
//         变量名仍然接受（历史保存过的公式不能因为删变量而失效），取值恒为 0。
// 可用函数：min max floor ceil round abs clamp(x,lo,hi)。
const BITE_FUNCS = {
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
  clamp: function (x, lo, hi) { return Math.min(hi, Math.max(lo, x)); },
};
const BITE_VAR_NAMES = ['speed', 'skill', 'big', 'rare', 'material', 'size', 'double', 'interval'];
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
function biteProbabilityOf(eff, interval, spot) {
  return D.biteProbabilityOf(eff, interval, spot, String(world.biteFormula || BITE_FORMULA_DEFAULT));
}

// ---- 全服动态通知等级（管理员可调；只影响广播的 feed，钓者自己的 catch 推送不受影响）----
const NOTIFY_LEVELS = {
  all: '全部渔获（默认）',
  uncommon: '仅非普通：稀有鱼 / 史诗鱼 / 组件',
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
  if (lv === 'uncommon') return item.kind === 'component' || (item.kind === 'fish' && item.rarity !== 'common'); // 稀有/史诗渔获（旧「大鱼」已并入稀有与史诗）
  if (lv === 'offrange') {
    if (item.kind !== 'fish' || item.size == null) return false;
    const r = baseRangeOf(item.id);
    return !r || item.size > r[1] || item.size < r[0];
  }
  return true;
}

// ---- 组件订阅提醒（玩家级配置，存账号文件 rec.subNotify）----
// 新组件入包时由服务端判定并定向推送 subalert（背包红标 / 浏览器图标闪烁由前端处理）。
// 结构：{ on, baseId, quality, affixType, min, max, badge, blink }；条件留空 = 不限制。
function subCfgOf(rec) {
  if (Features.blocked(world.features, 'inventory.subscribe')) return null;
  const cfg = rec && rec.subNotify;
  return (cfg && typeof cfg === 'object' && cfg.on) ? cfg : null;
}
function componentMatchesSub(item, cfg) {
  if (!cfg || item.kind !== 'component') return false;
  if (cfg.baseId && item.baseId !== cfg.baseId) return false;
  if (cfg.quality && item.quality !== cfg.quality) return false;
  if (!cfg.affixType && cfg.min == null && cfg.max == null) return true;
  return (item.affixes || []).some(function (a) {
    if (cfg.affixType && a.type !== cfg.affixType) return false;
    if (cfg.min != null && a.value < cfg.min) return false;
    if (cfg.max != null && a.value > cfg.max) return false;
    return true;
  });
}
// 命中订阅则定向提醒（渔获/掉落共用；dev 接口也走这里，便于测试）
function maybeSendSubAlert(rec, key, item) {
  const cfg = subCfgOf(rec);
  if (!cfg || !componentMatchesSub(item, cfg)) return false;
  sendTo(key, {
    type: 'subalert',
    item: { id: item.id, name: item.name, baseId: item.baseId, quality: item.quality, affixes: item.affixes || [] },
    t: Date.now(),
  });
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
// 钓点增益数值范围：上限 100（曾允许到 1000，实测那个量级会让钓鱼循环异常频繁、拖垮服务器）
const BUFF_VALUE_MIN = -100;
const BUFF_VALUE_MAX = 100;
// 收敛一份增益列表：丢掉未知类别，数值夹到 [MIN, MAX]（历史配置里可能存着超限值）
function clampSpotBuffs(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(function (b) { return b && D.AFFIX_LABEL[b.type]; }).map(function (b) {
    const v = Math.round((Number(b.value) || 0) * 10) / 10;
    return { type: b.type, value: Math.max(BUFF_VALUE_MIN, Math.min(BUFF_VALUE_MAX, v)) };
  });
}
function validateBuffList(list) {
  if (!Array.isArray(list)) return { error: '增益格式错误' };
  const out = [];
  for (const b of list) {
    const type = String((b && b.type) || '');
    if (!D.AFFIX_LABEL[type]) return { error: '未知增益类别：' + type };
    const value = Number(b && b.value);
    if (!isFinite(value) || value < BUFF_VALUE_MIN || value > BUFF_VALUE_MAX) {
      return { error: '增益数值需在 ' + BUFF_VALUE_MIN + ' 到 ' + BUFF_VALUE_MAX + ' 之间' };
    }
    out.push({ type: type, value: Math.round(value * 10) / 10 });
  }
  return { ok: true, buffs: out };
}
// ---- 钓场目录的运行时组装（管理后台可增删改；配置全部存 world.groundCfg）----
// world.groundCfg 结构：
//   spots:   { 'gid:sid': { pool, buffs } }         钓点掉落池/增益覆盖（原有）
//   grounds: { gid: { locked, name, desc, type, openFrom, openTo } }  渔场级覆盖（含限时窗口，毫秒时间戳）
//   custom:  [ { id, name, type, desc, spots:[{id,name,pool,buffs}] } ]  新建的渔场
//   customSpots: { gid: [ {id,name,pool,buffs} ] }   为已有渔场新增的钓点
//   removed: { grounds:[gid], spots:['gid:sid'] }    删除记录（目录内置项可恢复）
// 组装基准：启动时对 data.js 的 GROUNDS 做一份深拷贝快照；每次配置变化都从快照重建 D.GROUNDS，
// 这样删除内置渔场/钓点后仍可原样恢复，且重复应用不会叠加。
const GROUNDS_BASE = JSON.parse(JSON.stringify(D.GROUNDS));
const GROUND_ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
const SPOT_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
// 内置掉落池预设：一键填充用（按目录价格分层，取「合适可钓取」的物品组合）
const POOL_PRESETS = {
  economy: { name: '经济浅水（新手场）', desc: '常见鱼为主 + 少量大鱼/材料，收益平稳' },
  big: { name: '大物塘', desc: '大鱼与稀有比例高，适合作战型钓点' },
  rare: { name: '稀有秘境', desc: '稀有鱼权重最高，适合追图鉴/收藏' },
  material: { name: '材料工坊', desc: '材料掉落为主，适合刷组件强化材料' },
};
function presetFishByTier() {
  const byTier = { common: [], big: [], rare: [] };
  ['common', 'big', 'rare'].forEach(function (tier) {
    byTier[tier] = D.FISH[tier].slice().sort(function (a, b) { return a.price - b.price; });
  });
  return byTier;
}
// preset → [{pick, weight}]（component: 条目为「组件」随机掉落）
function defaultPoolPreset(preset) {
  const t = presetFishByTier();
  const mats = D.MATERIALS.slice().sort(function (a, b) { return a.price - b.price; });
  const out = [];
  function addFish(tier, n, weight) {
    t[tier].slice(0, n).forEach(function (f) { out.push({ pick: 'fish:' + f.id, weight: weight }); });
  }
  function addMat(n, weight) {
    mats.slice(0, n).forEach(function (m) { out.push({ pick: 'material:' + m.id, weight: weight }); });
  }
  if (preset === 'big') { addFish('common', 4, 6); addFish('big', 5, 8); addFish('rare', 2, 3); addMat(2, 5); out.push({ pick: 'component:', weight: 3 }); }
  else if (preset === 'rare') { addFish('common', 3, 5); addFish('big', 3, 5); addFish('rare', 4, 6); addMat(2, 4); out.push({ pick: 'component:', weight: 4 }); }
  else if (preset === 'material') { addFish('common', 4, 6); addFish('big', 2, 3); addMat(4, 12); out.push({ pick: 'component:', weight: 2 }); }
  else { addFish('common', 8, 10); addFish('big', 2, 3); addMat(2, 6); out.push({ pick: 'component:', weight: 2 }); }
  return out;
}
function removeListOf(kind) {
  world.groundCfg = world.groundCfg || {};
  world.groundCfg.removed = world.groundCfg.removed || {};
  if (!Array.isArray(world.groundCfg.removed[kind])) world.groundCfg.removed[kind] = [];
  return world.groundCfg.removed[kind];
}
// 解析限时窗口时间：接受毫秒时间戳或可被 Date.parse 识别的字符串（管理页用 datetime-local）
function parseWindow(from, to) {
  function one(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) return Math.round(v);
    const t = Date.parse(String(v));
    return isFinite(t) ? t : NaN;
  }
  const f = one(from), t = one(to);
  if (Number.isNaN(f) || Number.isNaN(t)) return { error: '时间格式无法识别' };
  if (f && t && f >= t) return { error: '开始时间必须早于结束时间' };
  return { openFrom: f, openTo: t };
}
// 钓点在地图上的位置：地图宽高的百分比 [x, y]（后台「渔场钓点」页可拖动设置）。
// 夹到 2 ~ 98：拖到边缘时仍留出节点自身的宽度，避免图标被裁掉或点不到。
function normalizeSpotPos(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const x = Number(v[0]), y = Number(v[1]);
  if (!isFinite(x) || !isFinite(y)) return null;
  const cl = function (n) { return Math.round(Math.max(2, Math.min(98, n)) * 10) / 10; };
  return [cl(x), cl(y)];
}
// 从快照重建 D.GROUNDS（每次配置变更后调用；幂等）
function applyGroundCfg() {
  const cfg = world.groundCfg || {};
  const removedG = {}; removeListOf('grounds').forEach(function (k) { removedG[k] = 1; });
  const removedS = {}; removeListOf('spots').forEach(function (k) { removedS[k] = 1; });
  const next = [];
  // 1) 目录内置渔场（排除已删除的），并过滤已删除钓点
  GROUNDS_BASE.forEach(function (g) {
    if (removedG[g.id]) return;
    const copy = JSON.parse(JSON.stringify(g));
    copy.spots = (copy.spots || []).filter(function (s) { return !removedS[g.id + ':' + s.id]; });
    copy.custom = false;
    next.push(copy);
  });
  // 2) 新建渔场（含自带钓点）
  (Array.isArray(cfg.custom) ? cfg.custom : []).forEach(function (cg) {
    if (removedG[cg.id] || next.some(function (x) { return x.id === cg.id; })) return;
    next.push({
      id: cg.id, name: cg.name, type: cg.type === 'event' ? 'event' : 'normal', desc: cg.desc || '',
      locked: false, custom: true, openFrom: cg.openFrom || null, openTo: cg.openTo || null,
      spots: (cg.spots || []).filter(function (sp) { return !removedS[cg.id + ':' + sp.id]; }).map(function (sp) {
        return { id: sp.id, name: sp.name, pool: JSON.parse(JSON.stringify(sp.pool || [])), buffs: clampSpotBuffs(sp.buffs) };
      }),
    });
  });
  // 3) 为任意渔场追加的自定义钓点
  Object.keys(cfg.customSpots || {}).forEach(function (gid) {
    const g = next.find(function (x) { return x.id === gid; });
    if (!g) return;
    (cfg.customSpots[gid] || []).forEach(function (sp) {
      if (removedS[gid + ':' + sp.id]) return;
      if (g.spots.some(function (x) { return x.id === sp.id; })) return;
      g.spots.push({ id: sp.id, name: sp.name, pool: JSON.parse(JSON.stringify(sp.pool || [])), buffs: clampSpotBuffs(sp.buffs) });
    });
  });
  // 4) 钓点级覆盖（掉落池 / 增益）
  Object.keys(cfg.spots || {}).forEach(function (k) {
    const parts = k.split(':');
    const g = next.find(function (x) { return x.id === parts[0]; });
    const sp = g && g.spots.find(function (x) { return x.id === parts[1]; });
    if (!sp) return;
    if (cfg.spots[k].pool) sp.pool = cfg.spots[k].pool;
    if (cfg.spots[k].buffs) sp.buffs = clampSpotBuffs(cfg.spots[k].buffs);
    if (cfg.spots[k].biteRate != null && cfg.spots[k].biteRate !== '') sp.biteRate = Number(cfg.spots[k].biteRate);
    if (cfg.spots[k].intervalMs != null && cfg.spots[k].intervalMs !== '') sp.intervalMs = Math.round(Number(cfg.spots[k].intervalMs));
  });
  // 4.5) 钓点在地图上的位置（后台拖动设置）：{ 'gid:sid': [x%, y%] }
  // 内置钓点在 data.js 里带默认 pos；这里只覆盖被后台改过的那些，未改动的沿用默认。
  Object.keys(cfg.spotPos || {}).forEach(function (k) {
    const parts = k.split(':');
    const g = next.find(function (x) { return x.id === parts[0]; });
    const sp = g && g.spots.find(function (x) { return x.id === parts[1]; });
    if (!sp) return;
    const pos = normalizeSpotPos(cfg.spotPos[k]);
    if (pos) sp.pos = pos;
  });
  // 5) 渔场级覆盖：名称/描述/类型/手动锁定/限时窗口（窗口外自动锁定）
  const now = Date.now();
  Object.keys(cfg.grounds || {}).forEach(function (gid) {
    const g = next.find(function (x) { return x.id === gid; });
    if (!g) return;
    const gc = cfg.grounds[gid] || {};
    if (gc.name) g.name = gc.name;
    if (gc.desc) g.desc = gc.desc;
    if (gc.type) g.type = gc.type === 'event' ? 'event' : 'normal';
    g.locked = !!gc.locked;
    g.openFrom = gc.openFrom || null;
    g.openTo = gc.openTo || null;
    if (g.openFrom && now < g.openFrom) g.locked = true;
    if (g.openTo && now > g.openTo) g.locked = true;
  });
  D.GROUNDS.length = 0;
  next.forEach(function (g) { D.GROUNDS.push(g); });
}
// 结束在某钓场钓鱼的玩家（钓场被删除/限时关闭时调用）：与锁场逻辑一致，按钓点匹配
function stopFishingAtGrounds(ids) {
  const set = {};
  (Array.isArray(ids) ? ids : [ids]).forEach(function (id) { set[id] = 1; });
  const keys = [];
  players.forEach(function (p, key) { if (p.fishing && set[p.fishing.groundId]) keys.push(key); });
  keys.forEach(function (key) { stopFishingSession(key); });
  if (keys.length) sendPlayersAll();
}
// 限时渔场到点开/关：定时重算并广播（只在状态变化时推）
let groundLockState = {};
function sweepLimitedGrounds() {
  applyGroundCfg();
  const nextState = {};
  const newlyLocked = [];
  D.GROUNDS.forEach(function (g) {
    nextState[g.id] = g.locked ? 1 : 0;
    if (groundLockState[g.id] !== undefined && groundLockState[g.id] !== nextState[g.id] && nextState[g.id]) newlyLocked.push(g.id);
  });
  const changed = Object.keys(nextState).some(function (k) { return groundLockState[k] !== nextState[k]; }) ||
    Object.keys(groundLockState).some(function (k) { return nextState[k] === undefined; });
  groundLockState = nextState;
  if (changed) {
    if (newlyLocked.length) stopFishingAtGrounds(newlyLocked);
    broadcastGroundcfg();
    if (newlyLocked.length) broadcast({ type: 'notice', msg: '⏰ 限时渔场已关闭：' + newlyLocked.map(function (id) { const g = D.GROUNDS.find(function (x) { return x.id === id; }); return g ? g.name : id; }).join('、') });
  }
}
setInterval(function () { try { sweepLimitedGrounds(); } catch (e) {} }, 30 * 1000).unref();
function saveSpotCfg(groundId, spotId, patch) {
  world.groundCfg = world.groundCfg || {};
  world.groundCfg.spots = world.groundCfg.spots || {};
  const k = groundId + ':' + spotId;
  const cur = world.groundCfg.spots[k] || {};
  if (patch.pool) cur.pool = patch.pool;
  if (patch.buffs) cur.buffs = patch.buffs;
  if (patch.biteRate !== undefined) { if (patch.biteRate == null) delete cur.biteRate; else cur.biteRate = patch.biteRate; }
  if (patch.intervalMs !== undefined) { if (patch.intervalMs == null) delete cur.intervalMs; else cur.intervalMs = patch.intervalMs; }
  world.groundCfg.spots[k] = cur;
  saveConfig();
}
// 保存钓点在（世界）地图上的坐标；同一渔场一次性保存整组，避免拖动多次写盘
function saveSpotPositions(groundId, list) {
  world.groundCfg = world.groundCfg || {};
  world.groundCfg.spotPos = world.groundCfg.spotPos || {};
  let changed = 0;
  (Array.isArray(list) ? list : []).forEach(function (e) {
    const sid = String((e && e.spotId) || '');
    if (!sid) return;
    const key = groundId + ':' + sid;
    const pos = normalizeSpotPos(e && e.pos);
    if (!pos) { if (world.groundCfg.spotPos[key]) { delete world.groundCfg.spotPos[key]; changed++; } return; }
    const cur = world.groundCfg.spotPos[key];
    if (!cur || cur[0] !== pos[0] || cur[1] !== pos[1]) { world.groundCfg.spotPos[key] = pos; changed++; }
  });
  if (changed) saveConfig();
  applyGroundCfg();
  broadcastGroundcfg();
  return changed;
}
// 钓场配置变化：向游戏端广播整份目录（图鉴产地/渔场页即时同步）
function broadcastGroundcfg() { broadcast({ type: 'groundcfg', grounds: groundsWithDrop() }); }

// 横幅颜色校验（#rgb / #rrggbb；空串表示用样式默认渐变）
function validBannerColor(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t.toLowerCase() : null;
}

// ---- 横幅滚播跟踪（内存态，不落盘）：客户端在横幅开始播放时上报 ----
// bannerPlaying = { [bannerId]: { watchers: { playerKey: lastAt }, lastAt } }
const bannerPlaying = {};
const BANNER_WATCH_TTL = 15 * 1000; // 超过该时长没有心跳的上报视为已播完
// 后台「当前滚播」视图：把每条横幅的观看人数（TTL 内）整理出来
function bannerPlayingView() {
  const now = Date.now();
  const out = [];
  Object.keys(bannerPlaying).forEach(function (id) {
    const rec = bannerPlaying[id];
    const by = {};
    Object.keys(rec.watchers || {}).forEach(function (k) {
      if (now - rec.watchers[k] <= BANNER_WATCH_TTL) by[k] = rec.watchers[k];
    });
    rec.watchers = by;
    const count = Object.keys(by).length;
    if (!count && now - (rec.lastAt || 0) > BANNER_WATCH_TTL) { delete bannerPlaying[id]; return; }
    const bn = (world.banners || []).find(function (x) { return x.id === id; });
    out.push({ id: id, content: bn ? bn.content : '（已从队列移除）', count: count, lastAt: rec.lastAt || 0 });
  });
  return out.sort(function (a, b) { return b.count - a.count || b.lastAt - a.lastAt; });
}

// 顶号：使该账号所有旧会话失效并断开其实时连接（一个账号同时只允许一个在线窗口）
function kickUserSessions(key) {
  const dead = [];
  sessions.forEach(function (v, h) { if (v && v.key === key) dead.push(h); });
  dead.forEach(function (h) { sessions.delete(h); }); // 使旧 token 全部失效（顶号核心）
  if (dead.length) saveSessions();
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

function basePrice(id) { const ov = priceOvOf(id); if (ov && ov.base > 0) return Math.round(ov.base); return ECO_PRICE[id] || (D.itemOf(id).price || 10); }
function itemName(id) { return ITEM_NAME[id] || D.itemOf(id).name || id; }
// 物品是否可出售/上架：渔获、材料、组件实例、旧通用组件
function sellableOf(id) { return D.isSellable(id) || id === 'comp_generic'; }
// 单件成交价：经济物品随供需浮动；组件实例与旧通用组件为固定价
function unitPriceOf(id) { return ECO_PRICE[id] ? currentPrice(id) : (D.itemOf(id).price || 10); }

// ---- 自动售出（玩家自助规则，规则存在账号上）----
// v0.13.8 重做：由「钓到即按价格线全量卖出」改为「按件启用 + 保留量 + 攒够一包再卖」。
// 规则模型： rec.autoSell = { items: { <物品id>: { on, minPct, minPrice, slackPct, slackPrice, keep } } }
//   · on       —— 该物品是否参与自动售出（关掉只停用，阈值原样保留）
//   · minPct   —— 基准价百分比线（150 = 基准的 150%）；minPrice —— 绝对价格线；
//                 两条都空 = 不看价格，只看保留量与打包阈值（材料常用的「留够就卖多余的」）
//   · keep     —— 最少保留数量：可用量里先扣掉 keep，只有超出的部分会被卖
// 可参与的物品 = 渔获 + 材料（组件/宝匣/钓竿不参与，它们走市集）。
// 打包（带宽）：可卖余量 = 可用量 − keep，攒够全服阈值（world.autoSellCfg.batch，后台可调）
// 才成交一次；命中即整批卖出，一次推送包含全部物品——省掉逐条上鱼的 notice/assets 往返。
// 触发时机：钓到入包后 / 每分钟价格采样（价格回升越过阈值）/ 登录读档 / 规则保存 / 后台模拟上鱼。
// 出售走与手动 /api/sell 完全相同的经济路径（单乘数下压、今日售出、交易流水），行情一致。
const AUTO_SELL_BATCH_DEFAULT = 100; // 默认打包阈值（条）
const AUTO_SELL_BATCH_MAX = 10000;
const AUTOSELL_BATCH_ENV = parseInt(process.env.AUTOSELL_BATCH, 10) || 0; // 测试/运维固定阈值（优先于后台配置）
function autoSellBatchOf() {
  if (AUTOSELL_BATCH_ENV >= 1) return Math.min(AUTOSELL_BATCH_ENV, AUTO_SELL_BATCH_MAX);
  const v = parseInt(world.autoSellCfg && world.autoSellCfg.batch, 10);
  return (isFinite(v) && v >= 1 && v <= AUTO_SELL_BATCH_MAX) ? v : AUTO_SELL_BATCH_DEFAULT;
}
function autoSellCfgOf() { return { batch: autoSellBatchOf(), def: AUTO_SELL_BATCH_DEFAULT, max: AUTO_SELL_BATCH_MAX }; }
// 可参与自动售出的物品：渔获与材料（其余类别不可）
function autoSellEligibleId(id) {
  const k = D.itemOf(id).kind;
  return k === 'fish' || k === 'material';
}
function autoSellIdsOfKind(kind) {
  return D.allItems().filter(function (it) { return it.kind === kind; }).map(function (it) { return it.id; });
}
function autoSellItems(rec) { return (rec && rec.autoSell && rec.autoSell.items) || null; }
function autoSellRuleOf(rec, id) { const t = autoSellItems(rec); return (t && t[id]) || null; }
function autoSellKeepOf(rule) {
  const n = Math.floor(Number(rule && rule.keep));
  return (isFinite(n) && n > 0) ? n : 0;
}
// 价格线判定：浮动接受值（slack）允许在「阈值 − 浮动」提前成交，避免行情在阈值附近回落时错过；
// 有效线最低钳到 1（百分比 1% / 价格 1💰），填多大浮动都不会变成无条件卖出。
function autoSellHit(rec, id, rule) {
  const r = rule || autoSellRuleOf(rec, id);
  if (!r) return null;
  const base = basePrice(id);
  const price = currentPrice(id);
  const pctLine = r.minPct != null ? Math.max(1, r.minPct - (Number(r.slackPct) || 0)) : null;
  const priceLine = r.minPrice != null ? Math.max(1, r.minPrice - (Number(r.slackPrice) || 0)) : null;
  if (pctLine == null && priceLine == null) return { price: price, base: base, by: '无条件' };
  const pctOk = pctLine != null && base > 0 && price >= base * pctLine / 100;
  const priceOk = priceLine != null && price >= priceLine;
  return (pctOk || priceOk) ? { price: price, base: base, by: pctOk ? '基准' : '价格' } : null;
}
// 可卖余量：可用量（v0.13.6 起大型/巨型为预留量，自动售出只动普通量）− 最少保留量
// v0.14.0：账号开了「体型档」开关后，可卖余量改用**持有总量**（＝可用量 + 大型/巨型预留量），
// 也就是档位鱼也参与自动售出（成交时走各自通道、含 +50% / +150% 加成）。
function autoSellTierOn(rec) { return !!(rec && rec.autoSell && rec.autoSell.tier); }
function autoSellExcess(rec, id, rule) {
  const pool = autoSellTierOn(rec) ? invCountOf(rec, id) : invAvailOf(rec, id);
  return pool - autoSellKeepOf(rule);
}
// 打包计划（v0.13.9 口径）：打包阈值对「已启用物品的合计」判定，不再逐件判定。
//   可入账余量 = 可用量 − 保留量（> 0 才有意义），价格达标的记入 pool；
//   pool ≥ batch 才打包成交一次，成交时这些物品各自的余量一起结算（一次推送，省往返）。
// ⚠️ 价格未达标的余量**不计入 pool**：否则它们会永远把合计顶在阈值之上，
//    退化成「每上一条鱼就推一次」，把打包省带宽的意义抹掉（blocked 只用于界面提示）。
function autoSellPlan(rec) {
  const items = autoSellItems(rec);
  if (!items) return null;
  const list = [];
  let pool = 0, blocked = 0;
  Object.keys(items).forEach(function (id) {
    const rule = items[id];
    if (!rule || !rule.on) return;
    if (!autoSellEligibleId(id)) return;
    const excess = autoSellExcess(rec, id, rule);
    if (excess <= 0) return;
    const hit = autoSellHit(rec, id, rule);
    if (!hit) { blocked += excess; return; }
    pool += excess;
    list.push({ id: id, rule: rule, excess: excess, hit: hit });
  });
  return { list: list, pool: pool, blocked: blocked, batch: autoSellBatchOf() };
}
// 界面用视图：前端右栏 / 清单据此展示「合计可卖 / 还差多少 / 哪些因价格未达标不计入」
function autoSellPlanView(rec) {
  const p = autoSellPlan(rec);
  if (!p) return { pool: 0, blocked: 0, batch: autoSellBatchOf(), ready: 0, items: {} };
  const items = {};
  p.list.forEach(function (x) {
    items[x.id] = { excess: x.excess, keep: autoSellKeepOf(x.rule), by: x.hit.by };
  });
  return { pool: p.pool, blocked: p.blocked, batch: p.batch, ready: p.list.length, items: items };
}
// 扫描启用中的物品并按系统行情卖出；只有「已启用物品的可卖余量合计 ≥ 打包阈值」才成交，返回明细（无则 null）
function autoSellCheck(key) {
  if (Features.blocked(world.features, 'mall.autosell') || Features.blocked(world.features, 'mall.sell')) return;
  const rec = users[key];
  if (!rec) return null;
  const plan = autoSellPlan(rec);
  if (!plan || !plan.list.length) return null;
  const batch = plan.batch;
  if (plan.pool < batch) return null;                    // 合计没攒够一包 → 不成交（省带宽的关键）
  const sold = [];
  plan.list.forEach(function (x) {
    const id = x.id, rule = x.rule;
    const unit = unitPriceOf(id);
    // v0.14.0：可能要卖的量分成普通量与档位量两截——普通通道先卖，
    // 档位量按「大型 → 巨型」的顺序动用（加成更高的巨型留到最后，玩家想留大鱼更划算）。
    let need = x.excess;
    const parts = [];
    const fromNormal = Math.min(need, invAvailOf(rec, id));
    if (fromNormal > 0) { need -= fromNormal; parts.push({ tier: null, qty: fromNormal }); }
    ['L', 'G'].forEach(function (t) {
      if (need <= 0) return;
      const bf = rec.bigfish && rec.bigfish[id];
      const have = (bf && bf[t]) || 0;
      const q = Math.min(need, have);
      if (q > 0) { need -= q; parts.push({ tier: t, qty: q }); }
    });
    let gainOfItem = 0, bonusOfItem = 0;
    parts.forEach(function (pt) {
      const bonus = pt.tier ? Math.round(unit * pt.qty * SIZE_TIER_BONUS[pt.tier]) : 0;
      invAdd(rec, id, -pt.qty);
      if (pt.tier) bigfishDropOf(rec, id, pt.tier, pt.qty);
      rec.coins += unit * pt.qty + bonus;
      gainOfItem += unit * pt.qty + bonus;
      bonusOfItem += bonus;
      if (ECO_PRICE[id]) registerSale(id, pt.qty, rec.name + '·自动', unit);
    });
    if (!gainOfItem) return;
    sold.push({ id: id, name: itemName(id), qty: x.excess, unit: unit, gain: gainOfItem, bonus: bonusOfItem, by: x.hit.by, keep: autoSellKeepOf(rule) });
  });
  if (!sold.length) return null;
  saveAccount(key); saveEconomy(); broadcastShop();
  const total = sold.reduce(function (s, x) { return s + x.gain; }, 0);
  // v0.13.10：播报只留「卖了什么、进账多少」——括号里的细则（规则命中 / 合计与阈值）不再展示，
  // 玩家反馈那样太长、横幅要占两行。（明细仍可从商城 → 收购 → 自动售出清单里看到。）
  sendTo(key, { type: 'notice', msg: '🤖 自动售出 ' + sold.map(function (x) { return x.name + '×' + x.qty; }).join('、') +
    '，+ ' + total + '💰' });
  sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount, bigfish: rec.bigfish || null });
  return sold;
}
// v0.13.8 存量迁移：旧结构 { all, fish:{id:{...}} } → { items:{ id:{ on, ... } } }。
// 旧的「全部鱼」通配规则展开成逐鱼规则（阈值原样继承、保留量 0），保证老玩家的规则不丢。
function migrateAutoSell() {
  let n = 0;
  Object.keys(users).forEach(function (k) {
    const rec = users[k];
    const a = rec && rec.autoSell;
    if (!a || a.items) return;
    const items = {};
    const put = function (id, r) {
      items[id] = {
        on: true,
        minPct: r.minPct != null ? r.minPct : null,
        minPrice: r.minPrice != null ? r.minPrice : null,
        slackPct: Number(r.slackPct) || 0,
        slackPrice: Number(r.slackPrice) || 0,
        keep: 0,
      };
    };
    Object.keys(a.fish || {}).forEach(function (id) { if (autoSellEligibleId(id)) put(id, a.fish[id]); });
    if (a.all) autoSellIdsOfKind('fish').forEach(function (id) { if (!items[id]) put(id, a.all); });
    rec.autoSell = { items: items };
    saveAccount(k);
    n++;
  });
  if (n) console.log('[migrate] 自动售出规则升级为逐物品结构（' + n + ' 个账号；旧「全部鱼」规则已展开到各鱼种）');
}

// ---- 市集挂单规则：同时挂单上限默认每人 40 个（账号可用 listingCap 单独覆盖，0 = 不限）；
//      时长 6/12/24 小时对应费率 1%/3%/5%，过期退物品不退费 ----
const DEFAULT_LISTING_CAP = 40;
// 挂单上限：未设置 → 默认 40；显式 0 → 不限
function listingCapOf(rec) {
  const n = Math.floor(Number(rec && rec.listingCap));
  return (isFinite(n) && n >= 0) ? n : DEFAULT_LISTING_CAP;
}
const LIST_FEE_RATES = { 6: 0.01, 12: 0.03, 24: 0.05 };
// v0.14.0：鱼类暂时不许上市集（临时开关；前端 frontend/js/ui.js 有同名常量，恢复时两边一起改）。
// 已有挂单不受影响（照常可买 / 可下架），只拦新上架。
// 运维/测试逃生口：环境变量 MARKET_FISH_LIST=1 可恢复（既有回归套件里大量用例拿鱼当「方便的上架素材」，
// 那些套件在自己的 spawn env 里带这个变量；线上不要带）。
const MARKET_FISH_LIST = process.env.MARKET_FISH_LIST === '1';
const LISTING_TTL_MS_ENV = Number(process.env.LISTING_TTL_MS) || 0; // 测试用固定 TTL

// ---- 动态收购价（服务器权威 · 单乘数模型 · 参数全程可调）----
// 每个物品维护一个价格乘数 m ∈ [floor, ceil]（默认 [0.4, 2.0]），实际价 = 基准价 × m：
//   售出：m 每件除以 (1 + saleDivisor)（成比例下压——2 倍价卖一件不会一键跌回原价）；
//   闲置：m 以 riseTauMin 为时间常数向 riseTargetPct 指数靠拢（高于目标缓慢回落，低于目标缓慢回升）。
// 涨跌共用同一个乘数，状态连续、无跳变。
// 全部参数由后台「💰 经济参数」页配置（world.priceCfg，落 config.json）：
//   保存时逐项校验范围，读取时再次收敛——历史文件被手改或旧值越界都不会让模型失稳。
const PRICE_DEFAULTS = {
  floorPct: 40,        // 地板（% 基准价，10-100）
  ceilPct: 200,        // 天花板（% 基准价，100-500）
  saleDivisor: 0.0075, // 每售 1 件乘数 ÷(1+divisor)（0.001-0.05，即 -0.1%~-5%/件）
  riseTauMin: 60,      // 闲置靠拢时间常数（分钟，5-1440）
  riseTargetPct: 200,  // 闲置靠拢目标（% 基准价，100-300；默认=天花板）
  sampleSec: 60,       // 价格采样间隔（秒，15-300）
  historyMin: 360,     // 价格历史保留时长（分钟，60-1440）
};
// 产出倍率（后台「💰 经济参数」页；百分比，0-500）= 掉落池权重倍率，全局 × 分类
const DROP_DEFAULTS = { global: 100, common: 100, big: 100, rare: 100, material: 100 };
const DROP_KEYS = ['global', 'common', 'big', 'rare', 'material'];
function clampNum(v, lo, hi, dft) {
  const n = Number(v);
  return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dft;
}
// 生效参数（含范围收敛；tiers 为品质层覆盖，仅 saleDivisor / riseTauMin 支持）
function priceCfg() {
  const c = world.priceCfg || {};
  const ceilPct = clampNum(c.ceilPct, 100, 500, PRICE_DEFAULTS.ceilPct);
  const tiers = {};
  const srcTiers = c.tiers || {};
  ['common', 'big', 'rare'].forEach(function (tier) {
    const o = srcTiers[tier];
    if (!o) return;
    const e = {};
    if (o.saleDivisor != null) e.saleDivisor = clampNum(o.saleDivisor, 0.001, 0.05, PRICE_DEFAULTS.saleDivisor);
    if (o.riseTauMin != null) e.riseTauMin = clampNum(o.riseTauMin, 5, 1440, PRICE_DEFAULTS.riseTauMin);
    if (Object.keys(e).length) tiers[tier] = e;
  });
  return {
    floorPct: clampNum(c.floorPct, 10, 100, PRICE_DEFAULTS.floorPct),
    ceilPct: ceilPct,
    saleDivisor: clampNum(c.saleDivisor, 0.001, 0.05, PRICE_DEFAULTS.saleDivisor),
    riseTauMin: clampNum(c.riseTauMin, 5, 1440, PRICE_DEFAULTS.riseTauMin),
    riseTargetPct: clampNum(c.riseTargetPct, 100, 300, ceilPct),
    sampleSec: clampNum(c.sampleSec, 15, 300, PRICE_DEFAULTS.sampleSec),
    historyMin: clampNum(c.historyMin, 60, 1440, PRICE_DEFAULTS.historyMin),
    tiers: Object.keys(tiers).length ? tiers : null,
  };
}
function dropCfg() {
  const c = world.dropCfg || {};
  const out = {};
  DROP_KEYS.forEach(function (k) { out[k] = clampNum(c[k], 0, 500, 100); });
  return out;
}
function dropCfgIsDefault() {
  const c = world.dropCfg || {};
  return DROP_KEYS.every(function (k) { return c[k] == null || clampNum(c[k], 0, 500, 100) === 100; });
}
// 下发用钓场目录：产出倍率不为默认时，把有效权重换算后返回（图鉴/钓点详情与实钓概率一致；服务端落盘权重不受影响）
function groundsWithDrop() {
  if (dropCfgIsDefault()) return D.GROUNDS;
  const dc = dropCfg();
  return D.GROUNDS.map(function (g) {
    return Object.assign({}, g, {
      spots: (g.spots || []).map(function (s) {
        return Object.assign({}, s, {
          pool: (s.pool || []).map(function (e) {
            const i = e.pick.indexOf(':');
            const type = e.pick.slice(0, i), id = e.pick.slice(i + 1);
            let mult = dc.global / 100;
            if (type === 'fish') {
              const tier = D.fishTierOf(id);
              if (tier === 'big') mult *= dc.big / 100;
              else if (tier === 'rare') mult *= dc.rare / 100;
              else mult *= dc.common / 100;
            } else if (type === 'material') mult *= dc.material / 100;
            return { pick: e.pick, weight: Math.round(e.weight * mult * 1000) / 1000 };
          }),
        });
      }),
    });
  });
}
// 品质层动态覆盖（普通/大鱼/稀有各自可覆盖 下压/回升；未覆盖 = 跟随全局）
function tierDynOf(tier) {
  if (!tier) return null;
  const t = (world.priceCfg && world.priceCfg.tiers) || {};
  const o = t[tier];
  if (!o) return null;
  const out = {};
  if (o.saleDivisor != null) out.saleDivisor = clampNum(o.saleDivisor, 0.001, 0.05, null);
  if (o.riseTauMin != null) out.riseTauMin = clampNum(o.riseTauMin, 5, 1440, null);
  return (out.saleDivisor != null || out.riseTauMin != null) ? out : null;
}
// 某物品的生效率（品质层覆盖优先于全局）
function dynOf(id) {
  const g = priceCfg();
  const tc = D.fishTierOf ? tierDynOf(D.fishTierOf(id)) : null;
  return {
    saleDivisor: (tc && tc.saleDivisor != null) ? tc.saleDivisor : g.saleDivisor,
    riseTauMin: (tc && tc.riseTauMin != null) ? tc.riseTauMin : g.riseTauMin,
    floor: g.floorPct / 100,
    ceil: g.ceilPct / 100,
    target: g.riseTargetPct / 100,
  };
}
// 单品干预（运营工具）：world.priceOv = { [id]: { base?, m?, until? } }
//   base = 覆盖基准价；m = 锁定乘数（无视供需）；until = 过期时间戳（到时自动失效）
function priceOvOf(id) {
  const o = world.priceOv && world.priceOv[id];
  if (!o) return null;
  if (o.until && Date.now() > o.until) return null;
  return o;
}
// 清理已过期的单品覆盖（后台读取/保存时顺带调用，避免残留）
function sweepPriceOv() {
  const ov = world.priceOv;
  if (!ov) return false;
  let changed = false;
  Object.keys(ov).forEach(function (id) {
    const o = ov[id];
    if (!o) return;
    if (o.until && Date.now() > o.until) { delete ov[id]; changed = true; }
    else if (o.base == null && o.m == null) { delete ov[id]; changed = true; }
  });
  return changed;
}
// 经济改动审计（后台每次调参/干预留痕，落 economy.json，玩家端不可见）
function econLog(who, text) {
  world.economyLog = world.economyLog || [];
  world.economyLog.push({ t: Date.now(), who: who || '?', text: text });
  if (world.economyLog.length > 200) world.economyLog.splice(0, world.economyLog.length - 200);
}

// 当前乘数（含闲置靠拢；无状态计算，不写存储）
function currentMultiplier(s, now, id) {
  const dyn = id ? dynOf(id) : { riseTauMin: priceCfg().riseTauMin, floor: priceCfg().floorPct / 100, ceil: priceCfg().ceilPct / 100, target: priceCfg().riseTargetPct / 100 };
  const idle = Math.max(0, now - (s.lastTs || now));
  const m0 = Math.min(dyn.ceil, Math.max(dyn.floor, s.m == null ? 1 : s.m));
  const tauMs = dyn.riseTauMin * 60000;
  return Math.min(dyn.ceil, Math.max(dyn.floor, dyn.target - (dyn.target - m0) * Math.exp(-idle / tauMs)));
}
function currentPrice(id) {
  const ov = priceOvOf(id);
  if (ov && ov.m > 0) return Math.max(1, Math.round(basePrice(id) * ov.m)); // 锁价：无视供需
  const s = world.shopSales[id];
  if (!s) return basePrice(id);
  return Math.max(1, Math.round(basePrice(id) * currentMultiplier(s, Date.now(), id)));
}
// 售出：压低乘数 + 统计交易量 + 记录价格点 + 交易流水（同账号一分钟内由前端合并展示）
function registerSale(id, qty, who, unit) {
  const s = world.shopSales[id] || { m: 1, lastTs: Date.now(), soldTotal: 0, soldToday: 0, day: null };
  const dyn = dynOf(id);
  const cur = currentMultiplier(s, Date.now(), id);
  s.m = Math.max(dyn.floor, cur / Math.pow(1 + dyn.saleDivisor, qty));
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
// 价格历史采样：售出即时记点 + 全量周期采样（捕捉无人供应时的缓慢涨落）
function recordPrice(id) {
  const P = priceCfg();
  world.priceLog = world.priceLog || {};
  const log = world.priceLog[id] || (world.priceLog[id] = []);
  const p = currentPrice(id);
  const last = log[log.length - 1];
  if (!last || last.p !== p || Date.now() - last.t > P.sampleSec * 1000) log.push({ t: Date.now(), p: p });
  const maxPts = Math.max(30, Math.round(P.historyMin * 60 / P.sampleSec));
  if (log.length > maxPts) log.splice(0, log.length - maxPts);
}
// 采样定时器：间隔可调（保存 sampleSec 后重挂）
let priceSamplerTimer = null;
function armPriceSampler() {
  if (priceSamplerTimer) clearInterval(priceSamplerTimer);
  const sec = priceCfg().sampleSec;
  priceSamplerTimer = setInterval(function () {
    Object.keys(ECO_PRICE).forEach(recordPrice);
    try { saveEconomy(); } catch (e) {}
    // 自动售出：价格闲置回升可能越过玩家设的阈值 → 对在线玩家跑一遍
    players.forEach(function (p, key) { try { autoSellCheck(key); } catch (e) {} });
  }, sec * 1000);
  priceSamplerTimer.unref();
}
armPriceSampler();

// ================================================================
// ---- 服务器统计采样（后台概览「服务器热力图」的数据源）----
// 每 60 秒记一条：在线 / 正在钓鱼 / 市集挂单 / 进行中交易 / 注册账号。
//  - statMin：分钟样本，保留 24 小时（近 1-6 小时的细节靠它）
//  - statHour：小时聚合（均值 + 峰值），保留 30 天（热力格与 7/30 天曲线靠它）
// 每隔 10 条采样才落盘（约 10 分钟），不会每分钟重写整个文件。
// ================================================================
function statsLive() {
  let fishing = 0;
  // v0.16.0：概览热力图支持按钓场 / 钓点筛选，所以采样时按钓场与钓点分别统计**正在钓鱼的人数**。
  // 只记非零项，样本很小（多数时刻只有几个钓点有人）。
  const grounds = {}, spots = {};
  players.forEach(function (pl) {
    if (pl.status !== 'fishing') return;
    fishing++;
    if (!pl.groundId) return;
    grounds[pl.groundId] = (grounds[pl.groundId] || 0) + 1;
    if (pl.spotId) {
      const sk = pl.groundId + ':' + pl.spotId;
      spots[sk] = (spots[sk] || 0) + 1;
    }
  });
  let activeTrades = 0;
  trades.forEach(function (t) { if (!t.done && !t.cancelled) activeTrades++; });
  return {
    t: Math.floor(Date.now() / HEAT_STATS.gapMs) * HEAT_STATS.gapMs,
    online: players.size,
    fishing: fishing,
    listings: world.listings.length,
    trades: activeTrades,
    users: Object.keys(users).length,
    grounds: grounds,
    spots: spots,
  };
}
let statsDirty = 0;
let statsFlushed = false;   // 首次采样先落一次盘：重启后立刻有历史，不会从空曲线开始
function statsSample() {
  const s = statsLive();
  const min = world.statMin || (world.statMin = []);
  const last = min[min.length - 1];
  if (last && last.t >= s.t) return;   // 同一分钟内被重复调用：不重复记
  min.push(s);
  if (min.length > HEAT_STATS.min) min.splice(0, min.length - HEAT_STATS.min);
  // 小时聚合：同一小时内在最后一条上累加，滚到下一小时就开新桶
  const hour = world.statHour || (world.statHour = []);
  const hT = Math.floor(s.t / 3600000) * 3600000;
  let h = hour[hour.length - 1];
  const rolled = !h || h.t !== hT;
  if (rolled) {
    h = { t: hT, n: 0, oSum: 0, oMax: 0, fSum: 0, lSum: 0, trSum: 0, uLast: 0, gSum: {}, sSum: {} };
    hour.push(h);
    if (hour.length > HEAT_STATS.hour) hour.splice(0, hour.length - HEAT_STATS.hour);
  }
  // 按钓场 / 钓点的钓鱼人数：小时桶里累加，长区间（7/30 天）也能按钓点出曲线
  h.gSum = h.gSum || {}; h.sSum = h.sSum || {};
  Object.keys(s.grounds || {}).forEach(function (k) { h.gSum[k] = (h.gSum[k] || 0) + s.grounds[k]; });
  Object.keys(s.spots || {}).forEach(function (k) { h.sSum[k] = (h.sSum[k] || 0) + s.spots[k]; });
  h.n++; h.oSum += s.online; h.oMax = Math.max(h.oMax, s.online);
  h.fSum += s.fishing; h.lSum += s.listings; h.trSum += s.trades; h.uLast = s.users;
  if (s.online > ((world.statPeak && world.statPeak.online) || 0)) world.statPeak = { online: s.online, t: s.t };
  statsDirty++;
  // 落盘：首次采样 / 每 10 条 / 整点换桶（整点检查点），其余时刻不重写文件
  if (statsDirty >= HEAT_STATS.flushEvery || !statsFlushed || rolled) {
    statsDirty = 0; statsFlushed = true;
    try { saveStats(); } catch (e) {}
  }
}
// 区间档位：短区间用分钟样本（越短步长越细），长区间用小时样本
const STATS_RANGES = {
  '1h': { span: 3600000, step: 60000, src: 'min' },
  '6h': { span: 6 * 3600000, step: 5 * 60000, src: 'min' },
  '24h': { span: 24 * 3600000, step: 10 * 60000, src: 'min' },
  '7d': { span: 7 * 86400000, step: 3600000, src: 'hour' },
  '30d': { span: 30 * 86400000, step: 6 * 3600000, src: 'hour' },
};
// 区间曲线 + 星期×小时热力格（热力格取最近 28 天的小时样本，按服务器本地时间落格）
// filter：{ ground: 钓场 id, spot: '钓场:钓点' } —— 两者都空 = 全服口径（原有行为）。
// 带筛选时，曲线与热力格改用「该钓场 / 该钓点当前正在钓鱼的人数」，其余全局指标仍在 points 里返回。
function statsReport(range, filter) {
  const rf = STATS_RANGES[range] ? range : '24h';
  const R = STATS_RANGES[rf];
  const fGround = (filter && filter.ground) ? String(filter.ground) : '';
  const fSpot = (filter && filter.spot) ? String(filter.spot) : '';
  const areaOf = function (grounds, spots) {
    if (fSpot) return (spots && spots[fSpot]) || 0;
    if (fGround) return (grounds && grounds[fGround]) || 0;
    return null;
  };
  const now = Date.now();
  const from = now - R.span;
  const acc = {};
  const put = function (t, o, oMax, f, l, tr, u, area) {
    const key = Math.floor(t / R.step) * R.step;
    const b = acc[key] || (acc[key] = { t: key, n: 0, oSum: 0, oMax: 0, fSum: 0, lSum: 0, trSum: 0, uLast: 0, aSum: 0, aN: 0 });
    b.n++; b.oSum += o; b.oMax = Math.max(b.oMax, oMax); b.fSum += f; b.lSum += l; b.trSum += tr; b.uLast = u;
    if (area != null) { b.aSum += area; b.aN++; }
  };
  if (R.src === 'min') {
    (world.statMin || []).forEach(function (s) {
      if (s.t < from) return;
      put(s.t, s.online, s.online, s.fishing, s.listings, s.trades, s.users, areaOf(s.grounds, s.spots));
    });
  } else {
    (world.statHour || []).forEach(function (h) {
      if (h.t < from || !h.n) return;
      const area = fSpot ? ((h.sSum && h.sSum[fSpot]) || 0) / h.n
        : (fGround ? ((h.gSum && h.gSum[fGround]) || 0) / h.n : null);
      put(h.t, h.oSum / h.n, h.oMax, h.fSum / h.n, h.lSum / h.n, h.trSum / h.n, h.uLast, area);
    });
  }
  const live = statsLive();
  put(live.t, live.online, live.online, live.fishing, live.listings, live.trades, live.users, areaOf(live.grounds, live.spots)); // 曲线始终连到「现在」
  const r1 = function (v) { return Math.round(v * 10) / 10; };
  const points = Object.keys(acc).map(function (k) { return acc[k]; })
    .sort(function (x, y) { return x.t - y.t; })
    .map(function (b) {
      return {
        t: b.t, n: b.n,
        online: r1(b.oSum / b.n), onlineMax: b.oMax,
        fishing: r1(b.fSum / b.n), listings: r1(b.lSum / b.n),
        trades: r1(b.trSum / b.n), users: b.uLast,
        // 筛选口径下的「本钓场 / 本钓点钓鱼人数」（未筛选时为 null）
        area: b.aN ? r1(b.aSum / b.aN) : (fSpot || fGround ? 0 : null),
      };
    });
  const grid = [], cnt = [];
  for (let i = 0; i < 7; i++) { grid.push(new Array(24).fill(0)); cnt.push(new Array(24).fill(0)); }
  const heatDays = 28;
  const heatFrom = now - heatDays * 86400000;
  const srcH = (world.statHour || []).filter(function (h) { return h.t >= heatFrom && h.n; });
  (srcH.length ? srcH : (world.statMin || [])).forEach(function (s) {
    const d = new Date(s.t);
    const wd = (d.getDay() + 6) % 7;   // 周一 = 0
    const hh = d.getHours();
    if (fSpot || fGround) {
      // 筛选口径：热力格画「该钓点 / 钓场在星期×小时的钓鱼人数均值」
      const area = s.n
        ? (fSpot ? ((s.sSum && s.sSum[fSpot]) || 0) / s.n : ((s.gSum && s.gSum[fGround]) || 0) / s.n)
        : areaOf(s.grounds, s.spots);
      grid[wd][hh] += area || 0;
    } else {
      grid[wd][hh] += (s.n ? (s.oSum / s.n) : s.online) || 0;
    }
    cnt[wd][hh] += 1;
  });
  let heatMax = 0;
  const heat = grid.map(function (row, i) {
    return row.map(function (v, j) {
      const n = cnt[i][j];
      if (!n) return null;
      const avg = Math.round(v / n * 10) / 10;
      if (avg > heatMax) heatMax = avg;
      return avg;
    });
  });
  return {
    range: rf, step: R.step, span: R.span, from: from, now: now,
    points: points, heat: heat, heatN: cnt, heatMax: heatMax, heatDays: heatDays,
    filter: { ground: fGround, spot: fSpot, areaLabel: fSpot || fGround ? '该钓点钓鱼人数' : '' },
    peak: world.statPeak || { online: 0, t: 0 }, live: live,
    // 概览筛选下拉用的钓场 / 钓点目录（含人数为 0 的，便于随时切换）
    grounds: D.GROUNDS.map(function (g) {
      return { id: g.id, name: g.name, spots: (g.spots || []).map(function (sp) { return { id: sp.id, name: sp.name, key: g.id + ':' + sp.id }; }) };
    }),
    samples: { min: (world.statMin || []).length, hour: (world.statHour || []).length },
  };
}
let statsSamplerTimer = null;
function armStatsSampler() {
  if (statsSamplerTimer) clearInterval(statsSamplerTimer);
  try { statsSample(); } catch (e) {}   // 启动即记一条：重启后曲线马上就有右端点
  statsSamplerTimer = setInterval(function () {
    try { statsSample(); } catch (e) { console.error('[statsSample] ' + ((e && e.stack) || e)); }
  }, HEAT_STATS.gapMs);
  statsSamplerTimer.unref();
}

// ---- 落盘原语（同步写、整文件重写；单账号/单域粒度） ----
// v0.13.9：写失败不再「静默丢一份数据」——失败的文件重新放回脏集合（dirtyFiles），
// 到点后重试整份写入。账号文件持有的就是内存里的活对象，重试时写的是最新状态。
// 重试有上限（SAVE_RETRY_MAX），避免磁盘满 / 权限错误时无限循环刷盘刷日志。
const SAVE_RETRY_MAX = 5;          // 同一文件连续写失败的重试上限
const SAVE_RETRY_MS = 3000;        // 下次重试（flush 脏文件）的间隔
const dirtyFiles = new Map();      // fp -> { obj, n }：写失败待重试的文件（n = 连续失败次数）
let dirtyFileTimer = null;
let processExiting = false;        // 退出钩子里不再排队重试（定时器已不会执行）
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8') || 'null'); } catch (e) { return null; } }
function writeJson(fp, obj) {
  try {
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
    dirtyFiles.delete(fp);         // 写成功：清掉该文件的失败计数与待重试数据
    return true;
  } catch (e) {
    console.error('[save] ' + fp + ' 写入失败：' + e.message);
    markFileDirty(fp, obj);
    return false;
  }
}
function markFileDirty(fp, obj) {
  if (processExiting) return;
  const n = ((dirtyFiles.get(fp) || {}).n || 0) + 1;
  if (n > SAVE_RETRY_MAX) {
    dirtyFiles.delete(fp);
    console.error('[save] ' + fp + ' 已连续失败 ' + SAVE_RETRY_MAX + ' 次，放弃本轮重试（内存数据仍在，下次改动会再触发落盘）');
    return;
  }
  dirtyFiles.set(fp, { obj: obj, n: n });
  if (!dirtyFileTimer) {
    dirtyFileTimer = setTimeout(flushDirtyFiles, SAVE_RETRY_MS);
    if (dirtyFileTimer.unref) dirtyFileTimer.unref();
  }
}
function flushDirtyFiles(finalAttempt) {
  dirtyFileTimer = null;
  if (!dirtyFiles.size) return;
  Array.from(dirtyFiles.entries()).forEach(function (pair) {
    const fp = pair[0], ent = pair[1];
    if (dirtyFiles.get(fp) !== ent) return;   // 期间已被写成功 / 被新数据替换
    try {
      fs.writeFileSync(fp, JSON.stringify(ent.obj, null, 2));
      dirtyFiles.delete(fp);
    } catch (e) {
      console.error('[save] ' + fp + ' 第 ' + ent.n + ' 次重试写入失败：' + e.message);
      if (ent.n >= SAVE_RETRY_MAX) {
        dirtyFiles.delete(fp);
        console.error('[save] ' + fp + ' 已达重试上限 ' + SAVE_RETRY_MAX + '，放弃本轮重试');
      } else {
        ent.n++;
      }
    }
  });
  if (!finalAttempt && dirtyFiles.size) {
    dirtyFileTimer = setTimeout(flushDirtyFiles, SAVE_RETRY_MS);
    if (dirtyFileTimer.unref) dirtyFileTimer.unref();
  }
}
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
// ---- 性能修复(perf-1)：账号写盘改为「脏标记 + 定时批量异步落盘」----
// 原实现每竿捕获都同步 fs.writeFileSync 整份账号 JSON，高在线 + 高钓速时事件循环
// 被同步 IO 塞满（实测 200 人即饱和、新玩家无法进入）。现在 saveAccount 只做内存标记，
// 统一由 1s 定时器批量刷盘；进程退出前强制刷一次，保证数据不丢。
const dirtyAccounts = new Set();
let accountFlushTimer = null;
function saveAccount(key) {
  const rec = users[key];
  if (!rec) return;
  dirtyAccounts.add(key);
  if (!accountFlushTimer) accountFlushTimer = setTimeout(flushAccounts, 1000);
}
// v0.13.9：库存快照版本号 invRev 只用于「同一会话内的快照新鲜度比较」，不落盘
// （每个账号文件都多一个字段没有收益）。落盘时去掉该字段，读档后 rev 自然从 0 重新开始。
// 注意：这里必须返回浅拷贝——写失败时排队重试的就是这个对象，若直接把 rec 交出去，
// 重试时会把「后来才自增的 invRev」写进存档。
function accountSaveView(rec) {
  const out = Object.assign({}, rec);
  delete out.invRev;
  return out;
}
function writeAccountFile(key, rec) { return writeJson(accountFile(key), accountSaveView(rec)); }
function flushAccounts() {
  if (accountFlushTimer) { clearTimeout(accountFlushTimer); accountFlushTimer = null; }
  const keys = Array.from(dirtyAccounts);
  dirtyAccounts.clear();
  keys.forEach(function (k) { const rec = users[k]; if (rec) writeAccountFile(k, rec); });
}
function saveAllAccounts() {
  Object.keys(users).forEach(saveAccount);
}
process.on('exit', function () {
  processExiting = true;   // 退出时不再排队重试（定时器不会执行了），写失败只留日志
  if (accountFlushTimer) { clearTimeout(accountFlushTimer); accountFlushTimer = null; }
  if (dirtyAccounts.size) {
    const ks = Array.from(dirtyAccounts); dirtyAccounts.clear();
    ks.forEach(function (k) { const rec = users[k]; if (rec) { try { writeAccountFile(k, rec); } catch (e) {} } });
  }
  if (dirtyFiles.size) { try { flushDirtyFiles(true); } catch (e) {} }   // 退出前最后试一次待重试的文件
  if (sessionsDirty) { try { saveSessionsNow(); } catch (e) {} }
  if (recordsFlushTimer) { clearTimeout(recordsFlushTimer); recordsFlushTimer = null; try { saveRecords(); } catch (e) {} }
});

// ================================================================
// ---- 玩家存档快照（后台可配：多久存一份 / 保留几份；支持单人回档）----
// 目录 DATA_DIR/snapshots/<safeKey>/<时间戳>.json —— 与 accounts/ 分开，避免被 loadAccounts 误读。
// 内容 = accountSaveView 的深拷贝（不带内存专用的 invRev）；回档只覆盖「资产」字段，
// 密码 / 权限 / 封禁 / 挂单上限这些身份类字段一律保留当前值。
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
try { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch (e) {}
const SNAP_KEEP_MAX = 50;   // 保留份数上限（与 data.js setSnapshotCfg 的夹取口径一致）
function snapshotCfgOf() { return (world && world.snapshotCfg) ? world.snapshotCfg : D.defaultSnapshotCfg(); }
function snapshotDirOf(key) { return path.join(SNAPSHOT_DIR, safeKey(key)); }
function listSnapshotFiles(key) {
  let names = [];
  try { names = fs.readdirSync(snapshotDirOf(key)).filter(function (n) { return /\.json$/.test(n); }); } catch (e) { return []; }
  // 文件名是「时间戳[-序号].json」，字典序即时间序
  return names.sort().map(function (n) { return { name: n, file: path.join(snapshotDirOf(key), n), ts: Number(n.split('.')[0].split('-')[0]) || 0 }; });
}
function pruneSnapshots(key, keep) {
  const list = listSnapshotFiles(key);
  const k = Math.max(1, Math.min(SNAP_KEEP_MAX, Math.floor(Number(keep) || SNAP_KEEP_MAX)));
  if (list.length <= k) return 0;
  const drop = list.slice(0, list.length - k);
  drop.forEach(function (s) { try { fs.unlinkSync(s.file); } catch (e) {} });
  return drop.length;
}
// 给一个账号存一份快照（内存视图深拷贝；同一毫秒重复调用加后缀避免互相覆盖）
function writeUserSnapshot(key) {
  const rec = users[key];
  if (!rec) return null;
  const dir = snapshotDirOf(key);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const ts = Date.now();
  let file = path.join(dir, ts + '.json');
  if (fs.existsSync(file)) file = path.join(dir, ts + '-1.json');
  const view = JSON.parse(JSON.stringify(accountSaveView(rec)));
  writeJson(file, view);
  pruneSnapshots(key, snapshotCfgOf().keep);
  return file;
}
// 全服快照：先 flushAccounts 把脏账号落盘，保证快照与账号文件口径一致
function takeAllSnapshots() {
  flushAccounts();
  let n = 0;
  Object.keys(users).forEach(function (k) { try { if (writeUserSnapshot(k)) n++; } catch (e) {} });
  return n;
}
let snapshotTimer = null;
function armSnapshotTimer() {
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
  const cfg = snapshotCfgOf();
  if (!cfg.enabled) return;
  const min = Math.max(1, Math.floor(Number(cfg.intervalMin) || 30));
  snapshotTimer = setInterval(function () {
    try { takeAllSnapshots(); } catch (e) { console.log('[snapshot] 快照失败: ' + e.message); }
  }, min * 60000);
  snapshotTimer.unref();
}
// 快照摘要（后台列表用，不必把整份存档发给前端）
function snapshotSummary(view) {
  const inv = (view && view.inventory) || {};
  const ids = Object.keys(inv);
  let total = 0;
  ids.forEach(function (id) { total += Math.max(0, Math.floor(Number(inv[id]) || 0)); });
  return {
    coins: Math.max(0, Math.floor(Number(view && view.coins) || 0)),
    kinds: ids.length, total: total,
    rodSlots: Object.keys((view && view.rodSlots) || {}).length,
    catchCount: Math.max(0, Math.floor(Number(view && view.catchCount) || 0)),
  };
}
// 回档覆盖的资产字段（profileOf 里属于「玩家资产」的那批）
const SNAPSHOT_ASSET_KEYS = ['coins', 'inventory', 'bigfish', 'codex', 'catchCount', 'bd', 'rodSlots', 'rodActiveSlot', 'rodName', 'autoSell', 'subNotify'];
function applySnapshot(rec, view) {
  SNAPSHOT_ASSET_KEYS.forEach(function (k) {
    if (view[k] === undefined) delete rec[k];
    else rec[k] = JSON.parse(JSON.stringify(view[k]));
  });
  rec.inventory = rec.inventory || {};
  rec.codex = rec.codex || {};
  rec.catchCount = Math.max(0, Math.floor(Number(rec.catchCount) || 0));
  bumpInvRev(rec);   // 整体替换资产：版本号必须前进（与后台快照编辑同口径）
  Object.keys(rec.inventory).forEach(function (id) { bigfishClampTo(rec, id); });
  return rec;
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
const RECORDS_KEYS = ['bigRecords', 'smallRecords', 'topCatches', 'topSmall', 'globalMax', 'rank', 'lastRec'];
const ECONOMY_KEYS = ['shopSales', 'priceLog', 'tradeLog', 'marketLog', 'priceOv', 'economyLog'];
const CONFIG_KEYS = ['features', 'groundCfg', 'notifyLevel', 'autoNotify', 'biteFormula', 'doubleBase', 'componentCfg', 'fishCfg', 'bannerSeq', 'banners', 'bannerCfg', 'feedbackCfg', 'castCfg', 'priceCfg', 'dropCfg', 'chestCfg', 'mallCfg', 'smeltCfg', 'recordsCfg', 'rareK', 'autoSellCfg', 'snapshotCfg', 'wikiConfigRevision'];
// 反馈意见：items 列表 + meta（每账号下次可提交时间），单独一个文件
const FEEDBACK_KEYS = ['feedback', 'feedbackMeta'];
// 服务器统计采样（后台概览热力图）：分钟样本 24h + 小时样本 30 天 + 历史峰值在线
const STATS_KEYS = ['statMin', 'statHour', 'statPeak'];
const HEAT_STATS = { min: 1440, hour: 720, gapMs: 60000, flushEvery: 10 };
function loadMarket() {
  loadDomain(MARKET_FILE, MARKET_KEYS);
  // 存量修复：后台批量上架曾把「原始大小写的用户名」写进 seller（如 Wj1752），
  // 而成交/下架/退单/删号全按账号 key（小写）查——统一归一化，否则这些挂单卖出去
  // 不进卖家账、也不出现在它的历史订单里。
  let fixed = 0;
  (world.listings || []).forEach(function (l) {
    if (!l || l.seller == null) return;
    const k = String(l.seller).toLowerCase();
    if (l.seller !== k) { l.seller = k; fixed++; }
  });
  if (fixed) saveMarket();
}
function saveMarket() { saveDomain(MARKET_FILE, MARKET_KEYS); }
function loadRecords() {
  loadDomain(RECORDS_FILE, RECORDS_KEYS);
  // v0.13.8 存量修复：渔获记录里只该有渔获。历史上被改判成别的分类的物品（如龙宫宝珠：
  // v0.11 起从「鱼」划归「材料」）会残留在记录页的最大/最小/前十榜里，载入时统一剔除并回写。
  let n = 0;
  ['bigRecords', 'smallRecords', 'topCatches', 'topSmall'].forEach(function (k) {
    const m = world[k];
    if (!m || typeof m !== 'object') return;
    Object.keys(m).forEach(function (id) { if (!FISH_ID_SET[id]) { delete m[id]; n++; } });
  });
  const b = rankBuckets();
  ['day', 'week'].forEach(function (scope) {
    Object.keys(b[scope]).forEach(function (day) {
      const bucket = b[scope][day];
      Object.keys(bucket).forEach(function (id) { if (!FISH_ID_SET[id]) { delete bucket[id]; n++; } });
      if (!Object.keys(bucket).length) delete b[scope][day];
    });
  });
  if (world.globalMax && !FISH_ID_SET[world.globalMax.id]) { world.globalMax = recomputeGlobalMax(); n++; }
  if (world.lastRec && !FISH_ID_SET[world.lastRec.id]) { world.lastRec = null; n++; }
  pruneRanks();
  if (n) { saveRecords(); console.log('[records] 已清理 ' + n + ' 条非渔获残留纪录（分类变动的历史物品）'); }
}
function saveRecords() { saveDomain(RECORDS_FILE, RECORDS_KEYS); }
function loadEconomy() { loadDomain(ECONOMY_FILE, ECONOMY_KEYS); }
function saveEconomy() { saveDomain(ECONOMY_FILE, ECONOMY_KEYS); }
function loadConfig() {
  loadDomain(CONFIG_FILE, CONFIG_KEYS);
  // 存量修复：v0.13.3 删掉了「大鱼概率」增益类别 —— 旧存档里可能还留着 { type:'big' } 的增益。
  // 载入时统一剔除并回写，免得后台增益列表/配置文件里残留一个永远不生效的类别。
  let fixed = 0;
  const gc = world.groundCfg || {};
  const stripBig = function (sp) {
    if (!sp || !Array.isArray(sp.buffs)) return;
    const keep = sp.buffs.filter(function (b) { return b && D.AFFIX_LABEL[b.type]; });
    if (keep.length === sp.buffs.length) return;
    sp.buffs = keep;
    fixed++;
  };
  Object.keys(gc.spots || {}).forEach(function (k) { stripBig(gc.spots[k]); });
  (Array.isArray(gc.custom) ? gc.custom : []).forEach(function (cg) {
    (cg.spots || []).forEach(stripBig);
  });
  Object.keys(gc.customSpots || {}).forEach(function (gid) {
    (gc.customSpots[gid] || []).forEach(stripBig);
  });
  if (fixed) { saveConfig(); console.log('[config] 已清理 ' + fixed + ' 处无效增益类别（大鱼概率）'); }
}
// ---- Wiki 规则快照：与默认 /api/version 共用同一份公开配置组装 ----
// schema/rules 版本只表示 Wiki 消费方兼容性；游戏版本仍以 data.js 的 VERSION 为准。
const WIKI_SCHEMA_VERSION = 1;
const WIKI_RULES_VERSION = 1;
const SERVER_INSTANCE_ID = crypto.randomBytes(8).toString('hex');

function sourceCommitOf() {
  const v = String(process.env.SOURCE_COMMIT || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(v) ? v : null;
}
// 规范化 JSON：对象键排序、数组顺序保留、undefined 跳过。configHash 必须不受对象插入顺序影响。
function stableJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableJson(value[k]); }).join(',') + '}';
  }
  return JSON.stringify(value);
}
function publicVersionConfig() {
  return {
    features: world.features || {},
    componentCfg: D.getComponentCfg ? D.getComponentCfg() : null,
    fishCfg: D.getFishCfg ? D.getFishCfg() : null,
    castCfg: { baseMs: castBaseMs(), minMs: castMinMs(), speedBonus: castSpeedBonus(), speedCap: castSpeedCap() },
    priceCfg: priceCfg(),
    dropCfg: dropCfg(),
    autoSellCfg: autoSellCfgOf(),
    chestCfg: chestCfgOf(),
    smeltCfg: smeltCfgOf(),
  };
}
function publicRulesConfig() {
  return Object.assign(publicVersionConfig(), {
    biteFormula: world.biteFormula || BITE_FORMULA_DEFAULT,
    doubleBase: Number(world.doubleBase) || 0,
    rareK: rareK(),
  });
}
function wikiCatalog() {
  const fish = [];
  ['common', 'big', 'rare'].forEach(function (tier) {
    (D.FISH[tier] || []).forEach(function (f) { fish.push(Object.assign({}, f, { tier: tier })); });
  });
  return {
    fish: fish,
    materials: D.MATERIALS,
    components: D.COMPONENT_BASES,
    chests: D.CHESTS,
    rodParts: D.ROD_PARTS,
    affixes: D.AFFIX_LABEL,
    affixTypes: D.AFFIX_TYPES,
    quality: D.QUALITY,
    smeltMaterials: D.smeltMaterialIds().map(function (id) {
      const it = D.MATERIALS.find(function (m) { return m.id === id; }) || {};
      const affix = D.smeltMaterialAffix(id);
      return { id: id, name: it.name || id, rarity: it.rarity || null, affix: affix, affixName: D.AFFIX_LABEL[affix] || '' };
    }),
    smeltPearl: { id: D.SMELT_PEARL, name: (D.MATERIALS.find(function (m) { return m.id === D.SMELT_PEARL; }) || {}).name || D.SMELT_PEARL },
  };
}
function wikiSnapshot(rulesConfig) {
  const catalog = wikiCatalog();
  const grounds = groundsWithDrop();
  const hashSource = {
    schemaVersion: WIKI_SCHEMA_VERSION,
    gameVersion: D.VERSION,
    sourceCommit: sourceCommitOf(),
    rulesVersion: WIKI_RULES_VERSION,
    catalog: catalog,
    grounds: grounds,
    rulesConfig: rulesConfig,
  };
  const configHash = crypto.createHash('sha256').update(stableJson(hashSource), 'utf8').digest('hex');
  const revision = Math.max(1, Math.floor(Number(world.wikiConfigRevision) || 1));
  const snapshotId = SERVER_INSTANCE_ID + ':' + revision + ':' + configHash;
  return {
    schemaVersion: WIKI_SCHEMA_VERSION,
    gameVersion: D.VERSION,
    sourceCommit: sourceCommitOf(),
    rulesVersion: WIKI_RULES_VERSION,
    serverInstanceId: SERVER_INSTANCE_ID,
    configRevision: revision,
    snapshotId: snapshotId,
    configHash: configHash,
    sourceKind: 'server',
    generatedAt: new Date().toISOString(),
    catalog: catalog,
    grounds: grounds,
    rulesConfig: rulesConfig,
  };
}
function versionPayload(profile) {
  if (profile === 'wiki') {
    return { profile: 'wiki', version: D.VERSION, snapshot: wikiSnapshot(publicRulesConfig()) };
  }
  return Object.assign(
    { version: D.VERSION, build: D.BUILD },
    publicVersionConfig(),
    { recordsCfg: recordsCfgOf() }
  );
}
function etagMatches(headerValue, etag) {
  if (!headerValue) return false;
  return String(headerValue).split(',').map(function (v) { return v.trim(); }).some(function (v) {
    return v === etag || v === 'W/' + etag;
  });
}
function saveConfig() {
  world.wikiConfigRevision = Math.max(1, Math.floor(Number(world.wikiConfigRevision) || 0) + 1);
  saveDomain(CONFIG_FILE, CONFIG_KEYS);
}
// ---- 按在线人数自动调节全服动态通知等级（管理后台可配，带迟滞+防抖）----
// world.autoNotify = { on, rules:[{min, level}...]（min 降序生效）, hysteresisPct, holdCount }
// 防抖：人数在门槛附近波动时不会反复横跳——①切换需跨越带 hysteresisPct% 余量的门槛；
// ②连续 holdCount 次评估（每 5s 一次）指向同一目标档才真正切换。
const NOTIFY_ORDER = ['all', 'offrange', 'uncommon', 'records', 'none'];
let autoNotifyStreak = 0;
function autoNotifyPreset(name) {
  if (name === 'relaxed') return [{ min: 1500, level: 'records' }, { min: 4000, level: 'none' }];
  return [{ min: 800, level: 'uncommon' }, { min: 2000, level: 'records' }, { min: 4000, level: 'none' }]; // default
}
setInterval(function () {
  try {
    const an = world.autoNotify;
    if (!an || !an.on || !Array.isArray(an.rules) || !an.rules.length) return;
    const n = players.size;
    const rules = an.rules.filter(function (r) { return r && NOTIFY_LEVELS[r.level]; })
      .sort(function (a, b) { return (b.min || 0) - (a.min || 0); });
    if (!rules.length) return;
    let raw = rules[rules.length - 1].level; // 低于最低门槛 → 最宽松档
    for (let i = 0; i < rules.length; i++) { if (n >= (rules[i].min || 0)) { raw = rules[i].level; break; } }
    if (raw === world.notifyLevel) { autoNotifyStreak = 0; return; }
    const curIdx = NOTIFY_ORDER.indexOf(world.notifyLevel), rawIdx = NOTIFY_ORDER.indexOf(raw);
    if (curIdx < 0 || rawIdx < 0) return;
    const h = Math.min(Math.max(Number(an.hysteresisPct) || 10, 0), 90) / 100;
    let ok;
    if (rawIdx > curIdx) {
      // 升严格：目标档门槛需带正余量（人数明显高于门槛才切换）
      let m = 0;
      rules.forEach(function (r) { const li = NOTIFY_ORDER.indexOf(r.level); if (li > curIdx && li <= rawIdx && (r.min || 0) > m) m = r.min || 0; });
      ok = m === 0 || n >= m * (1 + h);
    } else {
      // 降宽松：需低于进入当前严格档门槛的 (1 - h)（人数明显回落才切回）
      let m = 0;
      rules.forEach(function (r) { const li = NOTIFY_ORDER.indexOf(r.level); if (li > rawIdx && li <= curIdx && (r.min || 0) > m) m = r.min || 0; });
      ok = m === 0 || n < m * (1 - h);
    }
    if (!ok) { autoNotifyStreak = 0; return; }
    autoNotifyStreak++;
    const hold = Math.min(Math.max(parseInt(an.holdCount, 10) || 2, 1), 12);
    if (autoNotifyStreak < hold) return;
    autoNotifyStreak = 0;
    world.notifyLevel = raw;
    saveConfig();
    broadcast({ type: 'notice', msg: '📡 在线人数变化，全服动态通知等级已自动调整为「' + raw + '」' });
  } catch (e) { console.error('[autoNotify] ' + ((e && e.stack) || e)); }
}, 5000).unref();
function loadFeedback() { loadDomain(FEEDBACK_FILE, FEEDBACK_KEYS); }
function saveFeedback() { saveDomain(FEEDBACK_FILE, FEEDBACK_KEYS); }
function loadStats() { loadDomain(STATS_FILE, STATS_KEYS); }
function saveStats() { saveDomain(STATS_FILE, STATS_KEYS); }
function saveWorld() { saveMarket(); saveRecords(); saveEconomy(); saveConfig(); saveFeedback(); saveStats(); }

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
  loadMarket(); loadRecords(); loadEconomy(); loadConfig(); loadFeedback(); loadStats(); loadAdminLog();
  void hasDomain;
}
loadUsers();
migrateAutoSell(); // v0.13.8 自动售出重做：旧 {all,fish} 结构升级为逐物品 {items}
loadWorld();
// 存档快照：把持久化的配置灌进共享目录（data.js 的 getSnapshotCfg 供后台表单回显），再挂定时器
world.snapshotCfg = D.setSnapshotCfg(world.snapshotCfg);
armSnapshotTimer();
armStatsSampler();   // 统计采样基于 loadWorld 后的历史样本，必须排在其后
loadSessions(); // 重启后恢复登录态（客户端可自动登录，见 sessionGet 注释）
// v0.8 组件实例化迁移：旧编码组件 id（`部位_code值_…`）→ 实例签名；背包/钓竿配置/挂单原位换新。
// v0.12.2 词缀范围来源迁移：旧实例签名（词缀 token 无 @src）解析时按底材池推断来源
// （池内 = 底材、池外 = 突破'bt'），normalizeItemId 重写为带 @src 的新签名——普通组件签名不变，
// 只有带池外词缀的宝匣件 / 熔炼件 id 会变化，同样在背包 / 钓竿配置 / 挂单原位换新。
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
    // 钓竿槽位：整根钓竿的每个配件也要一起升级，否则「拆回背包 / 市集整竿」会把旧签名带出去
    if (Array.isArray(rec.rodSlots)) {
      rec.rodSlots.forEach(function (sl) {
        if (!sl || !sl.bd) return;
        Object.keys(sl.bd).forEach(function (part) {
          const slot = sl.bd[part];
          if (!slot || !slot.compId) return;
          const comp = D.componentOf(slot.compId);
          if (comp && (comp.id !== slot.compId || slot.name !== comp.name)) {
            slot.compId = comp.id; slot.name = comp.name; slot.affixes = comp.affixes; slot.rare = comp.quality;
            accountsDirty = true;
          }
        });
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
  if (accountsDirty || marketDirty || econDirty) console.log('[migrate] component ids → v0.12.2 instance signatures (affix range source)');
})();

// 套用管理后台保存的钓场/钓点配置覆盖（掉落池 / 增益 / 锁定状态 / 地图坐标）
applyGroundCfg();
// 套用管理后台保存的宝匣成本覆盖（残片 / 金币）：宝匣目录是前后端共用的一份，改在这里即全站生效
applyChestCostCfg();
// 套用工坊熔炼参数与商城配置（管理后台可调；缺省回退出厂默认）
if (D.setSmeltCfg) D.setSmeltCfg(world.smeltCfg);
if (!world.mallCfg) world.mallCfg = D.defaultMallCfg();
// 套用管理后台保存的组件生成配置（品质概率 / 词条数概率 / roll 模型 / 数值区间 / 修饰词规则）
if (D.setComponentCfg) D.setComponentCfg(world.componentCfg);
// 套用管理后台保存的鱼类体型 roll 模型（默认正态；影响所有上鱼体型与大小鱼榜）
if (D.setFishCfg) D.setFishCfg(world.fishCfg);
// 为所有经济物品补齐乘数状态（老档迁移：旧"供应压力"按 -1%/件 折算为初始乘数）
(function ensureSaleStats() {
  const day = new Date().toISOString().slice(0, 10);
  Object.keys(ECO_PRICE).forEach(function (id) {
    const s = world.shopSales[id];
    if (!s) { world.shopSales[id] = { m: 1, lastTs: Date.now(), soldTotal: 0, soldToday: 0, day: day }; return; }
    if (s.m == null) {
      s.m = Math.max(priceCfg().floorPct / 100, 1 - Math.min(0.6, (s.debt || 0) * 0.01));
      delete s.debt;
    }
    if (s.day !== day) { s.day = day; s.soldToday = s.soldToday || 0; }
  });
})();

async function verifyPassword(rec, password, key) {
  if (!await Transport.verifyPassword(rec, password)) return false;
  if (!rec.pwHash.startsWith('scrypt$v1$')) {
    rec.pwHash = await Transport.hashPassword(password); delete rec.salt; saveAccount(key);
  }
  return true;
}
function newToken() { return crypto.randomBytes(16).toString('hex'); }
function profileOf(key) {
  const rec = users[key];
  return {
    features: world.features || {}, username: rec.username, name: rec.name, coins: rec.coins, qq: rec.qq || '',
    inventory: rec.inventory || {}, bd: rec.bd || {},
    invRev: invRevOf(rec),   // 库存快照版本号：客户端据此丢弃过期快照（v0.13.9）
    bigfish: rec.bigfish || null,
    codex: rec.codex || {}, catchCount: rec.catchCount || 0,
    admin: !!rec.admin,
    listingCap: listingCapOf(rec),
    listingCapSet: rec.listingCap != null,
    autoSell: rec.autoSell || null,
    subNotify: rec.subNotify || null,
    // 钓竿存档：当前装备命名 / 槽位（含已购买数量与下一槽位价格）/ 被钓竿占用的实例件数（前端锁定标记）
    rodName: rec.rodName || '',
    rodSlotsCount: rodSlotCountOf(rec),
    rodSlotsMax: ROD_SLOT_MAX,
    rodActiveSlot: rodActiveSlotOf(rec),
    freeRodSlots: (function () { let n = 0; for (let i = 0; i < rodSlotCountOf(rec); i++) if (freeRodSlotOf && freeRodSlotOf(rec) >= 0) { n++; break; } return freeRodSlotOf(rec) >= 0 ? 1 : 0; })(),
    rodSlots: rodSlotView(rec),
    nextRodSlotPrice: nextRodSlotPrice(rec),
    rodLocked: rodUsageOf(rec),
  };
}

// ---- 管理后台鉴权：token → 会话 → 账号须带 admin 标志 ----
function anyAdminExists() {
  return Object.keys(users).some(function (k) { return users[k].admin; });
}
function adminOf(token) {
  const key = token && sessionGet(token);
  const rec = key && users[key];
  const session = key && sessions.get(tokenHash(token));
  return (rec && rec.admin && session && session.adminMfa === true) ? { key: key, rec: rec } : null;
}

// ================================================================
// ---- 后台安全（v0.16.0）----
// 1) 管理操作审计：所有写操作都记一条（谁 / 什么时候 / 对谁 / 做了什么），落盘 admin.json；
// 2) 异常登录防护：同「账号 + IP」10 分钟内连续失败 5 次 → 锁定 5 分钟（只挡登录，不影响在线玩家）；
// 3) 封禁：按账号封任意时长（支持永久），封禁立即踢掉在线会话与实时连接。
// 敏感操作的二次确认在后台界面侧（confirmModalLocal），这里只保证服务端一定会校验权限。
// ================================================================
function saveAdminLog() { saveDomain(ADMIN_FILE, ADMIN_KEYS); }
function loadAdminLog() { loadDomain(ADMIN_FILE, ADMIN_KEYS); }
function audit(a, action, target, detail) {
  try {
    const list = world.adminLog || (world.adminLog = []);
    list.push({
      t: Date.now(),
      key: (a && a.key) || '',
      name: (a && a.rec && a.rec.name) || '',
      action: String(action || ''),
      target: String(target || ''),
      detail: String(detail == null ? '' : detail).slice(0, 200),
    });
    if (list.length > 500) list.splice(0, list.length - 500);
    saveAdminLog();
  } catch (e) { console.error('[audit] ' + ((e && e.stack) || e)); }
}
// ---- 异常登录防护 ----
const LOGIN_MAX_FAILS = 5;                 // 连续失败次数上限
const LOGIN_WINDOW_MS = 10 * 60 * 1000;    // 统计窗口
const LOGIN_LOCK_MS = 5 * 60 * 1000;       // 锁定时长
const loginGuard = new Map();              // ident -> { fails:[t…], until }
setInterval(function () {
  const now = Date.now();
  for (const [key, g] of loginGuard) {
    g.fails = g.fails.filter(t => now - t < LOGIN_WINDOW_MS);
    if (g.until <= now && !g.fails.length) loginGuard.delete(key);
  }
}, 60000).unref();
function clientIpOf(req) { return Security.clientIp(req); }
function loginIdent(req, username) { return String(username || '').toLowerCase() + '|' + clientIpOf(req); }
function loginLockRemain(ident) {
  const g = loginGuard.get(ident);
  if (!g || !g.until) return 0;
  const rem = g.until - Date.now();
  if (rem <= 0) { loginGuard.delete(ident); return 0; }
  return rem;
}
function loginFail(ident) {
  const now = Date.now();
  const g = loginGuard.get(ident) || { fails: [], until: 0 };
  g.fails = (g.fails || []).filter(function (t) { return now - t < LOGIN_WINDOW_MS; });
  g.fails.push(now);
  if (g.fails.length >= LOGIN_MAX_FAILS) { g.until = now + LOGIN_LOCK_MS; g.fails = []; }
  loginGuard.set(ident, g);
}
function loginFailureResponse(res, ident, error) {
  const count = ((loginGuard.get(ident) || {}).fails || []).length;
  loginFail(ident);
  setTimeout(function () {
    if (!res.destroyed && !res.writableEnded) apiResp(res, 401, { error });
  }, Math.min(1000, 100 * Math.pow(2, count)));
}
function loginOk(ident) { loginGuard.delete(ident); }
function loginGuardSnapshot() {
  const out = [];
  loginGuard.forEach(function (g, ident) {
    const rem = g.until ? Math.max(0, g.until - Date.now()) : 0;
    if (!rem) return;
    const parts = String(ident).split('|');
    out.push({ user: parts[0], ip: parts.slice(1).join('|'), remainMs: rem });
  });
  return out.sort(function (a, b) { return b.remainMs - a.remainMs; });
}
// ---- 封禁 ----
function banInfoOf(rec) {
  if (!rec || !rec.banUntil) return { banned: false, until: 0, permanent: false, remainMs: 0, reason: '' };
  const permanent = rec.banUntil < 0;
  const remain = permanent ? 0 : Math.max(0, rec.banUntil - Date.now());
  if (!permanent && remain <= 0) return { banned: false, until: 0, permanent: false, remainMs: 0, reason: '' };
  return { banned: true, until: rec.banUntil, permanent: permanent, remainMs: remain, reason: rec.banReason || '' };
}
function banTextOf(info) {
  if (!info.banned) return '';
  const when = info.permanent ? '永久封禁' : ('解封时间 ' + new Date(info.until).toLocaleString() +
    '（剩余 ' + Math.max(1, Math.ceil(info.remainMs / 3600000)) + ' 小时）');
  return when + (info.reason ? ' · 原因：' + info.reason : '');
}
// 封禁生效：踢掉在线会话与实时连接（下一句是「服务器权威」——客户端无法绕过）
function applyBan(key) {
  kickUserSessions(key);
  const doomed = [];
  clientOwners.forEach(function (ownerKey, res) { if (ownerKey === key) doomed.push(res); });
  doomed.forEach(function (res) {
    clients.delete(res); clientOwners.delete(res); clientViews.delete(res);
    try { res.write('data: ' + JSON.stringify({ type: 'kicked', msg: '账号已被封禁，请联系管理员' }) + '\n\n'); } catch (e) {}
    try { res.end(); } catch (e) {}
  });
}

// ---- 性能修复(perf-3+5)：SSE 批量合并推送 + 背压保护 ----
// (a) 批量合并：同一时间窗内的多条事件合并成一条 {type:'batch', list:[...]} 推送，
//     前端 net.js 已支持解包（向后兼容单条消息）。把「每竿 3-6 条事件 × N 连接」的
//     小包洪水降为「每窗 1 条 × N 连接」的大包写出，实测降低一个数量级以上的
//     socket 写次数——这是 500 人时 RTT 飙升、错误率 33% 的直接原因。
// (b) 背压保护：慢客户端写缓冲超过 4MB 直接断开（close 清理逻辑回收），防内存膨胀。
const SSE_MAX_BUFFER = 4 * 1024 * 1024;
// 网络统计（压测观测用）：SSE 推送与 API 响应的累计字节/消息计数
const netStats = { sseBytes: 0, sseMsgs: 0, sseWrites: 0, apiBytes: 0, apiReqs: 0, start: Date.now() };
function sseWrite(res, d) {
  try {
    netStats.sseBytes += Buffer.byteLength(d);
    if (res.writableLength > SSE_MAX_BUFFER) { try { res.end(); } catch (e) {} return; }
    netStats.sseWrites++;
    res.write(d);
  } catch (e) {}
}
const pendingBcast = [];
let bcastTimer = null;
// perf-8：广播支持钓场分区（groundScope = groundId）——feed 事件只分发给正在
// 该钓场钓鱼的玩家，扇出量直接除以钓场数；全局快照（players/grounds/records 等）不传 scope。
function broadcast(obj, groundScope) {
  pendingBcast.push({ o: obj, g: groundScope || null });
  if (!bcastTimer) bcastTimer = setTimeout(flushBcast, 200);
}
function flushBcast() {
  bcastTimer = null;
  if (!pendingBcast.length) return;
  netStats.sseMsgs++;
  const raw = pendingBcast.splice(0, pendingBcast.length);
  // 同窗口内「全量状态快照」类事件只保留最后一条（players/grounds/records/shop/market
  // 都是完整快照，同窗口旧快照没有信息量）。缺了这一步，高钓速下每秒数百条 players
  // 快照会被原样合并成几十 MB 的巨型 batch，瞬间打爆所有连接的写缓冲。
  const lastIdx = {};
  for (let i = 0; i < raw.length; i++) { const ev = raw[i]; if (!ev.g && COALESCE_TYPES[ev.o.type]) lastIdx[ev.o.type] = i; }
  // 分区：feed/globalRecord（社交类，走 1s 慢窗口）vs 其他（200ms 快窗口）
  // perf-8b：实测 5000 人时带宽 1.2Gbps 几乎全部来自 feed——30条/窗×5窗/s×逐客户端投递，
  // 而人不可能读 150 行/秒的动态。社交事件改为 1 秒窗口：feed 每客户端 ≤10 条/秒、
  // 纪录横幅 ≤3 条/秒，5000 人时 feed 带宽从 ~1.2Gbps 降到 ≤60Mbps。
  const gList = [];
  for (let i = 0; i < raw.length; i++) {
    const ev = raw[i];
    if (ev.o.type === 'feed') { queueFeed(ev.o.entry, ev.g); continue; }
    if (ev.o.type === 'globalRecord') { queueBanner(ev.o); continue; }
    if (!ev.g && (!COALESCE_TYPES[ev.o.type] || lastIdx[ev.o.type] === i)) gList.push(ev.o);
  }
  if (gList.length) {
    const d = 'data: ' + JSON.stringify({ type: 'batch', list: gList }) + '\n\n';
    clients.forEach(function (r) { sseWrite(r, d); });
  }
}
// ---- perf-8b：feed / 纪录横幅专用 1 秒批量窗口 ----
// feed 按钓场分桶（无 groundId 的进全局桶），每秒每桶最多 10 条，一条 feedBatch
// 消息只序列化一次、只发给正在该钓场钓鱼的客户端；globalRecord 每秒最多 3 条。
const pendingFeedGlobal = [];
const pendingFeedGround = new Map(); // groundId -> [entry]
const pendingBanners = [];
let socialTimer = null;
function queueFeed(entry, groundId) {
  if (groundId) {
    let arr = pendingFeedGround.get(groundId);
    if (!arr) { arr = []; pendingFeedGround.set(groundId, arr); }
    arr.push(entry);
  } else {
    pendingFeedGlobal.push(entry);
  }
  if (!socialTimer) socialTimer = setTimeout(flushSocial, 1000);
}
function queueBanner(obj) {
  pendingBanners.push(obj);
  if (!socialTimer) socialTimer = setTimeout(flushSocial, 1000);
}
function flushSocial() {
  socialTimer = null;
  if (pendingFeedGlobal.length) {
    const list = pendingFeedGlobal.splice(0, pendingFeedGlobal.length).slice(-10);
    const d = 'data: ' + JSON.stringify({ type: 'batch', list: list.map(function (e) { return { type: 'feed', entry: e }; }) }) + '\n\n';
    clients.forEach(function (r) { sseWrite(r, d); });
  }
  if (pendingBanners.length) {
    const list = pendingBanners.splice(0, pendingBanners.length).slice(-3);
    const d = 'data: ' + JSON.stringify({ type: 'batch', list: list }) + '\n\n';
    clients.forEach(function (r) { sseWrite(r, d); });
  }
  if (pendingFeedGround.size) {
    const gs = Array.from(pendingFeedGround.entries());
    pendingFeedGround.clear();
    gs.forEach(function (pair) {
      const gid = pair[0], entries = pair[1].slice(-10);
      const d = 'data: ' + JSON.stringify({ type: 'batch', list: [{ type: 'feedBatch', list: entries }] }) + '\n\n';
      clientOwners.forEach(function (ownerKey, res) {
        const p = players.get(ownerKey);
        if (p && p.groundId === gid) sseWrite(res, d);
      });
    });
  }
}
const COALESCE_TYPES = { players: 1, playersDelta: 1, grounds: 1, records: 1, shop: 1, market: 1 };
// 定向推送：只发给某个账号名（key）的 SSE 连接（同样按 150ms 窗口合并）
const pendingTo = new Map(); // key -> [events]
let sendToTimer = null;
function sendTo(key, obj) {
  // v0.13.6：背包全量同步顺带带上大型/巨型预留计数（前端仓库标签行与筛选项的数据源）
  // v0.13.9：库存相关载荷一律在**入队这一刻**定版（内容 + rev 一起冻结）：
  //   · 此前 inventory / bigfish 存的是 rec 的活引用，150ms 后才序列化 → 消息内容比它标注的时刻更新，
  //     于是「同批次里排在后面的 invAdd 增量」会把已经包含在快照里的那件东西**再加一次**
  //     （前端表现为数字比服务端多；v0.13.9 的界面回归就是这么抓到的）。
  //   · 增量（invAdd/bigAdd）也盖上 rev：客户端只在 rev 比已应用的更新时才叠加，避免重复计入。
  if (obj.type === 'assets' && users[key]) {
    const rec = users[key];
    if (obj.inventory) {
      obj.inventory = Object.assign({}, obj.inventory);
      // bigfish 是 {id:{L,G}}：外层浅拷贝还不够，内层计数是就地自增的 → 两层都要拷
      const bf = rec.bigfish;
      obj.bigfish = bf ? Object.keys(bf).reduce(function (o, id) { o[id] = { L: bf[id].L || 0, G: bf[id].G || 0 }; return o; }, {}) : null;
    }
    obj.invRev = invRevOf(rec);
  }
  let arr = pendingTo.get(key);
  if (!arr) { arr = []; pendingTo.set(key, arr); }
  arr.push(obj);
  if (!sendToTimer) sendToTimer = setTimeout(flushSendTo, 150);
}
function flushSendTo() {
  sendToTimer = null;
  if (!pendingTo.size) return;
  netStats.sseMsgs += pendingTo.size;
  const entries = Array.from(pendingTo.entries());
  pendingTo.clear();
  entries.forEach(function (pair) {
    const d = 'data: ' + JSON.stringify({ type: 'batch', list: pair[1] }) + '\n\n';
    clientOwners.forEach(function (ownerKey, res) { if (ownerKey === pair[0]) sseWrite(res, d); });
  });
}
// ---- perf-6+7：presence 节流 + 增量广播 ----
// players 全量数组随在线人数线性增大（800 人 ≈ 150KB/条），而每次渔获都会触发
// sendPlayersAll → 高钓速下全量快照 = 带宽与序列化量随人数平方爆炸（3200 人饱和的元凶）。
// 现在：1s 节流 + 增量广播——只推「状态有变化的玩家」（upserts）与「掉线的玩家」(removed)；
// 变更超过一半或每 30 个窗口自动回退一次全量（playersDelta.full）纠偏。
// ---- perf-9：presence 按视口分页推送 ----
// 玩家列表改为服务端分页（/api/players/page）：客户端通过 /api/players/view 登记
// 当前页（页码/页大小/搜索词/钓场过滤），服务器每秒只把「该页玩家」的最新状态推给
// 该连接（playersPage 事件，≤页大小条）；未登记视口的连接零 presence 流量。
// 在线人数/钓场人数（grounds，几十字节）仍全量广播。
let presenceDirty = false;
let presenceThrottleTimer = null;
const clientViews = new Map(); // SSE res -> { page, size, q, ground, spot }
function sendPlayers() {
  presenceDirty = true;
  if (!presenceThrottleTimer) presenceThrottleTimer = setTimeout(flushPresence, 1000);
}
function playersSortedFiltered(q, ground, spot) {
  const kw = (q || '').toLowerCase();
  const out = [];
  players.forEach(function (p) {
    if (ground && p.groundId !== ground) return;
    if (spot && p.spotId !== spot) return;
    if (kw && String(p.name || '').toLowerCase().indexOf(kw) < 0) return;
    out.push(p);
  });
  out.sort(function (a, b) {
    const ra = a.status === 'fishing' ? 0 : 1, rb = b.status === 'fishing' ? 0 : 1;
    return ra - rb || String(a.name).localeCompare(String(b.name));
  });
  return out;
}
function flushPresence() {
  presenceThrottleTimer = null;
  if (!presenceDirty) return;
  presenceDirty = false;
  if (clientViews.size) {
    // 相同过滤参数的视口共享一次排序/过滤结果
    const cache = new Map();
    clientViews.forEach(function (view, res) {
      const key = (view.q || '') + '|' + (view.ground || '') + '|' + (view.spot || '');
      let all = cache.get(key);
      if (!all) { all = playersSortedFiltered(view.q, view.ground, view.spot); cache.set(key, all); }
      const size = Math.min(Math.max(view.size || 30, 5), 100);
      const pages = Math.max(1, Math.ceil(all.length / size));
      const page = Math.min(Math.max(view.page || 1, 1), pages);
      const d = 'data: ' + JSON.stringify({ type: 'playersPage', page: page, pages: pages, total: all.length,
        players: all.slice((page - 1) * size, page * size) }) + '\n\n';
      sseWrite(res, d);
    });
  }
  broadcast({ type: 'grounds', counts: groundCounts(), total: players.size });
}
function readBody(req, cb) {
  const res = req.securityResponse;
  let chunks = [], bytes = 0, done = false;
  const timer = setTimeout(() => fail(408, '请求体读取超时'), 10000);
  function fail(status, error) {
    if (done) return;
    done = true; clearTimeout(timer); chunks = [];
    if (!res.headersSent) { res.setHeader('Connection', 'close'); apiResp(res, status, { error }); }
    else res.destroy();
    req.resume();
  }
  req.on('data', function (c) {
    if (done) return;
    bytes += c.length;
    if (bytes > 1e6) return fail(413, '请求体过大');
    chunks.push(c);
  });
  req.on('aborted', () => { done = true; clearTimeout(timer); chunks = []; });
  req.on('error', () => fail(400, '请求读取失败'));
  res.on('close', () => { done = true; clearTimeout(timer); chunks = []; });
  req.on('end', function () {
    if (done) return;
    clearTimeout(timer);
    try {
      const body = Buffer.concat(chunks).toString('utf8'); chunks = [];
      const data = bodyObj(body);
      Security.validate(url.parse(req.url).pathname, data);
      // Only transport credentials authenticate; query/body tokens are never accepted.
      if (Object.prototype.hasOwnProperty.call(data, 'token')) throw new Security.ValidationError('请使用 Authorization 请求头或会话 Cookie');
      data.token = req.authToken;
      if (!req.featureAllowed || req.featureAllowed()) {
        Promise.resolve(cb(JSON.stringify(data))).then(() => { done = true; }, e => {
          if (!(e instanceof Security.ValidationError)) console.error('[request]', e.stack || e);
          fail(e instanceof Security.ValidationError ? 400 : 500, e instanceof Security.ValidationError ? e.message : '服务器处理失败');
        });
      } else done = true;
    } catch (e) {
      if (!(e instanceof Security.ValidationError)) console.error('[request]', e.stack || e);
      fail(e instanceof Security.ValidationError ? 400 : 500, e instanceof Security.ValidationError ? e.message : '服务器处理失败');
    }
  });
}
// 安全解析请求体：JSON.parse('null') 是「成功」的（返回 null），而只 catch 语法错误的代码
// 紧接着读 d.token / d.username 就会抛 TypeError —— 未捕获异常会直接终止整个服务端进程，
// 这里统一收口：只接受普通 JSON 对象；数组、null 与裸数字/字符串均拒绝。
function bodyObj(body) {
  let d;
  try { d = JSON.parse(body); } catch (e) { return null; }
  return (d !== null && typeof d === 'object' && !Array.isArray(d)) ? d : null;
}

function apiResp(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  netStats.apiBytes += Buffer.byteLength(body); netStats.apiReqs++;
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(body);
}
function auth(req, res, body, cb) {
  let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
  const key = d.token && sessionGet(d.token);
  if (!key) return apiResp(res, 401, { error: '未登录' });
  cb(d, key);
}
// v0.13.9 库存快照版本号：invRev 随每次库存写入自增（只活在内存里，不落盘，读档后从 0 开始）。
// 客户端把它当作「快照新鲜度」，只接受 rev 更大的 inventory 全量快照——避免 HTTP 响应
// （apiResp 当场序列化，较旧）与 SSE assets（150ms 批处理里按活引用串行化，较新）
// 两条通道乱序到达时，旧快照把刚开出的配件从界面抹掉。
function invRevOf(rec) { return (rec && rec.invRev) || 0; }
function bumpInvRev(rec) { if (rec) rec.invRev = (rec.invRev || 0) + 1; }
function invAdd(rec, id, qty) { rec.inventory = rec.inventory || {}; rec.inventory[id] = (rec.inventory[id] || 0) + qty; if (rec.inventory[id] <= 0) delete rec.inventory[id]; bumpInvRev(rec); }
function invHas(rec, id, qty) { return (rec.inventory && rec.inventory[id] || 0) >= qty; }
function invCountOf(rec, id) { return (rec.inventory && rec.inventory[id]) || 0; }

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
let marketRevision = 0;
let lastMarket = new Map(world.listings.map(l => [l.lid, JSON.stringify(MarketPage.publicListing(l))]));
let marketDeltaTimer = null;
function broadcastMarket() {
  if (!marketDeltaTimer) marketDeltaTimer = setTimeout(flushMarketDelta, 100);
}
function flushMarketDelta() {
  marketDeltaTimer = null;
  const next = new Map(), upsert = [], removed = [];
  for (const l of world.listings) {
    const row = MarketPage.publicListing(l), encoded = JSON.stringify(row);
    next.set(l.lid, encoded);
    if (lastMarket.get(l.lid) !== encoded) upsert.push(row);
  }
  for (const lid of lastMarket.keys()) if (!next.has(lid)) removed.push(lid);
  lastMarket = next;
  if (!upsert.length && !removed.length) return;
  marketRevision++;
  const ev = { type: 'marketDelta', revision: marketRevision, total: world.listings.length };
  if (upsert.length + removed.length > 100) ev.reset = true;
  else { ev.upsert = upsert; ev.removed = removed; }
  broadcast(ev);
}

// 过期挂单清扫：物品退回卖家（上架费不退），广播市集变化
function sweepExpiredListings() {
  const now = Date.now();
  let changed = false;
  const keep = [];
  const sellers = {};
  world.listings.forEach(function (l) {
    if (l.expireAt && l.expireAt <= now) {
      // 后台批量上架的虚拟挂单：物品本就是服务器现造的，退回背包等于凭空生成 → 直接清除
      if (l.src === 'admin') { changed = true; return; }
      const seller = users[l.seller];
      if (seller) {
        if (D.isRodSet(l.id)) deliverRodBack(seller, l.id, l.name);
        else invAdd(seller, l.id, l.qty);
        sellers[l.seller] = 1;
        sendTo(l.seller, { type: 'assets', coins: seller.coins, inventory: seller.inventory, invRev: invRevOf(seller) });
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
setInterval(function () { try { sweepExpiredListings(); } catch (e) { console.error('[sweepExpiredListings] ' + ((e && e.stack) || e)); } }, 30 * 1000).unref();
// perf-9：榜单改拉取制——records 全量快照（大鱼榜+小鱼榜，50-100KB）原来每窗口都可能
// 广播给全部连接，高负载下破纪录事件不断 → 5次/秒 × N客户端 × 50KB = 数 Gbps。
// 现在只推 20 字节的 recordsDirty 版本号，客户端打开榜单页/收到通知时拉取 /api/records。
function markRecordsDirty() {
  world.recordsVersion = (world.recordsVersion || 0) + 1;
  if (recordsDirtyTimer) return;
  recordsDirtyTimer = setTimeout(function () {
    recordsDirtyTimer = null;
    broadcast({ type: 'recordsDirty', v: world.recordsVersion || 0 });
  }, 1000);
}
let recordsDirtyTimer = null;
// 榜单桶（日/周）每次渔获都会写内存，落盘不能再走「每竿一次同步写」——
// 与账号落盘同款防抖：2 秒静默后一次性写盘；进程退出前强制刷一次（见 process.on('exit')）。
let recordsFlushTimer = null;
function saveRecordsSoon() {
  if (recordsFlushTimer) return;
  recordsFlushTimer = setTimeout(function () { recordsFlushTimer = null; try { saveRecords(); } catch (e) {} }, 2000);
  if (recordsFlushTimer.unref) recordsFlushTimer.unref();
}

// ================================================================
// ---- 后台批量上架（活跃市场）：按配置现造一批可上架物品 ----
// 支持鱼 / 材料 / 宝匣 / 组件实例（整根钓竿除外：它来自钓竿槽位，不能凭空造）。
// 组件用 data.js 的 genComponent，即与钓鱼掉落完全同一条路径 —— 池内底材 + 自然区间数值，
// 也就是「正常配件」（不出池外词缀、不越界）。要池外/越界件请用后台「组件生成」页逐件定制。
// ================================================================
const BULK_LIST_MAX = 500;   // 单次上限：市集是所有玩家共用的列表，一次挂太多会拖慢客户端
const BULK_KINDS = ['fish', 'material', 'chest', 'component'];
function bulkNum(v, def, lo, hi) {
  const n = Math.floor(Number(v));
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}
function bulkMul(v, def) {
  const n = Number(v);
  return isFinite(n) ? Math.max(0.1, Math.min(10, Math.round(n * 100) / 100)) : def;
}
// 限定物品：给了合法 id 就只用这些，否则用该类的全部
function bulkPicksOf(v, all) {
  const arr = (Array.isArray(v) ? v : []).map(String).filter(function (x) { return all.indexOf(x) >= 0; });
  return arr.length ? arr : all.slice();
}
function bulkSampleOf(it) {
  const meta = D.itemOf(it.id);
  return { id: it.id, name: it.name, kind: meta.kind, quality: meta.quality || null, affixN: (meta.affixes || []).length, qty: it.qty, price: it.price };
}
// 生成挂单条目（只算不写）：counts 每类条数 / picks 限定物品 / part 组件部位 /
// quality 品质权重 / affixMin·affixMax 词条条数 / qtyMin·qtyMax 每单数量 / mulMin·mulMax 价格倍率
function bulkListPlan(d) {
  const counts = (d.counts && typeof d.counts === 'object') ? d.counts : {};
  const rawOf = function (k) { const n = Math.floor(Number(counts[k])); return isFinite(n) && n > 0 ? n : 0; };
  // 超上限直接拒绝（不静默截断）：管理员填 501 时应该看到原因，而不是以为上架了 501 条
  const overKinds = BULK_KINDS.filter(function (k) { return rawOf(k) > BULK_LIST_MAX; });
  if (overKinds.length) return { error: '单类最多 ' + BULK_LIST_MAX + ' 条，请调小：' + overKinds.join('、') };
  const kinds = BULK_KINDS.filter(function (k) { return rawOf(k) > 0; });
  if (!kinds.length) return { error: '请至少给一类物品设置条数' };
  let total = 0;
  kinds.forEach(function (k) { total += rawOf(k); });
  if (total > BULK_LIST_MAX) return { error: '单次最多上架 ' + BULK_LIST_MAX + ' 条（当前 ' + total + ' 条）' };

  const picks = (d.picks && typeof d.picks === 'object') ? d.picks : {};
  // 可上架的静态物品一律走 D.allItems()（带 kind 标签）：注意 D.FISH 是**按 id 索引的对象**、
  // D.MATERIALS / D.CHESTS 才是数组，直接 .map 会抛「不是函数」。
  const ALL_ITEMS = D.allItems();
  const idsOfKind = function (kind) { return ALL_ITEMS.filter(function (i) { return i.kind === kind; }).map(function (i) { return i.id; }); };
  const fishIds = bulkPicksOf(picks.fish, idsOfKind('fish'));
  const matIds = bulkPicksOf(picks.material, idsOfKind('material'));
  const chestIds = bulkPicksOf(picks.chest, idsOfKind('chest'));
  const part = String(d.part || '');
  const partBases = D.COMPONENT_BASES.filter(function (b) { return !part || b.part === part; });
  // 限定了底材却与所选部位没有交集 → 直接报错（静默忽略限定会让人以为「按限定挂的」）
  const rawPicked = (Array.isArray(picks.component) ? picks.component : []).map(String);
  const pickedBases = rawPicked.filter(function (id) { return partBases.some(function (b) { return b.id === id; }); });
  if (rawPicked.length && !pickedBases.length) return { error: '限定的组件底材都不在所选部位下（换部位或清空底材限定）' };
  const baseIds = pickedBases.length ? pickedBases : partBases.map(function (b) { return b.id; });
  if (kinds.indexOf('component') >= 0 && !baseIds.length) return { error: '所选部位下没有可用的底材（换部位或清空底材限定）' };

  const q = (d.quality && typeof d.quality === 'object') ? d.quality : {};
  const qWeights = { common: 3, rare: 2, epic: 1, mythic: 0 };
  Object.keys(qWeights).forEach(function (k) { if (q[k] != null) qWeights[k] = Math.max(0, Number(q[k]) || 0); });
  if (kinds.indexOf('component') >= 0 && !Object.keys(qWeights).some(function (k) { return qWeights[k] > 0; })) {
    return { error: '组件的品质权重至少要有一项大于 0' };
  }
  // 词条条数区间 → genComponent 的数量权重（数组下标 = 条数-1）
  const affixMin = bulkNum(d.affixMin, 1, 1, 4);
  const affixMax = bulkNum(d.affixMax, 0, 0, 4);   // 0 = 用该品质上限
  const affixWeights = [1, 2, 3, 4].map(function (n) {
    return (n >= affixMin && (!affixMax || n <= affixMax)) ? 1 : 0;
  });
  const qtyMin = bulkNum(d.qtyMin, 1, 1, 999);
  const qtyMax = Math.max(qtyMin, bulkNum(d.qtyMax, 1, 1, 999));
  let mulMin = bulkMul(d.mulMin, 1), mulMax = bulkMul(d.mulMax, 1);
  if (mulMin > mulMax) { const t = mulMin; mulMin = mulMax; mulMax = t; }
  const hours = [6, 12, 24].indexOf(Number(d.hours)) >= 0 ? Number(d.hours) : 24;

  const pickOne = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
  const randInt = function (a, b) { return a + Math.floor(Math.random() * (b - a + 1)); };
  const priceOf = function (id) { return Math.max(1, Math.round(unitPriceOf(id) * (mulMin + Math.random() * (mulMax - mulMin)))); };
  const items = [];
  const byKind = {};
  kinds.forEach(function (kind) {
    const n = rawOf(kind);
    for (let i = 0; i < n; i++) {
      let id = null;
      if (kind === 'fish') id = pickOne(fishIds);
      else if (kind === 'material') id = pickOne(matIds);
      else if (kind === 'chest') id = pickOne(chestIds);
      // 组件走 genComponent（返回的是实例元数据对象，取 .id —— 与宝匣开箱同一套用法）
      else {
        const comp = D.genComponent(pickOne(baseIds), D.weightedKey(qWeights, 'common'), { countWeights: affixWeights, minAffixes: affixMin });
        id = comp ? comp.id : null;
      }
      // 兜底：造不出来 / 不可上架 / 整竿（整竿只能来自钓竿槽位）一律跳过，不让脏数据进市集
      if (!id || !sellableOf(id) || D.isRodSet(id)) continue;
      items.push({ id: id, name: itemName(id), qty: kind === 'component' ? 1 : randInt(qtyMin, qtyMax), price: priceOf(id) });
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
  });
  if (!items.length) return { error: '没有生成出任何可上架的物品（检查限定物品与品质权重）' };
  const mul = mulMin === mulMax ? String(mulMin) : (mulMin + '~' + mulMax);
  return { items: items, hours: hours, mul: mul, byKind: byKind };
}
function broadcastRecords() { broadcast({ type: 'records', records: world.bigRecords, small: world.smallRecords, last: world.lastRec || null }); }

function groundCounts() {
  const map = {};
  players.forEach(function (p) { if (p.status === 'fishing' && p.groundId) map[p.groundId] = (map[p.groundId] || 0) + 1; });
  return map;
}
function broadcastGrounds() { broadcast({ type: 'grounds', counts: groundCounts(), total: players.size }); }
// perf-4 的独立节流已被 perf-5/6 取代：sendPlayersAll 走 presence 1s 节流 + 批量广播队列
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
  req.securityResponse = res;
  try {
  if (!Transport.headers(req, res)) { req.resume(); return apiResp(res, 403, { error: '不允许的请求来源' }); }
  if (process.env.REQUIRE_HTTPS === '1' && !Transport.secure(req)) { req.resume(); return apiResp(res, 426, { error: '请通过 HTTPS 访问' }); }
  if (req.method === 'POST' && !Transport.csrf(req)) { req.resume(); return apiResp(res, 403, { error: '请求来源验证失败' }); }
  // ---- CORS 预检（分离部署时，浏览器对跨域 POST 会先发 OPTIONS） ----
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const u = url.parse(req.url, true);
  const p = u.pathname;
  if (Object.prototype.hasOwnProperty.call(u.query, 'token')) { req.resume(); return apiResp(res, 400, { error: 'URL 不允许携带会话凭据' }); }
  req.authToken = Transport.token(req, p.startsWith('/api/admin/'));
  u.query.token = req.authToken;
  if (p === '/api/admin/logout' && req.method === 'POST') {
    sessionDelete(req.authToken); Transport.setCookie(req, res, '', true, true);
    req.resume(); return apiResp(res, 200, { ok: true });
  }
  if (!Security.authRate(req, p)) { req.resume(); res.setHeader('Retry-After', '60'); return apiResp(res, 429, { error: '请求过于频繁，请稍后重试' }); }
  // 管理员穿透：开启后，带管理员身份的请求可以继续使用「已关闭」的功能（玩家端照常受限）。
  // 客户端在每个请求上都带 X-Auth-Token（见 net.js），因此这里不必先解析请求体。
  function adminBypassAllowed(req, u) {
    if (!world.features || world.features.adminBypass !== true) return false;
    const tok = req.authToken || '';
    return !!adminOf(tok);
  }
  req.featureAllowed = function () {
    const feature = Features.route(req.method, p);
    if (!Features.blocked(world.features, feature)) return true;
    if (adminBypassAllowed(req, u)) return true;   // v0.16.0：管理员可进入已关闭功能
    apiResp(res, 423, { error: Features.message(world.features, feature), code: 'FEATURE_LOCKED', feature: feature });
    return false;
  };
  if (!req.featureAllowed()) { req.resume(); return; }
  if (p === '/api/features' && req.method === 'GET') return apiResp(res, 200, { features: world.features || {} });
  if (p === '/api/admin/features' && req.method === 'GET') {
    if (!adminOf(u.query.token)) return apiResp(res, 403, { error: '需要管理员权限' });
    return apiResp(res, 200, { features: world.features || {}, groups: Features.groups });
  }
  if (p === '/api/admin/features' && req.method === 'POST') {
    return readBody(req, function (body) {
      const d = bodyObj(body);
      if (!d) return apiResp(res, 400, { error: '请求格式错误' });
      if (!adminOf(d.token)) return apiResp(res, 403, { error: '需要管理员权限' });
      if (!d.features || typeof d.features !== 'object' || Array.isArray(d.features)) return apiResp(res, 400, { error: '功能配置格式错误' });
      const keys = Object.keys(d.features);
      // adminBypass 是「开关的开关」（v0.16.0）：不在功能目录里，但同样必须是布尔值
      if (keys.some(function (key) {
        if (typeof d.features[key] !== 'boolean') return true;
        return key === 'adminBypass' ? false : !Features.byId[key];
      })) return apiResp(res, 400, { error: '未知功能或开关值不是布尔值' });
      world.features = Object.assign({}, world.features || {}, d.features);
      saveConfig();
      if (Features.blocked(world.features, 'fishing.cast')) {
        Array.from(fishingTimers.keys()).forEach(function (key) { stopFishingSession(key, { forget: true }); });
      }
      if (Features.blocked(world.features, 'ground.trade')) {
        trades.forEach(function (t, id) { if (!t.done && !t.cancelled) { t.cancelled = true; t.closed = true; broadcastTrade(t); trades.delete(id); } });
      }
      broadcast({ type: 'features', features: world.features });
      return apiResp(res, 200, { ok: true, features: world.features });
    });
  }

  if (p === '/api/register/challenge' && req.method === 'GET') {
    const challenge = Registration.issue(req);
    return apiResp(res, challenge ? 200 : 429, challenge || { error: '请求过于频繁' });
  }
  if (p === '/api/admin/registration/stats' && req.method === 'GET') {
    if (!adminOf(req.authToken)) return apiResp(res, 403, { error: '需要管理员权限' });
    return apiResp(res, 200, Registration.snapshot());
  }
  // ---- 注册 ----
  if (p === '/api/register' && req.method === 'POST') {
    readBody(req, async function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '请求格式错误' });
      const username = (d.username || '').trim();
      const password = d.password || '';
      const name = (d.name || '').trim() || username;
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return apiResp(res, 400, { error: '用户名需为 3-20 位字母/数字/下划线' });
      Transport.passwordPolicy(password);
      if (d.confirmPassword != null && String(d.confirmPassword) !== password) return apiResp(res, 400, { error: '两次输入的密码不一致' });
      // QQ 号必填：5-12 位数字
      const qq = String(d.qq == null ? '' : d.qq).trim();
      if (!qq) return apiResp(res, 400, { error: '请填写 QQ 号' });
      if (!/^[0-9]{5,12}$/.test(qq)) return apiResp(res, 400, { error: 'QQ 号需为 5-12 位数字' });
      const key = username.toLowerCase();
      const guard = Registration.begin(req, key);
      if (guard.status) return apiResp(res, guard.status, { error: guard.error });
      if (guard.challenge && !Registration.consume(req, d.proof)) {
        Registration.metrics.challenged++;
        return apiResp(res, 403, { error: '请完成注册验证后重试', code: 'REGISTRATION_CHALLENGE' });
      }
      const pwHash = await Transport.hashPassword(password);
      if (users[key]) {
        Registration.metrics.duplicate++; Registration.metrics.rejected++;
        return apiResp(res, 409, { error: '注册未完成，请更换账号或稍后再试' });
      }
      Registration.metrics.created++;
      users[key] = { username: username, pwHash: pwHash, name: name, qq: qq, coins: 500, inventory: {}, bd: {}, codex: {}, catchCount: 0, createdAt: Date.now() };
      saveAccount(key);
      const token = newToken(); sessionSet(token, key);
      apiResp(res, 200, { token: Transport.loginToken(req, res, token, false), profile: profileOf(key) });
    });
    return;
  }

  // ---- 登录 ----
  if (p === '/api/login' && req.method === 'POST') {
    readBody(req, async function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '请求格式错误' });
      const key = (d.username || '').trim().toLowerCase();
      // v0.16.0：异常登录防护——同账号 + 同 IP 连续失败达上限后锁定一段时间
      const ident = loginIdent(req, key);
      if (!Security.rate('account:' + key, 30, 60000)) return apiResp(res, 429, { error: '账号尝试过于频繁，请稍后重试' });
      const lockMs = loginLockRemain(ident);
      if (lockMs > 0) return apiResp(res, 429, { error: '登录失败次数过多，请 ' + Math.ceil(lockMs / 60000) + ' 分钟后再试' });
      const rec = users[key];
      if (!rec || !await verifyPassword(rec, d.password, key)) {
        return loginFailureResponse(res, ident, '用户名或密码错误');
      }
      const ban = banInfoOf(rec);
      if (ban.banned) return apiResp(res, 403, { error: '账号已被封禁：' + banTextOf(ban) });
      loginOk(ident);
      kickUserSessions(key); // 顶号：同账号旧会话全部失效
      const token = newToken(); sessionSet(token, key);
      apiResp(res, 200, { token: Transport.loginToken(req, res, token, false), profile: profileOf(key) });
    });
    return;
  }

  // ---- 登出：使该 token 失效并断开实时连接 ----
  if (p === '/api/logout' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) d = {}; // 解析失败或不是对象：当空请求处理
      const token = req.authToken;
      Transport.setCookie(req, res, '', false, true);
      const key = token && sessionGet(token);
      if (key) {
        sessionDelete(token);
        // 仅当该账号已无其他有效会话时，才断开实时连接并移除玩家
        const stillLive = Array.from(sessions.values()).some(function (v) { return v && v.key === key; });
        if (!stillLive) {
          stopFishingSession(key);
          const doomed = [];
          clientOwners.forEach(function (ownerKey, res) { if (ownerKey === key) doomed.push(res); });
          doomed.forEach(function (res) {
            clients.delete(res); clientOwners.delete(res); clientViews.delete(res);
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
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录或会话失效' });
    // 封禁中：会话立即失效（管理员封禁时已踢过一次；这里兜住「封禁期间仍拿着旧 token」的情况）
    const ban = banInfoOf(users[key]);
    if (ban.banned) { sessionDelete(u.query.token); return apiResp(res, 403, { error: '账号已被封禁：' + banTextOf(ban), code: 'BANNED' }); }
    try { autoSellCheck(key); } catch (e) {}  // 读档即触发：离线期间价格回升越过阈值的情况
    return apiResp(res, 200, profileOf(key));
  }

  // ---- 保存显示名（资产/背包/配置一律由服务器维护，不再接受客户端上报） ----
  if (p === '/api/profile' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const key = d.token && sessionGet(d.token);
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
    const key = u.query.token && sessionGet(u.query.token);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.write('retry: 3000\n\n');
    if (!key) {
      res.write('data: ' + JSON.stringify({ type: 'kicked', msg: '登录已失效，请重新登录' }) + '\n\n');
      res.end();
      return;
    }
    // 封禁中的账号不允许建立实时连接（在线玩家被踢后，浏览器自动重连也会在这里被挡下）
    const ban0 = banInfoOf(users[key]);
    if (ban0.banned) {
      res.write('data: ' + JSON.stringify({ type: 'kicked', msg: '账号已被封禁：' + banTextOf(ban0) }) + '\n\n');
      res.end();
      return;
    }
    clients.add(res);
    clientOwners.set(res, key);
    const id = key;
    const rec = users[key];
    const existing = players.get(id);
    players.set(id, { id: id, name: rec.name, status: 'idle', groundId: null, spotId: null, recent: null, fishing: null });
    // 重连自动续钓：账号里还记着「上次没主动收竿的钓点」就接着钓（服务器更新强刷 / 掉线 / 重启都走这里）
    const resumed = resumeFishingSpot(id);
    res.write('data: ' + JSON.stringify({
      type: 'init', you: id, feed: feed, features: world.features || {},
      // perf-9：init 不再携带全量 players（5000 人时 868KB）与全量 records（50-100KB）——
      // 玩家列表走分页 API（/api/players/page），榜单走拉取制（/api/records）。
      playersTotal: players.size, recordsVersion: world.recordsVersion || 0,
      shop: shopSnapshot(), marketRevision: marketRevision, marketTotal: world.listings.length,
      grounds: groundCounts(), trade: myTradeView(id),
      // 钓场目录（含管理后台保存的掉落池/增益/锁定覆盖）：新客户端连接时同步，
      // 否则前端会一直用 data.js 里的硬编码默认值，导致图鉴产地与实际掉落不符。
      groundCfg: D.GROUNDS,
      codex: rec.codex || {}, catchCount: rec.catchCount || 0,
      bigfish: rec.bigfish || null,   // v0.13.6：大型/巨型预留计数（背包标签行/筛选）
      // 服务器版本：客户端据此判断自己是不是旧前端。重启换版本后 SSE 会自动重连，
      // 这条 init 就是「服务器已更新」的最快信号（比定时轮询快得多）。
      version: D.VERSION,
      // 续钓成功时一并带回钓速明细，前端不必再发一次 start 请求（顶栏立刻显示正确钓速）
      resumedFishing: resumed,
    }) + '\n\n');
    sendPlayersAll();
    // 心跳：v0.16.0 起同时发一条注释与一条**真消息**——注释能保活代理，但前端看不见，
    // 因此客户端无法分辨「连接还活着」和「连接假死（readyState 仍是 OPEN 却收不到数据）」。
    // data 版 ping 让前端可以做心跳看门狗，切后台回来时能立刻判断要不要重连。
    const hb = setInterval(function () {
      try {
        if (!sessionGet(req.authToken)) {
          clearInterval(hb);
          res.end('data: ' + JSON.stringify({ type: 'kicked', msg: '会话已过期，请重新登录' }) + '\n\n');
          return;
        }
        res.write(': ping\n\n');
        res.write('data: ' + JSON.stringify({ type: 'ping', t: Date.now() }) + '\n\n');
      } catch (e) {}
    }, 25000);
    req.on('close', function () {
      clearInterval(hb);
      const wasTracked = clientOwners.get(res) === id;
      clients.delete(res); clientOwners.delete(res); clientViews.delete(res);
      if (!wasTracked) return; // 该连接已被顶号流程接管，跳过清理
      // 同一账号可能同时挂着多条实时连接（强刷时新旧连接短暂重叠、多标签页）：
      // 只有全部断开才算掉线——否则新连接刚续上的钓会被旧连接的清理逻辑掐掉。
      const stillLive = Array.from(clientOwners.values()).some(function (k) { return k === id; });
      if (stillLive) return;
      stopFishingSession(id); // 断线即停竿：钓鱼循环是服务器权威的（钓点保留，重连自动续钓）
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
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const key = d.token && sessionGet(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      const r = startFishingSession(key, d.groundId, d.spotId);
      if (r.error) return apiResp(res, 400, { error: r.error });
      const found = spotOf(d.groundId, d.spotId);
      apiResp(res, 200, { ok: true, interval: r.interval, castInfo: castInfoOf(users[key], found && found.spot) });
    });
    return;
  }
  // ---- 钓竿存档：购买槽位 / 保存 / 命名 / 改名 / 使用（切换）/ 删除 ----
  // 当前装备的钓竿即「第 1 个槽位」（免费）；购买更多槽位用于保存与快速切换。
  if (p === '/api/rod/slot/buy' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const price = nextRodSlotPrice(rec);
        if (price == null) return apiResp(res, 400, { error: '钓竿槽位已达上限（' + ROD_SLOT_MAX + ' 根）' });
        if ((rec.coins || 0) < price) return apiResp(res, 400, { error: '金币不足（购买第 ' + (rodSlotCountOf(rec) + 1) + ' 个槽位需 ' + price + '）' });
        rec.coins -= price;
        rec.rodSlotsCount = rodSlotCountOf(rec) + 1;
        rodSlotsOf(rec);
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, { ok: true, coins: rec.coins, price: price, rodSlotsCount: rec.rodSlotsCount, nextRodSlotPrice: nextRodSlotPrice(rec), rodSlots: rodSlotView(rec) });
      });
    });
    return;
  }
  if (p === '/api/rod/save' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const slot = Math.floor(Number(d.slot));
        if (!isFinite(slot) || slot < 0 || slot >= rodSlotCountOf(rec)) {
          return apiResp(res, 400, { error: '槽位未购买（当前已购买 ' + rodSlotCountOf(rec) + ' 个）' });
        }
        const parts = rodPartsOfBd(rec.bd);
        if (!Object.keys(parts).length) return apiResp(res, 400, { error: '当前钓竿还没有装配任何组件' });
        const slots = rodSlotsOf(rec);
        const activeSlot = rodActiveSlotOf(rec);
        if (activeSlot >= 0 && activeSlot !== slot) {
          return apiResp(res, 400, { error: '当前钓竿已占用槽位 ' + (activeSlot + 1) + '（可直接「改名」）；如需另存请先卸下再装配' });
        }
        if (slots[slot] && Object.keys(rodPartsOfBd(slots[slot].bd)).length && slot !== activeSlot) {
          if (!d.force) return apiResp(res, 400, { error: '该槽位已有钓竿，请先删除或选择其他槽位' });
          deliverRodToInventory(rec, D.rodSetId(rodPartsOfBd(slots[slot].bd)) || '');
        }
        // 保存 = 当前装配的这根直接占用该槽位（配件保持装戴并被锁定），仍可继续使用与改名
        const name = String(d.name != null ? d.name : ((slots[slot] || {}).name || '')).trim().slice(0, ROD_NAME_MAX) || (rec.rodName || '');
        slots[slot] = { name: name, bd: JSON.parse(JSON.stringify(rec.bd || {})), t: Date.now() };
        rec.rodName = name;
        rec.rodActiveSlot = slot;
        saveAccount(key);
        const found = null;
        void found;
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, slot: slot, bd: rec.bd, rodName: rec.rodName, rodActiveSlot: rec.rodActiveSlot,
          inventory: rec.inventory, invRev: invRevOf(rec), rodSlots: rodSlotView(rec), rodLocked: rodUsageOf(rec),
        });
      });
    });
    return;
  }
  if (p === '/api/rod/name' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        rec.rodName = String(d.name || '').trim().slice(0, ROD_NAME_MAX);
        const as = rodActiveSlotOf(rec);
        if (as >= 0) rodSlotsOf(rec)[as].name = rec.rodName; // 使用中的钓竿改名 → 槽位名同步
        saveAccount(key);
        apiResp(res, 200, { ok: true, rodName: rec.rodName, rodSlots: rodSlotView(rec) });
      });
    });
    return;
  }
  if (p === '/api/rod/rename' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const slot = Math.floor(Number(d.slot));
        const sl = rodSlotsOf(rec)[slot];
        if (!sl) return apiResp(res, 404, { error: '该槽位没有已保存的钓竿' });
        sl.name = String(d.name || '').trim().slice(0, ROD_NAME_MAX);
        if (rodActiveSlotOf(rec) === slot) rec.rodName = sl.name;
        saveAccount(key);
        apiResp(res, 200, { ok: true, rodName: rec.rodName, rodSlots: rodSlotView(rec) });
      });
    });
    return;
  }
  if (p === '/api/rod/use' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const slot = Math.floor(Number(d.slot));
        const sl = rodSlotsOf(rec)[slot];
        if (!sl || !Object.keys(rodPartsOfBd(sl.bd)).length) return apiResp(res, 404, { error: '该槽位没有已保存的钓竿' });
        if (rodActiveSlotOf(rec) === slot) return apiResp(res, 400, { error: '这根钓竿正在使用中' });
        // 当前装配的是「散件」（不属于任何槽位）时，切换前把散件退回背包，避免丢失
        let returned = 0;
        if (rodActiveSlotOf(rec) < 0) {
          const loose = rodPartsOfBd(rec.bd);
          Object.keys(loose).forEach(function (k) { invAdd(rec, loose[k], 1); returned++; });
        }
        // 使用槽位里的钓竿：槽位保持占用（原钓竿原地不动），仅切换「使用中」指向
        rec.bd = JSON.parse(JSON.stringify(sl.bd || {}));
        rec.rodName = sl.name || '';
        rec.rodActiveSlot = slot;
        saveAccount(key);
        const pNow = players.get(key);
        const atSpot = (pNow && pNow.fishing) ? spotOf(pNow.fishing.groundId, pNow.fishing.spotId) : null;
        if (atSpot) restartFishingAt(atSpot.ground.id, atSpot.spot.id);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, bd: rec.bd, rodName: rec.rodName, rodActiveSlot: rec.rodActiveSlot, returned: returned,
          inventory: rec.inventory, invRev: invRevOf(rec), rodSlots: rodSlotView(rec), rodLocked: rodUsageOf(rec),
          interval: atSpot ? intervalFor(rec, atSpot.spot) : null,
          castInfo: atSpot ? castInfoOf(rec, atSpot.spot) : null,
        });
      });
    });
    return;
  }
  // ---- 收起当前钓竿：槽位钓竿只是「卸下」不再装戴（仍保留在槽位、配件继续锁定）；
  //      散件装配则把配件退回背包，便于装配另一根钓竿。
  if (p === '/api/rod/stow' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const parts = rodPartsOfBd(rec.bd);
        if (!Object.keys(parts).length) return apiResp(res, 400, { error: '当前没有装戴钓竿' });
        const as = rodActiveSlotOf(rec);
        let returned = 0;
        if (as < 0) {
          Object.keys(parts).forEach(function (k) { invAdd(rec, parts[k], 1); returned++; });
        }
        rec.bd = {};
        rec.rodName = '';
        rec.rodActiveSlot = -1;
        saveAccount(key);
        const pNow = players.get(key);
        const atSpot = (pNow && pNow.fishing) ? spotOf(pNow.fishing.groundId, pNow.fishing.spotId) : null;
        if (atSpot) restartFishingAt(atSpot.ground.id, atSpot.spot.id);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, returned: returned, fromSlot: as, bd: rec.bd, rodName: rec.rodName, rodActiveSlot: -1,
          inventory: rec.inventory, invRev: invRevOf(rec), rodSlots: rodSlotView(rec), rodLocked: rodUsageOf(rec),
          interval: atSpot ? intervalFor(rec, atSpot.spot) : null,
          castInfo: atSpot ? castInfoOf(rec, atSpot.spot) : null,
        });
      });
    });
    return;
  }
  if (p === '/api/rod/delete' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const slot = Math.floor(Number(d.slot));
        const slots = rodSlotsOf(rec);
        if (!slots[slot]) return apiResp(res, 404, { error: '该槽位没有已保存的钓竿' });
        const isActive = rodActiveSlotOf(rec) === slot;
        let back = 0;
        if (isActive) {
          // 使用中的：解除占用但保持装戴（配件仍锁定在竿上），随后可直接改名/改动
          rec.rodActiveSlot = -1;
        } else {
          // 未使用的：把它的配件退回背包（解锁可交易）
          back = deliverRodToInventory(rec, D.rodSetId(rodPartsOfBd(slots[slot].bd)) || '');
        }
        slots[slot] = null;
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, returned: back, wasActive: isActive, rodActiveSlot: rec.rodActiveSlot,
          rodSlots: rodSlotView(rec), inventory: rec.inventory, invRev: invRevOf(rec), rodLocked: rodUsageOf(rec),
        });
      });
    });
    return;
  }

  // ---- 停止钓鱼 ----
  if (p === '/api/fishing/stop' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const key = d.token && sessionGet(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      stopFishingSession(key, { forget: true }); // 玩家主动收竿：忘掉离线钓点，重连不再自动续钓
      apiResp(res, 200, { ok: true });
    });
    return;
  }

  // ---- 钓竿配置：装备/卸下组件（服务器校验部位与组件目录，掷骰加成由此生效） ----
  if (p === '/api/bd/set' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        // 钓速变化即时生效：正在钓鱼则按新间隔重启循环
        const pl = players.get(key);
        let interval = null;
        if (pl && pl.fishing) {
          const old = fishingTimers.get(key);
          if (old) clearInterval(old);
          const found = spotOf(pl.fishing.groundId, pl.fishing.spotId);
          interval = intervalFor(rec, found && found.spot);
          fishingTimers.set(key, setInterval(function () { try { fishTick(key); } catch (e) { console.error('[fishTick] ' + key + ' 抛错（跳过本竿，服务继续）: ' + ((e && e.stack) || e)); } }, interval));
        }
        // 钓速明细随装备变化即时更新（含当前钓点的增益）
        // 卸下配件 = 把这根已保存的钓竿拆开，它在槽位里的那份配置随之取消。
        // 旧行为是把改动后的装配同步回槽位快照：槽位会被静默改写成残件，卸光后更会留下
        // 「空壳槽位」——界面显示为空、却被 freeRodSlotOf 当成空位复用，新存的竿就把原配置顶掉。
        const wasActiveSlot = rodActiveSlotOf(rec);
        let releasedSlot = -1;
        let releasedName = '';
        if (!comp && wasActiveSlot >= 0) {
          releasedSlot = wasActiveSlot;
          releasedName = (rodSlotsOf(rec)[wasActiveSlot] || {}).name || '';
          rodSlotsOf(rec)[wasActiveSlot] = null;
          rec.rodActiveSlot = -1;
        } else {
          syncActiveRodSlot(rec); // 换装：使用中的钓竿被改动 → 槽位快照同步（其配件仍锁定）
        }
        saveAccount(key);
        const pNow = players.get(key);
        const atSpot = (pNow && pNow.fishing) ? spotOf(pNow.fishing.groundId, pNow.fishing.spotId) : null;
        apiResp(res, 200, { ok: true, bd: rec.bd, effects: bdEffectsOf(rec.bd), interval: interval, inventory: rec.inventory, invRev: invRevOf(rec),
          rodSlots: rodSlotView(rec), rodLocked: rodUsageOf(rec),
          rodActiveSlot: rodActiveSlotOf(rec), releasedSlot: releasedSlot, releasedName: releasedName,
          castInfo: castInfoOf(rec, atSpot && atSpot.spot) });
      });
    });
    return;
  }

  // ---- 开发/测试辅助：仅 FISHING_DEV=1 时存在；正常部署（run.bat）不开启 ----
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/catch' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        let itemId = d.item && d.item.id;
        if (!itemId) return apiResp(res, 400, { error: '缺少物品' });
        // 组件：规范化为实例签名（旧编码 id 会被升级）；渔获/材料保持不变
        itemId = D.normalizeItemId(itemId);
        const itemMeta = D.itemOf(itemId);
        invAdd(rec, itemId, 1);
        // v0.13.6：与线上一致——先按体型判档（大型/巨型预留 + 图鉴最高档）
        const rawSize0 = d.item && d.item.size != null ? d.item.size : d.size;
        const devTier = sizeTierOf(itemId, Number(rawSize0));
        if (devTier) bigfishOf(rec, itemId)[devTier] += 1;
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
        if (devTier && cx.tier !== 'G') cx.tier = devTier;
        rec.codex[codexId] = cx;
        let recordEvent = null;
        let smallEventDev = false;
        let globalRecordDev = null;
        let topBigRankDev = 0, topSmallRankDev = 0;
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
          const dTop = upsertTopRanked((world.topCatches[itemId] = world.topCatches[itemId] || []), { size: rsize, who: rec.name, t: Date.now() }, false);
          void dTop;   // 历史总榜只记榜；横幅播报走当日榜（见下 rankPut）
          const smD = world.smallRecords[itemId];
          if (!smD || rsize < smD.size) {
            world.smallRecords[itemId] = { id: itemId, name: itemName(itemId), size: rsize, who: rec.name, t: Date.now() };
            smallEventDev = true;
          }
          const dTopS = upsertTopRanked((world.topSmall[itemId] = world.topSmall[itemId] || []), { size: rsize, who: rec.name, t: Date.now() }, true);
          void dTopS;   // 同上：历史总榜不驱动横幅
          // v0.13.8：日/周榜分桶（与线上同一路径），当日名次驱动横幅播报
          const dayRankDev = rankPut(itemId, rsize, rec.name, Date.now());
          topBigRankDev = dayRankDev.big;
          topSmallRankDev = dayRankDev.small;
          saveRecordsSoon();
        }
        const entry = { t: Date.now(), who: rec.name, item: Object.assign({}, d.item, { id: itemId }, isFinite(size) && size > 0 ? { size: Math.round(size * 10) / 10 } : {}, devTier ? { tier: devTier } : {}), ground: d.ground, spot: d.spot, size: isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null };
        feed.unshift(entry); if (feed.length > 60) feed.pop();
        // perf-8：与线上一致——通知等级过滤 + 瘦身（原来这里漏了 feedVisible 过滤）
        if (feedVisible(entry.item, !!(recordEvent || smallEventDev))) broadcast({ type: 'feed', entry: slimFeedEntry(entry) });
        saveAccount(key);
        // 与线上一致：任意榜单更新都播报
        const boardDev = boardAnnouncement({
          who: rec.name, name: itemName(itemId), size: (isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null),
          globalMax: !!globalRecordDev, record: !!recordEvent, small: smallEventDev, topBig: topBigRankDev, topSmall: topSmallRankDev,
        });
        if (boardDev && bannerCatchAllowed(boardDev.level)) broadcast({ type: 'globalRecord', record: Object.assign({}, globalRecordDev || { id: itemId, name: itemName(itemId), size: size, who: rec.name, t: Date.now() }, { key: key, text: boardDev.text, level: boardDev.level }) });
        if (boardDev) {
          // 与线上一致：记录页顶部的「最新播报」同步更新
          world.lastRec = {
            id: itemId, name: itemName(itemId), size: (isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null),
            who: rec.name, t: Date.now(), level: boardDev.level, text: boardDev.text, global: !!globalRecordDev,
          };
          markRecordsDirty();
        }
        if (recordEvent || smallEventDev || globalRecordDev) {
          saveRecords();
          if (recordEvent || smallEventDev) markRecordsDirty();
        }
        if (recordEvent && feedVisible(entry.item, true)) broadcast({ type: 'feed', entry: slimFeedEntry({ t: Date.now(), who: rec.name, item: entry.item, ground: entry.ground, spot: entry.spot, size: entry.size, record: true }) });
        // 与线上一致：定向推送本条渔获（perf-8c 增量：codexAdd + assets 只发金币/背包增量）
        sendTo(key, { type: 'catch', entry: entry });
        sendTo(key, { type: 'codexAdd', id: codexId, name: itemName(codexId), add: 1, mx: cx.max, mn: cx.min, tier: cx.tier || null, catchCount: rec.catchCount });
        const devInvDelta = {}; devInvDelta[itemId] = 1;
        let devBigDelta = null;
        if (devTier) { devBigDelta = {}; devBigDelta[itemId] = {}; devBigDelta[itemId][devTier] = 1; }
        sendTo(key, { type: 'assets', coins: rec.coins, catchCount: rec.catchCount, invAdd: devInvDelta, bigAdd: devBigDelta });
        maybeSendSubAlert(rec, key, itemMeta);
        // 与线上一致：模拟的是一次真实上鱼 → 若满足玩家的自动售出规则，同样立即卖出
        try { autoSellCheck(key); } catch (e) {}
        apiResp(res, 200, { ok: true, codex: cx, tier: devTier || null, bigfish: rec.bigfish || {}, record: recordEvent });
      });
    });
    return;
  }
  // 仅测试：模拟 n 次双钓判定，返回追加条数分布（验证 P=A/(A+100) 与最多 3 条）
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/doublecount' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      auth(req, res, body, function (d, key) {
        const range = Array.isArray(d.range) && d.range.length === 2 ? d.range : [150, 400];
        const eff = { size: Number(d.size) || 0 };
        const n = Math.max(1, Math.min(1000, Number(d.n) || 1));
        // 可选 model：验证「加成不设上限」这类与分布无关的性质时用 linear，避免正态下极值靠运气
        const model = d.model != null ? d.model : null;
        if (model != null && D.ROLL_MODELS.indexOf(model) < 0) return apiResp(res, 400, { error: '未知的体型 roll 模型' });
        const out = [];
        for (let i = 0; i < n; i++) out.push(rollSizeOf(range, eff, model));
        apiResp(res, 200, { ok: true, rolls: out, max: Math.max.apply(null, out), model: model || D.getFishCfg().sizeModel });
      });
    });
    return;
  }
  if (process.env.FISHING_DEV === '1' && p === '/api/dev/seed' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        if (d.inventory) {
          const next = {};
          // 与管理员快照同口径：过滤 0 / 负数 / 非数字，避免造出「0 件键」（前端会把它当一种物品画出来）
          Object.keys(d.inventory).forEach(function (id) {
            const q = Math.floor(Number(d.inventory[id]));
            if (!isFinite(q) || q <= 0) return;
            const nid = D.normalizeItemId(id);
            next[nid] = (next[nid] || 0) + q;
          });
          rec.inventory = next;
          bumpInvRev(rec); // 整体覆写背包：同样要让 rev 前进，否则前端会拿旧 rev 的快照覆盖回去（v0.13.9）
        }
        if (d.bigfish !== undefined) rec.bigfish = d.bigfish || null; // v0.13.6：测试可直接种体型档预留
        // 覆写背包/预留后夹一次：预留量不得超过持有量（否则会出现「可用量为负 → 钳 0」的假状态，
        // 前端算出的可卖/可上架数字会和实际对不上）
        Object.keys(rec.bigfish || {}).forEach(function (id) { bigfishClampTo(rec, id); });
        if (d.coins != null) rec.coins = d.coins;
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, { ok: true });
      });
    });
    return;
  }

  // ---- 系统商店：查询价格 / 出售物品 ----
  if (p === '/shop' && req.method === 'GET') {
    // Wiki 经济页复用该接口展示当前收购价；价格随供需实时变化，不允许缓存成旧价。
    return apiResp(res, 200, shopSnapshot(), { 'Cache-Control': 'no-store' });
  }
  // 市集挂单快照（公开只读；前端进入市集页时按需拉取）
  if (p === '/api/market' && req.method === 'GET') {
    sweepExpiredListings();
    return apiResp(res, 200, MarketPage.page(world.listings, u.query, sessionGet(req.authToken), marketRevision));
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
  // ---- 宝匣（沉船打捞）：查询 / 合成 / 开箱 ----
  // 合成：残片 × costRelic + 金币 costCoins → 宝匣物品入包（宝匣可市集交易，但不可卖给系统商店）
  // 开箱：消耗 1 个宝匣 → 服务器权威掷骰（基底/品质/词条数由 data.js 的 CHESTS 档位决定）
  // 保底：连续 N-1 次未突破则第 N 次必出突破件（N 由后台「宝匣配置」设定，0 = 关闭）
  //   仅对有突破判定的档位生效（即带 extra 的档位）；判定与计数都以 data.js 的 breakthrough 为准。
  function chestPickBase(chest, d) {
    if (chest.mode === 'random') {
      return D.COMPONENT_BASES[Math.floor(Math.random() * D.COMPONENT_BASES.length)];
    }
    if (chest.mode === 'part') {
      const part = String(d.part || '');
      const cands = D.COMPONENT_BASES.filter(function (b) { return b.part === part; });
      if (!cands.length) return { error: '未知的部位（该部位没有可用底材）' };
      return cands[Math.floor(Math.random() * cands.length)];
    }
    const base = D.componentBase(String(d.baseId || ''));
    if (!base) return { error: '未知的底材' };
    return base;
  }
  function chestViewList(rec) {
    const cfg = chestCfgOf();
    return D.CHESTS.map(function (c) {
      const p = chestPityOf(rec, c.id);
      return {
        id: c.id, name: c.name, rarity: c.rarity, desc: c.desc, mode: c.mode,
        costRelic: c.costRelic, costCoins: c.costCoins, price: c.price,
        hasExtra: !!c.extra, minAffixes: c.minAffixes || 0, forceMax: !!c.forceMax,
        have: invCountOf(rec, c.id),
        // 保底进度：pityNow = 已连续未突破次数；pityNeed = 还差几次触发（0 = 本档位无保底）
        pityNow: c.extra ? p : 0,
        pityNeed: (c.extra && cfg.pityN > 0) ? Math.max(0, cfg.pityN - p) : 0,
      };
    });
  }
  if (p === '/api/chest' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const rec = users[key];
    const cfg = chestCfgOf();
    return apiResp(res, 200, {
      chests: chestViewList(rec), relicId: 'relic', relicName: itemName('relic'),
      relicHave: invCountOf(rec, 'relic'), relicPrice: basePrice('relic'),
      pityN: cfg.pityN, coins: rec.coins,
    });
  }
  if (p === '/api/chest/craft' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const chest = D.chestOf(String(d.chestId || ''));
        if (!chest) return apiResp(res, 400, { error: '未知的宝匣' });
        const qty = d.qty === undefined ? 1 : d.qty; // 单次批量上限：避免误点把残片一次清光
        const needRelic = chest.costRelic * qty;
        const needCoins = chest.costCoins * qty;
        if (!invHas(rec, 'relic', needRelic)) {
          return apiResp(res, 400, { error: '宝匣残片不足（需 ' + needRelic + ' 个，当前 ' + invCountOf(rec, 'relic') + ' 个）' });
        }
        if ((rec.coins || 0) < needCoins) return apiResp(res, 400, { error: '金币不足（需 ' + needCoins + '）' });
        invAdd(rec, 'relic', -needRelic);
        invAdd(rec, chest.id, qty);
        rec.coins -= needCoins;
        saveAccount(key);
        // v0.13.9：合成宝匣与开箱一样是「付费换物」的不可逆操作，立刻落盘——1s 防抖窗口内
        // 进程被强杀会连扣掉的残片/金币带新合成的宝匣一起丢，玩家看到的就是「凭空少了一批东西」。
        flushAccounts();
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, chestId: chest.id, qty: qty, coins: rec.coins,
          inventory: rec.inventory, invRev: invRevOf(rec), chests: chestViewList(rec),
        });
      });
    });
    return;
  }
  if (p === '/api/chest/open' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const chest = D.chestOf(String(d.chestId || ''));
        if (!chest) return apiResp(res, 400, { error: '未知的宝匣' });
        if (!invHas(rec, chest.id, 1)) return apiResp(res, 400, { error: '没有「' + chest.name + '」可开（请先合成）' });
        const base = chestPickBase(chest, d);
        if (base && base.error) return apiResp(res, 400, { error: base.error });
        const cfg = chestCfgOf();
        const before = chestPityOf(rec, chest.id);
        // 保底触发：把 50% 掷骰换成必中（genBreakthrough 内部对「池长已够」的底材本来就是免费满池）
        const forced = !!(chest.extra && cfg.pityN > 0 && before >= cfg.pityN - 1);
        const item = chest.extra
          ? D.genBreakthrough(base.id, {
              hitCount: chest.hitCount, missCount: chest.missCount,
              chance: forced ? 1 : chest.chance,
            })
          : D.genComponent(base.id, D.rollChestQuality(chest), {
              minAffixes: chest.minAffixes, forceMax: !!chest.forceMax,
            });
        if (!item) return apiResp(res, 500, { error: '产出生成失败' });
        invAdd(rec, chest.id, -1);
        invAdd(rec, item.id, 1);
        // 图鉴登记（与钓鱼一致：组件按底材登记，累计获得次数）
        rec.codex = rec.codex || {};
        const cx = rec.codex[item.baseId] || { count: 0, first: Date.now() };
        cx.count += 1;
        rec.codex[item.baseId] = cx;
        // 保底计数：突破则清零，未突破则累加
        rec.chestPity = rec.chestPity || {};
        if (item.breakthrough) delete rec.chestPity[chest.id];
        else rec.chestPity[chest.id] = before + 1;
        saveAccount(key);
        // v0.13.9：开箱成功立刻落盘（不等 1s 防抖窗口）——玩家刚开出的配件在界面里已经爆出，
        // 若此时进程被强杀而整批账号还没写盘，重启后配件就「消失」了（线上反馈的丢件现象之一）。
        flushAccounts();
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        // 突破件全服播报（复用纪录横幅轨）：稀有度足够高，是免费的内容运营素材
        if (item.breakthrough) {
          broadcast({
            type: 'globalRecord',
            record: { level: 2, key: key, who: rec.name, name: item.name, t: Date.now(),
              text: '🎁 ' + rec.name + ' 从「' + chest.name + '」打捞出神话突破件：' + item.name + '（4 词条）' },
          });
        }
        apiResp(res, 200, {
          ok: true, chestId: chest.id, chestName: chest.name, item: item, coins: rec.coins,
          inventory: rec.inventory, invRev: invRevOf(rec), forced: forced,
          pityNow: chestPityOf(rec, chest.id), pityNeed: (chest.extra && cfg.pityN > 0) ? Math.max(0, cfg.pityN - chestPityOf(rec, chest.id)) : 0,
          chests: chestViewList(rec),
        });
      });
    });
    return;
  }
  // ---- 商城（每日限购）：读取当前周期商品与限购余额 ----
  if (p === '/api/mall' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    return apiResp(res, 200, mallView(users[key]));
  }
  // ---- 商城：购买（服务器权威：校验限购 / 金币 / 商品有效性，成功后入包广播） ----
  if (p === '/api/mall/buy' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const view = mallView(rec);
        const item = view.items.find(function (x) { return x.id === String(d.id || ''); });
        if (!item) return apiResp(res, 400, { error: '该商品不在商城中' });
        const qty = d.qty === undefined ? 1 : d.qty;
        if (qty > MALL_MAX_QTY) return apiResp(res, 400, { error: '超过单次购买上限' });
        if (item.limit > 0 && item.remain != null && qty > item.remain) {
          return apiResp(res, 400, { error: '超过今日限购（剩余 ' + item.remain + ' 件）' });
        }
        const cost = item.price * qty;
        if ((rec.coins || 0) < cost) return apiResp(res, 400, { error: '金币不足（需 ' + cost + '，当前 ' + Math.round(rec.coins || 0) + '）' });
        rec.coins -= cost;
        invAdd(rec, item.id, qty);
        const cyc = D.mallCycleOf(view.refreshTime, Date.now());
        const bought = mallBoughtOf(rec, cyc.key);
        rec.mall = { key: cyc.key, bought: Object.assign({}, bought) };
        rec.mall.bought[item.id] = (rec.mall.bought[item.id] || 0) + qty;
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        const next = mallView(rec);
        apiResp(res, 200, {
          ok: true, id: item.id, name: item.name, qty: qty, cost: cost, coins: rec.coins,
          inventory: rec.inventory, invRev: invRevOf(rec), mall: next,
        });
      });
    });
    return;
  }
  // ---- 工坊 · 熔炼：读取参数（材料→词缀对照 / 成功率与花费系数） ----
  if (p === '/api/workshop' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const rec = users[key];
    const cfg = smeltCfgOf();
    const materials = D.smeltMaterialIds().map(function (id) {
      const it = D.itemOf(id);
      return { id: id, name: it.name, rarity: it.rarity, affix: D.smeltMaterialAffix(id), affixName: D.AFFIX_LABEL[D.smeltMaterialAffix(id)] || '' };
    });
    const pearlMeta = D.itemOf(D.SMELT_PEARL);
    return apiResp(res, 200, {
      ok: true, cfg: cfg, materials: materials,
      pearl: { id: D.SMELT_PEARL, name: pearlMeta.name, rarity: pearlMeta.rarity },
      affixLabel: D.AFFIX_LABEL, coins: rec.coins || 0,
      // 重铸（v0.16.0）：材料为龙宫宝珠——基础消耗重 roll 全部词条，
      // 额外投入宝珠可指定单条词条（第 n 条 = 额外 n 颗）；由后台「⚒ 工坊配置」决定。
      // v0.16.3：金币改成**每颗宝珠的单价**（goldPerPearl），总手续费 = 宝珠数 × 单价（见 D.recastGoldFor）。
      recast: {
        quality: D.RECAST_QUALITY, qualityName: (D.QUALITY[D.RECAST_QUALITY] || {}).name || D.RECAST_QUALITY,
        pearlId: D.SMELT_PEARL, pearlName: pearlMeta.name,
        pearlBase: Math.max(0, Math.floor(Number(cfg.recastPearl) || 0)),
        pearlHave: invCountOf(rec, D.SMELT_PEARL),
        goldPerPearl: Math.max(0, Math.floor(Number(cfg.recastGold) || 0)),
        minValue: !!cfg.recastMinValue,
      },
      // 熔炼 · 残片保留（海王遗匣产出的神话主件专享）：片数上限与每片概率由后台「⚒ 工坊配置」决定。
      // v0.13：每片概率由公式给出（默认 10 - breakthrough * 0.5，breakthrough = 主件突破词缀条数），
      // 客户端拿到公式后按所选主件自己算每片/总概率；另附投入 1 片即保护的说明。
      retain: {
        quality: D.RECAST_QUALITY, qualityName: (D.QUALITY[D.RECAST_QUALITY] || {}).name || D.RECAST_QUALITY,
        relicId: 'relic', relicName: itemName('relic'),
        max: Math.max(0, Math.floor(Number(cfg.retainMaxRelic) || 0)),
        formula: String(cfg.retainFormula || ''),
        per: D.retainChancePerRelic(0),
        protectAffix: true,
        relicHave: invCountOf(rec, 'relic'),
      },
    });
  }
  // ---- 工坊 · 熔炼：执行（结果掷骰复用 data.js；服务器负责权威资产结算） ----
  if (p === '/api/workshop/smelt' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const plan = planSmelt(rec, d);
        if (plan.error) return apiResp(res, 400, { error: plan.error });
        const out = D.simulateSmeltPlan(plan);
        // 资源先扣（成功与否都消耗：副件被熔毁、材料烧掉、残片烧掉、金币花掉）
        rec.coins -= plan.gold;
        invAdd(rec, plan.subId, -1);
        plan.consume.forEach(function (e) { invAdd(rec, e.id, -1 * e.qty); });
        if (out.success) {
          invAdd(rec, plan.mainId, -1);
          invAdd(rec, out.resultId, 1);
        } else {
          invAdd(rec, plan.mainId, -1);
          invAdd(rec, out.mainAfterId, 1);
        }
        try { syncActiveRodSlot(rec); } catch (e) {}
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, Object.assign({
          ok: true,
          rate: plan.rates.rate, extraRate: plan.rates.extraRate, gold: plan.gold,
          pearl: plan.pearl, rollBoundary: plan.rollBoundary,
          load: plan.load, extraType: plan.extraType, ranges: plan.ranges,
          relics: plan.relics, relicId: plan.relicId, retainChance: plan.retainChance,
          breakthrough: plan.breakthrough, perRelic: plan.perRelic, retainFormula: plan.retainFormula,
          mainId: plan.mainId, subId: plan.subId,
          coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec),
        }, out));
      });
    });
    return;
  }
  // ---- 工坊 · 重铸：用龙宫宝珠重 roll 神话件词条数值（服务器掷骰） ----
  // 带 affixIndex = 指定单条词条（额外消耗 = 第几条就几颗）；不带 = 重 roll 全部词条。
  if (p === '/api/workshop/recast' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const plan = planRecast(rec, d.id, d.affixIndex);
        if (plan.error) return apiResp(res, 400, { error: plan.error });
        const rolled = D.recastAffixes(plan.meta.baseId, plan.meta.affixes, plan.target >= 0 ? plan.target : undefined);
        if (!rolled || !rolled.length) return apiResp(res, 400, { error: '该组件没有可重铸的词条' });
        const before = plan.meta.affixes.map(function (a) { return { type: a.type, value: a.value }; });
        // 先扣材料与金币，再换件（新旧签名相同时也要走一遍「扣一件、加一件」）
        invAdd(rec, plan.pearlId, -plan.pearlNeed);
        if (plan.gold) rec.coins -= plan.gold;
        invAdd(rec, plan.meta.id, -1);
        const newId = D.instanceId(plan.meta.baseId, plan.meta.quality, rolled);
        invAdd(rec, newId, 1);
        try { syncActiveRodSlot(rec); } catch (e) {}
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, changed: newId !== plan.meta.id,
          before: before, item: D.componentOf(newId), id: newId,
          target: plan.target,
          gold: plan.gold, pearlBase: plan.pearlBase, pearlExtra: plan.pearlExtra, pearlNeed: plan.pearlNeed,
          pearlId: plan.pearlId, pearlName: itemName(plan.pearlId),
          materials: [{ id: plan.pearlId, name: itemName(plan.pearlId), need: plan.pearlNeed, have: invCountOf(rec, plan.pearlId) }],
          coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec),
        });
      });
    });
    return;
  }
  if (p === '/api/sell' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const id = d.id; const qty = d.qty === undefined ? 1 : d.qty;
        // v0.13.6：tier='L'|'G' → 按「大型/巨型」通道出售（单独预留量，售出额外金币加成）
        const tier = (d.tier === 'L' || d.tier === 'G') ? d.tier : null;
        if (D.isRodSet(id)) return apiResp(res, 400, { error: '整根钓竿请在「商城 → 市集」上架出售（收购不收整竿）' });
        if (D.isChest(id)) return apiResp(res, 400, { error: '宝匣请在「商城 → 市集」交易（收购不收宝匣）' });
        if (!sellableOf(id)) return apiResp(res, 400, { error: '该物品无法出售' });
        if (tier && !FISH_ID_SET[id]) return apiResp(res, 400, { error: '只有渔获有体型档' });
        const rodLock = rodLockError(rec, id, qty);
        if (rodLock) return apiResp(res, 400, { error: rodLock });
        if (tier) {
          const bf = rec.bigfish && rec.bigfish[id];
          if (!bf || (bf[tier] || 0) < qty) return apiResp(res, 400, { error: tierNameOf(tier) + '鱼数量不足' });
          if (!invHas(rec, id, qty)) return apiResp(res, 400, { error: '数量不足' });
        } else {
          // 普通通道：大型/巨型鱼单独预留，不随普通出售/上架动用
          if (invAvailOf(rec, id) < qty) return apiResp(res, 400, { error: '数量不足' });
        }
        const unit = unitPriceOf(id);
        // 额外金币：大型 +50% / 巨型 +150%（按售出当时收购价；不新增收购项、不影响供需记账）
        const bonus = tier ? Math.round(unit * qty * SIZE_TIER_BONUS[tier]) : 0;
        const gain = unit * qty + bonus;
        invAdd(rec, id, -qty);
        if (tier) bigfishDropOf(rec, id, tier, qty);
        rec.coins += gain;
        // 仅经济物品（渔获/材料）影响供需乘数与价格历史；组件固定价，只加金币
        if (ECO_PRICE[id]) registerSale(id, qty, rec.name, unit);
        saveAccount(key); saveEconomy();
        broadcastShop();
        // v0.16.2：卖出后除了 HTTP 回包，再推一条**带 inventory 的权威快照**。
        // 回包是「当场序列化」的，若客户端此刻已经收到更新的钓鱼增量，回包会被判旧丢弃
        // （表现：金币涨了、卖掉的竿身还在背包里，再卖报「数量不足」）。多标签页 / 多设备也一并受益。
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), bigfish: rec.bigfish || {} });
        apiResp(res, 200, { ok: true, unit: unit, bonus: bonus, gain: gain, coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), bigfish: rec.bigfish || {}, shop: shopSnapshot() });
      });
    });
    return;
  }

  // ---- 自动售出规则：读取 / 设置（玩家自助） ----
  // v0.13.8 重做：按物品（渔获 / 材料）逐条启用，支持最少保留数量与批量设置。
  // 规则项：{ on, minPct, minPrice, slackPct, slackPrice, keep }；两条价格线都空 = 不看价格。
  // 请求：单件 { id, ... }；批量 { bulk: 'fish'|'material'|'all', ... }；只传 on = 就地开关（不动阈值）；
  //       remove:true = 删除该件（或该批）规则。空值（'' / null）表示该线不参与判定。
  if (p === '/api/autosell' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const rec = users[key];
    return apiResp(res, 200, { ok: true, items: autoSellItems(rec) || {}, batch: autoSellBatchOf(), tier: autoSellTierOn(rec), plan: autoSellPlanView(rec) });
  }
  if (p === '/api/autosell' && req.method === 'POST') {
    readBody(req, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        // v0.14.0：「体型档」开关（全账号一个，不属于任何单件规则）——开了之后自动售出也会卖掉
        // 大型/巨型鱼（走各自通道、含加成）。单独一个请求：只带 tier，不带 id/bulk。
        if (d.tier !== undefined && d.bulk == null && d.id == null && d.scope == null) {
          rec.autoSell = rec.autoSell || { items: {} };
          if (!rec.autoSell.items) rec.autoSell.items = {};
          rec.autoSell.tier = !!d.tier;
          saveAccount(key);
          const soldT = (function () { try { return autoSellCheck(key); } catch (e) { return null; } })();
          return apiResp(res, 200, { ok: true, tier: rec.autoSell.tier, items: rec.autoSell.items || {}, batch: autoSellBatchOf(),
            plan: autoSellPlanView(rec), sold: soldT || null, coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec),
            bigfish: rec.bigfish || {}, shop: shopSnapshot() });
        }
        const cleanPos = function (v, max) {
          if (v == null || v === '') return null;
          const n = Math.floor(Number(v));
          return (isFinite(n) && n > 0 && n <= max) ? n : NaN;
        };
        const minPct = cleanPos(d.minPct, 1000000);
        const minPrice = cleanPos(d.minPrice, 1e9);
        // 浮动接受值：允许 0（不浮动）；为非负数
        const cleanSlack = function (v, max) {
          if (v == null || v === '') return 0;
          const n = Math.floor(Number(v));
          return (isFinite(n) && n >= 0 && n <= max) ? n : NaN;
        };
        const slackPct = cleanSlack(d.slackPct, 1000000);
        const slackPrice = cleanSlack(d.slackPrice, 1e9);
        // 最少保留数量：允许 0（不保留）
        const cleanKeep = function (v) {
          if (v == null || v === '') return 0;
          const n = Math.floor(Number(v));
          return (isFinite(n) && n >= 0 && n <= 1e9) ? n : NaN;
        };
        const keep = cleanKeep(d.keep);
        if (isNaN(minPct) || isNaN(minPrice) || isNaN(slackPct) || isNaN(slackPrice) || isNaN(keep)) {
          return apiResp(res, 400, { error: '阈值需为正整数，浮动与保留数量需为非负数' });
        }
        const bulk = d.bulk != null && d.bulk !== '' ? String(d.bulk) : null;
        let ids;
        if (bulk) {
          if (bulk === 'all') ids = autoSellIdsOfKind('fish').concat(autoSellIdsOfKind('material'));
          else if (bulk === 'fish' || bulk === 'material') ids = autoSellIdsOfKind(bulk);
          else return apiResp(res, 400, { error: '未知批量范围：' + bulk });
        } else {
          const id = (d.id != null && d.id !== '') ? String(d.id) : (d.scope != null ? String(d.scope) : '');
          if (!id) return apiResp(res, 400, { error: '缺少物品 id' });
          if (!autoSellEligibleId(id)) return apiResp(res, 400, { error: '该物品不能自动售出（仅渔获与材料）：' + id });
          ids = [id];
        }
        // 只传了 on（或 remove）：就地开关，不动已有阈值——界面上的勾选框走这条路径
        const toggleOnly = d.minPct === undefined && d.minPrice === undefined &&
          d.slackPct === undefined && d.slackPrice === undefined && d.keep === undefined;
        rec.autoSell = rec.autoSell || { items: {} };
        if (!rec.autoSell.items) rec.autoSell.items = {};
        const tb = rec.autoSell.items;
        ids.forEach(function (id) {
          if (d.remove) { delete tb[id]; return; }
          if (toggleOnly) {
            const prev = tb[id];
            if (!prev) return;                                  // 没有配置过就没有可开关的
            prev.on = d.on != null ? !!d.on : !prev.on;
            return;
          }
          tb[id] = {
            on: d.on != null ? !!d.on : true,
            minPct: minPct, minPrice: minPrice,
            slackPct: slackPct, slackPrice: slackPrice,
            keep: keep,
          };
        });
        saveAccount(key);
        const sold = (function () { try { return autoSellCheck(key); } catch (e) { return null; } })();
        apiResp(res, 200, { ok: true, items: rec.autoSell.items || {}, batch: autoSellBatchOf(), plan: autoSellPlanView(rec),
          sold: sold || null, coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), shop: shopSnapshot() });
      });
    });
    return;
  }

  // ---- 开放市集：上架 / 购买 / 下架 ----
  if (p === '/api/market/list' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const price = d.price;
        // 整根钓竿上架：来源是钓竿槽位（整体卖出，组件随挂单走）
        let id = null, qty = 1, rodFrom = -1;
        if (d.rodSlot != null) {
          rodFrom = d.rodSlot;
          const sl = rodSlotsOf(rec)[rodFrom];
          if (!sl) return apiResp(res, 400, { error: '该槽位没有已保存的钓竿' });
          id = D.rodSetId(rodPartsOfBd(sl.bd));
          if (!id) return apiResp(res, 400, { error: '该钓竿没有装配任何组件' });
        } else {
          id = D.normalizeItemId(d.id);
          qty = d.qty === undefined ? 1 : d.qty;
        }
        if (!sellableOf(id)) return apiResp(res, 400, { error: '该物品不可上架' });
        // v0.14.0：**暂时屏蔽鱼类的市集上架**（体型档改版期间，渔获改由系统收购 + 档位按钮出售）。
        // 这是一个开关式的临时限制：把 MARKET_FISH_LIST 改回 true 即恢复，前后端各一处（见 ui.js 同名常量）。
        // 只拦「新上架」：已有挂单照常可买 / 可下架，不受影响。
        if (!MARKET_FISH_LIST && D.itemOf(id).kind === 'fish') {
          return apiResp(res, 400, { error: '鱼类暂时不能在市集上架（改版中：渔获请直接在商城·收购出售，大型/巨型鱼可按档位出售拿加成）' });
        }
        if (rodFrom < 0) {
          const rodLock = rodLockError(rec, id, qty);
          if (rodLock) return apiResp(res, 400, { error: rodLock });
          // v0.13.6：大型/巨型鱼单独预留，普通上架不可动用
          if (invAvailOf(rec, id) < qty) return apiResp(res, 400, { error: '数量不足（大型/巨型鱼为预留量，请在背包标签行单独出售）' });
        }
        sweepExpiredListings();
        const myCount = world.listings.filter(function (l) { return l.seller === key; }).length;
        const myCap = listingCapOf(rec);
        if (myCap > 0 && myCount >= myCap) return apiResp(res, 400, { error: '挂单数量已达上限（同时最多 ' + myCap + ' 个，可在市集下架后再上架）' });
        const hours = d.hours === undefined ? 6 : d.hours;
        const feeRate = LIST_FEE_RATES[hours];
        const fee = Math.ceil(price * qty * feeRate); // 上架费：定价总额 × 时长费率，下架不退
        if (rec.coins < fee) return apiResp(res, 400, { error: '金币不足（需上架费 ' + fee + '）' });
        let listingName = itemName(id);
        if (rodFrom >= 0) {
          const sl = rodSlotsOf(rec)[rodFrom];
          listingName = (sl.name ? sl.name + ' · ' : '') + '整根钓竿（' + Object.keys(rodPartsOfBd(sl.bd)).length + ' 件）';
          if (rodActiveSlotOf(rec) === rodFrom) { rec.bd = {}; rec.rodName = ''; rec.rodActiveSlot = -1; } // 卖掉的正是使用中的那根
          rodSlotsOf(rec)[rodFrom] = null; // 从槽位移出
        } else {
          invAdd(rec, id, -qty);
        }
        rec.coins -= fee;
        const ttl = LISTING_TTL_MS_ENV || hours * 3600 * 1000;
        const listing = { lid: world.listingSeq++, seller: key, sellerName: rec.name, id: id, name: listingName, qty: qty, price: price, t: Date.now(), expireAt: Date.now() + ttl, hours: hours };
        world.listings.push(listing);
        saveAccount(key); saveMarket();
        broadcastMarket();
        apiResp(res, 200, { ok: true, listing: listing, inventory: rec.inventory, invRev: invRevOf(rec), fee: fee, coins: rec.coins, rodSlots: rodSlotView(rec) });
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
        const qty = d.qty === undefined ? l.qty : d.qty;
        if (qty > l.qty) return apiResp(res, 400, { error: '购买数量超过挂单数量' });
        const total = l.price * qty;
        if (rec.coins < total) return apiResp(res, 400, { error: '金币不足（需 ' + total + '）' });
        const tax = Math.ceil(total * 0.10);          // 10% 交易税（由卖家承担）
        const sellerGain = total - tax;
        if (D.isRodSet(l.id) && qty !== l.qty) return apiResp(res, 400, { error: '整根钓竿只能整单购买' });
        if (D.isRodSet(l.id) && freeRodSlotOf(rec) < 0) {
          return apiResp(res, 400, { error: '钓竿槽位已满（' + rodSlotCountOf(rec) + '/' + ROD_SLOT_MAX + '），请先购买槽位或清空一个槽位再购买整竿' });
        }
        rec.coins -= total;
        if (D.isRodSet(l.id)) {
          // 整根钓竿整体进入空槽位（不拆散）；槽位名沿用挂单名，可自行改名
          const nameHint = String(l.name || '').replace(/\s*·?\s*整根钓竿（\d+ 件）$/, '').trim().slice(0, ROD_NAME_MAX);
          const putAt = stashRodToSlot(rec, l.id, nameHint);
          if (putAt < 0) return apiResp(res, 400, { error: '钓竿槽位已满，无法放入整根钓竿' });
        } else invAdd(rec, l.id, qty);
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
        // 市集成交同时进「📜 日志 · ✅ 交易」：买卖双方各推一条（含物品 id，客户端据此解析词条数值）。
        // 不能只推 notice：notice 会落进「系统」分类，市集成交属于交易流水。
        const mktEvent = { type: 'mktTrade', t: Date.now(), id: l.id, name: l.name, qty: qty,
          price: l.price, total: total, tax: tax, sellerGain: sellerGain,
          buyer: key, buyerName: rec.name, seller: l.seller, sellerName: l.sellerName };
        sendTo(key, Object.assign({ role: 'buy', other: l.sellerName }, mktEvent));
        // 卖家可能不在当前页面，必须主动推送权威资产，否则收不到钱
        if (seller && l.seller !== key) {
          sendTo(l.seller, { type: 'assets', coins: seller.coins, inventory: seller.inventory, invRev: invRevOf(seller) });
          sendTo(l.seller, Object.assign({ role: 'sell', other: rec.name, coins: seller.coins }, mktEvent));
        }
        // v0.16.0：整竿成交也要把槽位状态一并回给买家 —— 否则买到的钓竿要等下一次 /api/me（重登）
        // 才会出现在「钓鱼 · 钓竿」的栏位里，界面上表现为「买了但栏位没变」。
        apiResp(res, 200, {
          ok: true, qty: qty, total: total, tax: tax, coins: rec.coins,
          inventory: rec.inventory, invRev: invRevOf(rec),
          rodSlots: rodSlotView(rec), rodSlotsCount: rodSlotCountOf(rec), rodActiveSlot: rodActiveSlotOf(rec),
          rodLocked: rodUsageOf(rec), rodName: rec.rodName || '', nextRodSlotPrice: nextRodSlotPrice(rec),
        });
      });
    });
    return;
  }
  // ---- 我的历史订单（市集成交记录：买入 + 卖出） ----
  if (p === '/api/market/history' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
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
        if (D.isRodSet(l.id)) deliverRodBack(rec, l.id, l.name); // 整竿下架：优先整根回槽位
        else invAdd(rec, l.id, l.qty);
        world.listings.splice(idx, 1);
        saveAccount(key); saveMarket();
        broadcastMarket();
        // 整竿下架会回到槽位：把槽位状态一并带回，界面当场就能看到（与市集购买同一口径）
        apiResp(res, 200, {
          ok: true, inventory: rec.inventory, invRev: invRevOf(rec),
          rodSlots: rodSlotView(rec), rodSlotsCount: rodSlotCountOf(rec), rodActiveSlot: rodActiveSlotOf(rec),
          rodLocked: rodUsageOf(rec), nextRodSlotPrice: nextRodSlotPrice(rec),
        });
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
        const items = d.items;
        // 校验物品与数量
        const rec = users[key];
        const norm = [];
        const seen = new Set();
        for (const it of items) {
          const id = D.normalizeItemId(it.id); const qty = it.qty;
          if (!id || D.isRodSet(id) || !sellableOf(id) || seen.has(id)) return apiResp(res, 400, { error: '交易物品非法或重复' });
          seen.add(id);
          if (invAvailOf(rec, id) < qty) return apiResp(res, 400, { error: '你没有足够的 ' + itemName(id) });
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
          // 二次校验，防并发。⚠️ 必须用可用量（总量 − 大型/巨型预留）：与 /api/trade/set 同一口径，
          // 否则「设好交易后把普通量卖掉」会让这里的总量校验继续通过，把预留的大鱼交易出去（v0.13.9）
          const okA = t.aItems.every(function (it) { return invAvailOf(ra, it.id) >= it.qty; });
          const okB = t.bItems.every(function (it) { return invAvailOf(rb, it.id) >= it.qty; });
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
          // 通知双方最新库存；aItems/bItems 一并下发，客户端据此把「给出/获得」写进交易日志
          const settlement = { type: 'tradeDone', tradeId: t.id,
            aItems: t.aItems, bItems: t.bItems, aName: t.a.name, bName: t.b.name,
            a: { key: t.a.key, inventory: Object.assign({}, ra.inventory), coins: ra.coins, invRev: invRevOf(ra) }, b: { key: t.b.key, inventory: Object.assign({}, rb.inventory), coins: rb.coins, invRev: invRevOf(rb) } };
          sendTo(t.a.key, settlement);
          sendTo(t.b.key, settlement);
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
  // profile=wiki：给无登录 Wiki 使用的完整规则快照；默认响应保持轻量并兼容现有前端。
  if (p === '/api/version' && req.method === 'GET') {
    const profile = String(u.query.profile || '');
    if (profile && profile !== 'wiki') return apiResp(res, 400, { error: '未知的版本 profile' });
    const payload = versionPayload(profile);
    if (profile === 'wiki') {
      const etag = '"' + payload.snapshot.snapshotId + '"';
      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, { 'Cache-Control': 'no-cache', 'ETag': etag });
        res.end();
        return;
      }
      return apiResp(res, 200, payload, { 'Cache-Control': 'no-cache', 'ETag': etag });
    }
    return apiResp(res, 200, payload, { 'Cache-Control': 'no-cache' });
  }
  // ---- 钓场目录（公开只读；含管理后台保存的掉落池/增益/锁定覆盖） ----
  // 前端在进入游戏时主动拉取一次，作为 SSE init 之外的兜底，确保后进入/刷新的玩家也能拿到最新目录。
  // 产出倍率（dropCfg）非默认时下发「有效权重」，图鉴概率与实钓一致。
  if (p === '/api/grounds' && req.method === 'GET') {
    return apiResp(res, 200, { grounds: groundsWithDrop() });
  }

  // ---- 组件订阅提醒：查询 / 保存（玩家级配置，落盘账号文件，重登后保留）----
  if (p === '/api/subscribe' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const cfg = users[key].subNotify || {};
    return apiResp(res, 200, {
      ok: true, cfg: cfg,
      catalog: { bases: D.COMPONENT_BASES.map(function (b) { return { id: b.id, name: b.name, part: b.part }; }), qualities: D.QUALITY, affixes: D.AFFIX_LABEL },
    });
  }
  if (p === '/api/subscribe' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const baseId = String(d.baseId || '');
        if (baseId && !D.componentBase(baseId)) return apiResp(res, 400, { error: '未知的底材' });
        const quality = String(d.quality || '');
        if (quality && !D.QUALITY[quality]) return apiResp(res, 400, { error: '未知的品质' });
        const affixType = String(d.affixType || '');
        if (affixType && !D.AFFIX_LABEL[affixType]) return apiResp(res, 400, { error: '未知的词条类型' });
        function optNum(v) {
          if (v == null || v === '') return null;
          const n = Number(v);
          return isFinite(n) ? Math.round(n) : NaN;
        }
        const min = optNum(d.min), max = optNum(d.max);
        if (Number.isNaN(min) || Number.isNaN(max)) return apiResp(res, 400, { error: '数值范围需为数字' });
        if (min != null && max != null && min > max) return apiResp(res, 400, { error: '最小值不能大于最大值' });
        rec.subNotify = {
          on: !!d.on, baseId: baseId, quality: quality, affixType: affixType, min: min, max: max,
          badge: d.badge !== false, blink: d.blink !== false,
        };
        saveAccount(key);
        apiResp(res, 200, { ok: true, cfg: rec.subNotify });
      });
    });
    return;
  }

  // ---- 反馈意见：查询 CD 状态 / 提交（默认 24h CD；可花 10000 金币立即结束 CD）----
  function feedbackStatusOf(key) {
    const meta = (world.feedbackMeta && world.feedbackMeta[key]) || {};
    const nextAt = meta.nextAt || 0;
    const now = Date.now();
    return { nextAt: nextAt, ready: now >= nextAt, remainingMs: Math.max(0, nextAt - now), skipCost: feedbackSkipCost(), cdHours: Math.round(feedbackCdMs() / 3600000 * 100) / 100 };
  }
  if (p === '/api/feedback' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
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
          return apiResp(res, 429, { error: '冷却中，' + Math.ceil(st.remainingMs / 60000) + ' 分钟后可再次提交（或花 ' + st.skipCost + ' 金币立即结束冷却）', status: st });
        }
        const text = String(d.text || '').trim().slice(0, FEEDBACK_MAX_LEN);
        if (!text) return apiResp(res, 400, { error: '反馈内容不能为空' });
        const entry = { id: 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), t: Date.now(), key: key, name: rec.name, text: text, kind: String(d.kind || 'other').slice(0, 20), version: D.VERSION, status: 'submitted' };
        world.feedback = world.feedback || [];
        world.feedback.push(entry);
        if (world.feedback.length > FEEDBACK_KEEP) world.feedback.splice(0, world.feedback.length - FEEDBACK_KEEP);
        world.feedbackMeta = world.feedbackMeta || {};
        world.feedbackMeta[key] = { nextAt: Date.now() + feedbackCdMs(), lastAt: Date.now() };
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
        const cost = feedbackSkipCost();
        if (rec.coins < cost) return apiResp(res, 400, { error: '金币不足（需 ' + cost + '）' });
        rec.coins -= cost;
        world.feedbackMeta[key] = Object.assign({}, world.feedbackMeta[key] || {}, { nextAt: 0 });
        saveAccount(key); saveFeedback();
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, { ok: true, coins: rec.coins, status: feedbackStatusOf(key) });
      });
    });
    return;
  }

  // ---- 图鉴 / 大鱼榜 ----
  if (p === '/api/codex' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const rec = users[key];
    return apiResp(res, 200, { codex: rec.codex || {}, catchCount: rec.catchCount || 0 });
  }
  if (p === '/api/records' && req.method === 'GET') {
    return apiResp(res, 200, {
      records: world.bigRecords, small: world.smallRecords, globalMax: world.globalMax || null,
      // v0.13.8：记录页顶部展示「当前最新播报的鱼」（没有播报过时为 null，前端回退到全场最大）
      last: world.lastRec || null,
      rankLabel: { day: rankLabelOf('day'), week: rankLabelOf('week'), all: rankLabelOf('all') },
    });
  }
  // 某种鱼的捕获榜（公开只读）：range=day|week|all（默认 all）；kind=small 取小鱼榜
  if (p === '/api/records/top' && req.method === 'GET') {
    const fid = u.query.id;
    if (!FISH_ID_SET[fid]) return apiResp(res, 404, { error: '未知鱼类' });
    const small = String(u.query.kind || '') === 'small';
    const range = (u.query.range === 'day' || u.query.range === 'week') ? u.query.range : 'all';
    const list = range === 'all'
      ? (small ? ((world.topSmall && world.topSmall[fid]) || []) : ((world.topCatches && world.topCatches[fid]) || []))
      : rankListOf(range, fid, small);
    return apiResp(res, 200, {
      id: fid, name: itemName(fid), kind: small ? 'small' : 'big', range: range,
      label: rankLabelOf(range), top: list,
    });
  }

  // ================================================================
// ---- 管理后台 API（/api/admin/*）：账号须带 admin 标志 ----
  // 后台写操作统一审计（v0.16.0）：所有 /api/admin/* 的 POST 都先经这里记一条审计（谁 / 何时 / 对谁 / 做了什么），
  // 再交给端点自己的处理逻辑。走一层薄包装而不是逐个端点手写，是为了避免漏项——
  // 新增后台接口时只要沿用 adminAuditedBody 就自动进审计。未带管理员身份的请求照旧由端点返回 403（不入审计）。
  function adminAuditedBody(req, path, cb) {
    return readBody(req, function (body) {
      try {
        const d = bodyObj(body);
        const a = d && adminOf(d.token);
        if (a) {
          const target = String((d && (d.target || d.key || d.user || d.username || d.id)) || '');
          const parts = [];
          ['admin', 'hours', 'reason', 'coins', 'note', 'status', 'amount', 'qty', 'price', 'name', 'gid', 'sid', 'cid', 'range', 'spotKey', 'validateOnly', 'snap'].forEach(function (k) {
            if (d && d[k] !== undefined && (typeof d[k] !== 'object' || d[k] === null)) parts.push(k + '=' + String(d[k]).slice(0, 40));
          });
          if (d && d.features && typeof d.features === 'object') {
            const off = Object.keys(d.features).filter(function (k) { return d.features[k] === false; });
            const on = Object.keys(d.features).filter(function (k) { return d.features[k] === true; });
            parts.push('功能开关：关闭 ' + off.length + ' 项' + (on.length ? ' / 开启 ' + on.length + ' 项' : ''));
          }
          if (d && d.confirm === true) parts.push('已二次确认');
          audit(a, String(path || '').replace('/api/admin/', ''), target, parts.join(' '));
        }
      } catch (e) {}
      return cb(body);
    });
  }
  // ---- 后台 · 模拟钓竿（v0.16.0）----
// 把管理员填的「词缀合计」装到一根**合成钓竿**上，再走线上同一套 castInfoOf / 掉落池换算，
// 用来预览「任意词条组合 × 任意钓点」的实际结果（间隔 / 上鱼率 / 双钓 / 每小时期望 / 产出分布）。
// 合成钓竿只存在于这次请求里：不落盘、不碰任何真实账号，也不会被当成作弊路径。
function syntheticRodOf(totals) {
  const types = Object.keys(totals || {}).filter(function (t) {
    return D.AFFIX_LABEL[t] != null && Math.abs(Number(totals[t]) || 0) > 0;
  });
  const byPart = {};
  types.forEach(function (t) {
    // 每类词缀挑一个「词缀池里确实有这一类」的底材：保证合成组件与真实生成规则同形
    const base = D.COMPONENT_BASES.find(function (b) {
      return (b.pool || []).some(function (p) { return p.type === t; });
    });
    if (!base) return;
    (byPart[base.part] = byPart[base.part] || []).push({ type: t, value: Number(totals[t]) || 0, baseId: base.id });
  });
  const bd = {};
  Object.keys(byPart).forEach(function (part) {
    const list = byPart[part].slice(0, 4);   // 神话品质最多 4 条词缀
    const id = D.instanceId(list[0].baseId, 'mythic', list.map(function (x) { return { type: x.type, value: x.value }; }));
    bd[part] = { compId: id };
  });
  return bd;
}
function simulateRod(rec0, spot, totals) {
  const sim = D.simulateRodPlan(rec0, spot, simulationRulesOf());
  sim.totals = totals;
  return sim;
}
// 产出分布（与 /api/admin/loot/test 同一套权重换算），供模拟钓竿一并展示。
function lootPreviewRows(spot, rareVal) {
  const pool = boostPoolOf((spot && spot.pool) || [], {});
  const mult = D.rareCommonMult(Math.max(0, Number(rareVal) || 0), rareK());
  const compMult = componentCommonProb() * mult + (1 - componentCommonProb());
  const effOf = function (e) {
    const i = e.pick.indexOf(':');
    return e.pick.slice(0, i) === 'component' ? compMult : (pickIsCommon(e.pick) ? mult : 1);
  };
  const before = pool.reduce(function (s, e) { return s + e.weight; }, 0) || 1;
  const after = pool.reduce(function (s, e) { return s + e.weight * effOf(e); }, 0) || 1;
  return pool.map(function (e) {
    const i = e.pick.indexOf(':');
    const type = e.pick.slice(0, i), id = e.pick.slice(i + 1);
    let name = id, quality = '普通';
    if (type === 'fish') {
      for (const t of ['common', 'big', 'rare']) {
        const x = D.FISH[t].find(function (y) { return y.id === id; });
        if (x) { name = x.name; quality = (D.QUALITY[x.rarity] || {}).name || x.rarity; break; }
      }
    } else if (type === 'material') {
      const x = D.MATERIALS.find(function (y) { return y.id === id; });
      if (x) { name = x.name; quality = (D.QUALITY[x.rarity] || {}).name || x.rarity; }
    } else if (type === 'component') {
      name = '组件'; quality = '随机';
    }
    return { pick: e.pick, type: type, id: id, name: name, quality: quality,
      beforePct: e.weight / before * 100, afterPct: e.weight * effOf(e) / after * 100 };
  }).sort(function (a, b) { return b.afterPct - a.afterPct; });
}
  // 引导：服务器上没有任何管理员时，第一个通过后台登录的账号自动成为管理员。
  // ================================================================

  // ---- 管理后台登录（复用游戏账号密码；不顶号：不影响同一账号的游戏会话） ----
  if (p === '/api/admin/login' && req.method === 'POST') {
    adminAuditedBody(req, p, async function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const key = (d.username || '').trim().toLowerCase();
      const ident = loginIdent(req, 'admin:' + key);
      if (!Security.rate('account:' + key, 30, 60000)) return apiResp(res, 429, { error: '账号尝试过于频繁，请稍后重试' });
      const lockMs = loginLockRemain(ident);
      if (lockMs > 0) return apiResp(res, 429, { error: '登录失败次数过多，请 ' + Math.ceil(lockMs / 60000) + ' 分钟后再试' });
      const rec = users[key];
      if (!rec || !await verifyPassword(rec, d.password, key)) {
        return loginFailureResponse(res, ident, '用户名或密码错误');
      }
      const ban = banInfoOf(rec);
      if (ban.banned) return apiResp(res, 403, { error: '账号已被封禁：' + banTextOf(ban) });
      if (!rec.admin) return apiResp(res, 403, { error: '该账号没有管理员权限' });
      if (!rec.adminTotpSecret) return apiResp(res, 403, { error: '请在服务器控制台配置管理员验证器', code: 'MFA_SETUP_REQUIRED' });
      if (!Security.verifyTotp(rec, d.otp)) return loginFailureResponse(res, ident, '动态验证码无效或已使用');
      saveAccount(key); flushAccounts(); loginOk(ident);
      const token = newToken(); sessionSet(token, key, true);
      apiResp(res, 200, { ok: true, token: Transport.loginToken(req, res, token, true), username: rec.username, name: rec.name, admin: true });
    });
    return;
  }
  // ---- 会话校验（页面刷新后恢复登录态） ----
  if (p === '/api/admin/session' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    return apiResp(res, 200, { ok: true, username: a.rec.username, name: a.rec.name });
  }
  // ---- 带宽统计查询（压测观测） ----
  if (p === '/api/admin/netstats' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    return apiResp(res, 200, Object.assign({ ok: true, uptimeSec: Math.round((Date.now() - netStats.start) / 1000) }, netStats));
  }
  // ---- perf-9：玩家列表分页 / 搜索 ----
  if (p === '/api/players/page' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const size = Math.min(Math.max(parseInt(u.query.size, 10) || 30, 5), 100);
    const all = playersSortedFiltered(String(u.query.q || '').slice(0, 40), u.query.ground || null, u.query.spot || null);
    const pages = Math.max(1, Math.ceil(all.length / size));
    const page = Math.min(Math.max(parseInt(u.query.page, 10) || 1, 1), pages);
    return apiResp(res, 200, { ok: true, page: page, pages: pages, size: size, total: all.length,
      totalOnline: players.size, players: all.slice((page - 1) * size, page * size) });
  }
  // 视口登记：客户端告诉服务器自己当前正在看玩家列表的哪一页（含搜索词/钓场过滤），
  // 之后每秒只推该页玩家的最新状态（playersPage）；clear=true 取消登记（零 presence 流量）。
  if (p === '/api/players/view' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const key = d.token && sessionGet(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      let hit = 0;
      clientOwners.forEach(function (ownerKey, sres) {
        if (ownerKey !== key) return;
        hit++;
        if (d.clear) clientViews.delete(sres);
        else clientViews.set(sres, { page: parseInt(d.page, 10) || 1, size: parseInt(d.size, 10) || 30,
          q: String(d.q || '').slice(0, 40), ground: d.ground || null, spot: d.spot || null });
      });
      if (hit && !d.clear) sendPlayers(); // 立即触发一次该页推送
      return apiResp(res, 200, { ok: true, pushed: hit });
    });
    return;
  }
  // ---- 查看其他玩家当前装备的钓竿组件构成（渔场动态玩家卡片「查看」按钮） ----
  // 只读接口：返回对方的 bd 槽位（compId/name/affixes/quality），不含背包与金币等隐私数据。
  if (p === '/api/players/rod' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const key = d.token && sessionGet(d.token);
      if (!key) return apiResp(res, 401, { error: '未登录' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '玩家不存在' });
      if (!players.has(target)) return apiResp(res, 400, { error: '对方不在线' });
      // 装备弹窗需要组件目录元数据（品质/词条区间），只发槽位与组件实例 id，前端自己查目录
      apiResp(res, 200, { ok: true, name: rec.name, rodName: rec.rodName || '', bd: rec.bd || {} });
    });
    return;
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
  // ---- 服务器热力图（概览页）：区间曲线 + 星期×小时热力格 ----
  // range: 1h / 6h / 24h / 7d / 30d（默认 24h）
  if (p === '/api/admin/stats' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
        // v0.16.0：概览热力图可按钓场 / 钓点筛选（ground=钓场 id，spot=钓场:钓点）
        return apiResp(res, 200, Object.assign({ ok: true }, statsReport(u.query.range, { ground: u.query.ground, spot: u.query.spot })));
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
      playing: bannerPlayingView(),
      online: players.size,
    });
  }
  // 发布横幅：content + duration(秒)，可选 repeat(播放轮数，默认 1)
  if (p === '/api/admin/banner/add' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const content = String(d.content || '').trim().slice(0, 200);
      if (!content) return apiResp(res, 400, { error: '横幅内容不能为空' });
      const dur = Number(d.duration);
      if (!isFinite(dur) || dur < 1 || dur > 3600) return apiResp(res, 400, { error: '时长需在 1-3600 秒之间' });
      const color = validBannerColor(d.color);
      if (color === null) return apiResp(res, 400, { error: '颜色需为 #RGB 或 #RRGGBB 格式' });
      const banner = {
        id: 'bn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        seq: world.bannerSeq++, content: content, duration: Math.round(dur * 10) / 10,
        color: color, createdAt: Date.now(), by: a.rec.name,
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
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      world.bannerCfg = Object.assign({ blink: false, blinkTitle: '📢 有新公告', noticeColor: '' }, world.bannerCfg || {});
      if (d.blink != null) world.bannerCfg.blink = !!d.blink;
      if (d.noticeColor !== undefined) {
        const nc = validBannerColor(d.noticeColor);
        if (nc === null) return apiResp(res, 400, { error: '公告默认颜色需为 #RGB 或 #RRGGBB 格式' });
        world.bannerCfg.noticeColor = nc;
      }
      if (d.blinkTitle != null) world.bannerCfg.blinkTitle = String(d.blinkTitle).slice(0, 40);
      // perf-9：上鱼通告横幅等级（gmax/gmax10/fish/fish10，见 bannerCatchAllowed）
      if (d.catchLevel != null) {
        if (!['gmax', 'gmax10', 'fish', 'fish10'].includes(d.catchLevel)) return apiResp(res, 400, { error: '未知的上鱼通告横幅等级' });
        world.bannerCfg.catchLevel = d.catchLevel;
      }
      saveConfig();
      broadcast({ type: 'banner', banners: world.banners || [], cfg: world.bannerCfg });
      apiResp(res, 200, { ok: true, cfg: world.bannerCfg });
    });
    return;
  }
  // 修改已发布横幅（颜色 / 内容 / 时长）
  if (p === '/api/admin/banner/update' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const bn = (world.banners || []).find(function (x) { return x.id === d.id; });
      if (!bn) return apiResp(res, 404, { error: '横幅不存在' });
      if (d.content != null) {
        const c = String(d.content).trim().slice(0, 200);
        if (!c) return apiResp(res, 400, { error: '横幅内容不能为空' });
        bn.content = c;
      }
      if (d.duration != null) {
        const dur = Number(d.duration);
        if (!isFinite(dur) || dur < 1 || dur > 3600) return apiResp(res, 400, { error: '时长需在 1-3600 秒之间' });
        bn.duration = Math.round(dur * 10) / 10;
      }
      if (d.color !== undefined) {
        const color = validBannerColor(d.color);
        if (color === null) return apiResp(res, 400, { error: '颜色需为 #RGB 或 #RRGGBB 格式' });
        bn.color = color;
      }
      saveConfig();
      broadcast({ type: 'banner', banners: world.banners, cfg: world.bannerCfg || {} });
      apiResp(res, 200, { ok: true, banner: bn });
    });
    return;
  }
  // 客户端上报「正在滚播这条横幅」（前端在横幅开始播放时调用；仅用于后台查看滚播人数）
  if (p === '/api/banner/playing' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      auth(req, res, body, function (d, key) {
        const id = String(d.id || '');
        const bn = (world.banners || []).find(function (x) { return x.id === id; });
        if (!bn) return apiResp(res, 200, { ok: true, ignored: true });
        const cur = bannerPlaying[id] || (bannerPlaying[id] = { watchers: {}, lastAt: 0 });
        cur.watchers[key] = Date.now();
        cur.lastAt = Date.now();
        apiResp(res, 200, { ok: true });
      });
    });
    return;
  }
  // 停止滚播：广播 bannerStop，客户端立即中止正在播/待播的同 id 横幅（不删除队列条目）
  if (p === '/api/admin/banner/stop' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const id = String(d.id || '');
      if (!(world.banners || []).some(function (x) { return x.id === id; })) return apiResp(res, 404, { error: '横幅不存在' });
      delete bannerPlaying[id];
      broadcast({ type: 'bannerStop', id: id });
      apiResp(res, 200, { ok: true });
    });
    return;
  }
  // 清空整个横幅队列：广播 banner（空列表）+ 停止所有滚播
  if (p === '/api/admin/banner/clear' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const ids = (world.banners || []).map(function (b) { return b.id; });
      world.banners = [];
      ids.forEach(function (id) { delete bannerPlaying[id]; });
      saveConfig();
      broadcast({ type: 'banner', banners: [], cfg: world.bannerCfg || {} });
      ids.forEach(function (id) { broadcast({ type: 'bannerStop', id: id }); });
      apiResp(res, 200, { ok: true, cleared: ids.length });
    });
    return;
  }

  // ---- 反馈意见列表（管理员只读；按时间倒序） ----
  if (p === '/api/admin/feedback' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const list = (world.feedback || []).slice().sort(function (x, y) { return y.t - x.t; });
    return apiResp(res, 200, {
      ok: true, feedback: list, total: list.length, statuses: FEEDBACK_STATUSES,
      cfg: {
        cdHours: Math.round(feedbackCdMs() / 3600000 * 100) / 100,
        skipCost: feedbackSkipCost(),
        cdHoursDefault: FEEDBACK_CD_DEFAULT_HOURS,
        skipCostDefault: FEEDBACK_SKIP_COST_DEFAULT,
      },
    });
  }
  // ---- 反馈配置：CD 时长（小时）与清空 CD 费用（金币） ----
  if (p === '/api/admin/feedback/cfg' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      world.feedbackCfg = Object.assign({}, world.feedbackCfg || {});
      if (d.cdHours != null) {
        const h = Number(d.cdHours);
        if (!isFinite(h) || h < 0 || h > 8760) return apiResp(res, 400, { error: 'CD 时长需在 0 - 8760 小时之间' });
        world.feedbackCfg.cdHours = Math.round(h * 100) / 100;
      }
      if (d.skipCost != null) {
        const c = Math.floor(Number(d.skipCost));
        if (!isFinite(c) || c < 0 || c > 1e12) return apiResp(res, 400, { error: '清空 CD 费用需为非负整数' });
        world.feedbackCfg.skipCost = c;
      }
      saveConfig();
      apiResp(res, 200, {
        ok: true,
        cfg: { cdHours: Math.round(feedbackCdMs() / 3600000 * 100) / 100, skipCost: feedbackSkipCost() },
      });
    });
    return;
  }
  // ---- 反馈状态：管理员标记（已提交 / 已受理 / 已完成） ----
  if (p === '/api/admin/feedback/status' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
  // ---- 删除反馈（v0.16.0）：管理员可单条删除；玩家端同步移除（在线时立刻刷新） ----
  if (p === '/api/admin/feedback/del' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const id = String(d.id || '');
      const list = world.feedback || [];
      const idx = list.findIndex(function (f) { return f.id === id; });
      if (idx < 0) return apiResp(res, 404, { error: '反馈不存在' });
      const item = list[idx];
      list.splice(idx, 1);
      saveFeedback();
      // 通知提交者：他的历史列表里那条要消失（在线时立即刷新）
      if (item.key) {
        sendTo(item.key, { type: 'notice', msg: '你的一条反馈已被管理员删除' });
        sendTo(item.key, { type: 'feedback' });
      }
      apiResp(res, 200, { ok: true, id: id, total: list.length });
    });
    return;
  }
  // ---- 反馈奖励：给提交反馈的玩家发金币（可附备注），并通知玩家 ----
  if (p === '/api/admin/feedback/reward' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const coins = Math.floor(Number(d.coins));
      if (!isFinite(coins) || coins <= 0 || coins > 1000000000) return apiResp(res, 400, { error: '奖励金币需在 1 - 10 亿之间' });
      const item = (world.feedback || []).find(function (f) { return f.id === d.id; });
      if (!item) return apiResp(res, 404, { error: '反馈不存在' });
      const rec = item.key && users[item.key];
      if (!rec) return apiResp(res, 404, { error: '该反馈的玩家账号已不存在' });
      rec.coins = (rec.coins || 0) + coins;
      item.reward = {
        coins: coins,
        note: String(d.note || '').trim().slice(0, 60),
        at: Date.now(),
        by: a.rec.name,
        total: ((item.reward && item.reward.total) || 0) + coins,
      };
      saveAccount(item.key);
      saveFeedback();
      // 实时通知 + 资产同步（在线时立刻到账，离线则下次登录已带上）
      sendTo(item.key, { type: 'notice', msg: '🎁 管理员奖励了你的反馈：+' + coins + ' 金币' + (item.reward.note ? '（' + item.reward.note + '）' : '') });
      sendTo(item.key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
      apiResp(res, 200, { ok: true, id: item.id, reward: item.reward, playerCoins: rec.coins });
    });
    return;
  }
  // ---- 账号列表（管理员授权数据源） ----
  if (p === '/api/admin/users' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    // 每账号当前挂单数（账号管理页展示「已用 / 上限」，后台批量上架会把这里顶满）
    const listingCount = {};
    (world.listings || []).forEach(function (l) {
      const k = l && l.seller;
      if (k) listingCount[k] = (listingCount[k] || 0) + 1;
    });
    const list = Object.keys(users).map(function (k) {
      const r = users[k];
      const pl = players.get(k);
      const ban = banInfoOf(r);
      return {
        key: k, username: r.username, name: r.name, qq: r.qq || '',
        admin: !!r.admin, coins: r.coins || 0,
        listingCap: listingCapOf(r), capSet: r.listingCap != null, listings: listingCount[k] || 0,
        catchCount: r.catchCount || 0,
        online: !!pl,
        fishing: (pl && pl.fishing) || null,
        createdAt: r.createdAt || null,
        // v0.16.0：封禁状态（账号管理页显示「已封禁」并给解封入口）
        banned: ban.banned, banPermanent: ban.permanent, banUntil: ban.until,
        banRemainMs: ban.remainMs, banReason: ban.reason, banBy: r.banBy || '',
      };
    }).sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); });
    return apiResp(res, 200, { ok: true, users: list, me: a.key });
  }
  // ---- 设置/撤销账号的管理员权限（不能撤销自己，避免把自己锁在后台外） ----
  if (p === '/api/admin/users/setadmin' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '账号不存在' });
      if (typeof d.admin !== 'boolean') return apiResp(res, 400, { error: '权限必须为布尔值' });
      const want = d.admin;
      if (!want && rec.admin && Object.values(users).filter(r => r.admin).length <= 1) return apiResp(res, 400, { error: '不能撤销最后一位管理员' });
      if (target === a.key && !want) return apiResp(res, 400, { error: '不能撤销自己的管理员权限' });
      if (rec.admin !== want) kickUserSessions(target);
      rec.admin = want;
      saveAccount(target);
      sendTo(target, { type: 'notice', msg: want ? '🛡 你已获得管理员权限，可打开管理后台（/admin.html）' : '你的管理员权限已被收回' });
      apiResp(res, 200, { ok: true, target: target, admin: want });
    });
    return;
  }
  // ---- 删除账号（管理员；需二次确认——前端传 confirm: true） ----
  // ---- 封禁 / 解封（v0.16.0；任意时长，hours <= 0 视为自定义，负数 = 永久） ----
  // 入参：{ target, hours, reason, confirm }
  //   hours > 0   = 封禁 N 小时（支持小数）
  //   hours === 0 = 解封
  //   hours < 0   = 永久封禁
  // 封禁立即踢掉该账号的全部会话与实时连接，并在登录、/api/me、SSE 三处设卡。
  if (p === '/api/admin/users/ban' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '账号不存在' });
      if (target === a.key) return apiResp(res, 400, { error: '不能封禁自己的账号' });
      const hours = Number(d.hours);
      if (!isFinite(hours)) return apiResp(res, 400, { error: '封禁时长无效' });
      if (Math.abs(hours) > 24 * 3650) return apiResp(res, 400, { error: '封禁时长过大（上限 3650 天）' });
      if (d.confirm !== true) return apiResp(res, 400, { error: '需要二次确认' });
      const reason = String(d.reason || '').trim().slice(0, 60);
      if (hours > 0) {
        rec.banUntil = Date.now() + Math.round(hours * 3600000);
        rec.banReason = reason;
        rec.banAt = Date.now();
        rec.banBy = a.rec.name;
      } else if (hours < 0) {
        rec.banUntil = -1;                 // 负数 = 永久
        rec.banReason = reason;
        rec.banAt = Date.now();
        rec.banBy = a.rec.name;
      } else {
        delete rec.banUntil; delete rec.banReason; delete rec.banAt; delete rec.banBy;
      }
      saveAccount(target);
      const info = banInfoOf(rec);
      if (info.banned) applyBan(target);
      apiResp(res, 200, {
        ok: true, target: target, banned: info.banned, permanent: info.permanent,
        until: info.until, remainMs: info.remainMs, reason: info.reason,
      });
    });
    return;
  }
  // ---- 后台安全面板数据：审计日志 + 当前锁定中的异常登录 + 封禁名单 ----
  if (p === '/api/admin/security' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const log = (world.adminLog || []).slice(-300).reverse();
    const banned = Object.keys(users).filter(function (k) { return banInfoOf(users[k]).banned; }).map(function (k) {
      const info = banInfoOf(users[k]);
      return { key: k, name: users[k].name, username: users[k].username, permanent: info.permanent,
        until: info.until, remainMs: info.remainMs, reason: info.reason, banBy: users[k].banBy || '', banAt: users[k].banAt || 0 };
    }).sort(function (x, y) { return y.banAt - x.banAt; });
    return apiResp(res, 200, {
      ok: true, log: log, banned: banned, lockouts: loginGuardSnapshot(),
      rules: { maxFails: LOGIN_MAX_FAILS, windowMin: Math.round(LOGIN_WINDOW_MS / 60000), lockMin: Math.round(LOGIN_LOCK_MS / 60000) },
    });
  }
  if (p === '/api/admin/users/delete' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      if (!target || !users[target]) return apiResp(res, 404, { error: '账号不存在' });
      if (users[target].admin && Object.values(users).filter(r => r.admin).length <= 1) return apiResp(res, 400, { error: '不能删除最后一位管理员' });
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
      coins: rec.coins || 0, inventory: rec.inventory || {}, invRev: invRevOf(rec),
      catchCount: rec.catchCount || 0, admin: !!rec.admin,
      // v0.16.3：后台「资产快照」里可以直接看/改这套钓竿装配（每个部位装了什么）
      bd: rec.bd || {}, rodName: rec.rodName || '',
      effects: bdEffectsOf(rec.bd), interval: intervalFor(rec, null),
    });
  }
  // ---- 账号快照编辑：直接设置金币与背包（管理员） ----
  if (p === '/api/admin/users/snapshot' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
        bumpInvRev(rec); // 后台整体覆写背包：rev 必须前进（v0.13.9）
        // 预留量可能超出新的持有量（后台只编辑了 inventory）：夹回持有量，避免出现「预留 > 持有」（v0.13.9）
        Object.keys(rec.bigfish || {}).forEach(function (id) { bigfishClampTo(rec, id); });
      }
      if (d.coins != null) {
        const c = Math.floor(Number(d.coins));
        if (!isFinite(c) || c < 0 || c > 1e12) return apiResp(res, 400, { error: '金币数无效' });
        rec.coins = c;
      }
      // v0.16.3：钓竿装配（后台可单独改某个部位装了什么）。只写 rec.bd，不动背包：
      // 换下来的那件本来就不在背包里（装配时已扣），清空/换件等于把它留在“装备位”上；
      // 校验只要求「是该部位合法的组件实例」，允许管理员直接把定制件装上（背包里没有也能装，
      // 与后台「给任意物品」的权限一致；真要退回背包，玩家端卸下时会 invAdd 回去）。
      if (d.bd != null) {
        if (typeof d.bd !== 'object') return apiResp(res, 400, { error: '钓竿配置格式错误' });
        const nextBd = Object.assign({}, rec.bd || {});
        for (const partKey of Object.keys(d.bd)) {
          const part = D.ROD_PARTS.find(function (x) { return x.key === partKey; });
          if (!part) return apiResp(res, 400, { error: '未知部位：' + partKey });
          const raw = d.bd[partKey];
          const rawId = (raw && typeof raw === 'object') ? raw.compId : raw;
          const compId = (rawId == null || rawId === '') ? null : D.normalizeItemId(String(rawId));
          if (!compId) {
            nextBd[partKey] = { compId: null, name: part.default.name, affixes: [], rare: null, isCharm: !!part.isCharm };
            continue;
          }
          const comp = D.componentOf(compId);
          if (!comp) return apiResp(res, 400, { error: '未知组件：' + rawId });
          if (comp.part !== partKey) return apiResp(res, 400, { error: '「' + comp.name + '」不是' + part.name });
          nextBd[partKey] = { compId: comp.id, name: comp.name, affixes: comp.affixes, rare: comp.quality, isCharm: !!part.isCharm };
        }
        rec.bd = nextBd;
      }
      saveAccount(target);
      sendTo(target, {
        type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec),
        codex: rec.codex, catchCount: rec.catchCount,
        bd: rec.bd || {}, rodLocked: rec.rodLocked || {},
      });
      sendTo(target, { type: 'notice', msg: '管理员更新了你的资产快照' });
      apiResp(res, 200, { ok: true, key: target, coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), bd: rec.bd || {} });
    });
    return;
  }
  // ---- 存档快照：列出某个账号的历史快照（管理员） ----
  if (p === '/api/admin/users/snapshots' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const target = String(u.query.key || '').toLowerCase();
    if (!users[target]) return apiResp(res, 404, { error: '账号不存在' });
    const cfg = snapshotCfgOf();
    // 新的在前：回档列表从最近的往下看最顺手
    const list = listSnapshotFiles(target).reverse().map(function (s) {
      const view = readJson(s.file) || {};
      let size = 0;
      try { size = fs.statSync(s.file).size; } catch (e) {}
      return Object.assign({ name: s.name, ts: s.ts, size: size }, snapshotSummary(view));
    });
    return apiResp(res, 200, { ok: true, key: target, cfg: cfg, count: list.length, snapshots: list });
  }
  // ---- 存档快照：立即备份（给了 target 就只备这一个，否则全服）（管理员） ----
  if (p === '/api/admin/users/snapshot-now' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      const d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      let n = 0;
      if (target) {
        if (!users[target]) return apiResp(res, 404, { error: '账号不存在' });
        if (writeUserSnapshot(target)) n = 1;
      } else {
        n = takeAllSnapshots();
      }
      return apiResp(res, 200, { ok: true, key: target || null, count: n, keep: snapshotCfgOf().keep });
    });
    return;
  }
  // ---- 存档快照：把某个账号回档到指定快照（管理员） ----
  if (p === '/api/admin/users/rollback' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      const d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '账号不存在' });
      if (d.confirm !== true) return apiResp(res, 400, { error: '回档需要二次确认' });
      const snap = String(d.snap || '');
      if (!/^[0-9]{6,}(-[0-9]{1,3})?\.json$/.test(snap)) return apiResp(res, 400, { error: '快照名无效' });
      const view = readJson(path.join(snapshotDirOf(target), snap));
      if (!view || typeof view !== 'object') return apiResp(res, 404, { error: '快照不存在或已损坏' });
      // 回档前先留一份「回档前」的快照：点错还能退回来
      writeUserSnapshot(target);
      applySnapshot(rec, view);
      saveAccount(target);
      sendTo(target, {
        type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec),
        codex: rec.codex, catchCount: rec.catchCount, bigfish: rec.bigfish || {},
      });
      const ts = Number(snap.split('.')[0].split('-')[0]);
      sendTo(target, { type: 'notice', msg: '管理员把你的存档回档到了 ' + new Date(ts).toLocaleString('zh-CN') });
      return apiResp(res, 200, { ok: true, key: target, snap: snap, coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec) });
    });
    return;
  }
  // ---- 存档快照：保存策略（间隔分钟 / 保留份数 / 是否启用）（管理员） ----
  if (p === '/api/admin/snapshot/config' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      const d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const patch = (d.cfg && typeof d.cfg === 'object') ? d.cfg : {};
      const merged = D.setSnapshotCfg(d.reset === true ? null : Object.assign({}, world.snapshotCfg || {}, patch));
      world.snapshotCfg = merged;
      saveConfig();
      armSnapshotTimer();   // 间隔/开关变了要重挂（与价格采样器同一套写法）
      return apiResp(res, 200, { ok: true, cfg: merged });
    });
    return;
  }
  // ---- 账号管理：改密码 / 改显示名 / 调整金币（管理员） ----
  if (p === '/api/admin/users/update' && req.method === 'POST') {
    adminAuditedBody(req, p, async function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const target = String(d.target || '').toLowerCase();
      const rec = users[target];
      if (!rec) return apiResp(res, 404, { error: '账号不存在' });
      const changed = [];
      if (d.password != null && String(d.password) !== '') {
        const pw = String(d.password);
        Transport.passwordPolicy(d.password);
        rec.pwHash = await Transport.hashPassword(pw); delete rec.salt;
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
      // 市集挂单上限：0 = 不限；null/'' = 清掉自定义值、回到默认 40
      if (d.listingCap !== undefined) {
        if (d.listingCap === null || d.listingCap === '') {
          delete rec.listingCap;
          changed.push('挂单上限（恢复默认 ' + DEFAULT_LISTING_CAP + '）');
        } else {
          const n = Math.floor(Number(d.listingCap));
          if (!isFinite(n) || n < 0 || n > 100000) return apiResp(res, 400, { error: '挂单上限无效（0 = 不限，最大 100000）' });
          rec.listingCap = n;
          changed.push('挂单上限（' + (n === 0 ? '不限' : n) + '）');
        }
      }
      if (!changed.length) return apiResp(res, 400, { error: '没有需要修改的字段' });
      saveAccount(target);
      // 若该账号在线，推送最新资产/名称
      const pl = players.get(target);
      if (pl) { pl.name = rec.name; sendPlayersAll(); }
      sendTo(target, { type: 'assets', coins: rec.coins, inventory: rec.inventory, invRev: invRevOf(rec), codex: rec.codex, catchCount: rec.catchCount });
      sendTo(target, { type: 'notice', msg: '管理员修改了你的账号信息：' + changed.join(' / ') });
      apiResp(res, 200, { ok: true, target: target, changed: changed, name: rec.name, coins: rec.coins, listingCap: listingCapOf(rec), capSet: rec.listingCap != null });
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
    // 经济目录：全部经济物品（渔获/材料）的基准价、现价、乘数、销量与单品覆盖
    sweepPriceOv();
    const ecoItems = [];
    ['common', 'big', 'rare'].forEach(function (tier) {
      D.FISH[tier].forEach(function (f) { ecoItems.push({ id: f.id, name: f.name, kind: 'fish', tier: tier, rarity: f.rarity }); });
    });
    D.MATERIALS.forEach(function (m) { ecoItems.push({ id: m.id, name: m.name, kind: 'material', tier: 'material', rarity: m.rarity }); });
    const economyCatalog = ecoItems.map(function (it) {
      const s = world.shopSales[it.id] || {};
      const base = basePrice(it.id);
      const price = currentPrice(it.id);
      const ov = (world.priceOv && world.priceOv[it.id]) || null;
      return Object.assign({}, it, {
        base: base, price: price,
        m: base > 0 ? Math.round(price / base * 100) : 100,
        soldToday: s.soldToday || 0, soldTotal: s.soldTotal || 0,
        ov: ov ? { base: ov.base || null, m: ov.m || null, until: ov.until || null } : null,
      });
    });
    return apiResp(res, 200, {
      ok: true,
      grounds: D.GROUNDS,
      catalog: { fish: fish, materials: D.MATERIALS, components: D.COMPONENT_BASES, chests: D.CHESTS },
      affixTypes: D.AFFIX_LABEL,        // 组件词缀（6 类，「技巧」在此）；钓点增益用同一套类别
      quality: D.QUALITY,
      notifyLevel: world.notifyLevel || 'all',
      notifyLevels: NOTIFY_LEVELS,
      autoNotify: world.autoNotify || { on: false, rules: autoNotifyPreset('default'), hysteresisPct: 10, holdCount: 2 },
      onlineCount: players.size,
      biteFormula: world.biteFormula || BITE_FORMULA_DEFAULT,
      // 稀有度（rare 词缀）：普通品质物品权重系数 K/(K+R) 的 K 值
      rareK: rareK(), rareKDefault: D.RARE_K_DEFAULT,
      snapshotCfg: snapshotCfgOf(),
      // 材料催化词缀范围的一键预设（按部位 × 词缀 = 该部位包络）与各部位包络（校验约束提示用）
      catalystPreset: D.catalystPreset(),
      catalystEnvelopes: (function () {
        const out = {};
        D.COMPONENT_BASES.forEach(function (b) {
          out[b.part] = out[b.part] || {};
          b.pool.forEach(function (p) {
            const env = D.catalystEnvelopeOf(b.part, p.type);
            if (env) out[b.part][p.type] = env;
          });
        });
        return out;
      })(),
      doubleBase: Number(world.doubleBase) || 0,
      castBaseMs: castBaseMs(),
      castMinMs: castMinMs(),
      castSpeedBonus: castSpeedBonus(),
      castSpeedCap: castSpeedCap(),
      castDefaults: { baseMs: CAST_BASE_DEFAULT, minMs: CAST_MIN_DEFAULT, speedBonus: CAST_SPEED_BONUS_DEFAULT, speedCap: CAST_SPEED_CAP_DEFAULT },
      poolPresets: POOL_PRESETS,
      removedGrounds: (world.groundCfg && world.groundCfg.removed && world.groundCfg.removed.grounds) || [],
      removedSpots: (world.groundCfg && world.groundCfg.removed && world.groundCfg.removed.spots) || [],
      componentCfg: D.getComponentCfg ? D.getComponentCfg() : null,
      componentDefaults: D.defaultComponentCfg ? D.defaultComponentCfg() : null,
      fishCfg: D.getFishCfg ? D.getFishCfg() : null,
      fishDefaults: D.defaultFishCfg ? D.defaultFishCfg() : null,
      affixCodes: D.AFFIX_CODES,
      // ---- 经济参数（价格模型全程可调）----
      priceCfg: priceCfg(),
      priceDefaults: PRICE_DEFAULTS,
      dropCfg: dropCfg(),
      dropDefaults: DROP_DEFAULTS,
      // ---- 自动售出打包阈值（全服）----
      autoSellCfg: autoSellCfgOf(),
      economyCatalog: economyCatalog,
      economyLog: (world.economyLog || []).slice(-40),
      // ---- 宝匣配置 ----
      chestCfg: chestCfgOf(),
      chestPityMax: CHEST_PITY_MAX,
      chests: (D.CHESTS || []).map(function (c) {
        return { id: c.id, name: c.name, rarity: c.rarity, mode: c.mode, costRelic: c.costRelic, costCoins: c.costCoins,
          baseRelic: D.CHEST_BASE_COSTS[c.id] ? D.CHEST_BASE_COSTS[c.id].costRelic : c.costRelic,
          baseCoins: D.CHEST_BASE_COSTS[c.id] ? D.CHEST_BASE_COSTS[c.id].costCoins : c.costCoins,
          hasExtra: !!c.extra, hitCount: c.hitCount, missCount: c.missCount, chance: c.chance };
      }),
      chestCostMax: { relic: CHEST_COST_RELIC_MAX, coins: CHEST_COST_COINS_MAX },
      extraAffixRanges: (D.getComponentCfg && D.getComponentCfg().extraAffixRanges) || {},
      extraAffixDefaults: D.DEFAULT_EXTRA_AFFIX_RANGES,
      // ---- 工坊熔炼（成功率 / 花费 / 投料上限；材料→词缀对照只读展示） ----
      smeltCfg: smeltCfgOf(),
      smeltDefaults: D.defaultSmeltCfg(),
      smeltMaterials: D.smeltMaterialIds().map(function (id) {
        const it = D.itemOf(id);
        return { id: id, name: it.name, rarity: it.rarity, affix: D.smeltMaterialAffix(id), affixName: D.AFFIX_LABEL[D.smeltMaterialAffix(id)] || '' };
      }),
      smeltPearl: { id: D.SMELT_PEARL, name: itemName(D.SMELT_PEARL) },
      // ---- 商城（每日限购）：商品 + 刷新时间 ----
      mallCfg: mallCfgOf(),
      mallDefaults: D.defaultMallCfg(),
      // ---- 渔获记录贴图（缩放 / 偏移）----
      recordsCfg: recordsCfgOf(),
      recordsDefaults: RECORDS_DEFAULTS,
      recordsLimits: { scaleMin: RECORDS_SCALE_MIN, scaleMax: RECORDS_SCALE_MAX, offsetMin: RECORDS_OFFSET_MIN, offsetMax: RECORDS_OFFSET_MAX },
    });
  }
  // ---- 组件生成配置：品质概率 / 词条数概率 / roll 模型 / 数值区间 / 修饰词规则 ----
  if (p === '/api/admin/component/config' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const cfg = {};
      if (d.qualityWeights != null) {
        if (typeof d.qualityWeights !== 'object') return apiResp(res, 400, { error: '品质概率格式错误' });
        const qw = {};
        // 刻意不含 mythic：「神话」是宝匣专属品质（权重写在 data.js 的 CHESTS 各档位内），
        // 一旦混进这里，普通钓鱼掉落就能出神话组件，宝匣的价值主张会被直接稀释。
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
        // 同上：不含 mythic（神话件由 genBreakthrough 生成，不查词条数权重表）
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
      // 池外词缀数值区间（宝匣突破件的补足词缀用）：键为词缀类型，不限定底材
      if (d.extraAffixRanges != null) {
        if (typeof d.extraAffixRanges !== 'object') return apiResp(res, 400, { error: '池外词缀区间格式错误' });
        const out = {};
        Object.keys(d.extraAffixRanges).forEach(function (t) {
          if (D.AFFIX_TYPES.indexOf(t) < 0) return;
          const r = d.extraAffixRanges[t];
          if (!Array.isArray(r) || r.length !== 2) return;
          const mn = Number(r[0]), mx = Number(r[1]);
          if (!isFinite(mn) || !isFinite(mx) || mx < mn) return;
          out[t] = [Math.round(mn), Math.round(mx)];
        });
        cfg.extraAffixRanges = out;
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
      // v0.11.5：池外（突破）区间也会决定工坊补缀词缀的取值，改了要立刻同步到在线客户端
      broadcast({ type: 'componentcfg', componentCfg: world.componentCfg });
      apiResp(res, 200, { ok: true, componentCfg: world.componentCfg });
    });
    return;
  }
  // ---- 组件生成配置：恢复默认 ----
  if (p === '/api/admin/component/reset' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      world.componentCfg = D.setComponentCfg(null);
      saveConfig();
      broadcast({ type: 'componentcfg', componentCfg: world.componentCfg });
      apiResp(res, 200, { ok: true, componentCfg: world.componentCfg });
    });
    return;
  }
  // ---- 组件掉落实测（按当前配置采样，给管理后台预览概率分布） ----
  if (p === '/api/admin/component/simulate' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const n = Math.max(1, Math.min(200000, Number(d.n) || 20000));
      const qDist = { common: 0, rare: 0, epic: 0 };
      const cDist = { common: { 1: 0, 2: 0, 3: 0 }, rare: { 1: 0, 2: 0, 3: 0 }, epic: { 1: 0, 2: 0, 3: 0 } };
      const vals = {};
      let zeroAffixes = 0; // 0 值词条计数（roll=0 已被拒绝重 roll，正常应恒为 0）
      // v0.13.5：修饰词规则的**实际命中分布**——每条规则被第一条命中抢到的比例，一眼看出
      // 「哪条规则从来轮不到」（被上面的规则盖住）以及命名是否过于泛滥；带 1~2 个示例件。
      const ruleHits = {};
      let fullCount = 0, extraCount = 0;
      for (let i = 0; i < n; i++) {
        const c = D.rollComponent();
        qDist[c.quality] = (qDist[c.quality] || 0) + 1;
        cDist[c.quality][c.affixes.length] = (cDist[c.quality][c.affixes.length] || 0) + 1;
        if (c.isFull) fullCount++;
        if (c.hasExtra) extraCount++;
        const key = c.adjective || '（无修饰词）';
        const hit = ruleHits[key] || (ruleHits[key] = { count: 0, samples: [] });
        hit.count++;
        if (hit.samples.length < 2) hit.samples.push(c.name + ' · ' + c.affixes.length + '/' + c.maxAffixes + ' 词条');
        c.affixes.forEach(function (af) {
          if (af.value === 0) zeroAffixes++;
          vals[af.type] = vals[af.type] || { sum: 0, n: 0, min: 1e9, max: -1e9 };
          const v = vals[af.type]; v.sum += af.value; v.n++; if (af.value < v.min) v.min = af.value; if (af.value > v.max) v.max = af.value;
        });
      }
      const affixStats = {};
      Object.keys(vals).forEach(function (t) { affixStats[t] = { mean: Math.round((vals[t].sum / vals[t].n) * 10) / 10, min: vals[t].min, max: vals[t].max }; });
      apiResp(res, 200, { ok: true, n: n, quality: qDist, count: cDist, affix: affixStats, zeroAffixes: zeroAffixes,
        rules: ruleHits, fullCount: fullCount, extraCount: extraCount });
    });
    return;
  }
  // ---- 鱼类体型 roll 模型：保存（默认正态；影响全服上鱼体型与大小鱼榜，即时生效） ----
  if (p === '/api/admin/fish/config' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      if (d.sizeModel == null) return apiResp(res, 400, { error: '缺少 sizeModel' });
      if (D.ROLL_MODELS.indexOf(d.sizeModel) < 0) return apiResp(res, 400, { error: '未知的体型 roll 模型' });
      const merged = Object.assign({}, D.getFishCfg ? D.getFishCfg() : {}, { sizeModel: d.sizeModel });
      world.fishCfg = D.setFishCfg(merged);
      saveConfig();
      apiResp(res, 200, { ok: true, fishCfg: world.fishCfg });
    });
    return;
  }
  // ---- 鱼类体型 roll 模型：恢复默认（正态） ----
  if (p === '/api/admin/fish/reset' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      world.fishCfg = D.setFishCfg(null);
      saveConfig();
      apiResp(res, 200, { ok: true, fishCfg: world.fishCfg });
    });
    return;
  }
  // ---- 鱼类体型分布试算（按当前模型采样，给后台预览分布形状） ----
  // 可选 model 试算尚未保存的模型；可选 fishId 指定单条鱼（返回 cm 统计）；
  // 否则返回全鱼种归一化位置的直方图。可选 sizeBonus 预览体型词缀加成后的分布（如 +55）。
  if (p === '/api/admin/fish/simulate' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const n = Math.max(1, Math.min(200000, Number(d.n) || 20000));
      const bonus = isFinite(Number(d.sizeBonus)) ? Number(d.sizeBonus) : 0;
      const eff = bonus ? { size: bonus } : {};
      const all = [];
      ['common', 'big', 'rare'].forEach(function (t) {
        D.FISH[t].forEach(function (f) { if (f.size) all.push(f); });
      });
      if (!all.length) return apiResp(res, 400, { error: '没有带体型范围的鱼' });
      const cur = (D.getFishCfg && D.getFishCfg().sizeModel) || 'normal';
      const model = d.model != null ? d.model : cur;
      if (D.ROLL_MODELS.indexOf(model) < 0) return apiResp(res, 400, { error: '未知的体型 roll 模型' });
      const target = d.fishId ? all.find(function (f) { return f.id === d.fishId; }) : null;
      if (d.fishId && !target) return apiResp(res, 400, { error: '未知鱼类：' + d.fishId });
      const buckets = new Array(20).fill(0);
      const samples = [];
      const use = target ? [target] : all;
      for (let i = 0; i < n; i++) {
        const f = use[i % use.length];
        const size = rollSizeOf(f.size, eff, model);
        const base = size / (1 + bonus / 100);
        const pos = f.size[1] > f.size[0] ? (base - f.size[0]) / (f.size[1] - f.size[0]) : 0;
        buckets[Math.max(0, Math.min(19, Math.floor(pos * 20)))]++;
        if (target) samples.push(size);
      }
      const out = { ok: true, n: n, model: model, currentModel: cur, sizeBonus: bonus, bucketCount: buckets.length, buckets: buckets };
      if (target) {
        samples.sort(function (x, y) { return x - y; });
        const at = function (q) { return samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]; };
        out.fishId = target.id;
        out.fishName = target.name;
        out.range = target.size;
        out.stats = {
          min: samples[0], p25: at(0.25), p50: at(0.5), p75: at(0.75), max: samples[samples.length - 1],
          mean: Math.round((samples.reduce(function (s, v) { return s + v; }, 0) / samples.length) * 10) / 10,
        };
      }
      apiResp(res, 200, out);
    });
    return;
  }
  // ---- 钓点掉落池（种类 + 权重；保存后全服即时生效并广播游戏端） ----
  if (p === '/api/admin/spot/pool' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
  // ---- 掉落池一键填充预设：返回条目列表（前端填入草稿，仍走原「保存掉落池」流程）----
  if (p === '/api/admin/pool/preset' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const preset = String(d.preset || 'economy');
      if (!POOL_PRESETS[preset]) return apiResp(res, 400, { error: '未知的填充预设' });
      return apiResp(res, 200, { ok: true, preset: preset, pool: defaultPoolPreset(preset), presets: POOL_PRESETS });
    });
    return;
  }
  // ---- 新建渔场（可选一键填充首个钓点 / 限时窗口） ----
  if (p === '/api/admin/ground/add' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const id = String(d.id || '').trim().toLowerCase();
      if (!GROUND_ID_RE.test(id)) return apiResp(res, 400, { error: '渔场 ID 需为 2-24 位小写字母/数字/下划线，且以字母开头' });
      if (GROUNDS_BASE.some(function (g) { return g.id === id; })) return apiResp(res, 400, { error: '该 ID 与内置渔场冲突，请换一个' });
      const cfg = world.groundCfg = world.groundCfg || {};
      cfg.custom = Array.isArray(cfg.custom) ? cfg.custom : [];
      if (cfg.custom.some(function (g) { return g.id === id; })) return apiResp(res, 409, { error: '渔场 ID 已存在' });
      const name = String(d.name || '').trim().slice(0, 20);
      if (!name) return apiResp(res, 400, { error: '渔场名称不能为空' });
      const win = parseWindow(d.openFrom, d.openTo);
      if (win.error) return apiResp(res, 400, { error: win.error });
      const preset = POOL_PRESETS[d.preset] ? d.preset : 'economy';
      const fill = d.fill !== false;
      const spotId = String(d.spotId || 'main').trim().toLowerCase();
      const spotName = String(d.spotName || '主钓点').trim().slice(0, 20) || '主钓点';
      if (!SPOT_ID_RE.test(spotId)) return apiResp(res, 400, { error: '钓点 ID 需为 1-24 位小写字母/数字/下划线，且以字母开头' });
      cfg.custom.push({
        id: id, name: name, type: d.type === 'event' ? 'event' : 'normal',
        desc: String(d.desc || '').trim().slice(0, 80),
        spots: [{ id: spotId, name: spotName, pool: fill ? defaultPoolPreset(preset) : [], buffs: [] }],
      });
      cfg.grounds = cfg.grounds || {};
      cfg.grounds[id] = Object.assign({ locked: false }, cfg.grounds[id] || {}, { openFrom: win.openFrom, openTo: win.openTo });
      saveConfig();
      applyGroundCfg();
      broadcastGroundcfg();
      const created = D.GROUNDS.find(function (g) { return g.id === id; });
      apiResp(res, 200, { ok: true, ground: created, preset: preset, filled: fill });
    });
    return;
  }
  // ---- 新建钓点（归属任意渔场；可一键填充掉落池） ----
  if (p === '/api/admin/spot/add' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const g = D.GROUNDS.find(function (x) { return x.id === d.groundId; });
      if (!g) return apiResp(res, 404, { error: '渔场不存在' });
      const id = String(d.id || '').trim().toLowerCase();
      if (!SPOT_ID_RE.test(id)) return apiResp(res, 400, { error: '钓点 ID 需为 1-24 位小写字母/数字/下划线，且以字母开头' });
      if (g.spots.some(function (s) { return s.id === id; })) return apiResp(res, 409, { error: '该渔场已有同名钓点' });
      if (removeListOf('spots').indexOf(g.id + ':' + id) >= 0) return apiResp(res, 409, { error: '该 ID 属于已删除的内置钓点，请先恢复或换一个 ID' });
      const name = String(d.name || '').trim().slice(0, 20);
      if (!name) return apiResp(res, 400, { error: '钓点名称不能为空' });
      const preset = POOL_PRESETS[d.preset] ? d.preset : 'economy';
      const fill = d.fill !== false;
      const entry = { id: id, name: name, pool: fill ? defaultPoolPreset(preset) : [], buffs: [] };
      const cfg = world.groundCfg = world.groundCfg || {};
      const cg = (cfg.custom || []).find(function (x) { return x.id === g.id; });
      if (cg) { cg.spots = cg.spots || []; cg.spots.push(entry); }
      else {
        cfg.customSpots = cfg.customSpots || {};
        cfg.customSpots[g.id] = cfg.customSpots[g.id] || [];
        cfg.customSpots[g.id].push(entry);
      }
      saveConfig();
      applyGroundCfg();
      broadcastGroundcfg();
      apiResp(res, 200, { ok: true, groundId: g.id, spot: entry, preset: preset, filled: fill });
    });
    return;
  }
  // ---- 删除渔场（内置渔场记录删除可恢复；自定义渔场直接移除） ----
  if (p === '/api/admin/ground/remove' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const g = D.GROUNDS.find(function (x) { return x.id === d.groundId; });
      if (!g) return apiResp(res, 404, { error: '渔场不存在' });
      const cfg = world.groundCfg = world.groundCfg || {};
      if (g.custom) {
        cfg.custom = (cfg.custom || []).filter(function (x) { return x.id !== g.id; });
        if (cfg.grounds) delete cfg.grounds[g.id];
        if (cfg.customSpots) delete cfg.customSpots[g.id];
      } else {
        const list = removeListOf('grounds');
        if (list.indexOf(g.id) < 0) list.push(g.id);
      }
      saveConfig();
      applyGroundCfg();
      stopFishingAtGrounds([g.id]);
      broadcastGroundcfg();
      apiResp(res, 200, { ok: true, removed: g.id, restorable: !g.custom });
    });
    return;
  }
  // ---- 删除钓点（内置钓点记录删除可恢复；自定义钓点直接移除） ----
  if (p === '/api/admin/spot/remove' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const found = spotOf(d.groundId, d.spotId);
      if (!found) return apiResp(res, 404, { error: '钓点不存在' });
      const key = found.ground.id + ':' + found.spot.id;
      const cfg = world.groundCfg = world.groundCfg || {};
      const cg = (cfg.custom || []).find(function (x) { return x.id === found.ground.id; });
      let custom = false;
      if (cg) {
        const before = cg.spots.length;
        cg.spots = cg.spots.filter(function (s) { return s.id !== found.spot.id; });
        custom = cg.spots.length !== before;
      }
      if (!custom && cfg.customSpots && Array.isArray(cfg.customSpots[found.ground.id])) {
        const before = cfg.customSpots[found.ground.id].length;
        cfg.customSpots[found.ground.id] = cfg.customSpots[found.ground.id].filter(function (s) { return s.id !== found.spot.id; });
        custom = cfg.customSpots[found.ground.id].length !== before;
      }
      if (!custom) {
        const list = removeListOf('spots');
        if (list.indexOf(key) < 0) list.push(key);
      } else if (cfg.spots) {
        delete cfg.spots[key]; // 自定义钓点连带清掉它的覆盖配置
      }
      saveConfig();
      applyGroundCfg();
      stopFishingAtGrounds([found.ground.id]);
      broadcastGroundcfg();
      apiResp(res, 200, { ok: true, removed: key, restorable: !custom });
    });
    return;
  }
  // ---- 恢复被删除的内置渔场 / 钓点 ----
  if (p === '/api/admin/ground/restore' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const cfg = world.groundCfg = world.groundCfg || {};
      let restored = null;
      if (d.spotId) {
        const key = String(d.groundId) + ':' + String(d.spotId);
        const list = removeListOf('spots');
        const i = list.indexOf(key);
        if (i < 0) return apiResp(res, 404, { error: '该钓点不在删除名单中' });
        list.splice(i, 1);
        restored = key;
      } else {
        const gid = String(d.groundId || '');
        const list = removeListOf('grounds');
        const i = list.indexOf(gid);
        if (i < 0) return apiResp(res, 404, { error: '该渔场不在删除名单中' });
        list.splice(i, 1);
        restored = gid;
      }
      saveConfig();
      applyGroundCfg();
      broadcastGroundcfg();
      apiResp(res, 200, { ok: true, restored: restored });
    });
    return;
  }
  // ---- 修改渔场信息：名称/描述/类型/限时窗口/手动锁定 ----
  if (p === '/api/admin/ground/update' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const g = D.GROUNDS.find(function (x) { return x.id === d.groundId; });
      if (!g) return apiResp(res, 404, { error: '渔场不存在' });
      const cfg = world.groundCfg = world.groundCfg || {};
      cfg.grounds = cfg.grounds || {};
      const cur = Object.assign({}, cfg.grounds[g.id] || {});
      if (d.name != null) {
        const nm = String(d.name).trim().slice(0, 20);
        if (!nm) return apiResp(res, 400, { error: '渔场名称不能为空' });
        cur.name = nm;
      }
      if (d.desc != null) cur.desc = String(d.desc).trim().slice(0, 80);
      if (d.type != null) cur.type = d.type === 'event' ? 'event' : 'normal';
      if (d.clearWindow) { cur.openFrom = null; cur.openTo = null; }
      else if (d.openFrom != null || d.openTo != null) {
        const win = parseWindow(d.openFrom, d.openTo);
        if (win.error) return apiResp(res, 400, { error: win.error });
        cur.openFrom = win.openFrom; cur.openTo = win.openTo;
      }
      if (d.locked != null) cur.locked = !!d.locked;
      cfg.grounds[g.id] = cur;
      // 自定义渔场的名称/描述/类型同步写回其结构定义（保持数据一致）
      const cg = (cfg.custom || []).find(function (x) { return x.id === g.id; });
      if (cg) {
        if (cur.name) cg.name = cur.name;
        if (cur.desc != null) cg.desc = cur.desc;
        if (cur.type) cg.type = cur.type;
      }
      saveConfig();
      applyGroundCfg();
      const after = D.GROUNDS.find(function (x) { return x.id === g.id; });
      if (after && after.locked) stopFishingAtGrounds([g.id]);
      broadcastGroundcfg();
      apiResp(res, 200, { ok: true, ground: after });
    });
    return;
  }
  // ---- 钓点独立上鱼率 / 速率（留空 = 用全服默认：上鱼率用公式，速率按基础间隔+钓速计算） ----
  if (p === '/api/admin/spot/rate' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const found = spotOf(d.groundId, d.spotId);
      if (!found) return apiResp(res, 404, { error: '钓点不存在' });
      const patch = {};
      function opt(name, min, max, label) {
        if (!(name in d)) return null;
        const raw = d[name];
        if (raw == null || raw === '') { patch[name] = null; return null; }
        const n = Number(raw);
        if (!isFinite(n) || n < min || n > max) return label + '需在 ' + min + ' - ' + max + ' 之间（留空表示用全服默认）';
        patch[name] = Math.round(n * 100) / 100;
        return null;
      }
      let err = opt('biteRate', 0, 100, '上鱼率（%）');
      if (!err) err = opt('intervalMs', 100, 60000, '抛竿间隔（ms）');
      if (err) return apiResp(res, 400, { error: err });
      saveSpotCfg(found.ground.id, found.spot.id, patch);
      applyGroundCfg();
      restartFishingAt(found.ground.id, found.spot.id);
      broadcastGroundcfg();
      const sp = spotOf(found.ground.id, found.spot.id).spot;
      apiResp(res, 200, {
        ok: true,
        biteRate: sp.biteRate != null ? sp.biteRate : null,
        intervalMs: sp.intervalMs != null ? sp.intervalMs : null,
      });
    });
    return;
  }
  // ---- 钓点在世界地图上的位置（后台拖动设置；pos = [x%, y%]，null/缺失 = 恢复该钓点的出厂坐标） ----
  if (p === '/api/admin/spot/pos' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const g = D.GROUNDS.find(function (x) { return x.id === d.groundId; });
      if (!g) return apiResp(res, 404, { error: '钓场不存在' });
      const list = Array.isArray(d.list) ? d.list : [{ spotId: d.spotId, pos: d.pos }];
      const bad = list.some(function (e) {
        return e && e.pos != null && !normalizeSpotPos(e.pos);
      });
      if (bad) return apiResp(res, 400, { error: '坐标格式错误（需 [x, y]，0-100 的百分比）' });
      const changed = saveSpotPositions(g.id, list);
      apiResp(res, 200, {
        ok: true, changed: changed,
        spots: (D.GROUNDS.find(function (x) { return x.id === g.id; }).spots || []).map(function (s) {
          return { id: s.id, name: s.name, pos: s.pos || null };
        }),
      });
    });
    return;
  }
  // ---- 钓场开放/锁定（锁定时立即停掉该场所有钓鱼循环） ----
  if (p === '/api/admin/ground/lock' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      sweepExpiredListings();
      const idx = world.listings.findIndex(function (l) { return l.lid === d.lid; });
      if (idx < 0) return apiResp(res, 404, { error: '该挂单已不存在' });
      const l = world.listings[idx];
      world.listings.splice(idx, 1);
      const seller = users[l.seller];
      // 后台批量上架的虚拟挂单：物品本是现造的，退回会凭空塞进该账号背包 → 直接清除
      if (seller && l.src !== 'admin') {
        if (D.isRodSet(l.id)) deliverRodBack(seller, l.id, l.name);
        else invAdd(seller, l.id, l.qty);
        saveAccount(l.seller);
        sendTo(l.seller, { type: 'assets', coins: seller.coins, inventory: seller.inventory, invRev: invRevOf(seller) });
        sendTo(l.seller, { type: 'notice', msg: '管理员退回了你的挂单：' + l.name + ' ×' + l.qty + '（上架费不退）' });
      }
      saveMarket();
      broadcastMarket();
      apiResp(res, 200, { ok: true, returned: { lid: l.lid, id: l.id, name: l.name, qty: l.qty, seller: l.seller } });
    });
    return;
  }
  // ---- 市集：后台批量上架（活跃市场）----
  // 以某个账号的名头挂出一批**服务器现造**的物品（组件 / 鱼 / 材料 / 宝匣），用来把空市集填活。
  // 与玩家上架的区别：不扣背包、不收上架费、不受「每人 40 单」限制；挂单带 src:'admin'，
  // 过期或被退回时直接清除（见 sweepExpiredListings / market/return）。
  // dryRun=true 只生成样例与统计，不写任何数据（前端「预览」用）。
  if (p === '/api/admin/market/bulk' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const sellerKey = String(d.seller || '').toLowerCase();
      const seller = users[sellerKey];
      if (!seller) return apiResp(res, 400, { error: '卖家账号不存在' });
      // 生成过程兜底：抛错也要回一个响应，否则请求会一直挂着（客户端只能等到超时）
      let plan = null;
      try { plan = bulkListPlan(d); } catch (e) { return apiResp(res, 500, { error: '生成失败：' + ((e && e.message) || e) }); }
      if (plan.error) return apiResp(res, 400, { error: plan.error });      if (d.dryRun) {
        return apiResp(res, 200, {
          ok: true, dryRun: true, seller: { key: sellerKey, name: seller.name },
          count: plan.items.length, samples: plan.items.slice(0, 8).map(bulkSampleOf),
          totalValue: plan.items.reduce(function (s, it) { return s + it.price * it.qty; }, 0),
          hours: plan.hours, mul: plan.mul, byKind: plan.byKind,
        });
      }
      const ttl = LISTING_TTL_MS_ENV || plan.hours * 3600 * 1000;
      const now = Date.now();
      const created = [];
      plan.items.forEach(function (it) {
        const listing = {
          // seller 必须是账号 key（小写）：成交/下架/退单/删除账号都按 key 查，
          // 写成 seller.username 会因大小写不符而不入账、不进该账号的历史订单。
          lid: world.listingSeq++, seller: sellerKey, sellerName: seller.name,
          id: it.id, name: it.name, qty: it.qty, price: it.price,
          t: now, expireAt: now + ttl, hours: plan.hours, src: 'admin',
        };
        world.listings.push(listing);
        created.push(listing);
      });
      saveMarket();
      broadcastMarket();
      if (created.length) {
        sendTo(sellerKey, { type: 'notice', msg: '管理员以你的名头在市集上架了 ' + created.length + ' 件物品（' + plan.hours + ' 小时）' });
      }
      apiResp(res, 200, {
        ok: true, created: created.length, hours: plan.hours, mul: plan.mul, byKind: plan.byKind,
        seller: { key: sellerKey, name: seller.name },
        samples: created.slice(0, 8).map(bulkSampleOf),
        totalValue: created.reduce(function (s, l) { return s + l.price * l.qty; }, 0),
      });
    });
    return;
  }
  // ---- 商城配置：商品（物品 / 金币价 / 每日限购）+ 限购刷新时间 ----
  // 保存后：玩家端商城的商品、价格、限购与下次刷新时间立即同步（broadcast mallcfg）。
  if (p === '/api/admin/mall/config' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const cur = mallCfgOf();
      const next = { refreshTime: cur.refreshTime, items: cur.items };
      if (d.refreshTime != null && d.refreshTime !== '') {
        if (!D.parseRefreshTime(d.refreshTime)) return apiResp(res, 400, { error: '刷新时间格式应为 HH:MM（如 04:00）' });
        next.refreshTime = String(d.refreshTime).trim();
      }
      if (d.items != null) {
        const v = validateMallItems(d.items);
        if (v.error) return apiResp(res, 400, { error: v.error });
        next.items = v.items;
      }
      if (d.reset) next.items = D.defaultMallCfg().items;
      world.mallCfg = { refreshTime: next.refreshTime, items: next.items.map(function (e) { return { id: e.id, price: e.price, limit: e.limit }; }) };
      saveConfig();
      broadcast({ type: 'mallcfg' });
      econLog(a.name, '商城配置：' + world.mallCfg.items.length + ' 件商品，限购刷新 ' + world.mallCfg.refreshTime);
      apiResp(res, 200, { ok: true, mallCfg: mallCfgOf() });
    });
    return;
  }
  // ---- 稀有度：真实钓点战利品表试算（后台「🧮 公式管理 → 稀有度」用）----
  // 返回当前生效的钓点列表（含后台保存的掉落池覆盖），供下拉框选用实际存在的钓点。
  if (p === '/api/admin/loot/spots' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    const list = [];
    D.GROUNDS.forEach(function (g) {
      (g.spots || []).forEach(function (s) {
        list.push({ key: g.id + ':' + s.id, name: g.name + '·' + s.name, pool: (s.pool || []).length });
      });
    });
    return apiResp(res, 200, { ok: true, spots: list, k: rareK() });
  }
  // 用真实钓点战利品表试算稀有度效果：稀有度 R 只压低「普通品质」条目权重（系数 K/(K+R)），
  // 逐条给出前后占比，便于管理员直观看到稀有度的实际作用。
  // ---- 后台 · 模拟钓竿试算（v0.16.0 新增；公式管理页的中心面板）----
  // 入参：{ totals:{speed,skill,rare,material,size,double}, spotKey }；spotKey 可留空 = 站在岸边空钓点。
  if (p === '/api/admin/simulate' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const totals = {};
      D.AFFIX_TYPES.forEach(function (t) {
        const v = Number(d.totals && d.totals[t]);
        totals[t] = isFinite(v) ? Math.round(v * 10) / 10 : 0;
      });
      let found = null;
      const key = String(d.spotKey || '');
      if (key) {
        const ci = key.indexOf(':');
        if (ci <= 0) return apiResp(res, 400, { error: '钓点参数格式错误' });
        found = spotOf(key.slice(0, ci), key.slice(ci + 1));
        if (!found || !found.spot) return apiResp(res, 400, { error: '钓点不存在：' + key });
      }
      const sim = simulateRod(syntheticRodOf(totals), found ? found.spot : null, totals);
      const loot = found ? lootPreviewRows(found.spot, sim.eff.rare) : [];
      return apiResp(res, 200, {
        ok: true,
        spot: found ? { groundId: found.ground.id, groundName: found.ground.name, spotId: found.spot.id, spotName: found.spot.name,
          buffs: found.spot.buffs || [], biteRateOverride: spotBiteRateOf(found.spot), intervalOverride: (found.spot.intervalMs != null && found.spot.intervalMs !== '') ? Number(found.spot.intervalMs) : null } : null,
        cast: {
          baseMs: sim.info.baseMs, minMs: sim.info.minMs, globalBonus: sim.info.globalBonus, cap: sim.info.cap,
          affixSpeed: totals.speed, buffSpeed: sim.info.buffSpeed, effSpeed: sim.info.effSpeed,
          interval: sim.interval, castsPerHour: Math.round(sim.castsPerHour * 10) / 10,
        },
        bite: { rate: sim.bite, override: sim.info.biteOverride, formula: String(world.biteFormula || '') },
        rod: sim.totals,
        merged: sim.eff,
        double: { A: Math.max(0, Number(sim.eff.double) || 0), base: Math.max(0, Math.min(1, Number(world.doubleBase) || 0)),
          p: sim.doubleP, perCast: sim.perCast },
        expect: { castsPerHour: Math.round(sim.castsPerHour * 10) / 10, fishPerCast: Math.round(sim.perCast * 1000) / 1000,
          fishPerHour: Math.round(sim.fishPerHour * 10) / 10 },
        loot: loot,
        affixLabel: D.AFFIX_LABEL,
      });
    });
    return;
  }
  if (p === '/api/admin/loot/test' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const key = String(d.spotKey || '');
      const ci = key.indexOf(':');
      if (ci <= 0) return apiResp(res, 400, { error: '请选择一个钓点' });
      const found = spotOf(key.slice(0, ci), key.slice(ci + 1));
      if (!found || !found.spot) return apiResp(res, 400, { error: '钓点不存在：' + key });
      // 基础权重 = 该钓点当前生效的掉落池（应用产出倍率，但不含玩家词缀，保证可复现）
      const pool = boostPoolOf(found.spot.pool || [], {});
      const R = Math.max(0, Number(d.rare) || 0);
      const K = rareK();
      const mult = D.rareCommonMult(R, K);
      const compMult = componentCommonProb() * mult + (1 - componentCommonProb());
      const isCommon = function (e) {
        const i = e.pick.indexOf(':');
        const type = e.pick.slice(0, i);
        return type === 'component' ? false : pickIsCommon(e.pick); // 组件单独按 compMult 折算
      };      const effOf = function (e) {
        const i = e.pick.indexOf(':');
        const type = e.pick.slice(0, i);
        if (type === 'component') return compMult;
        return isCommon(e) ? mult : 1;
      };
      const before = pool.reduce(function (s, e) { return s + e.weight; }, 0) || 1;
      const after = pool.reduce(function (s, e) { return s + e.weight * effOf(e); }, 0) || 1;
      let commonBefore = 0, commonAfter = 0;
      const rows = pool.map(function (e) {
        const i = e.pick.indexOf(':');
        const type = e.pick.slice(0, i), id = e.pick.slice(i + 1);
        const f = effOf(e);
        const w2 = e.weight * f;
        const p1 = e.weight / before * 100, p2 = w2 / after * 100;
        if (type !== 'component' && isCommon(e)) { commonBefore += p1; commonAfter += p2; }
        let name = id, quality = '普通';
        if (type === 'fish') {
          const tier = D.fishTierOf(id);
          for (const t of ['common', 'big', 'rare']) {
            const x = D.FISH[t].find(function (y) { return y.id === id; });
            if (x) { name = x.name; quality = (D.QUALITY[x.rarity] || {}).name || x.rarity; break; }
          }
          void tier;
        } else if (type === 'material') {
          const x = D.MATERIALS.find(function (y) { return y.id === id; });
          if (x) { name = x.name; quality = (D.QUALITY[x.rarity] || {}).name || x.rarity; }
        } else if (type === 'component') {
          name = '组件（随机底材）'; quality = '按品质权重';
        }
        return { pick: e.pick, name: name, quality: quality, common: f < 1, weight: Math.round(e.weight * 1000) / 1000, beforePct: Math.round(p1 * 100) / 100, afterPct: Math.round(p2 * 100) / 100 };
      }).sort(function (x, y) { return y.beforePct - x.beforePct; });
      return apiResp(res, 200, {
        ok: true, k: K, rare: R, mult: Math.round(mult * 10000) / 10000,
        spot: { key: key, name: found.ground.name + '·' + found.spot.name },
        commonBefore: Math.round(commonBefore * 100) / 100,
        commonAfter: Math.round(commonAfter * 100) / 100,
        rows: rows,
      });
    });
    return;
  }
  // ---- 工坊熔炼配置：成功率 / 投料系数 / 金币花费 ----
  if (p === '/api/admin/smelt/config' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const RANGES = {
        baseRate: [0, 100], failPerMaterial: [-50, 50], extraRatePerMaterial: [0, 100], extraRatePearl: [0, 100],
        extraRateMax: [0, 100], rateMin: [0, 100], rateMax: [0, 100],
        goldBase: [0, 100000000], goldPerMaterial: [0, 10000000], goldPearl: [0, 100000000],
        maxMaterials: [0, 99], maxTypes: [0, 8],
        recastPearl: [0, 999], recastGold: [0, 100000000],
        retainMaxRelic: [0, 99],
        addAffixCap: [1, 6],
      };
      const LABEL = {
        baseRate: '熔炼基础成功率', failPerMaterial: '每份材料对失败率的影响', extraRatePerMaterial: '每份材料的补缀成功率加成',
        extraRatePearl: '龙宫宝珠的补缀成功率加成', extraRateMax: '补缀成功率上限', rateMin: '熔炼成功率下限', rateMax: '熔炼成功率上限',
        goldBase: '基础金币花费', goldPerMaterial: '每份材料金币', goldPearl: '龙宫宝珠金币', maxMaterials: '单次最大投料份数', maxTypes: '单次最大投料种类',
        recastPearl: '重铸基础消耗（龙宫宝珠）', recastGold: '重铸每颗宝珠的金币',
        retainMaxRelic: '单次最大投入残片',
        addAffixCap: '补缀后词条数上限',
      };
      const patch = {};
      let err = null;
      Object.keys(RANGES).forEach(function (k) {
        if (err || d[k] == null || d[k] === '') return;
        const v = Number(d[k]);
        const r = RANGES[k];
        if (!isFinite(v) || v < r[0] || v > r[1]) { err = LABEL[k] + '需在 ' + r[0] + ' - ' + r[1] + ' 之间'; return; }
        patch[k] = (k === 'failPerMaterial' || k === 'extraRatePerMaterial') ? Math.round(v * 10) / 10 : Math.round(v);
      });
      // v0.13：残片保留概率改为公式控制（变量 breakthrough = 主件突破词缀条数，默认 10 - breakthrough * 0.5）
      if (!err && d.retainFormula != null && String(d.retainFormula).trim() !== '') {
        const fsrc = String(d.retainFormula).trim();
        const c = D.compileExpr(fsrc, D.RETAIN_VAR_NAMES);
        if (c.error) err = '保留概率公式无效：' + c.error + '（可用变量：' + D.RETAIN_VAR_NAMES.join('/') + '）';
        else patch.retainFormula = fsrc;
      }
      if (d.pearlRollTwice != null) patch.pearlRollTwice = !!d.pearlRollTwice;
      if (d.recastMinValue != null) patch.recastMinValue = (d.recastMinValue === true || d.recastMinValue === 1 || d.recastMinValue === '1') ? 1 : 0;
      // v0.11.5：词缀搬移与补缀的三项开关（副件区间 / 不受底材池限制 / 补缀按池外区间取值）
      if (d.subRangeFromSub != null) patch.subRangeFromSub = !!d.subRangeFromSub;
      if (d.addAnyAffix != null) patch.addAnyAffix = !!d.addAnyAffix;
      if (d.addAffixExtraRange != null) patch.addAffixExtraRange = !!d.addAffixExtraRange;
      // v0.12.2：材料催化词缀范围（分组件部位设置，{ [part]: { [type]: [min, max] } }）；整表替换语义。
      // v0.13 硬约束：催化区间不得越出该部位的包络——上限不得高于该部位任一底材的最高值、
      // 下限不得低于最低值（否则催化词缀会比该部位自然产出还强）。越界直接报错，不接受静默夹紧。
      if (!err && d.catalystRanges != null) {
        const crIn = (typeof d.catalystRanges === 'object' && d.catalystRanges) ? d.catalystRanges : {};
        const bad = [];
        Object.keys(crIn).forEach(function (part) {
          const row = crIn[part];
          if (!row || typeof row !== 'object') return;
          Object.keys(row).forEach(function (t) {
            const r = row[t];
            if (!Array.isArray(r)) return;
            const mn = Number(r[0]), mx = Number(r[1]);
            if (!isFinite(mn) || !isFinite(mx)) { bad.push(partNameOf(part) + ' × ' + (D.AFFIX_LABEL[t] || t) + ' 不是有效数值'); return; }
            if (mx < mn) { bad.push(partNameOf(part) + ' × ' + (D.AFFIX_LABEL[t] || t) + ' 的下限大于上限'); return; }
            const env = D.catalystEnvelopeOf(part, t);
            if (!env) { bad.push(partNameOf(part) + ' × ' + (D.AFFIX_LABEL[t] || t) + ' 不在该部位的词缀池内（请留空，运行时回退突破区间）'); return; }
            if (mx > env[1] || mn < env[0]) {
              bad.push(partNameOf(part) + ' × ' + (D.AFFIX_LABEL[t] || t) + ' 超出该部位允许范围 ' + env[0] + ' ~ ' + env[1] +
                '（下限不得低于 ' + env[0] + '，上限不得高于 ' + env[1] + '），当前 ' + mn + ' ~ ' + mx);
            }
          });
        });
        if (bad.length) err = '催化词缀范围非法：' + bad.slice(0, 3).join('；') + (bad.length > 3 ? ' 等 ' + bad.length + ' 项' : '');
        else patch.catalystRanges = crIn;
      }
      if (err) return apiResp(res, 400, { error: err });
      if (d.reset) {
        world.smeltCfg = D.setSmeltCfg(null);
      } else {
        const merged = Object.assign({}, D.getSmeltCfg(), patch);
        if (merged.rateMin > merged.rateMax) return apiResp(res, 400, { error: '熔炼成功率下限不能大于上限' });
        if (merged.baseRate > merged.rateMax) merged.baseRate = merged.rateMax;
        if (merged.baseRate < merged.rateMin) merged.baseRate = merged.rateMin;
        world.smeltCfg = D.setSmeltCfg(merged);
      }
      saveConfig();
      broadcast({ type: 'smeltcfg', smeltCfg: smeltCfgOf() });
      econLog(a.name, '熔炼配置：基础成功率 ' + world.smeltCfg.baseRate + '%');
      apiResp(res, 200, { ok: true, smeltCfg: smeltCfgOf() });
    });
    return;
  }
  // ---- 渔获记录贴图：全场最大鱼图标的缩放与偏移（玩家端即时生效）----
  // scale：相对原始贴图的百分比（50 ~ 500，默认 175）；x/y：像素偏移（-400 ~ 400）
  if (p === '/api/admin/records/config' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      if (d.reset) {
        world.recordsCfg = null;
        saveConfig();
        broadcast({ type: 'recordscfg', recordsCfg: recordsCfgOf() });
        return apiResp(res, 200, { ok: true, recordsCfg: recordsCfgOf() });
      }
      const scale = Number(d.scale);
      const x = Number(d.x);
      const y = Number(d.y);
      if (!isFinite(scale) || scale < RECORDS_SCALE_MIN || scale > RECORDS_SCALE_MAX) {
        return apiResp(res, 400, { error: '缩放需在 ' + RECORDS_SCALE_MIN + ' - ' + RECORDS_SCALE_MAX + '% 之间' });
      }
      if (!isFinite(x) || x < RECORDS_OFFSET_MIN || x > RECORDS_OFFSET_MAX) {
        return apiResp(res, 400, { error: '横向偏移需在 ' + RECORDS_OFFSET_MIN + ' - ' + RECORDS_OFFSET_MAX + ' px 之间' });
      }
      if (!isFinite(y) || y < RECORDS_OFFSET_MIN || y > RECORDS_OFFSET_MAX) {
        return apiResp(res, 400, { error: '纵向偏移需在 ' + RECORDS_OFFSET_MIN + ' - ' + RECORDS_OFFSET_MAX + ' px 之间' });
      }
      world.recordsCfg = { scale: Math.round(scale), x: Math.round(x), y: Math.round(y) };
      saveConfig();
      broadcast({ type: 'recordscfg', recordsCfg: recordsCfgOf() });
      econLog(a.name, '纪录贴图：缩放 ' + world.recordsCfg.scale + '% / 偏移 ' + world.recordsCfg.x + ',' + world.recordsCfg.y);
      apiResp(res, 200, { ok: true, recordsCfg: recordsCfgOf() });
    });
    return;
  }
  // ---- 设置：通知等级 / 上钩公式（validateOnly=true 只校验不保存；evalVars 附带试算） ----
  // ---- 渔获纪录管理：删除某个鱼种 / 全部的捕获纪录（最大、最小、前十大、前十小、日周榜）（管理员）----
  if (p === '/api/admin/records/delete' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const id = (d.id != null && d.id !== '') ? String(d.id) : '';
      if (id && !FISH_ID_SET[id]) return apiResp(res, 400, { error: '未知鱼类：' + id });
      const removed = deleteRecords(id || null);
      saveRecords();
      markRecordsDirty();
      broadcastRecords();
      econLog(a.name, id ? ('删除渔获纪录：' + itemName(id)) : '删除全部渔获纪录');
      apiResp(res, 200, { ok: true, id: id || null, removed: removed,
        records: world.bigRecords, small: world.smallRecords, globalMax: world.globalMax || null, last: world.lastRec || null });
    });
    return;
  }
  // 删除榜上的**单条**纪录（v0.14.1）：id + range(day|week|all) + kind(big|small) + index，
  // 客户端另带该条的 who/size/t，服务端先核对名次上还是不是它 —— 期间被别人的渔获挤走就 409
  // 让人刷新重来，避免「列表看着是 A、实际删掉了 B」。可选 purge=1：把这条（同钓者 + 同尺寸）
  // 从该鱼种的其它榜单与「最大/最小纪录」里一并抹掉（作弊的一条往往同时躺在日/周/总三个榜里）。
  if (p === '/api/admin/records/delone' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const id = String(d.id || '');
      if (!FISH_ID_SET[id]) return apiResp(res, 400, { error: '未知鱼类：' + id });
      const range = d.range === 'week' ? 'week' : (d.range === 'all' ? 'all' : 'day');
      const small = d.kind === 'small';
      const index = parseInt(d.index, 10);
      const list = boardListRef(range, id, small);
      if (!list || !list.length) return apiResp(res, 404, { error: '该榜没有条目' });
      if (!(index >= 0) || index >= list.length) return apiResp(res, 409, { error: '名次已变化，请刷新后重试' });
      const cur = list[index];
      if (d.t != null && (Number(cur.t) !== Number(d.t) || String(cur.who) !== String(d.who) || Number(cur.size) !== Number(d.size))) {
        return apiResp(res, 409, { error: '该条已被更新，请刷新后重试' });
      }
      list.splice(index, 1);
      dropEmptyBoard(range, id, small);
      let purge = null;
      if (d.purge) purge = purgeEntryEverywhere(id, cur.who, cur.size);
      saveRecords();
      markRecordsDirty();
      broadcastRecords();
      const label = rankLabelOf(range) + (small ? ' · 最小' : ' · 最大');
      econLog(a.name, '删除纪录条目：' + itemName(id) + ' ' + label + ' 第 ' + (index + 1) + ' 名 ' +
        cur.who + ' ' + cur.size + 'cm' + (purge && purge.boards ? '（并清理同条目 ' + purge.boards + ' 处）' : ''));
      apiResp(res, 200, {
        ok: true, id: id, range: range, kind: small ? 'small' : 'big', label: label,
        removed: cur, purge: purge,
        top: (boardListRef(range, id, small) || []).slice(),
      });
    });
    return;
  }
  if (p === '/api/admin/settings' && req.method === 'POST') {
    adminAuditedBody(req, p, function (body) {
      let d = bodyObj(body); if (!d) return apiResp(res, 400, { error: '格式错误' });
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
          broadcast({ type: 'bitecfg' }); // 通知玩家端刷新「当前上鱼率」显示
        }
        out.biteFormula = formulaSrc;
      }
      // 稀有度（rare 词缀）的 K 值：普通品质物品权重系数 = K/(K+R)。必须 > 0。
      if (d.rareK != null && d.rareK !== '') {
        const k = Number(d.rareK);
        if (!isFinite(k) || k <= 0 || k > 100000) return apiResp(res, 400, { error: '稀有度的 K 值需在 0 以上（建议 0.1 - 100）' });
        if (!d.validateOnly) world.rareK = Math.round(k * 1000) / 1000;
        out.rareK = world.rareK;
      }
      if (d.notifyLevel != null) {
        if (!NOTIFY_LEVELS[d.notifyLevel]) return apiResp(res, 400, { error: '未知的通知等级' });
        if (!d.validateOnly) world.notifyLevel = d.notifyLevel;
        out.notifyLevel = d.notifyLevel;
      }
      // 按人数自动调节通知等级：{on, preset?('default'|'relaxed'), rules?, hysteresisPct?, holdCount?}
      if (d.autoNotify != null && typeof d.autoNotify === 'object' && !d.validateOnly) {
        const anIn = d.autoNotify;
        world.autoNotify = world.autoNotify || { on: false, rules: autoNotifyPreset('default'), hysteresisPct: 10, holdCount: 2 };
        if (anIn.on != null) world.autoNotify.on = !!anIn.on;
        if (anIn.preset) world.autoNotify.rules = autoNotifyPreset(anIn.preset === 'relaxed' ? 'relaxed' : 'default');
        else if (Array.isArray(anIn.rules)) {
          world.autoNotify.rules = anIn.rules.slice(0, 10).map(function (r) {
            return { min: Math.max(0, parseInt(r && r.min, 10) || 0), level: NOTIFY_LEVELS[r && r.level] ? r.level : 'uncommon' };
          });
        }
        if (anIn.hysteresisPct != null) world.autoNotify.hysteresisPct = Math.min(Math.max(parseInt(anIn.hysteresisPct, 10) || 10, 0), 90);
        if (anIn.holdCount != null) world.autoNotify.holdCount = Math.min(Math.max(parseInt(anIn.holdCount, 10) || 2, 1), 12);
        out.autoNotify = world.autoNotify;
      }
      // 基础双钓率 B（0..1）：叠加词缀双钓率 P 得最终双钓概率 1-(1-B)(1-P)
      if (d.doubleBase != null) {
        const b = Number(d.doubleBase);
        if (!isFinite(b) || b < 0 || b > 1) return apiResp(res, 400, { error: '基础双钓率需在 0 - 1 之间' });
        if (!d.validateOnly) world.doubleBase = b;
        out.doubleBase = b;
      }
      // 自动售出打包阈值：可卖余量攒够这个条数才成交一次（省掉逐条上鱼的收发包）
      if (d.autoSellCfg != null && d.autoSellCfg !== '' && typeof d.autoSellCfg === 'object') {
        const b = parseInt(d.autoSellCfg.batch, 10);
        if (!isFinite(b) || b < 1 || b > AUTO_SELL_BATCH_MAX) {
          return apiResp(res, 400, { error: '自动售出打包阈值需在 1 - ' + AUTO_SELL_BATCH_MAX + ' 之间' });
        }
        if (!d.validateOnly) {
          world.autoSellCfg = { batch: b };
          // 阈值调低后，在线玩家可能立刻够一包 → 就地跑一遍
          players.forEach(function (p, k) { try { autoSellCheck(k); } catch (e) {} });
          broadcast({ type: 'autosellcfg', autoSellCfg: autoSellCfgOf() });
          econLog(a.name, '自动出售打包阈值：' + b + ' 条');
        }
        out.autoSellCfg = autoSellCfgOf();
      }
      // 抛竿间隔与全服钓速：基础值 / 最短值 / 全服钓速加成 / 有效钓速上限
      // 保存后广播并重启所有在线钓鱼循环（钓速只影响间隔，上钩率由公式决定）
      if (d.castBaseMs != null || d.castMinMs != null || d.castSpeedBonus != null || d.castSpeedCap != null || d.resetCastSpeed) {
        const cur = world.castCfg || {};
        const bonusOff = !!d.resetCastSpeed;
        const base = d.castBaseMs != null ? Number(d.castBaseMs) : castBaseMs();
        const min = d.castMinMs != null ? Number(d.castMinMs) : castMinMs();
        const bonus = bonusOff ? CAST_SPEED_BONUS_DEFAULT : (d.castSpeedBonus != null ? Number(d.castSpeedBonus) : castSpeedBonus());
        const cap = bonusOff ? CAST_SPEED_CAP_DEFAULT : (d.castSpeedCap != null ? Number(d.castSpeedCap) : castSpeedCap());
        void cur;
        if (!isFinite(base) || base < 200 || base > 60000) return apiResp(res, 400, { error: '基础抛竿间隔需在 200 - 60000 ms 之间' });
        if (!isFinite(min) || min < 100 || min > 60000) return apiResp(res, 400, { error: '最短抛竿间隔需在 100 - 60000 ms 之间' });
        if (min > base) return apiResp(res, 400, { error: '最短间隔不能大于基础间隔' });
        if (!isFinite(bonus) || bonus < -100 || bonus > 500) return apiResp(res, 400, { error: '全服钓速加成需在 -100% - 500% 之间' });
        if (!isFinite(cap) || cap < 0 || cap > 100) return apiResp(res, 400, { error: '钓速上限需在 0% - 100% 之间' });
        if (!d.validateOnly) {
          world.castCfg = { baseMs: Math.round(base), minMs: Math.round(min), speedBonus: Math.round(bonus * 10) / 10, speedCap: Math.round(cap) };
          restartAllFishing();
          broadcast({ type: 'castcfg', baseMs: world.castCfg.baseMs, minMs: world.castCfg.minMs, speedBonus: world.castCfg.speedBonus, speedCap: world.castCfg.speedCap });
        }
        out.castBaseMs = Math.round(base);
        out.castMinMs = Math.round(min);
        out.castSpeedBonus = Math.round(bonus * 10) / 10;
        out.castSpeedCap = Math.round(cap);
      }
      if (!d.validateOnly) saveConfig();
      // ---- 经济参数：价格模型全程可调（world.priceCfg / world.dropCfg / 单品干预 world.priceOv）----
      // 逐项范围校验，并做跨项约束（地板 < 天花板、回升目标 ≥ 地板、0 ≤ 回升目标）；validateOnly 只校验。
      {
        const RANGES = {
          floorPct: [10, 100], ceilPct: [100, 500], saleDivisor: [0.001, 0.05],
          riseTauMin: [5, 1440], riseTargetPct: [100, 300], sampleSec: [15, 300], historyMin: [60, 1440],
        };
        const LABEL = {
          floorPct: '地板价', ceilPct: '天花板价', saleDivisor: '每件下压', riseTauMin: '回升时间常数',
          riseTargetPct: '回升目标', sampleSec: '采样间隔', historyMin: '历史保留',
        };
        const fmt = function (k, v) {
          if (k === 'saleDivisor') return Math.round(v * 100000) / 100000;
          return Math.round(v * 100) / 100;
        };
        if (d.resetPriceCfg) {
          if (!d.validateOnly) {
            world.priceCfg = {};
            armPriceSampler();
            econLog(a.name, '恢复默认价格参数');
            broadcast({ type: 'pricecfg', priceCfg: priceCfg(), dropCfg: dropCfg() });
            broadcastShop();
          }
          out.priceCfg = priceCfg();
        } else if (d.priceCfg != null) {
          if (typeof d.priceCfg !== 'object') return apiResp(res, 400, { error: 'priceCfg 格式错误' });
          const src = d.priceCfg;
          const cur = Object.assign({}, world.priceCfg || {});
          const changed = [];
          const keys = Object.keys(RANGES);
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (src[k] == null) continue;
            const v = Number(src[k]);
            const r = RANGES[k];
            if (!isFinite(v) || v < r[0] || v > r[1]) {
              return apiResp(res, 400, { error: LABEL[k] + '需在 ' + r[0] + ' - ' + r[1] + ' 之间' });
            }
            cur[k] = fmt(k, v);
            changed.push(LABEL[k] + '=' + cur[k]);
          }
          // 品质层覆盖：{ common|big|rare: {saleDivisor?, riseTauMin?} }；传 null 清除该层覆盖
          if (src.tiers !== undefined) {
            if (src.tiers != null && typeof src.tiers !== 'object') return apiResp(res, 400, { error: '品质层覆盖格式错误' });
            const tiers = {};
            let tierErr = null;
            ['common', 'big', 'rare'].forEach(function (tier) {
              const t = src.tiers && src.tiers[tier];
              if (t == null) return;
              const o = {};
              if (t.saleDivisor != null) {
                const v = Number(t.saleDivisor);
                if (!isFinite(v) || v < 0.001 || v > 0.05) { tierErr = tier + ' 每件下压需在 0.001 - 0.05 之间'; return; }
                o.saleDivisor = fmt('saleDivisor', v);
              }
              if (t.riseTauMin != null) {
                const v = Number(t.riseTauMin);
                if (!isFinite(v) || v < 5 || v > 1440) { tierErr = tier + ' 回升时间常数需在 5 - 1440 之间'; return; }
                o.riseTauMin = fmt('riseTauMin', v);
              }
              if (Object.keys(o).length) tiers[tier] = o;
            });
            if (tierErr) return apiResp(res, 400, { error: tierErr });
            cur.tiers = Object.keys(tiers).length ? tiers : null;
            changed.push('品质层覆盖');
          }
          // 跨项约束（按合并后的生效值判断）
          const effFloor = cur.floorPct != null ? Number(cur.floorPct) : PRICE_DEFAULTS.floorPct;
          const effCeil = cur.ceilPct != null ? Number(cur.ceilPct) : PRICE_DEFAULTS.ceilPct;
          const effTarget = cur.riseTargetPct != null ? Number(cur.riseTargetPct) : Math.min(effCeil, PRICE_DEFAULTS.riseTargetPct);
          if (effFloor >= effCeil) return apiResp(res, 400, { error: '地板价必须低于天花板价' });
          if (effTarget < effFloor) return apiResp(res, 400, { error: '回升目标不能低于地板价' });
          if (!d.validateOnly && changed.length) {
            world.priceCfg = cur;
            armPriceSampler(); // 采样间隔可能变化：重挂定时器
            econLog(a.name, '价格参数：' + changed.join('、'));
            broadcast({ type: 'pricecfg', priceCfg: priceCfg(), dropCfg: dropCfg() });
            broadcastShop();
          }
          out.priceCfg = priceCfg();
        }
        // ---- 产出倍率：全局 + 分类（普通/大鱼/稀有/材料）百分比 ----
        if (d.resetDropCfg) {
          if (!d.validateOnly) {
            world.dropCfg = {};
            econLog(a.name, '恢复默认产出倍率');
            broadcast({ type: 'pricecfg', priceCfg: priceCfg(), dropCfg: dropCfg() });
            broadcastGroundcfg(); // 下发有效权重，图鉴/钓点概率同步
          }
          out.dropCfg = dropCfg();
        } else if (d.dropCfg != null) {
          if (typeof d.dropCfg !== 'object') return apiResp(res, 400, { error: 'dropCfg 格式错误' });
          const cur = Object.assign({}, world.dropCfg || {});
          const changed = [];
          const DLABEL = { global: '全局产出', common: '普通鱼', big: '大鱼', rare: '稀有鱼', material: '材料' };
          for (let i = 0; i < DROP_KEYS.length; i++) {
            const k = DROP_KEYS[i];
            if (d.dropCfg[k] == null) continue;
            const v = Number(d.dropCfg[k]);
            if (!isFinite(v) || v < 0 || v > 500) return apiResp(res, 400, { error: DLABEL[k] + '倍率需在 0 - 500% 之间' });
            cur[k] = Math.round(v * 10) / 10;
            changed.push(DLABEL[k] + '=' + cur[k] + '%');
          }
          if (!d.validateOnly && changed.length) {
            world.dropCfg = cur;
            econLog(a.name, '产出倍率：' + changed.join('、'));
            broadcast({ type: 'pricecfg', priceCfg: priceCfg(), dropCfg: dropCfg() });
            broadcastGroundcfg(); // 下发有效权重，图鉴/钓点概率同步
          }
          out.dropCfg = dropCfg();
        }
        // ---- 单品干预：覆盖基准价 / 锁定乘数（可带过期分钟数，0 或空 = 永久）----
        if (d.priceOv != null) {
          if (typeof d.priceOv !== 'object' || !d.priceOv.id) return apiResp(res, 400, { error: 'priceOv 需指定物品 id' });
          const id = String(d.priceOv.id);
          if (!ECO_PRICE[id]) return apiResp(res, 400, { error: '该物品不在系统商店经济内' });
          if (d.priceOv.clear) {
            if (!d.validateOnly) {
              if (world.priceOv) delete world.priceOv[id];
              econLog(a.name, '清除单品干预：' + itemName(id));
              broadcastShop();
            }
            out.priceOv = null;
          } else {
            const o = {};
            if (d.priceOv.base != null && d.priceOv.base !== '') {
              const v = Number(d.priceOv.base);
              if (!isFinite(v) || v < 1 || v > 10000000) return apiResp(res, 400, { error: '覆盖基准价需在 1 - 10000000 之间' });
              o.base = Math.round(v);
            }
            if (d.priceOv.m != null && d.priceOv.m !== '') {
              const v = Number(d.priceOv.m);
              if (!isFinite(v) || v < 0.05 || v > 10) return apiResp(res, 400, { error: '锁定乘数需在 0.05 - 10 之间' });
              o.m = Math.round(v * 1000) / 1000;
            }
            if (!Object.keys(o).length) return apiResp(res, 400, { error: '至少填写覆盖基准价或锁定乘数之一' });
            const mins = Number(d.priceOv.untilMin);
            if (d.priceOv.untilMin != null && d.priceOv.untilMin !== '' && (!isFinite(mins) || mins < 0 || mins > 10080)) {
              return apiResp(res, 400, { error: '过期时间需在 0 - 10080 分钟之间（0 = 永久）' });
            }
            if (isFinite(mins) && mins > 0) o.until = Date.now() + Math.round(mins) * 60000;
            const before = priceOvOf(id);
            const b0 = basePrice(id);
            const p0 = currentPrice(id);
            if (!d.validateOnly) {
              world.priceOv = world.priceOv || {};
              world.priceOv[id] = o;
              econLog(a.name, '单品干预：' + itemName(id) +
                (o.base ? ' 基准价 ' + b0 + '→' + o.base : '') +
                (o.m ? ' 锁价 ×' + o.m : '') +
                (o.until ? '（' + Math.round(mins) + ' 分钟后恢复）' : ''));
              broadcastShop();
            }
            out.priceOv = Object.assign({ id: id, base: b0, price: p0, next: currentPrice(id) }, o);
            void before;
          }
        }
        if (!d.validateOnly && (d.resetPriceCfg || d.priceCfg != null || d.resetDropCfg || d.dropCfg != null || d.priceOv != null)) { saveConfig(); saveEconomy(); }
      }
      // ---- 宝匣配置：突破保底次数（0 = 关闭）+ 各档位合成成本（残片 / 金币）----
      // 成本覆盖存 world.chestCfg.costs，保存后立即套用到共享目录 D.CHESTS，
      // 玩家端 /api/chest 与合成校验读到的都是同一份有效成本（无需重启）。
      if (d.chestCfg != null) {
        if (typeof d.chestCfg !== 'object') return apiResp(res, 400, { error: 'chestCfg 格式错误' });
        const cur = Object.assign({}, world.chestCfg || {});
        if (d.chestCfg.pityN !== undefined) {
          const raw = Number(d.chestCfg.pityN);
          if (d.chestCfg.pityN != null && d.chestCfg.pityN !== '') {
            if (!isFinite(raw) || raw < 0 || raw > CHEST_PITY_MAX) {
              return apiResp(res, 400, { error: '突破保底次数需在 0 - ' + CHEST_PITY_MAX + ' 之间（0 = 关闭）' });
            }
            cur.pityN = Math.floor(raw);
          } else {
            cur.pityN = 0; // 留空 = 关闭保底
          }
        }
        if (d.chestCfg.costs !== undefined) {
          if (d.chestCfg.costs != null && typeof d.chestCfg.costs !== 'object') {
            return apiResp(res, 400, { error: '宝匣成本格式错误' });
          }
          const src = d.chestCfg.costs || {};
          const costs = {};
          let err = null;
          Object.keys(src).forEach(function (cid) {
            if (err) return;
            const ch = D.chestOf(cid);
            if (!ch) return;
            const o = src[cid] || {};
            const out2 = {};
            if (o.costRelic !== undefined && o.costRelic !== '') {
              const v = Number(o.costRelic);
              if (!isFinite(v) || v < 0 || v > CHEST_COST_RELIC_MAX || Math.floor(v) !== v) {
                err = '「' + ch.name + '」所需残片需为 0 - ' + CHEST_COST_RELIC_MAX + ' 的整数';
                return;
              }
              out2.costRelic = v;
            }
            if (o.costCoins !== undefined && o.costCoins !== '') {
              const v = Number(o.costCoins);
              if (!isFinite(v) || v < 0 || v > CHEST_COST_COINS_MAX || Math.floor(v) !== v) {
                err = '「' + ch.name + '」所需金币需为 0 - ' + CHEST_COST_COINS_MAX + ' 的整数';
                return;
              }
              out2.costCoins = v;
            }
            if (Object.keys(out2).length) costs[cid] = out2;
          });
          if (err) return apiResp(res, 400, { error: err });
          cur.costs = Object.keys(costs).length ? costs : null;
        }
        if (!d.validateOnly) {
          world.chestCfg = cur;
          applyChestCostCfg();
          saveConfig();
          // 通知在线玩家刷新宝匣页的成本与保底进度文案（无此广播则要重新进入页面才更新）
          broadcast({ type: 'chestcfg', chestCfg: chestCfgOf() });
        }
        out.chestCfg = chestCfgOf();
      }
      if (d.evalVars && formulaSrc != null) {
        const c2 = compileFormula(formulaSrc);
        if (c2.ok) {
          const vars = { speed: 0, skill: 0, big: 0, rare: 0, material: 0, size: 0, double: 0, interval: castBaseMs() };  // big 恒 0（兼容旧公式）
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
  if (p === '/wiki') { res.writeHead(301, { Location: '/wiki/' }); res.end(); return; }
  let rel = p === '/' ? '/index.html' : p;
  if (rel.endsWith('/')) rel += 'index.html';   // /wiki/ → /wiki/index.html
  const fp = path.normalize(path.join(STATIC_DIR, rel));
  if (!fp.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    // no-cache：每次重载都向服务器校验，避免版本更新后浏览器仍用旧 HTML 配新 JS
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
  } catch (e) {
    console.error('[request]', e.stack || e);
    if (!res.headersSent) apiResp(res, e instanceof Security.ValidationError ? 400 : 500, { error: e instanceof Security.ValidationError ? e.message : '服务器处理失败' }); else res.destroy();
  }
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;
server.listen(PORT, BIND_HOST, function () {
  console.log('🎣 钓鱼 API 服务器已启动: http://localhost:' + PORT);
  if (STATIC_DIR) console.log('   集成模式：前端已托管 → http://localhost:' + PORT + '/  （' + STATIC_DIR + '）');
  else console.log('   纯 API 模式：未托管静态前端（前后端分离部署）');
  console.log('   注册/登录后可开始；多开浏览器标签 = 多真实玩家。');
  console.log('   💾 关闭服务器：在本窗口输入 q 再回车（先存档再退出）；Ctrl+C 同样先存档。');
  console.log('      直接叉掉窗口 = 进程被强杀，最后一笔数据可能来不及落盘。');
});

// ---- 优雅停服：控制台指令 / Ctrl+C 先落盘再退出 ----
// 直接叉掉 cmd 窗口走的是 TerminateProcess，'exit' 钩子不执行：账号是「脏标记 + 1s 定时批量」、
// 会话是 2s 防抖，两者都可能丢掉最后一笔。这里给一个显式入口：账号、世界域、会话全部同步写盘后再退出。
function gracefulShutdown(why) {
  console.log('\n💾 正在保存数据（' + why + '）…');
  try {
    if (accountFlushTimer) { clearTimeout(accountFlushTimer); accountFlushTimer = null; }
    dirtyAccounts.clear();
    const keys = Object.keys(users);
    keys.forEach(function (k) { const rec = users[k]; if (rec) writeAccountFile(k, rec); });
    console.log('   ✔ 账号 ' + keys.length + ' 个');
  } catch (e) { console.error('   ✘ 账号保存失败：' + ((e && e.message) || e)); }
  try { saveWorld(); console.log('   ✔ 市集 / 记录 / 经济 / 配置 / 反馈 / 统计'); }
  catch (e) { console.error('   ✘ 世界数据保存失败：' + ((e && e.message) || e)); }
  try {
    if (sessionsFlushTimer) { clearTimeout(sessionsFlushTimer); sessionsFlushTimer = null; }
    sessionsDirty = false;
    saveSessionsNow();
    console.log('   ✔ 会话 ' + sessions.size + ' 条');
  } catch (e) { console.error('   ✘ 会话保存失败：' + ((e && e.message) || e)); }
  console.log('✅ 已保存，服务器关闭 —— 现在可以安全关掉这个窗口了。\n');
  process.exit(0);
}
// 输入 q / quit / exit / save / stop 回车即存档退出；Ctrl+C / SIGTERM 走同一条路径。
// stdin 被关掉（以服务方式启动）时安静跳过，不影响正常跑。
(function bindExitKeys() {
  if (!process.stdin || typeof process.stdin.on !== 'function') return;
  try { process.stdin.setEncoding('utf8'); } catch (e) {}
  process.stdin.on('data', function (buf) {
    const cmd = String(buf).trim().toLowerCase();
    const match = /^(admin-init|admin-totp) ([a-z0-9_]{3,20})$/.exec(cmd);
    if (match) {
      const rec = users[match[2]];
      if (!rec) return console.log('账号不存在，请先注册游戏账号');
      if (match[1] === 'admin-init') {
        if (anyAdminExists()) return console.log('已有管理员，不能再次初始化');
        rec.admin = true;
      } else if (!rec.admin) return console.log('该账号不是管理员');
      rec.adminTotpSecret = crypto.randomBytes(20).toString('hex'); rec.adminTotpStep = 0;
      kickUserSessions(match[2]); saveAccount(match[2]); flushAccounts();
      const secret = Security.base32(Buffer.from(rec.adminTotpSecret, 'hex'));
      console.log('仅在本机显示：请将以下密钥加入验证器，切勿分享：' + secret);
      console.log('otpauth://totp/FishGame:' + match[2] + '?secret=' + secret + '&issuer=FishGame');
      return;
    }
    if (['q', 'quit', 'exit', 'save', 'stop'].indexOf(cmd) >= 0) gracefulShutdown('控制台输入 ' + cmd);
  });
  process.stdin.on('error', function () {});
  process.on('SIGINT', function () { gracefulShutdown('Ctrl+C'); });
  process.on('SIGTERM', function () { gracefulShutdown('SIGTERM'); });
  try { process.stdin.resume(); } catch (e) {}
})();
