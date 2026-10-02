#!/usr/bin/env node
/**
 * 成长平衡模拟器 —— 把「毕业天数」变成可计算的量。
 *
 * 用途：
 *   1. 校验一套掉落/远航/强化数值是否落在设计区间（小毕业 ≈10 天、全毕业 ≈32 天）。
 *   2. 换地图 / 改数值后的回归工具：改完 catalog 或本文件的 PROPOSED 表，重跑一次即可。
 *      这是「换地图预案」的验收闸：天数出区间就调 tier 模板权重，不动消耗表。
 *
 * 用法：
 *   node tools/balance-sim.js                 # 现状(catalog) vs 提案 对照
 *   node tools/balance-sim.js --profile=idle  # idle | std | hard
 *   SIM_DEBUG=1 node tools/balance-sim.js     # 打印每 10 天的库存水位与卡点
 *
 * 模型口径（改数值前先读懂，这几条是方案的承重假设）：
 *   - 航时是唯一硬通货。每天航时上限由「一趟未领航次 + 时长档」决定，设计锚 = 16 航时/天（2 趟 8h）。
 *   - 8h/12h 带时长效率倍率（长航次单位航时收益更高）→ 鼓励每天两次登录，而不是挂机刷。
 *   - 金币来自「钓鱼 + 航次结算」；装备材料只来自航次。
 *   - 船级是航线前置门槛；XP 只由航时给（2 XP/航时），船级另收深海鳞片与金币。
 *   - 玩家每天按「当前缺口」贪心选航线，2 趟 8h。
 *   - 收益率按成功算（保守：失败只给 ×0.5，会让实际天数更慢，属于安全边）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-go/internal/rules/catalog.json'), 'utf8'));
const C = catalog.constants;

// ───────────────────────── 玩家档位 ─────────────────────────

const PROFILES = {
  idle: { name: '休闲', hoursPerDay: 8, castsPerDay: 250, note: '1 趟 8h · 每天半小时' },
  std: { name: '标准', hoursPerDay: 16, castsPerDay: 800, note: '2 趟 8h · 每天约 2 小时' },
  hard: { name: '硬核', hoursPerDay: 24, castsPerDay: 2000, note: '3 趟 8h · 每天 4 小时+' },
};

// ───────────────────── 钓鱼收入（金币/竿） ─────────────────────

// 只算可卖物；保留类（船/锚地/门票用的鳞片、熔炼用的宝珠）不计入金币收入。
const KEEP = new Set(['deepscale', 'dragonpearl']);
const SIZE_BONUS = 1.15; // 体型加成 large+50%/giant+150% 的粗估期望抬升

function sellPriceOf(id) {
  for (const g of ['common', 'big', 'rare']) {
    const f = (C.FISH[g] || []).find((x) => x.id === id);
    if (f) return f.price;
  }
  const m = (C.MATERIALS || []).find((x) => x.id === id);
  if (m) return KEEP.has(id) ? 0 : (m.price || 0);
  return 0;
}

function coinsPerCast(spot) {
  let wsum = 0, gold = 0;
  for (const e of spot.pool || []) {
    const w = e.weight || 0;
    wsum += w;
    const [kind, id] = String(e.pick || '').split(':');
    if ((kind === 'fish' || kind === 'material') && id) gold += w * sellPriceOf(id);
  }
  return wsum ? (gold / wsum) * SIZE_BONUS : 0;
}

const allSpots = () => C.GROUNDS.flatMap((g) => g.spots);

/** 钓点每竿的保留类材料掉落率（鳞片/宝珠是船级与熔炼货币，必须计入产出） */
function keepRates(spot) {
  let wsum = 0;
  for (const e of spot.pool || []) wsum += e.weight || 0;
  const r = {};
  for (const e of spot.pool || []) {
    const [kind, id] = String(e.pick || '').split(':');
    if (kind === 'material' && id && KEEP.has(id)) r[id] = (r[id] || 0) + (e.weight || 0) / wsum;
  }
  return r;
}



