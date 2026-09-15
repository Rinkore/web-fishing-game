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
const { spawn } = require('child_process');

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
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天未使用即失效，避免文件无限增长
const sessions = new Map();
function tokenHash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function saveSessions() {
  const out = {};
  const now = Date.now();
  sessions.forEach(function (v, h) { if (v && v.exp > now) out[h] = { k: v.key, e: v.exp }; });
  writeJson(SESSIONS_FILE, { tokens: out });
}
function loadSessions() {
  const data = readJson(SESSIONS_FILE);
  const now = Date.now();
  const tokens = (data && data.tokens) || {};
  Object.keys(tokens).forEach(function (h) {
    const v = tokens[h];
    if (!v || !v.k || !(v.e > now)) return; // 过期的不载入
    sessions.set(h, { key: v.k, exp: v.e });
  });
}
function sessionSet(token, key) {
  sessions.set(tokenHash(token), { key: key, exp: Date.now() + SESSION_TTL_MS });
  saveSessions();
}
function sessionGet(token) {
  if (!token) return null;
  const h = tokenHash(token);
  const v = sessions.get(h);
  if (!v) return null;
  if (!(v.exp > Date.now())) { sessions.delete(h); saveSessions(); return null; }
  // 滑动续期：剩余不足一半时才写盘，避免每次请求都落一次文件
  if (v.exp - Date.now() < SESSION_TTL_MS / 2) { v.exp = Date.now() + SESSION_TTL_MS; saveSessions(); }
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
let world = { shopSales: {}, listings: [], listingSeq: 1, bigRecords: {}, smallRecords: {}, topCatches: {}, topSmall: {}, globalMax: null, priceLog: {}, tradeLog: {}, marketLog: [], groundCfg: { spots: {}, grounds: {}, spotPos: {} }, notifyLevel: 'all', biteFormula: BITE_FORMULA_DEFAULT, doubleBase: 0, componentCfg: null, fishCfg: null, feedback: [], feedbackMeta: {}, bannerSeq: 1, banners: [], bannerCfg: {}, feedbackCfg: {}, castCfg: {}, priceCfg: {}, dropCfg: {}, priceOv: {}, economyLog: [], chestCfg: {}, mallCfg: null, smeltCfg: null, recordsCfg: null };

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

// ---- 服务端版本更新（优雅热更）----
// 流程：管理员在后台选一个「新版本启动用的 run.bat」→ 立即向全服播报 60 秒更新通知（倒计时横幅）→
//       横幅结束 5 秒后：启动新版本（独立进程，脱离当前进程）并关闭当前版本。
// 让出端口的顺序很关键：先 server.close() 停止监听（端口立即释放），再拉起新版本，最后退出进程——
// 否则新旧两个实例会抢同一个端口，新版本直接 EADDRINUSE 起不来。
const UPDATE_BANNER_MS = 60 * 1000; // 更新通知横幅时长（60 秒）
const UPDATE_GRACE_MS = 5 * 1000;   // 横幅结束后再等 5 秒才真正切换
const UPDATE_EXIT_DELAY_MS = 1500;  // 拉起新版本后留给旧进程的收尾时间（让在途响应写完）
const UPDATE_SCAN_DEPTH = 2;        // .bat 搜索深度（项目根为 0，允许 releases/xxx/run.bat 这类一层子目录）
const UPDATE_MAX_BAT = 60;
let updateTask = null;              // 当前更新任务（内存态：服务器重启即作废）

// 项目根目录：backend/ 的上一级（.bat 模板与版本目录都放在这里）
const PROJECT_ROOT = path.resolve(__dirname, '..');
// 候选启动脚本：项目根的 *.bat + 浅层子目录里的 run.bat / *.bat（如 releases/v0.11.0/run.bat）
function listBatCandidates() {
  const out = [];
  function scan(dir, depth) {
    if (out.length >= UPDATE_MAX_BAT) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (ent) {
      if (out.length >= UPDATE_MAX_BAT) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth <= 0) return;
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.charAt(0) === '.') return;
        scan(full, depth - 1);
        return;
      }
      if (!/\.bat$/i.test(ent.name)) return;
      let st = null;
      try { st = fs.statSync(full); } catch (e) { return; }
      out.push({
        path: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
        name: ent.name,
        dir: path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/') || '.',
        size: st.size, mtime: st.mtimeMs,
      });
    });
  }
  scan(PROJECT_ROOT, UPDATE_SCAN_DEPTH);
  // run.bat 排在最前（最常见的更新方式），其余按修改时间倒序
  return out.sort(function (a, b) {
    const ra = /run\.bat$/i.test(a.name) ? 1 : 0, rb = /run\.bat$/i.test(b.name) ? 1 : 0;
    return rb - ra || b.mtime - a.mtime;
  });
}
// 相对路径 → 绝对路径（必须落在项目目录内、且是 .bat，杜绝路径穿越）
function resolveBatPath(rel) {
  const r = String(rel == null ? '' : rel).trim().replace(/\\/g, '/');
  if (!r || !/\.bat$/i.test(r)) return { error: '请选择一个 .bat 启动脚本' };
  const full = path.resolve(PROJECT_ROOT, r);
  if (full !== PROJECT_ROOT && !full.startsWith(PROJECT_ROOT + path.sep)) return { error: '脚本必须位于项目目录内' };
  let st = null;
  try { st = fs.statSync(full); } catch (e) { return { error: '脚本不存在：' + r }; }
  if (!st.isFile()) return { error: '脚本不是文件：' + r };
  return { ok: true, full: full, rel: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/') };
}
function updateStateView() {
  if (!updateTask) return null;
  return {
    active: true, phase: updateTask.phase, bat: updateTask.bat, note: updateTask.note || '',
    by: updateTask.by || '', startedAt: updateTask.startedAt,
    endAt: updateTask.endAt, fireAt: updateTask.fireAt, bannerMs: UPDATE_BANNER_MS, graceMs: UPDATE_GRACE_MS,
    dryRun: !!updateTask.dryRun,
  };
}
function broadcastUpdate() { broadcast({ type: 'update', update: updateStateView() }); }
function clearUpdateTask() {
  if (!updateTask) return;
  (updateTask.timers || []).forEach(function (t) { clearTimeout(t); });
  updateTask = null;
}
// 启动新版本并关闭当前版本（真机行为）
function performUpdate() {
  if (!updateTask) return;
  const bat = updateTask.bat;
  const full = updateTask.full;
  updateTask.phase = 'restarting';
  broadcastUpdate();
  console.log('[update] 正在切换到新版本：' + bat);
  // 1) 停钓 + 停止监听：立刻释放端口，保证新版本能 bind
  try { players.forEach(function (p, key) { stopFishingSession(key); }); } catch (e) {}
  try { server.close(); } catch (e) {}
  // 2) 拉起新版本（独立窗口、脱离当前进程，旧进程退出不会连带杀掉它）
  if (!updateTask.dryRun) {
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', full], {
        cwd: path.dirname(full), detached: true, stdio: 'ignore', windowsHide: false,
      });
      child.unref();
    } catch (e) {
      console.error('[update] 启动新版本失败：' + e.message);
      updateTask.phase = 'failed';
      updateTask.error = e.message;
      broadcastUpdate();
      return;
    }
  }
  // 3) 关闭当前版本
  setTimeout(function () {
    console.log('[update] 旧版本进程退出');
    if (updateTask) updateTask.phase = 'done';
    try { if (typeof process.exit === 'function') process.exit(0); } catch (e) {}
  }, updateTask.dryRun ? 0 : UPDATE_EXIT_DELAY_MS).unref();
}
function startUpdateTask(opts) {
  clearUpdateTask();
  const now = Date.now();
  const endAt = now + UPDATE_BANNER_MS;
  updateTask = {
    bat: opts.bat, full: opts.full, note: opts.note || '', by: opts.by || '',
    startedAt: now, endAt: endAt, fireAt: endAt + UPDATE_GRACE_MS,
    phase: 'banner', dryRun: !!opts.dryRun, timers: [],
  };
  updateTask.timers.push(setTimeout(function () {
    if (!updateTask) return;
    updateTask.phase = 'grace';
    broadcastUpdate();
  }, UPDATE_BANNER_MS));
  updateTask.timers.push(setTimeout(function () { performUpdate(); }, UPDATE_BANNER_MS + UPDATE_GRACE_MS));
  broadcastUpdate();
  return updateTask;
}

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
// 全部成功率 / 花费 / 投料上限由 D.getSmeltCfg()（管理后台可调）决定，
// 掷骰与结算都在服务器：客户端只发「主件 / 副件 / 各自选中的词条 / 投料 / 是否用龙宫宝珠」。
const SMELT_RATE_PRECISION = 10;
function smeltCfgOf() { return D.getSmeltCfg(); }
// 主件熔炼后的词缀取值区间：词缀在主件池内 → 用主件区间；不在池内（从副件搬过来的）→ 用池外区间
function smeltRangeFor(base, type) {
  const slot = base.pool.find(function (p) { return p.type === type; });
  if (slot) return D.affixRangeOf(base.id, slot);
  return D.extraAffixRangeOf(type);
}
// 一次熔炼取值的 roll（宝珠开启时掷两次取靠近区间边界的那次）
function smeltRoll(range, useBoundary) {
  const model = (D.getComponentCfg && D.getComponentCfg().rollModel) || 'linear';
  return useBoundary
    ? D.rollAffixValueBoundary(range[0], range[1], model)
    : D.rollAffixValue(range[0], range[1], model);
}
// 校验一次熔炼请求（不改状态，纯校验 + 计算），返回 { error } 或完整方案
function planSmelt(rec, d) {
  const cfg = smeltCfgOf();
  const mainRaw = String(d.mainId || '');
  const subRaw = String(d.subId || '');
  const mainMeta = D.componentOf(mainRaw);
  const subMeta = D.componentOf(subRaw);
  if (!mainMeta || !D.isInstance(mainRaw)) return { error: '主组件必须是已生成的组件实例' };
  if (!subMeta || !D.isInstance(subRaw)) return { error: '副组件必须是已生成的组件实例' };
  // 一律用**规范签名**做背包键（客户端可能传来词条顺序不同的等价签名）
  const mainId = mainMeta.id;
  const subId = subMeta.id;
  const needMain = mainId === subId ? 2 : 1;
  if (!invHas(rec, mainId, needMain)) {
    const lock = rodLockError(rec, mainId, needMain);
    if (lock) return { error: lock };
    return { error: mainId === subId ? '主副组件相同，背包里需要 2 件' : '背包中没有该主组件' };
  }
  if (mainId !== subId && !invHas(rec, subId, 1)) {
    const lock = rodLockError(rec, subId, 1);
    if (lock) return { error: lock };
    return { error: '背包中没有该副组件' };
  }
  // 主副必须是**同类型（同部位）**组件：跨部位熔炼会把竿身的词缀搬到线上，语义与展示都会乱
  if (mainMeta.part !== subMeta.part) {
    return { error: '主件与副件必须是同一部位的组件（当前：' + partNameOf(mainMeta.part) + ' / ' + partNameOf(subMeta.part) + '）' };
  }
  const mainAffix = mainMeta.affixes.find(function (a) { return a.type === d.mainAffix; });
  const subAffix = subMeta.affixes.find(function (a) { return a.type === d.subAffix; });
  if (!mainAffix) return { error: '请选择主组件上的一条词条' };
  if (!subAffix) return { error: '请选择副组件上的一条词条' };
  if (mainAffix.type === subAffix.type) {
    return { error: '主副选中的词条类型不能相同（熔炼后两条词条会合成同一条）' };
  }
  // 投料：素材校验（份数 / 种类 / 库存）与主词缀合法性
  const maxM = cfg.maxMaterials;
  const list = Array.isArray(d.materials) ? d.materials : [];
  const matList = [];
  let pearl = !!d.pearl;              // 龙宫宝珠：布尔开关（前端勾选）或写进 materials 都接受
  let pearlQty = 0;
  let total = 0;
  const types = {};
  for (const e of list) {
    const id = String((e && e.id) || '');
    const qty = Math.floor(Number(e && e.qty) || 0);
    if (!id || qty <= 0) continue;
    if (id === D.SMELT_PEARL) { pearl = true; pearlQty += qty; continue; }  // 催化剂：不计入投料份数
    if (!D.smeltMaterialAffix(id)) return { error: '「' + itemName(id) + '」不是熔炼材料' };
    matList.push({ id: id, qty: qty });
    types[D.smeltMaterialAffix(id)] = 1;
    total += qty;
  }
  if (pearlQty > 1) return { error: '龙宫宝珠一次最多投入 1 个' };
  if (total > maxM) return { error: '投料最多 ' + maxM + ' 份（当前 ' + total + ' 份）' };
  if (Object.keys(types).length > cfg.maxTypes) return { error: '投料最多 ' + cfg.maxTypes + ' 种（当前 ' + Object.keys(types).length + ' 种）' };
  if (pearl && !invHas(rec, D.SMELT_PEARL, 1)) {
    return { error: '没有' + itemName(D.SMELT_PEARL) + '（加入宝珠可让词条 roll 两次取靠近区间边界的值）' };
  }
  for (const e of matList) {
    if (!invHas(rec, e.id, e.qty)) return { error: '材料不足：' + itemName(e.id) + ' 需要 ' + e.qty + ' 个，当前 ' + invCountOf(rec, e.id) + ' 个' };
  }
  // 实际消耗清单 = 投料 + 龙宫宝珠（宝珠不计入份数，但要扣件与计费）
  const consume = matList.slice();
  if (pearl) consume.push({ id: D.SMELT_PEARL, qty: 1 });
  const load = D.smeltLoadOf(matList);
  // 补缀目标：投料主词缀必须还在主件池里、且熔炼后的主件没有它
  const afterTypes = [mainAffix.type, subAffix.type];
  let extraType = null;
  if (load.total > 0) {
    extraType = load.dominant;
    const addable = D.smeltAddableAffixes(mainMeta.baseId, afterTypes);
    if (!extraType || addable.indexOf(extraType) < 0) {
      return { error: '投料对应的词缀「' + (D.AFFIX_LABEL[extraType] || extraType || '?') + '」无法加入该主件（主件词缀池里已经没有可补的该类词缀）' };
    }
  }
  const rates = D.smeltRatesOf(load, pearl);
  const gold = D.smeltGoldOf(load, pearl);
  if ((rec.coins || 0) < gold) return { error: '金币不足（需 ' + gold + '，当前 ' + Math.round(rec.coins || 0) + '）' };
  return {
    ok: true, cfg: cfg, mainId: mainId, subId: subId, mainMeta: mainMeta, subMeta: subMeta,
    mainAffix: mainAffix, subAffix: subAffix, materials: matList, consume: consume, load: load,
    pearl: pearl, extraType: extraType, rates: rates, gold: gold,
    rollBoundary: !!(pearl && cfg.pearlRollTwice),
  };
}
// 某账号在某档位上的「连续未突破」计数（惰性读取，0 表示没有记录）
// 部位名（错误提示与界面文案共用）
function partNameOf(key) {
  const p = D.ROD_PARTS.find(function (x) { return x.key === key; });
  return p ? p.name : String(key || '?');
}
// ---- 工坊 · 重铸 ----
// 用「沉船宝匣残片」给**宝匣产出的神话件**重 roll 全部词条数值（词条类型与条数不变）。
// 只允许神话品质：全游戏只有海王遗匣产出神话件（后台掉落权重刻意不含 mythic），
// 因此神话品质就是「宝匣产出」这一身份的判据；工坊熔炼保留主件品质，熔出来的神话件同样可重铸。
// 花费与「是否保底不降级」由后台「⚒ 工坊配置」决定（默认 10 残片 + 0 金币，完全重 roll）。
function planRecast(rec, id) {
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
  const relicId = 'relic';
  const relicNeed = Math.max(0, Math.floor(Number(cfg.recastRelic) || 0));
  const goldNeed = Math.max(0, Math.floor(Number(cfg.recastGold) || 0));
  const relicHave = invCountOf(rec, relicId);
  if (relicHave < relicNeed) {
    return { error: itemName(relicId) + '不足（需 ' + relicNeed + ' 个，当前 ' + relicHave + ' 个）' };
  }
  if ((rec.coins || 0) < goldNeed) return { error: '金币不足（需 ' + goldNeed + '，当前 ' + Math.round(rec.coins || 0) + '）' };
  return {
    ok: true, cfg: cfg, meta: meta, relicId: relicId, relicNeed: relicNeed, relicHave: relicHave,
    gold: goldNeed, materials: [{ id: relicId, name: itemName(relicId), need: relicNeed, have: relicHave }],
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
const FEEDBACK_STATUSES = { submitted: '已提交', accepted: '已受理', done: '已完成' };

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
// 有效钓速（%）：词缀/+钓点增益 + 全服加成，再按上限截断
function effectiveSpeed(eff) {
  const raw = (Number(eff && eff.speed) || 0) + castSpeedBonus();
  return Math.max(0, Math.min(castSpeedCap(), raw));
}

// 钓竿词缀合计。键集 = 组件词缀（speed/skill/rare/material/size/double）+ 只可能来自钓点增益的 big
// （「大鱼概率」在 v0.11 从组件词缀改为「技巧」，但钓点增益仍保留大鱼概率这一类）。
function bdEffectsOf(bd) {
  const eff = { speed: 0, skill: 0, big: 0, rare: 0, material: 0, size: 0, double: 0 };
  D.ROD_PARTS.forEach(function (part) {
    const comp = D.componentOf(bd && bd[part.key] && bd[part.key].compId);
    if (!comp) return;
    comp.affixes.forEach(function (a) { if (eff[a.type] != null) eff[a.type] += a.value; });
  });
  return eff;
}
function fishIntervalOf(eff) {
  return Math.max(castMinMs(), Math.round(castBaseMs() * (1 - effectiveSpeed(eff) / 100)));
}
// 钓点钓速增益（%）：作为「最终乘算」的速率倍率，不与钓竿词缀加算
function spotSpeedOf(spot) {
  let v = 0;
  ((spot && spot.buffs) || []).forEach(function (b) { if (b && b.type === 'speed') v += Number(b.value) || 0; });
  return v;
}
// 钓点独立上鱼率覆盖（%）：未配置返回 null（用全服公式）
function spotBiteRateOf(spot) {
  const v = spot && spot.biteRate;
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}
// 当前实际抛竿间隔：优先钓点独立间隔；否则 基础 × (1 - 有效钓速/100) × (1 - 钓点钓速/100)
// 钓点钓速为最终乘算（乘在钓竿/全服之后），最后再按「最短间隔」兜底。
function intervalFor(rec, spot) {
  const fixed = spot && spot.intervalMs;
  if (fixed != null && fixed !== '') {
    const n = Number(fixed);
    if (isFinite(n) && n >= 100) return Math.round(n);
  }
  const bdEff = bdEffectsOf(rec && rec.bd);
  const rodMs = castBaseMs() * (1 - effectiveSpeed({ speed: bdEff.speed }) / 100);
  const spotPct = Math.max(-100, Math.min(95, spotSpeedOf(spot)));
  const ms = rodMs * (1 - spotPct / 100);
  return Math.max(castMinMs(), Math.round(ms));
}
// 钓速明细（下发给前端展示：基础值来自后台配置，实际值含钓竿词缀 / 钓点增益 / 全服加成并受上限截断）
function castInfoOf(rec, spot) {
  const bdEff = bdEffectsOf(rec && rec.bd);
  const eff = mergedEffOf(rec && rec.bd, spot);
  const spotPct = spotSpeedOf(spot);
  const rodEff = effectiveSpeed({ speed: bdEff.speed });
  const interval = intervalFor(rec, spot);
  const override = spotBiteRateOf(spot);
  const biteRate = override != null ? override : Math.round(biteProbabilityOf(eff, interval, spot) * 10) / 10;
  return {
    baseMs: castBaseMs(),
    minMs: castMinMs(),
    globalBonus: castSpeedBonus(),
    cap: castSpeedCap(),
    affixSpeed: bdEff.speed,            // 钓竿词缀合计（%）
    buffSpeed: spotPct,                 // 钓点钓速增益（%，最终乘算）
    rawSpeed: Math.round((rodEff) * 10) / 10,
    effSpeed: Math.round(rodEff * 10) / 10, // 钓竿 + 全服加成（已按上限截断）
    spotMult: Math.round((1 - Math.max(-100, Math.min(95, spotPct)) / 100) * 1000) / 1000,
    intervalMs: spot && spot.intervalMs != null && spot.intervalMs !== '' ? Math.round(Number(spot.intervalMs)) : null,
    interval: interval,                 // 当前实际抛竿间隔
    biteRate: biteRate,                 // 当前实际上鱼率（%）：钓点覆盖优先，否则全服公式
    biteOverride: override != null,     // 是否来自钓点独立配置
  };
}

// 钓点增益并入总加成（管理员在后台为钓场/钓点配置，类别同词缀：speed/big/rare/material/size/double）
// 说明：这里的 speed 合计只用于「公式变量」与其它加成；抛竿间隔走 intervalFor()，
// 其中钓点钓速是最终乘算（不与钓竿词缀/全服加成相加）。
function mergedEffOf(bd, spot) {
  const eff = bdEffectsOf(bd);
  ((spot && spot.buffs) || []).forEach(function (b) {
    if (b && eff[b.type] != null) eff[b.type] += Number(b.value) || 0;
  });
  return eff;
}
// 大鱼/稀有/材料加成：按类别放大掉落池权重；后台「产出倍率」dropCfg 同层叠加（全局 × 分类，组件只吃全局）
function boostPoolOf(pool, eff) {
  const hasBoost = !!(eff.big || eff.rare || eff.material);
  if (!hasBoost && dropCfgIsDefault()) return pool;
  const dc = dropCfg();
  return pool.map(function (e) {
    const i = e.pick.indexOf(':');
    const type = e.pick.slice(0, i), id = e.pick.slice(i + 1);
    let mult = dc.global / 100;
    if (type === 'fish') {
      const tier = D.fishTierOf(id);
      if (tier === 'big') mult *= (dc.big / 100) * (1 + eff.big / 100);
      else if (tier === 'rare') mult *= (dc.rare / 100) * (1 + eff.rare / 100);
      else mult *= dc.common / 100;
    } else if (type === 'material') mult *= (dc.material / 100) * (1 + eff.material / 100);
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
// 前十榜更新判定：返回 { changed, rank }（changed = 该玩家新进榜或成绩被刷新）
function upsertTopRanked(list, entry, keepSmall) {
  const prev = list.find(function (x) { return x.who === entry.who; }) || null;
  upsertTop(list, entry, keepSmall);
  const changed = !prev || (keepSmall ? entry.size < prev.size : entry.size > prev.size);
  const rank = list.findIndex(function (x) { return x.who === entry.who; }) + 1;
  return { changed: changed, rank: rank, top: keepSmall ? 'small' : 'big' };
}
// 榜单播报文案（全部鱼种 / 全部榜单）：按重要性取一条播报
//   1 全场最大纪录被破 · 2 该鱼种最大/最小纪录 · 3 前十大更新 · 4 前十小更新
function boardAnnouncement(o) {
  if (o.globalMax) return { level: 1, text: '🎉 全场最大纪录被破！' + o.who + ' 钓到 ' + o.name + ' ' + o.size + 'cm' };
  if (o.record) return { level: 2, text: '🏆 ' + o.name + ' 全服最大纪录刷新：' + o.who + ' ' + o.size + 'cm' };
  if (o.small) return { level: 2, text: '🏆 ' + o.name + ' 全服最小纪录刷新：' + o.who + ' ' + o.size + 'cm' };
  if (o.topBig) return { level: 3, text: '📊 ' + o.name + ' 前十大更新：' + o.who + ' ' + o.size + 'cm（第 ' + o.topBig + ' 名）' };
  if (o.topSmall) return { level: 4, text: '📊 ' + o.name + ' 前十小更新：' + o.who + ' ' + o.size + 'cm（第 ' + o.topSmall + ' 名）' };
  return null;
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
  let topBigRank = 0, topSmallRank = 0; // 本次进入/刷新的前十榜名次（>0 表示榜单有更新）
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
    // 全服前十大捕获（记录页点开查看；每人只保留一条最大）——榜单有更新即播报
    const top = (world.topCatches[item.id] = world.topCatches[item.id] || []);
    const topRes = upsertTopRanked(top, { size: size, who: rec.name, t: Date.now() }, false);
    if (topRes.changed) topBigRank = topRes.rank;
    // 全服最小纪录
    const sm = world.smallRecords[item.id];
    if (!sm || size < sm.size) {
      world.smallRecords[item.id] = { id: item.id, name: itemName(item.id), size: size, who: rec.name, t: Date.now() };
      smallEvent = true;
    }
    // 全服前十小捕获（每人只保留一条最小）——同样播报
    const topS = (world.topSmall[item.id] = world.topSmall[item.id] || []);
    const topSRes = upsertTopRanked(topS, { size: size, who: rec.name, t: Date.now() }, true);
    if (topSRes.changed) topSmallRank = topSRes.rank;
  }

  const entry = { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null };
  // 通知等级过滤：只影响全服动态（feed 广播/历史/近期渔获），钓者自己的定向推送不受影响
  const visible = feedVisible(item, recordEvent || smallEvent);
  if (visible) {
    feed.unshift(entry); if (feed.length > 60) feed.pop();
    broadcast({ type: 'feed', entry: entry });
  }

  // 近期渔获（非普通渔获/组件）：更新 presence 并广播给所有人
  const p = players.get(key);
  if (p && visible && (item.kind === 'component' || (item.kind === 'fish' && item.rarity !== 'common'))) {
    p.recent = item.size ? (item.name + ' ' + item.size + 'cm') : item.name;
    sendPlayersAll();
  }
  saveAccount(key);
  // 任意榜单更新（全场最大 / 该鱼种纪录 / 前十大 / 前十小）都向上方横幅播报（覆盖所有鱼种）
  const board = boardAnnouncement({
    who: rec.name, name: itemName(item.id), size: (item.size != null ? (Math.round(item.size * 10) / 10) : null),
    globalMax: !!globalRecord, record: !!recordEvent, small: !!smallEvent, topBig: topBigRank, topSmall: topSmallRank,
  });
  if (board) broadcast({ type: 'globalRecord', record: Object.assign({}, globalRecord || { id: item.id, name: itemName(item.id), size: item.size, who: rec.name, t: Date.now() }, { text: board.text, level: board.level }) });
  if (recordEvent || smallEvent || globalRecord) {
    saveRecords();
    if (recordEvent || smallEvent) broadcastRecords();
    if (recordEvent && feedVisible(item, true)) broadcast({ type: 'feed', entry: { t: Date.now(), who: rec.name, item: item, ground: ground.name, spot: spot.name, size: item.size || null, record: true } });
  }
  // 定向推送：本条渔获 + 图鉴条目 + 权威资产（前端不持账本）
  sendTo(key, { type: 'catch', entry: entry });
  sendTo(key, { type: 'codex', codex: rec.codex, catchCount: rec.catchCount, entry: { id: codexId, name: itemName(codexId) } });
  sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
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
  // 上钩判断：钓点独立上鱼率优先，否则用全服公式；落空则本竿无收获，定时器继续下一竿
  if (Math.random() * 100 >= biteProbabilityOf(eff, intervalFor(rec, found.spot), found.spot)) return;
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
  const interval = intervalFor(users[key], found.spot);
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
    const interval = intervalFor(users[key], found && found.spot);
    fishingTimers.set(key, setInterval(function () { fishTick(key); }, interval));
  });
}

// 抛竿间隔配置变化：所有正在钓鱼的玩家按新间隔重启循环（钓速加成仍在 fishIntervalOf 内叠加）
function restartAllFishing() {
  players.forEach(function (p, key) {
    if (!p.fishing) return;
    const found = spotOf(p.fishing.groundId, p.fishing.spotId);
    if (!found) { stopFishingSession(key); return; }
    const old = fishingTimers.get(key);
    if (old) clearInterval(old);
    const interval = intervalFor(users[key], found.spot);
    fishingTimers.set(key, setInterval(function () { fishTick(key); }, interval));
  });
}

// ---- 上钩判断公式（管理员可编辑 · 递归下降解析，不用 eval）----
// 每次抛竿掷骰时求值：结果 = 本次上钩概率（%）；未上钩则该竿无收获（定时器继续下一竿）。
// 可用变量：speed/skill/rare/material/size/double（钓竿词缀 + 钓点增益，%）与 interval（抛竿间隔 ms）。
//   skill = 「技巧」词缀合计，是提升上钩率的主参数——**钩率提示只由这里的公式决定**，
//   代码里不写死「技巧 = +X% 上钩率」这类文案，后台随时可以改公式（默认 clamp(90 + skill,0,100)）。
//   big = 旧「大鱼概率」变量，v0.11 起组件不再产出该词缀；保留只为让历史保存过的公式仍能解析（恒为 0）。
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
let biteCompiledFn = null, biteCompiledSrc = null;
function biteProbabilityOf(eff, interval, spot) {
  const override = spotBiteRateOf(spot);
  if (override != null) return override; // 钓点独立上鱼率（后台钓点管理里配置）
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
    p = biteCompiledFn({ speed: eff.speed || 0, skill: eff.skill || 0, big: eff.big || 0, rare: eff.rare || 0, material: eff.material || 0, size: eff.size || 0, double: eff.double || 0, interval: interval || 0 });
  } catch (e) { return 100; }
  if (!isFinite(p)) p = p > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, p));
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
  return list.filter(function (b) { return b && D.BUFF_LABEL[b.type]; }).map(function (b) {
    const v = Math.round((Number(b.value) || 0) * 10) / 10;
    return { type: b.type, value: Math.max(BUFF_VALUE_MIN, Math.min(BUFF_VALUE_MAX, v)) };
  });
}
function validateBuffList(list) {
  if (!Array.isArray(list)) return { error: '增益格式错误' };
  const out = [];
  for (const b of list) {
    const type = String((b && b.type) || '');
    if (!D.BUFF_LABEL[type]) return { error: '未知增益类别：' + type };
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

// ---- 自动售出（玩家自助规则，仅渔获；规则存在账号上）----
// rec.autoSell = { all: {minPct,minPrice}|null, fish: { <鱼id>: {minPct,minPrice} } }
// 单鱼规则优先于「全部鱼」；minPct=基准价的百分比线，minPrice=绝对价格线，两线任一达到即卖。
// 触发时机：钓到鱼入包后 / 每分钟价格采样（价格回升越过阈值）/ 登录时。
// 出售走与手动 /api/sell 完全相同的经济路径（单乘数下压、今日售出、交易流水），行情一致。
function autoSellRuleOf(rec, id) {
  const a = rec.autoSell || {};
  const own = (a.fish || {})[id];
  if (own) return own;
  return a.all || null;
}
function autoSellHit(rec, id) {
  const rule = autoSellRuleOf(rec, id);
  if (!rule) return null;
  const base = basePrice(id);
  const price = currentPrice(id);
  // 浮动接受值（slack）：行情在阈值附近回落时，允许提前「阈值 − 浮动」成交，避免错过；
  // 有效线最低钳到 1（百分比 1% / 价格 1💰），用户填多大浮动都不会变成无条件卖出。
  const pctLine = rule.minPct != null ? Math.max(1, rule.minPct - (Number(rule.slackPct) || 0)) : null;
  const priceLine = rule.minPrice != null ? Math.max(1, rule.minPrice - (Number(rule.slackPrice) || 0)) : null;
  const pctOk = pctLine != null && base > 0 && price >= base * pctLine / 100;
  const priceOk = priceLine != null && price >= priceLine;
  return (pctOk || priceOk) ? { price: price, base: base, by: pctOk ? '基准' : '价格' } : null;
}
// 扫描背包里满足规则的鱼并按系统行情卖出；返回本次售出明细（无则 null）
function autoSellCheck(key) {
  const rec = users[key];
  if (!rec || !rec.autoSell) return null;
  const sold = [];
  Object.keys(rec.inventory || {}).forEach(function (id) {
    if (!FISH_ID_SET[id]) return;                       // 仅渔获
    const have = (rec.inventory[id] || 0);
    if (have <= 0 || sold.some(function (x) { return x.id === id; })) return;
    const hit = autoSellHit(rec, id);
    if (!hit) return;
    const qty = have;
    const unit = unitPriceOf(id);
    const gain = unit * qty;
    invAdd(rec, id, -qty);
    rec.coins += gain;
    if (ECO_PRICE[id]) registerSale(id, qty, rec.name + '·自动', unit);
    sold.push({ id: id, name: itemName(id), qty: qty, unit: unit, gain: gain, by: hit.by });
  });
  if (!sold.length) return null;
  saveAccount(key); saveEconomy(); broadcastShop();
  const total = sold.reduce(function (s, x) { return s + x.gain; }, 0);
  sendTo(key, { type: 'notice', msg: '🤖 自动售出 ' + sold.map(function (x) { return x.name + '×' + x.qty; }).join('、') +
    '，+ ' + total + '💰（' + sold[0].by + '线达标）' });
  sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
  return sold;
}

// ---- 市集挂单规则：每人最多同时 40 个挂单；时长 6/12/24 小时对应费率 1%/3%/5%，过期退物品不退费 ----
const MAX_LISTINGS_PER_PLAYER = 40;
const LIST_FEE_RATES = { 6: 0.01, 12: 0.03, 24: 0.05 };
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
const ECONOMY_KEYS = ['shopSales', 'priceLog', 'tradeLog', 'marketLog', 'priceOv', 'economyLog'];
const CONFIG_KEYS = ['groundCfg', 'notifyLevel', 'biteFormula', 'doubleBase', 'componentCfg', 'fishCfg', 'bannerSeq', 'banners', 'bannerCfg', 'feedbackCfg', 'castCfg', 'priceCfg', 'dropCfg', 'chestCfg', 'mallCfg', 'smeltCfg', 'recordsCfg'];
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
loadSessions(); // 重启后恢复登录态（客户端可自动登录，见 sessionGet 注释）
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
  if (accountsDirty || marketDirty || econDirty) console.log('[migrate] legacy component ids → v0.8 instance signatures');
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

function hashPw(pw, salt) { return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex'); }
function newToken() { return crypto.randomBytes(16).toString('hex'); }
function profileOf(key) {
  const rec = users[key];
  return {
    username: rec.username, name: rec.name, coins: rec.coins, qq: rec.qq || '',
    inventory: rec.inventory || {}, bd: rec.bd || {},
    codex: rec.codex || {}, catchCount: rec.catchCount || 0,
    admin: !!rec.admin,
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
  const key = d.token && sessionGet(d.token);
  if (!key) return apiResp(res, 401, { error: '未登录' });
  cb(d, key);
}
function invAdd(rec, id, qty) { rec.inventory = rec.inventory || {}; rec.inventory[id] = (rec.inventory[id] || 0) + qty; if (rec.inventory[id] <= 0) delete rec.inventory[id]; }
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
        if (D.isRodSet(l.id)) deliverRodBack(seller, l.id, l.name);
        else invAdd(seller, l.id, l.qty);
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
      const token = newToken(); sessionSet(token, key);
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
      const token = newToken(); sessionSet(token, key);
      apiResp(res, 200, { token: token, profile: profileOf(key) });
    });
    return;
  }

  // ---- 登出：使该 token 失效并断开实时连接 ----
  if (p === '/api/logout' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { d = {}; }
      const token = d.token || u.query.token;
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
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录或会话失效' });
    try { autoSellCheck(key); } catch (e) {}  // 读档即触发：离线期间价格回升越过阈值的情况
    return apiResp(res, 200, profileOf(key));
  }

  // ---- 保存显示名（资产/背包/配置一律由服务器维护，不再接受客户端上报） ----
  if (p === '/api/profile' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
      // 服务器版本：客户端据此判断自己是不是旧前端。重启换版本后 SSE 会自动重连，
      // 这条 init 就是「服务器已更新」的最快信号（比定时轮询快得多）。
      version: D.VERSION,
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, slot: slot, bd: rec.bd, rodName: rec.rodName, rodActiveSlot: rec.rodActiveSlot,
          inventory: rec.inventory, rodSlots: rodSlotView(rec), rodLocked: rodUsageOf(rec),
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, bd: rec.bd, rodName: rec.rodName, rodActiveSlot: rec.rodActiveSlot, returned: returned,
          inventory: rec.inventory, rodSlots: rodSlotView(rec), rodLocked: rodUsageOf(rec),
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, returned: returned, fromSlot: as, bd: rec.bd, rodName: rec.rodName, rodActiveSlot: -1,
          inventory: rec.inventory, rodSlots: rodSlotView(rec), rodLocked: rodUsageOf(rec),
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, returned: back, wasActive: isActive, rodActiveSlot: rec.rodActiveSlot,
          rodSlots: rodSlotView(rec), inventory: rec.inventory, rodLocked: rodUsageOf(rec),
        });
      });
    });
    return;
  }

  // ---- 停止钓鱼 ----
  if (p === '/api/fishing/stop' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const key = d.token && sessionGet(d.token);
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
          interval = intervalFor(rec, found && found.spot);
          fishingTimers.set(key, setInterval(function () { fishTick(key); }, interval));
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
        apiResp(res, 200, { ok: true, bd: rec.bd, effects: bdEffectsOf(rec.bd), interval: interval, inventory: rec.inventory,
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
          if (dTop.changed) topBigRankDev = dTop.rank;
          const smD = world.smallRecords[itemId];
          if (!smD || rsize < smD.size) {
            world.smallRecords[itemId] = { id: itemId, name: itemName(itemId), size: rsize, who: rec.name, t: Date.now() };
            smallEventDev = true;
          }
          const dTopS = upsertTopRanked((world.topSmall[itemId] = world.topSmall[itemId] || []), { size: rsize, who: rec.name, t: Date.now() }, true);
          if (dTopS.changed) topSmallRankDev = dTopS.rank;
        }
        const entry = { t: Date.now(), who: rec.name, item: Object.assign({}, d.item, { id: itemId }, isFinite(size) && size > 0 ? { size: Math.round(size * 10) / 10 } : {}), ground: d.ground, spot: d.spot, size: isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null };
        feed.unshift(entry); if (feed.length > 60) feed.pop();
        broadcast({ type: 'feed', entry: entry });
        saveAccount(key);
        // 与线上一致：任意榜单更新都播报
        const boardDev = boardAnnouncement({
          who: rec.name, name: itemName(itemId), size: (isFinite(size) && size > 0 ? Math.round(size * 10) / 10 : null),
          globalMax: !!globalRecordDev, record: !!recordEvent, small: smallEventDev, topBig: topBigRankDev, topSmall: topSmallRankDev,
        });
        if (boardDev) broadcast({ type: 'globalRecord', record: Object.assign({}, globalRecordDev || { id: itemId, name: itemName(itemId), size: size, who: rec.name, t: Date.now() }, { text: boardDev.text, level: boardDev.level }) });
        if (recordEvent || smallEventDev || globalRecordDev) {
          saveRecords();
          if (recordEvent || smallEventDev) broadcastRecords();
        }
        if (recordEvent) broadcast({ type: 'feed', entry: { t: Date.now(), who: rec.name, item: entry.item, ground: entry.ground, spot: entry.spot, size: entry.size, record: true } });
        // 与线上一致：定向推送本条渔获，主界面渔获日志才能随上鱼滚动刷新
        sendTo(key, { type: 'catch', entry: entry });
        sendTo(key, { type: 'codex', codex: rec.codex, catchCount: rec.catchCount, entry: { id: codexId, name: itemName(codexId) } });
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        maybeSendSubAlert(rec, key, itemMeta);
        // 与线上一致：模拟的是一次真实上鱼 → 若满足玩家的自动售出规则，同样立即卖出
        try { autoSellCheck(key); } catch (e) {}
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
        let qty = Math.floor(Number(d.qty) || 1);
        if (!isFinite(qty) || qty < 1) qty = 1;
        if (qty > 99) qty = 99; // 单次批量上限：避免误点把残片一次清光
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, chestId: chest.id, qty: qty, coins: rec.coins,
          inventory: rec.inventory, chests: chestViewList(rec),
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        // 突破件全服播报（复用纪录横幅轨）：稀有度足够高，是免费的内容运营素材
        if (item.breakthrough) {
          broadcast({
            type: 'globalRecord',
            record: { level: 2, who: rec.name, name: item.name, t: Date.now(),
              text: '🎁 ' + rec.name + ' 从「' + chest.name + '」打捞出神话突破件：' + item.name + '（4 词条）' },
          });
        }
        apiResp(res, 200, {
          ok: true, chestId: chest.id, chestName: chest.name, item: item, coins: rec.coins,
          inventory: rec.inventory, forced: forced,
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
        let qty = Math.floor(Number(d.qty) || 1);
        if (!isFinite(qty) || qty < 1) qty = 1;
        if (qty > MALL_MAX_QTY) qty = MALL_MAX_QTY;
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        const next = mallView(rec);
        apiResp(res, 200, {
          ok: true, id: item.id, name: item.name, qty: qty, cost: cost, coins: rec.coins,
          inventory: rec.inventory, mall: next,
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
      // 重铸：默认只收「沉船宝匣残片」，数量与金币由后台「⚒ 工坊配置」决定；
      // 客户端据此在放入组件后自动列出所需材料（目前只有残片这一种）。
      recast: {
        quality: D.RECAST_QUALITY, qualityName: (D.QUALITY[D.RECAST_QUALITY] || {}).name || D.RECAST_QUALITY,
        relicId: 'relic', relicName: itemName('relic'),
        relicNeed: Math.max(0, Math.floor(Number(cfg.recastRelic) || 0)),
        relicHave: invCountOf(rec, 'relic'),
        gold: Math.max(0, Math.floor(Number(cfg.recastGold) || 0)),
        minValue: !!cfg.recastMinValue,
      },
    });
  }
  // ---- 工坊 · 熔炼：执行（服务器掷骰；失败只损失副件与材料，主件保持原样） ----
  if (p === '/api/workshop/smelt' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const plan = planSmelt(rec, d);
        if (plan.error) return apiResp(res, 400, { error: plan.error });
        const base = D.componentBase(plan.mainMeta.baseId);
        const useBoundary = plan.rollBoundary;
        const success = Math.random() * 100 < plan.rates.rate;
        // 资源先扣（成功与否都消耗：副件被熔毁、材料烧掉、金币花掉）
        rec.coins -= plan.gold;
        invAdd(rec, plan.subId, -1);
        plan.consume.forEach(function (e) { invAdd(rec, e.id, -1 * e.qty); });
        let result = null, extraOk = false;
        if (success) {
          const affixes = [];
          affixes.push({ type: plan.mainAffix.type, value: smeltRoll(smeltRangeFor(base, plan.mainAffix.type), useBoundary) });
          affixes.push({ type: plan.subAffix.type, value: smeltRoll(smeltRangeFor(base, plan.subAffix.type), useBoundary) });
          if (plan.extraType) {
            extraOk = Math.random() * 100 < plan.rates.extraRate;
            if (extraOk) affixes.push({ type: plan.extraType, value: smeltRoll(smeltRangeFor(base, plan.extraType), useBoundary) });
          }
          invAdd(rec, plan.mainId, -1);
          const newId = D.instanceId(base.id, plan.mainMeta.quality, affixes);
          invAdd(rec, newId, 1);
          result = D.componentOf(newId);
        }
        try { syncActiveRodSlot(rec); } catch (e) {}
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, success: success, extraOk: extraOk,
          rate: plan.rates.rate, extraRate: plan.rates.extraRate, gold: plan.gold,
          pearl: plan.pearl, rollBoundary: useBoundary,
          load: plan.load, extraType: plan.extraType,
          mainId: plan.mainId, subId: plan.subId, item: result,
          coins: rec.coins, inventory: rec.inventory,
        });
      });
    });
    return;
  }
  // ---- 工坊 · 重铸：用残片重 roll 神话件的全部词条数值（服务器掷骰） ----
  if (p === '/api/workshop/recast' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const plan = planRecast(rec, d.id);
        if (plan.error) return apiResp(res, 400, { error: plan.error });
        const rolled = D.recastAffixes(plan.meta.baseId, plan.meta.affixes);
        if (!rolled || !rolled.length) return apiResp(res, 400, { error: '该组件没有可重铸的词条' });
        const before = plan.meta.affixes.map(function (a) { return { type: a.type, value: a.value }; });
        // 先扣材料与金币，再换件（新旧签名相同时也要走一遍「扣一件、加一件」）
        invAdd(rec, plan.relicId, -plan.relicNeed);
        if (plan.gold) rec.coins -= plan.gold;
        invAdd(rec, plan.meta.id, -1);
        const newId = D.instanceId(plan.meta.baseId, plan.meta.quality, rolled);
        invAdd(rec, newId, 1);
        try { syncActiveRodSlot(rec); } catch (e) {}
        saveAccount(key);
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
        apiResp(res, 200, {
          ok: true, changed: newId !== plan.meta.id,
          before: before, item: D.componentOf(newId), id: newId,
          gold: plan.gold, relicNeed: plan.relicNeed,
          materials: [{ id: plan.relicId, name: itemName(plan.relicId), need: plan.relicNeed, have: invCountOf(rec, plan.relicId) }],
          coins: rec.coins, inventory: rec.inventory,
        });
      });
    });
    return;
  }
  if (p === '/api/sell' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const id = d.id; const qty = Math.max(1, Math.floor(Number(d.qty) || 1));
        if (D.isRodSet(id)) return apiResp(res, 400, { error: '整根钓竿请到「开放市集」出售（系统商店不收购）' });
        if (D.isChest(id)) return apiResp(res, 400, { error: '宝匣请到「开放市集」出售（系统商店不收购）' });
        if (!sellableOf(id)) return apiResp(res, 400, { error: '该物品无法出售' });
        const rodLock = rodLockError(rec, id, qty);
        if (rodLock) return apiResp(res, 400, { error: rodLock });
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

  // ---- 自动售出规则：读取 / 设置（玩家自助，仅渔获） ----
  // 规则：scope='all' 为全部鱼；scope=鱼id 为单鱼（优先于全部鱼）。
  // minPct=基准价百分比线（如 150 = 基准的 150%），minPrice=绝对价格线；两线任一达到即卖，都空 = 清除该规则。
  if (p === '/api/autosell' && req.method === 'GET') {
    const key = u.query.token && sessionGet(u.query.token);
    if (!key) return apiResp(res, 401, { error: '未登录' });
    const rec = users[key];
    return apiResp(res, 200, { ok: true, all: (rec.autoSell && rec.autoSell.all) || null, fish: (rec.autoSell && rec.autoSell.fish) || {} });
  }
  if (p === '/api/autosell' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const scope = String(d.scope || '');
        const clean = function (v, max) {
          if (v == null || v === '') return null;
          const n = Math.floor(Number(v));
          return (isFinite(n) && n > 0 && n <= max) ? n : NaN;
        };
        const minPct = clean(d.minPct, 1000000);
        const minPrice = clean(d.minPrice, 1e9);
        // 浮动接受值：允许 0（不浮动）；为非负数
        const cleanSlack = function (v, max) {
          if (v == null || v === '') return 0;
          const n = Math.floor(Number(v));
          return (isFinite(n) && n >= 0 && n <= max) ? n : NaN;
        };
        const slackPct = cleanSlack(d.slackPct, 1000000);
        const slackPrice = cleanSlack(d.slackPrice, 1e9);
        if (isNaN(minPct) || isNaN(minPrice) || isNaN(slackPct) || isNaN(slackPrice)) {
          return apiResp(res, 400, { error: '阈值需为正整数，浮动需为非负数' });
        }
        rec.autoSell = rec.autoSell || { fish: {} };
        if (!rec.autoSell.fish) rec.autoSell.fish = {};
        if (scope === 'all') {
          if (minPct == null && minPrice == null) delete rec.autoSell.all;
          else rec.autoSell.all = { minPct: minPct, minPrice: minPrice, slackPct: slackPct, slackPrice: slackPrice };
        } else {
          if (!FISH_ID_SET[scope]) return apiResp(res, 400, { error: '未知鱼类：' + scope });
          if (minPct == null && minPrice == null) delete rec.autoSell.fish[scope];
          else rec.autoSell.fish[scope] = { minPct: minPct, minPrice: minPrice, slackPct: slackPct, slackPrice: slackPrice };
        }
        saveAccount(key);
        const sold = (function () { try { return autoSellCheck(key); } catch (e) { return null; } })();
        apiResp(res, 200, { ok: true, all: rec.autoSell.all || null, fish: rec.autoSell.fish || {},
          sold: sold || null, coins: rec.coins, inventory: rec.inventory, shop: shopSnapshot() });
      });
    });
    return;
  }

  // ---- 开放市集：上架 / 购买 / 下架 ----
  if (p === '/api/market/list' && req.method === 'POST') {
    readBody(req, function (body) {
      auth(req, res, body, function (d, key) {
        const rec = users[key];
        const price = Math.max(1, Math.floor(Number(d.price) || 0));
        // 整根钓竿上架：来源是钓竿槽位（整体卖出，组件随挂单走）
        let id = null, qty = 1, rodFrom = -1;
        if (d.rodSlot != null) {
          rodFrom = Math.floor(Number(d.rodSlot));
          const sl = rodSlotsOf(rec)[rodFrom];
          if (!sl) return apiResp(res, 400, { error: '该槽位没有已保存的钓竿' });
          id = D.rodSetId(rodPartsOfBd(sl.bd));
          if (!id) return apiResp(res, 400, { error: '该钓竿没有装配任何组件' });
        } else {
          id = D.normalizeItemId(d.id);
          qty = Math.max(1, Math.floor(Number(d.qty) || 1));
        }
        if (!sellableOf(id)) return apiResp(res, 400, { error: '该物品不可上架' });
        if (rodFrom < 0) {
          const rodLock = rodLockError(rec, id, qty);
          if (rodLock) return apiResp(res, 400, { error: rodLock });
          if (!invHas(rec, id, qty)) return apiResp(res, 400, { error: '数量不足' });
        }
        sweepExpiredListings();
        const myCount = world.listings.filter(function (l) { return l.seller === key; }).length;
        if (myCount >= MAX_LISTINGS_PER_PLAYER) return apiResp(res, 400, { error: '挂单数量已达上限（每人最多同时 ' + MAX_LISTINGS_PER_PLAYER + ' 个）' });
        const hours = [6, 12, 24].indexOf(Number(d.hours)) >= 0 ? Number(d.hours) : 6;
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
        apiResp(res, 200, { ok: true, listing: listing, inventory: rec.inventory, fee: fee, coins: rec.coins, rodSlots: rodSlotView(rec) });
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
          if (!id || D.isRodSet(id) || !sellableOf(id) || qty <= 0) continue;
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
    return apiResp(res, 200, {
      version: D.VERSION, build: D.BUILD,
      componentCfg: D.getComponentCfg ? D.getComponentCfg() : null,
      fishCfg: D.getFishCfg ? D.getFishCfg() : null,
      // 抛竿间隔与全服钓速配置：前端据此展示「后台基础值 + 实际钓速」（改动经 castcfg 广播同步）
      castCfg: { baseMs: castBaseMs(), minMs: castMinMs(), speedBonus: castSpeedBonus(), speedCap: castSpeedCap() },
      // 经济参数（商店文案与容量提示用；改动经 pricecfg 广播同步）
      priceCfg: priceCfg(),
      dropCfg: dropCfg(),
      // 宝匣配置（突破保底次数 + 各档位合成成本）：宝匣页据此显示成本与保底进度
      chestCfg: chestCfgOf(),
      // 工坊熔炼参数（成功率/花费系数）：工坊页据此展示预览；改动经 smeltcfg 广播同步
      smeltCfg: smeltCfgOf(),
      // 渔获记录贴图（全场最大鱼图标的缩放 / 偏移）：改动经 recordscfg 广播同步
      recordsCfg: recordsCfgOf(),
      // 版本更新进行中（60 秒通知横幅）：后连进来的客户端也能看到倒计时
      update: updateStateView(),
    });
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
        sendTo(key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
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
      const token = newToken(); sessionSet(token, key);
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
      playing: bannerPlayingView(),
      online: players.size,
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
      world.bannerCfg = Object.assign({ blink: false, blinkTitle: '📢 有新公告', noticeColor: '' }, world.bannerCfg || {});
      if (d.blink != null) world.bannerCfg.blink = !!d.blink;
      if (d.noticeColor !== undefined) {
        const nc = validBannerColor(d.noticeColor);
        if (nc === null) return apiResp(res, 400, { error: '公告默认颜色需为 #RGB 或 #RRGGBB 格式' });
        world.bannerCfg.noticeColor = nc;
      }
      if (d.blinkTitle != null) world.bannerCfg.blinkTitle = String(d.blinkTitle).slice(0, 40);
      saveConfig();
      broadcast({ type: 'banner', banners: world.banners || [], cfg: world.bannerCfg });
      apiResp(res, 200, { ok: true, cfg: world.bannerCfg });
    });
    return;
  }
  // 修改已发布横幅（颜色 / 内容 / 时长）
  if (p === '/api/admin/banner/update' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
  // ---- 反馈奖励：给提交反馈的玩家发金币（可附备注），并通知玩家 ----
  if (p === '/api/admin/feedback/reward' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
      sendTo(item.key, { type: 'assets', coins: rec.coins, inventory: rec.inventory, codex: rec.codex, catchCount: rec.catchCount });
      apiResp(res, 200, { ok: true, id: item.id, reward: item.reward, playerCoins: rec.coins });
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
      affixTypes: D.AFFIX_LABEL,        // 组件词缀（6 类，「技巧」在此）
      buffTypes: D.BUFF_LABEL,          // 钓点增益（比组件词缀多一类「大鱼概率」）
      quality: D.QUALITY,
      notifyLevel: world.notifyLevel || 'all',
      notifyLevels: NOTIFY_LEVELS,
      biteFormula: world.biteFormula || BITE_FORMULA_DEFAULT,
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
      // ---- 版本更新：候选 .bat 与当前任务 ----
      updateBats: listBatCandidates(),
      updateState: updateStateView(),
      updateBannerMs: UPDATE_BANNER_MS,
      updateGraceMs: UPDATE_GRACE_MS,
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
      let zeroAffixes = 0; // 0 值词条计数（roll=0 已被拒绝重 roll，正常应恒为 0）
      for (let i = 0; i < n; i++) {
        const c = D.rollComponent();
        qDist[c.quality] = (qDist[c.quality] || 0) + 1;
        cDist[c.quality][c.affixes.length] = (cDist[c.quality][c.affixes.length] || 0) + 1;
        c.affixes.forEach(function (af) {
          if (af.value === 0) zeroAffixes++;
          vals[af.type] = vals[af.type] || { sum: 0, n: 0, min: 1e9, max: -1e9 };
          const v = vals[af.type]; v.sum += af.value; v.n++; if (af.value < v.min) v.min = af.value; if (af.value > v.max) v.max = af.value;
        });
      }
      const affixStats = {};
      Object.keys(vals).forEach(function (t) { affixStats[t] = { mean: Math.round((vals[t].sum / vals[t].n) * 10) / 10, min: vals[t].min, max: vals[t].max }; });
      apiResp(res, 200, { ok: true, n: n, quality: qDist, count: cDist, affix: affixStats, zeroAffixes: zeroAffixes });
    });
    return;
  }
  // ---- 鱼类体型 roll 模型：保存（默认正态；影响全服上鱼体型与大小鱼榜，即时生效） ----
  if (p === '/api/admin/fish/config' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
  // ---- 掉落池一键填充预设：返回条目列表（前端填入草稿，仍走原「保存掉落池」流程）----
  if (p === '/api/admin/pool/preset' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
        if (D.isRodSet(l.id)) deliverRodBack(seller, l.id, l.name);
        else invAdd(seller, l.id, l.qty);
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
  // ---- 商城配置：商品（物品 / 金币价 / 每日限购）+ 限购刷新时间 ----
  // 保存后：玩家端商城的商品、价格、限购与下次刷新时间立即同步（broadcast mallcfg）。
  if (p === '/api/admin/mall/config' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
  // ---- 工坊熔炼配置：成功率 / 投料系数 / 金币花费 ----
  if (p === '/api/admin/smelt/config' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      const RANGES = {
        baseRate: [0, 100], failPerMaterial: [-50, 50], extraRatePerMaterial: [0, 100], extraRatePearl: [0, 100],
        extraRateMax: [0, 100], rateMin: [0, 100], rateMax: [0, 100],
        goldBase: [0, 100000000], goldPerMaterial: [0, 10000000], goldPearl: [0, 100000000],
        maxMaterials: [0, 99], maxTypes: [0, 8],
        recastRelic: [0, 9999], recastGold: [0, 100000000],
      };
      const LABEL = {
        baseRate: '熔炼基础成功率', failPerMaterial: '每份材料对失败率的影响', extraRatePerMaterial: '每份材料的补缀成功率加成',
        extraRatePearl: '龙宫宝珠的补缀成功率加成', extraRateMax: '补缀成功率上限', rateMin: '熔炼成功率下限', rateMax: '熔炼成功率上限',
        goldBase: '基础金币花费', goldPerMaterial: '每份材料金币', goldPearl: '龙宫宝珠金币', maxMaterials: '单次最大投料份数', maxTypes: '单次最大投料种类', recastRelic: '重铸所需残片', recastGold: '重铸所需金币',
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
      if (d.pearlRollTwice != null) patch.pearlRollTwice = !!d.pearlRollTwice;
      if (d.recastMinValue != null) patch.recastMinValue = (d.recastMinValue === true || d.recastMinValue === 1 || d.recastMinValue === '1') ? 1 : 0;
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
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
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
  // ---- 版本更新：候选启动脚本（.bat） ----
  if (p === '/api/admin/update/list' && req.method === 'GET') {
    const a = adminOf(u.query.token);
    if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
    return apiResp(res, 200, { ok: true, bats: listBatCandidates(), root: PROJECT_ROOT, bannerMs: UPDATE_BANNER_MS, graceMs: UPDATE_GRACE_MS, current: updateStateView() });
  }
  // ---- 版本更新：发布 60 秒通知横幅，随后自动切换（dryRun 只走流程不真的拉起新版本/退出） ----
  if (p === '/api/admin/update/start' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      if (updateTask) return apiResp(res, 400, { error: '已有一个更新任务在进行中（可先取消）' });
      const r = resolveBatPath(d.bat);
      if (r.error) return apiResp(res, 400, { error: r.error });
      const note = String(d.note || '').trim().slice(0, 120);
      const task = startUpdateTask({ bat: r.rel, full: r.full, note: note, by: a.name, dryRun: !!d.dryRun });
      econLog(a.name, '发布版本更新：' + r.rel + '（通知 ' + Math.round(UPDATE_BANNER_MS / 1000) + ' 秒后切换）');
      apiResp(res, 200, { ok: true, update: updateStateView(), task: { bat: task.bat, dryRun: task.dryRun } });
    });
    return;
  }
  // ---- 版本更新：取消（横幅立即撤回） ----
  if (p === '/api/admin/update/cancel' && req.method === 'POST') {
    readBody(req, function (body) {
      let d; try { d = JSON.parse(body); } catch (e) { return apiResp(res, 400, { error: '格式错误' }); }
      const a = adminOf(d.token);
      if (!a) return apiResp(res, 403, { error: '需要管理员权限' });
      if (!updateTask) return apiResp(res, 400, { error: '当前没有进行中的更新任务' });
      if (updateTask.phase === 'restarting') return apiResp(res, 400, { error: '已经在切换中，无法取消' });
      clearUpdateTask();
      broadcastUpdate();
      econLog(a.name, '取消版本更新');
      apiResp(res, 200, { ok: true, update: null });
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
          broadcast({ type: 'bitecfg' }); // 通知玩家端刷新「当前上鱼率」显示
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
          const vars = { speed: 0, skill: 0, big: 0, rare: 0, material: 0, size: 0, double: 0, interval: castBaseMs() };
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