// 提案金币阶梯：金币期望由「解锁门槛」唯一决定，单调递增。
// 现状的问题：13 个钓点里 12 个建号即解锁（只有 ice 是 locked），而期望完全乱序——
// 无门槛的 wreck 243 金/竿 > 需船 Lv3 的 reef 187 金/竿 → 升船在收益上毫无意义。
const PROPOSED_TIER = {
  dock: 1, reed: 1, estuary: 1, beach: 1,
  harbor: 2, falls: 2,
  deep: 3, ice: 3, lighthouse: 3, wreck: 3,
  shore: 4, reef: 4,
  trench: 5,
};
const PROPOSED_TIER_EV = { 1: 10, 2: 18, 3: 30, 4: 48, 5: 85 };
const PROPOSED_TIER_KEEP = { 1: {}, 2: {}, 3: { deepscale: 0.019 }, 4: { deepscale: 0.055 }, 5: { deepscale: 0.06, dragonpearl: 0.012 } };
// 单一口径的解锁门槛：累计渔获（时间型，买不到）+ 船级（远洋）。
// 不变量：门槛更难的钓点，金币期望必须不低于门槛更易的钓点 —— 由校验器强约束。
const PROPOSED_GATE = {
  dock: 0, reed: 150, estuary: 350, beach: 600,
  harbor: 1000, falls: 1600,
  deep: 2400, ice: 2600, lighthouse: 3400, wreck: 4500,
  shore: 5500, reef: 8000, trench: 12000,
};

// ───────────────────── 里程碑与采购队列 ─────────────────────

const MILESTONES = [
  { key: 'T1', name: '小毕业', lv: 6, sets: 1, setStage: 2, specs: 1, specStage: 2, engrave: 0, ship: 3, target: 10 },
  { key: 'T2', name: '中毕业', lv: 9, sets: 2, setStage: 3, specs: 2, specStage: 3, engrave: 0, ship: 4, target: 20 },
  { key: 'T3', name: '全毕业', lv: 12, sets: 4, setStage: 3, specs: 4, specStage: 3, engrave: 5, ship: 5, target: 32 },
];

const PARTS = 5; // 五个普通部位：鱼线 / 鱼钩 / 拟饵 / 卷线器 / 配件

function buildQueue(cfg) {
  const q = [];
  const ms = cfg.milestones;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    const prev = ms[i - 1] || { lv: 0, sets: 0, setStage: 0, specs: 0, specStage: 0, engrave: 0, ship: 1 };
    for (let lv = prev.ship; lv < m.ship; lv++) q.push({ tag: `${m.key}:船→Lv${lv + 1}`, ship: lv + 1, cost: { deepscale: cfg.shipScale[lv], coins: cfg.shipCoins[lv] } });
    for (let p = 0; p < PARTS; p++)
      for (let lv = prev.lv; lv < m.lv; lv++) q.push({ tag: `${m.key}:部位+${lv + 1}`, cost: cfg.upgrade[lv] });
    for (let s = 0; s < m.sets; s++) {
      if (s >= prev.sets) q.push({ tag: `${m.key}:第${s + 1}套 兑换`, cost: { marks: cfg.setMarks } });
      if (s >= cfg.freeSets) { /* 首套免费：仅第 1 套免兑换 */
      }
      for (let st = s < prev.sets ? prev.setStage : 0; st < m.setStage; st++)
        q.push({ tag: `${m.key}:第${s + 1}套 阶${st + 1}`, cost: cfg.setStage[st] });
    }
    for (let s = 0; s < m.specs; s++) {
      if (s >= prev.specs) q.push({ tag: `${m.key}:专精${s + 1} 认证`, cost: cfg.specUnlock });
      for (let st = s < prev.specs ? prev.specStage : 0; st < m.specStage; st++)
        q.push({ tag: `${m.key}:专精${s + 1} 阶${st + 1}`, cost: cfg.specStage[st] });
    }
    for (let e = prev.engrave; e < m.engrave; e++) q.push({ tag: `${m.key}:精工${e + 1}`, cost: cfg.engrave });
  }
  // 首套免费：把第 1 套的「兑换」条目去掉
  if (cfg.freeSets > 0) {
    const idx = q.findIndex((x) => x.tag === 'T1:第1套 兑换');
    if (idx >= 0) q.splice(idx, 1);
  }
  return q;
}

// ───────────────────── 现状（读 catalog 真值） ─────────────────────

function currentConfig() {
  const E = C.EXPEDITION, gs = C.GEAR_SYSTEM;
  const routes = {};
  for (const r of E.routes) {
    routes[r.id] = {
      lv: r.level, succ: (r.success || 100) / 100, coins: r.coins,
      perHour: { ...((gs.baseDrops || {})[r.id] || {}) },
      hours: E.hours, ticket: E.ticket, freeFirst: r.id === 'trade' ? 3 : 0,
      marks: { 2: 1, 8: 5, 12: 8 },
    };
  }
  return {
    label: '现状 v0.22.0（catalog 真值）',
    routes, mult: { 2: 1, 8: 1, 12: 1 },
    shipXp: C.SHIP.xpNeed, shipScale: C.SHIP.upScale, shipCoins: C.SHIP.upCoins,
    freeTrade: 3,
    upgrade: gs.costs.upgrade.map((u) => ({
      coins: u.coins, gear_alloy: (u.items || {}).gear_alloy || 0,
      gear_fine: (u.items || {}).gear_fine || 0, receipts: u.receipts || 0,
    })),
    engrave: { coins: gs.costs.engrave.coins, gear_fine: (gs.costs.engrave.items || {}).gear_fine || 0, receipts: gs.costs.engrave.receipts || 0 },
    setStage: [0, 1, 2].map((i) => ({ coins: [20000, 40000, 60000][i], gear_crystal: [10, 20, 30][i], receipts: 1 })),
    specStage: [0, 1, 2].map((i) => ({ coins: [20000, 40000, 60000][i], gear_crystal: [10, 20, 30][i], receipts: 1 })),
    specUnlock: { coins: 5000, gear_crystal: 2 },
    setMarks: 27, freeSets: 1, receiptHours: gs.receiptHours,
    milestones: MILESTONES,
  };
}

// ───────────────────── 提案（本方案 · map-agnostic） ─────────────────────
// 三条产线各自供一条成长轴，互不抢料：
//   采集线(trade/gather) → 强化合金 → 部位强化
//   打捞线(salvage)      → 精工合金 → 精工 + 高阶强化
//   远征线(danger/king)  → 催化晶 + 印记 → 套装 + 专精
// 门票只收在远征线（低阶线免费），彻底消除「没鳞片→不能出航→赚不到鳞片」的死锁。

function proposedConfig() {
  return {
    label: '提案（三产线分工 · 推荐）',
    mult: { 2: 1.0, 8: 1.35, 12: 1.6 },
    freeTrade: 3,
    routes: {
      trade: { lv: 1, succ: 1.00, coins: 2000, ticket: 0, marks: { 2: 1, 8: 5, 12: 8 },
        perHour: { gear_alloy: 4, deepscale: 0.6, bait_pack: 1.5 } },
      gather: { lv: 2, succ: 0.90, coins: 1600, ticket: 0, marks: { 2: 1, 8: 5, 12: 8 },
        perHour: { gear_alloy: 5, gear_fine: 0.8, deepscale: 0.5 } },
      salvage: { lv: 3, succ: 0.80, coins: 1900, ticket: 0, marks: { 2: 1, 8: 5, 12: 8 },
        perHour: { gear_alloy: 1.5, gear_fine: 1.5, gear_crystal: 1.1, deepscale: 0.3, relic: 1 } },
      danger: { lv: 4, succ: 0.65, coins: 2400, ticket: 1, marks: { 2: 1, 8: 5, 12: 8 },
        perHour: { gear_fine: 1.8, gear_crystal: 1.5, deepscale: 0.8, dragonpearl: 0.25 } },
      king: { lv: 5, succ: 0.65, coins: 3000, ticket: 1, marks: { 2: 1, 8: 5, 12: 8 },
        perHour: { gear_fine: 2.4, gear_crystal: 2.0, deepscale: 1.5, dragonpearl: 0.5 } },
    },
    shipXp: [0, 40, 140, 280, 480],
    shipScale: [0, 6, 16, 40, 80],
    shipCoins: [0, 15000, 40000, 90000, 160000],
    // 部位强化：前 4 级便宜（小毕业），+8 开门槛，末 4 级是长尾
    upgrade: [
      { coins: 1200, gear_alloy: 3 }, { coins: 2200, gear_alloy: 4 }, { coins: 3500, gear_alloy: 6 },
      { coins: 5000, gear_alloy: 8, receipts: 1 },                       // +4 副属性解锁 · 绑定
      { coins: 7000, gear_alloy: 12 }, { coins: 9000, gear_alloy: 16, gear_fine: 1 },
      { coins: 10500, gear_alloy: 20, gear_fine: 2 },
      { coins: 12000, gear_alloy: 24, gear_fine: 3, receipts: 1 },        // +8 精工开放
      { coins: 13500, gear_alloy: 28, gear_fine: 4 }, { coins: 15000, gear_alloy: 34, gear_fine: 6 },
      { coins: 17000, gear_alloy: 40, gear_fine: 9 },
      { coins: 19000, gear_alloy: 45, gear_fine: 12, receipts: 1 },       // +12 满级
    ],
    engrave: { coins: 12000, gear_fine: 25, receipts: 1 },
    setStage: [
      { coins: 20000, gear_crystal: 20, gear_fine: 10, receipts: 1 },
      { coins: 34000, gear_crystal: 32, gear_fine: 16, receipts: 1 },
      { coins: 50000, gear_crystal: 48, gear_fine: 24, receipts: 1 },
    ],
    specStage: [
      { coins: 14000, gear_crystal: 16, gear_fine: 8, receipts: 1 },
      { coins: 25000, gear_crystal: 28, gear_fine: 12, receipts: 1 },
      { coins: 38000, gear_crystal: 40, gear_fine: 18, receipts: 1 },
    ],
    specUnlock: { coins: 5000, gear_crystal: 2 },
    setMarks: 40, freeSets: 1, receiptHours: 8,
    milestones: MILESTONES,
  };
}

// ───────────────────── 主模拟 ─────────────────────

const RES = ['gear_alloy', 'gear_fine', 'gear_crystal', 'deepscale', 'marks', 'receipts', 'dragonpearl'];

function simulate(cfg, profile, spotPool, useProposedLadder) {
  const queue = buildQueue(cfg);
  const bag = Object.fromEntries(RES.map((k) => [k, 0]));
  let coins = 0, xp = 0, ship = 1, qi = 0, day = 0, catches = 0;
  const hit = {}, binding = {};
  const voyages = Object.fromEntries(Object.keys(cfg.routes).map((r) => [r, 0]));
  const dailyRoutes = Object.keys(cfg.routes).filter((r) => (cfg.routes[r].hours || [2, 8, 12]).includes(8));

  const pay = (need) => {
    for (const k of Object.keys(need)) if ((k === 'coins' ? coins : bag[k]) < need[k]) return false;
    for (const k of Object.keys(need)) if (k === 'coins') coins -= need[k]; else bag[k] -= need[k];
    return true;
  };
  const affordable = (need) => Object.keys(need).every((k) => (k === 'coins' ? coins : bag[k]) >= need[k]);

  function shipNeeds() {
    const n = {};
    if (ship < cfg.shipXp.length && xp >= cfg.shipXp[ship]) { n.deepscale = cfg.shipScale[ship]; }
    else if (ship < cfg.shipXp.length) { n.deepscale = cfg.shipScale[ship]; }
    return n;
  }

  function voyageGreedy(hours) {
    const target = queue[qi] ? { ...(queue[qi].cost || {}) } : {};
    for (const k of Object.keys(shipNeeds())) if (!(target[k] > (bag[k] || 0))) target[k] = Math.max(target[k] || 0, shipNeeds()[k]);
    const avail = dailyRoutes.filter((r) => cfg.routes[r].lv <= ship);
    if (!avail.length) return null;
    let best = null, bestScore = -1;
    for (const r of avail) {
      const R = cfg.routes[r], mult = cfg.mult[hours] || 1;
      let score = 0;
      for (const k of Object.keys(R.perHour)) {
        const amt = R.perHour[k] * hours * mult;
        if ((target[k] || 0) > (bag[k] || 0)) score += amt * 10;
      }
      score += (R.coins * hours) / 4000; // 金币软权重
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  const voyageHours = 8;
  const perDay = Math.max(1, Math.floor(profile.hoursPerDay / voyageHours));

  const spotInfo = (s) => {
    const tier = PROPOSED_TIER[s.id] || 1;
    if (useProposedLadder) return { id: s.id, name: s.name, minShip: s.minShip || 0, gate: PROPOSED_GATE[s.id] || 0, ev: PROPOSED_TIER_EV[tier], keep: PROPOSED_TIER_KEEP[tier] || {} };
    return { id: s.id, name: s.name, minShip: s.minShip || 0, gate: 0, ev: coinsPerCast(s), keep: keepRates(s) };
  };
  const spots = spotPool.map(spotInfo);
  const fishLog = {};

  for (day = 1; day <= 400; day++) {
    const unlocked = spots.filter((s) => s.minShip <= ship && catches >= s.gate);
    const best = unlocked.reduce((a, b) => (b.ev > a.ev ? b : a), unlocked[0] || spots[0]);
    fishLog[best.id] = (fishLog[best.id] || 0) + 1;
    catches += profile.castsPerDay;
    coins += profile.castsPerDay * best.ev;
    for (const k of Object.keys(best.keep || {})) bag[k] += profile.castsPerDay * best.keep[k];
    for (let v = 0; v < perDay; v++) {
      const r = voyageGreedy(voyageHours);
      if (!r) break;
      const R = cfg.routes[r], mult = cfg.mult[voyageHours] || 1;
      const debt = RES.filter((k) => {
        const need = (queue[qi]?.cost?.[k] || 0) + (shipNeeds()[k] || 0);
        return need > (bag[k] || 0) + 1e-9;
      });
      const freeLeft = (cfg.freeTrade || 0) - voyages.trade;
      if (R.ticket > 0 && !(r === 'trade' && freeLeft > 0)) {
        if (bag.deepscale < R.ticket) continue; // 门票不够就换免票航线，避免死锁
        bag.deepscale -= R.ticket;
      }
      voyages[r]++;
      xp += voyageHours * 2;
      coins += R.coins * voyageHours;
      for (const k of Object.keys(R.perHour)) bag[k] += R.perHour[k] * voyageHours * mult;
      bag.marks += R.marks[voyageHours] || 0;
      bag.receipts += voyageHours / cfg.receiptHours;
      void debt;
    }
    while (ship < cfg.shipXp.length && xp >= cfg.shipXp[ship] && bag.deepscale >= cfg.shipScale[ship] && coins >= cfg.shipCoins[ship]) {
      bag.deepscale -= cfg.shipScale[ship]; coins -= cfg.shipCoins[ship]; ship++;
    }
    while (qi < queue.length && affordable(queue[qi].cost || {})) {
      const item = queue[qi];
      if (item.ship) ship = Math.max(ship, item.ship);
      const tier = item.tag.split(':')[0];
      pay(item.cost || {});
      const more = queue[qi + 1] && queue[qi + 1].tag.startsWith(tier + ':');
      if (!more) hit[tier] = day;
      qi++;
    }
    if (process.env.SIM_DEBUG && (day % 10 === 0 || day === 1)) {
      const b = queue[qi];
      console.log(`   [d${day}] 船Lv${ship} xp=${xp} 金=${Math.round(coins / 1000)}k 合金=${Math.round(bag.gear_alloy)} 精工=${Math.round(bag.gear_fine)} 晶=${Math.round(bag.gear_crystal)} 鳞=${bag.deepscale.toFixed(0)} 印=${bag.marks} 证=${bag.receipts.toFixed(0)} | 卡在 ${b ? b.tag : '完成'}`);
    }
    if (hit.T3) break;
  }
  // 找出每个里程碑的约束瓶颈
  for (const m of cfg.milestones) {
    const upTo = queue.filter((x) => MILESTONES.findIndex((z) => z.key === x.tag.split(':')[0]) <= MILESTONES.indexOf(m));
    const need = upTo.reduce((a, x) => { for (const k of Object.keys(x.cost || {})) a[k] = (a[k] || 0) + x.cost[k]; return a; }, {});
    binding[m.key] = need;
  }
  void binding;
  return { hit, ship, xp, queue, fishLog, catches };
}

// ───────────────────── 输出 ─────────────────────

function report(label, cfg, profile, spotPool, useLadder) {
  const r = simulate(cfg, profile, spotPool, useLadder);
  const lines = cfg.milestones.map((m) => {
    const d = r.hit[m.key] || '>400';
    const ok = typeof d === 'number' && d >= m.target * 0.7 && d <= m.target * 1.3;
    return `   ${m.key} ${m.name}  目标 ${String(m.target).padStart(3)}d  实测 ${String(d).padStart(4)}d  ${typeof d === 'number' ? (ok ? '✓' : '⚠ 偏差') : '✗ 未达成'}`;
  });
  const fished = Object.entries(r.fishLog).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}(${v}d)`).join(' ');
  console.log(`── ${label}   [${profile.name} · 主要垂钓点 ${fished}]`);
  lines.forEach((l) => console.log(l));
  console.log(`   （终局 船 Lv${r.ship}，XP ${r.xp}，累计渔获 ${r.catches}）`);
  return r.hit;
}

function main() {
  const arg = process.argv.find((a) => a.startsWith('--profile='));
  const profile = PROFILES[arg ? arg.split('=')[1] : 'std'] || PROFILES.std;

  console.log('\n═══ 一、钓点金币期望阶梯（真实数据，每竿可卖物期望 × 体型加成）═══\n');
  const spotPool = allSpots();
  const spots = spotPool.map((s) => ({ id: s.id, name: s.name, map: s.map || 'inshore', minShip: s.minShip || 0, ev: coinsPerCast(s) }));
  const ranked = [...spots].sort((a, b) => a.ev - b.ev);
  for (const s of ranked) {
    const tier = PROPOSED_TIER[s.id] || 1;
    console.log(`   ${s.id.padEnd(11)} ${String(s.name).padEnd(8)} ${s.map.padEnd(8)} 船${s.minShip}  现 ${s.ev.toFixed(1).padStart(6)} 金/竿   提案 tier${tier} → ${PROPOSED_TIER_EV[tier]} 金/竿`);
  }
  const evs = ranked.map((s) => s.ev);
  console.log(`\n   现状：最低 ${Math.min(...evs).toFixed(1)} → 最高 ${Math.max(...evs).toFixed(1)}（倍差 ${(Math.max(...evs) / Math.min(...evs)).toFixed(1)}×，且与门槛无单调关系）`);
  console.log(`   提案：T1 ${PROPOSED_TIER_EV[1]} → T5 ${PROPOSED_TIER_EV[5]}（倍差 ${(PROPOSED_TIER_EV[5] / PROPOSED_TIER_EV[1]).toFixed(1)}×，严格随门槛递增）`);

  console.log(`\n═══ 二、毕业天数模拟（${profile.name}档：${profile.note}）═══\n`);
  console.log(`   玩家按「当前解锁的最高收益钓点」钓鱼，×${profile.castsPerDay} 竿/天，叠加航次结算\n`);
  const cur = report('现状 v0.22.0', currentConfig(), profile, spotPool, false);
  const pro = report('提案（三产线分工）', proposedConfig(), profile, spotPool, true);

  console.log('\n═══ 三、提案各里程碑累计消耗（数值表 / 迁移核对用）═══\n');
  const cfgP = proposedConfig();
  const q = buildQueue(cfgP);
  const order = ['T1', 'T2', 'T3'];
  for (const key of order) {
    const upTo = q.filter((x) => order.indexOf(x.tag.split(':')[0]) <= order.indexOf(key));
    const tot = upTo.reduce((a, x) => { for (const k of Object.keys(x.cost || {})) a[k] = (a[k] || 0) + x.cost[k]; return a; }, {});
    console.log(`   ${key}  ${String(upTo.length).padStart(3)} 项  ` + Object.entries(tot).map(([k, v]) => `${k}=${Math.round(v)}`).join('  '));
  }

  console.log('\n═══ 四、汇总 ═══\n');
  for (const [k, hit] of [['现状', cur], ['提案', pro]]) {
    console.log(`   ${k}  T1 ${String(hit.T1 || '-').padStart(3)}/10   T2 ${String(hit.T2 || '-').padStart(3)}/20   T3 ${String(hit.T3 || '-').padStart(3)}/32`);
  }
  console.log('');
}

main();
