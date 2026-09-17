/*
 * v0.11 新增功能端到端测试（纯 HTTP + 数据目录断言，可独立运行）
 * 覆盖：
 *   ① 品质系统纠正（四种品质 / 大鱼不再是品质 / 渔获归入稀有与史诗）
 *   ② 技巧词缀（大鱼概率 → 技巧，作为上钩率公式变量参与计算）
 *   ③ 龙宫宝珠归入材料
 *   ④ 商城（每日限购 + 刷新时间 + 后台配置）
 *   ⑤ 宝匣：合成成本后台可改 + 突破件 roll 两次取边界值
 *   ⑥ 工坊熔炼（双件词条改写 / 投料补缀 / 龙宫宝珠 / 成功率与花费 / 后台配置 / 残片保留 /
 *      失败结算改为「主件失去选中词条」）
 *   ⑦ 钓点地图坐标后台可改（拖动保存）
 *   ⑧ 服务端优雅版本更新（候选脚本 / 60 秒通知 / 5 秒后切换 / 取消 / 路径安全）
 *   ⑨ 存档修复脚本 tools/fix-save-v011.js
 * 运行： node tests/v011.test.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp, waitFor , flushWait } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 8186;
const BASE = 'http://localhost:' + PORT;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v011-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }

function req(method, u, body) {
  return new Promise((resolve) => {
    const p = url.parse(u);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: p.hostname, port: p.port, path: p.path, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, data: j, text: d });
      });
    });
    r.on('error', () => resolve({ status: 0, data: null, text: '' }));
    if (data) r.write(data);
    r.end();
  });
}
const GET = u => req('GET', u), POST = (u, b) => req('POST', u, b);

let srv = null;
function startServer() {
  srv = spawn(NODE, [path.join('backend', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  return waitHttp(BASE + '/api/version', { timeout: 20000 });
}

(async () => {
  const ready = await startServer();
  if (!ready) { console.log('服务器未就绪，测试中止'); killTree(srv); process.exit(1); }
  console.log('服务器就绪：' + BASE);

  // ---- 账号：首个登录后台的账号自动成为管理员 ----
  section('账号准备');
  await POST(BASE + '/api/register', { username: 'v_admin', password: 'v123456', name: '版本管理员', qq: '99001' });
  const lgA = await POST(BASE + '/api/admin/login', { username: 'v_admin', password: 'v123456' });
  const TOKA = lgA.data && lgA.data.token;
  check('管理员登录', lgA.status === 200 && !!TOKA, JSON.stringify(lgA.data));
  await POST(BASE + '/api/register', { username: 'v_player', password: 'v123456', name: '测试玩家', qq: '99002' });
  const lgP = await POST(BASE + '/api/login', { username: 'v_player', password: 'v123456' });
  const TOKP = lgP.data && lgP.data.token;
  check('玩家登录', lgP.status === 200 && !!TOKP);
  async function seed(inv, coins) { return POST(BASE + '/api/dev/seed', { token: TOKP, inventory: inv || {}, coins: coins == null ? 5000000 : coins }); }

  // ==========================================================================
  section('① 品质系统：只有 普通/稀有/史诗/神话 四种，大鱼不再是品质');
  const qKeys = Object.keys(D.QUALITY);
  check('品质共四种且顺序为 普通/稀有/史诗/神话',
    qKeys.length === 4 && qKeys.join(',') === 'common,rare,epic,mythic', qKeys.join(','));
  check('品质名称正确', qKeys.every(k => /^[普通稀有史诗神话]+$/.test(D.QUALITY[k].name)), JSON.stringify(qKeys.map(k => D.QUALITY[k].name)));
  const allFish = [];
  ['common', 'big', 'rare'].forEach(t => D.FISH[t].forEach(f => allFish.push({ tier: t, f: f })));
  const rarities = {};
  allFish.forEach(x => { rarities[x.f.rarity] = (rarities[x.f.rarity] || 0) + 1; });
  check('没有任何渔获的 rarity 是 big（大鱼不再是品质）', !rarities.big, JSON.stringify(rarities));
  check('渔获品质只落在 普通/稀有/史诗', Object.keys(rarities).every(r => ['common', 'rare', 'epic'].includes(r)), JSON.stringify(rarities));
  const bigTier = D.FISH.big;
  check('原「大鱼」档位已拆为 稀有 与 史诗',
    bigTier.some(f => f.rarity === 'rare') && bigTier.some(f => f.rarity === 'epic'),
    JSON.stringify(bigTier.map(f => f.id + ':' + f.rarity)));
  check('价值 ≥200 的大型鱼为史诗，其余为稀有',
    bigTier.every(f => (f.price >= 200 ? f.rarity === 'epic' : f.rarity === 'rare')),
    JSON.stringify(bigTier.filter(f => (f.price >= 200) !== (f.rarity === 'epic')).map(f => f.id)));
  // 品质价格倍率表兜底也要覆盖新品质（老的 big 兜底键必须还在，避免旧存档物品算不出价）
  check('稀有度兜底价表含四种品质', ['common', 'rare', 'epic', 'mythic'].every(k => D.RARITY_PRICE[k] > 0), JSON.stringify(D.RARITY_PRICE));

  // ==========================================================================
  section('② 技巧词缀：替换大鱼概率，参与上钩率公式');
  const poolTypes = new Set();
  D.COMPONENT_BASES.forEach(b => b.pool.forEach(p => poolTypes.add(p.type)));
  check('组件词缀池里不再有 big 类型', !poolTypes.has('big'), Array.from(poolTypes).join(','));
  check('组件词缀池含 技巧(skill)', poolTypes.has('skill'), Array.from(poolTypes).join(','));
  check('词缀标签：技巧 存在且没有 大鱼概率',
    D.AFFIX_LABEL.skill === '技巧' && !D.AFFIX_LABEL.big, JSON.stringify(D.AFFIX_LABEL));
  // v0.13.3：钓点增益类别 = 组件词缀同一套，「大鱼概率」不再单独存在（服务端仍拒绝未知类别）
  check('词缀标签表里没有 大鱼概率（增益与组件同表）',
    !Object.keys(D.AFFIX_LABEL).some(k => D.AFFIX_LABEL[k] === '大鱼概率') && !D.BUFF_LABEL,
    JSON.stringify(D.AFFIX_LABEL));
  check('技巧短码为 skl，且旧码 big 解析为技巧',
    D.AFFIX_CODES.skill === 'skl' && D.typeOfCode('big') === 'skill' && D.codeOf('big') === 'skl',
    JSON.stringify({ code: D.AFFIX_CODES.skill, legacy: D.typeOfCode('big') }));
  const legacyInstId = 'reel_turbo#rare#big-8,spd+30';
  // 整竿标识（rodset:）里的每个配件也要一起规范化：否则存档里的钓竿槽位会带着旧码继续流传
  check('整竿标识内的旧签名同步规范化（big → skl）',
    D.normalizeItemId('rodset:rod=rod_carbon#common#spd+22;reel=reel_turbo#rare#spd+37,big-5') ===
      'rodset:rod=rod_carbon#common#spd+22;reel=reel_turbo#rare#spd+37,skl-5',
    D.normalizeItemId('rodset:rod=rod_carbon#common#spd+22;reel=reel_turbo#rare#spd+37,big-5'));
  check('旧签名中的 big 短码被识别为技巧并规范化为 skl',
    D.instanceMeta(legacyInstId).affixes.some(a => a.type === 'skill' && a.value === -8) &&
    D.normalizeItemId(legacyInstId) === 'reel_turbo#rare#spd+30,skl-8', D.normalizeItemId(legacyInstId));
  const w0 = await GET(BASE + '/api/admin/world?token=' + encodeURIComponent(TOKA));
  check('默认上钩公式含技巧变量', /skill/.test(w0.data.biteFormula || ''), w0.data.biteFormula);
  const evalR = await POST(BASE + '/api/admin/settings', { token: TOKA, biteFormula: 'clamp(50 + skill * 2, 0, 100)', validateOnly: true, evalVars: { skill: 10 } });
  check('公式试算：技巧 10 → 70%', evalR.status === 200 && evalR.data.prob === 70, JSON.stringify(evalR.data));
  check('保存技巧公式成功', (await POST(BASE + '/api/admin/settings', { token: TOKA, biteFormula: 'clamp(50 + skill * 2, 0, 100)' })).status === 200);
  // 技巧词缀实际提升上钩率：bd/set 会回传服务器算出的 castInfo（含按当前公式得出的上鱼率），
  // 因此不必真开钓鱼循环即可断言「技巧 = 上钩率公式的一个参数」。
  const skillComp = D.instanceId('rod_dragonbone', 'rare', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }]);
  await seed({ [skillComp]: 1 }, 5000000);
  const bdOff = await POST(BASE + '/api/bd/set', { token: TOKP, part: 'rod', compId: null });
  const rate0 = bdOff.data.castInfo && bdOff.data.castInfo.biteRate;
  const bdEff = await POST(BASE + '/api/bd/set', { token: TOKP, part: 'rod', compId: skillComp });
  const rate1 = bdEff.data.castInfo && bdEff.data.castInfo.biteRate;
  check('词缀汇总里是 skill 而非 big', bdEff.data.effects.skill === 10 && !bdEff.data.effects.big, JSON.stringify(bdEff.data.effects));
  check('技巧词缀按公式提升上钩率（无技巧 50% → 技巧 10 为 70%）', rate0 === 50 && rate1 === 70,
    JSON.stringify({ rate0: rate0, rate1: rate1 }));
  check('钓竿不再通过 eff.big 影响大型鱼掉落权重（big 只由钓点增益提供）',
    !bdEff.data.effects.big, JSON.stringify(bdEff.data.effects));
  // 恢复默认公式与空装配，避免影响后续用例
  await POST(BASE + '/api/admin/settings', { token: TOKA, biteFormula: 'clamp(90 + skill, 0, 100)' });
  await POST(BASE + '/api/bd/set', { token: TOKP, part: 'rod', compId: null });

  // ==========================================================================
  section('③ 龙宫宝珠归入材料');
  const dpearl = D.itemOf('dragonpearl');
  check('龙宫宝珠类型为材料', dpearl.kind === 'material', JSON.stringify(dpearl));
  check('龙宫宝珠不再出现在渔获档位里', !['common', 'big', 'rare'].some(t => D.FISH[t].some(f => f.id === 'dragonpearl')));
  check('礁石区掉落池把它记为材料', (function () {
    const g = D.GROUNDS.find(x => x.id === 'sunset');
    const sp = g && g.spots.find(x => x.id === 'reef');
    return !!sp && sp.pool.some(e => e.pick === 'material:dragonpearl');
  })());
  check('钓点索引把宝珠归到材料类', D.spotsOf('dragonpearl').length > 0, JSON.stringify(D.spotsOf('dragonpearl')));

  // ==========================================================================
  section('④ 商城：每日限购 + 刷新时间 + 后台配置');
  const mall0 = await GET(BASE + '/api/mall?token=' + encodeURIComponent(TOKP));
  check('读取商城成功', mall0.status === 200 && Array.isArray(mall0.data.items) && mall0.data.items.length > 0, JSON.stringify(mall0.data).slice(0, 120));
  check('商城带限购刷新时间与下次刷新时间点',
    /^\d{1,2}:\d{2}$/.test(mall0.data.refreshTime) && mall0.data.nextRefreshAt > Date.now(), JSON.stringify(mall0.data.refreshTime));
  const baitItem = mall0.data.items.find(x => x.id === 'bait_pack');
  check('默认商品含诱饵包并带每日限购', !!baitItem && baitItem.limit > 0 && baitItem.remain === baitItem.limit, JSON.stringify(baitItem));
  check('未登录读商城 401', (await GET(BASE + '/api/mall')).status === 401);
  await seed({}, 100000);
  const buyMall = await POST(BASE + '/api/mall/buy', { token: TOKP, id: 'bait_pack', qty: 3 });
  check('购买商城商品成功（扣金币 + 入包）',
    buyMall.status === 200 && buyMall.data.cost === baitItem.price * 3 && buyMall.data.inventory.bait_pack === 3,
    JSON.stringify(buyMall.data).slice(0, 160));
  const buyMore = await POST(BASE + '/api/mall/buy', { token: TOKP, id: 'bait_pack', qty: baitItem.limit });
  check('超过每日限购被拒 400', buyMore.status === 400 && /限购/.test(buyMore.data.error || ''), JSON.stringify(buyMore.data));
  const buyRest = await POST(BASE + '/api/mall/buy', { token: TOKP, id: 'bait_pack', qty: baitItem.limit - 3 });
  check('买满限购成功', buyRest.status === 200, JSON.stringify(buyRest.data).slice(0, 120));
  check('买满后限购剩余为 0', (buyRest.data.mall.items.find(x => x.id === 'bait_pack') || {}).remain === 0);
  check('买满后再买被拒', (await POST(BASE + '/api/mall/buy', { token: TOKP, id: 'bait_pack', qty: 1 })).status === 400);
  check('金币不足时被拒', (await seed({}, 10)) && (await POST(BASE + '/api/mall/buy', { token: TOKP, id: 'bait_pack', qty: 1 })).status === 400);
  const mallBadAdmin = await POST(BASE + '/api/admin/mall/config', { token: TOKP, items: [] });
  check('非管理员改商城配置 403', mallBadAdmin.status === 403);
  const mallSet = await POST(BASE + '/api/admin/mall/config', {
    token: TOKA, refreshTime: '04:00',
    items: [{ id: 'tide_sand', price: 111, limit: 2 }, { id: 'rope', price: 22, limit: 0 }],
  });
  check('后台保存商城商品成功', mallSet.status === 200 && mallSet.data.mallCfg.items.length === 2, JSON.stringify(mallSet.data).slice(0, 140));
  const mall1 = await GET(BASE + '/api/mall?token=' + encodeURIComponent(TOKP));
  check('玩家端立即看到新商品与价格',
    mall1.data.items.length === 2 && mall1.data.items[0].price === 111 && mall1.data.items[1].limit === 0,
    JSON.stringify(mall1.data.items));
  check('不限购商品 remain 为 null', mall1.data.items.find(x => x.id === 'rope').remain === null);
  check('非法物品被拒 400', (await POST(BASE + '/api/admin/mall/config', { token: TOKA, items: [{ id: 'no_such', price: 1, limit: 1 }] })).status === 400);
  check('非法刷新时间被拒 400', (await POST(BASE + '/api/admin/mall/config', { token: TOKA, refreshTime: '25:99' })).status === 400);
  check('负价格被拒 400', (await POST(BASE + '/api/admin/mall/config', { token: TOKA, items: [{ id: 'rope', price: -5, limit: 1 }] })).status === 400);
  // 限购按「刷新时间」划分周期：改刷新时间让当前周期翻页 → 已购计数重置
  await seed({}, 1000000);
  await POST(BASE + '/api/admin/mall/config', { token: TOKA, refreshTime: '04:00', items: [{ id: 'rope', price: 10, limit: 2 }] });
  await POST(BASE + '/api/mall/buy', { token: TOKP, id: 'rope', qty: 2 });
  const mallFull = await GET(BASE + '/api/mall?token=' + encodeURIComponent(TOKP));
  check('限购已用满', mallFull.data.items[0].remain === 0, JSON.stringify(mallFull.data.items[0]));
  // 把刷新时间改到「能让当前周期起点换一天」的时点 → 周期键变化 → 计数清零。
  // 注意别写成「now + 3 小时」：周期起点只可能是今天或昨天，21 点后（或凌晨 4 点前）
  // now+3h 会落回同一天，周期键不变 —— 那是测试假设的问题，不是限购逻辑的问题。
  // 这里直接按周期键搜索一个会变化的刷新时间，全天（除每天最后 1 分钟）都成立。
  const keyFull = mallFull.data.cycleKey;
  let hhmm = null;
  for (let m = 0; m < 24 * 60; m++) {
    const cand = ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
    if (D.mallCycleOf(cand, Date.now()).key !== keyFull) { hhmm = cand; break; }
  }
  if (hhmm) {
    await POST(BASE + '/api/admin/mall/config', { token: TOKA, refreshTime: hhmm, items: [{ id: 'rope', price: 10, limit: 2 }] });
    const mallReset = await GET(BASE + '/api/mall?token=' + encodeURIComponent(TOKP));
    check('跨过刷新时间点后限购自动重置',
      mallReset.data.items[0].bought === 0 && mallReset.data.items[0].remain === 2 &&
      mallReset.data.cycleKey !== keyFull,
      JSON.stringify({ refreshTime: mallReset.data.refreshTime, key: mallReset.data.cycleKey, was: keyFull, item: mallReset.data.items[0] }));
  } else {
    // 每天最后 1 分钟内所有刷新时间都落在同一周期，无法构造跨周期（跳过而非误报失败）
    console.log('  SKIP  跨过刷新时间点后限购自动重置（当前时刻无可用跨周期刷新时间）');
  }

  // ==========================================================================
  section('⑤ 宝匣：合成成本可改 + 突破件边界取值');
  const chestAdmin0 = await GET(BASE + '/api/admin/world?token=' + encodeURIComponent(TOKA));
  const kingRow = (chestAdmin0.data.chests || []).find(c => c.id === 'chest_king');
  check('后台读到四档宝匣与出厂成本', !!kingRow && kingRow.costRelic === 100 && kingRow.costCoins === 300000 && kingRow.baseRelic === 100,
    JSON.stringify(kingRow));
  const setCost = await POST(BASE + '/api/admin/settings', {
    token: TOKA, chestCfg: { costs: { chest_king: { costRelic: 3, costCoins: 500 } } },
  });
  check('保存宝匣成本成功', setCost.status === 200 && setCost.data.chestCfg.costs.chest_king.costRelic === 3, JSON.stringify(setCost.data.chestCfg));
  const chestView = await GET(BASE + '/api/chest?token=' + encodeURIComponent(TOKP));
  const kingView = chestView.data.chests.find(c => c.id === 'chest_king');
  check('玩家端立即看到新成本', kingView.costRelic === 3 && kingView.costCoins === 500, JSON.stringify(kingView));
  await seed({ relic: 3 }, 100000);
  const craft1 = await POST(BASE + '/api/chest/craft', { token: TOKP, chestId: 'chest_king', qty: 1 });
  check('按新成本合成（扣 3 残片 / 500 金币）',
    craft1.status === 200 && craft1.data.inventory.relic === undefined && craft1.data.inventory.chest_king === 1,
    JSON.stringify(craft1.data.inventory));
  const coinsAfter = craft1.data.coins;
  check('合成扣款正确（100000 - 500）', coinsAfter === 99500, String(coinsAfter));
  check('成本非法值被拒 400', (await POST(BASE + '/api/admin/settings', { token: TOKA, chestCfg: { costs: { chest_king: { costRelic: -1 } } } })).status === 400);
  check('未知档位被忽略（不报错、不写入）', (await POST(BASE + '/api/admin/settings', { token: TOKA, chestCfg: { costs: { no_chest: { costRelic: 5 } } } })).status === 200);
  const resetCost = await POST(BASE + '/api/admin/settings', { token: TOKA, chestCfg: { costs: {} } });
  check('恢复出厂成本', resetCost.status === 200 && !resetCost.data.chestCfg.costs.chest_king, JSON.stringify(resetCost.data.chestCfg));
  const chestView2 = await GET(BASE + '/api/chest?token=' + encodeURIComponent(TOKP));
  check('出厂成本已恢复（100 / 300000）',
    chestView2.data.chests.find(c => c.id === 'chest_king').costRelic === 100);
  // —— 突破件 roll 两次取靠近区间边界的值 ——
  check('边界取值：区间 [-1,8] 取 -1 与 6 → -1', D.nearerBoundaryOf(-1, 6, -1, 8) === -1);
  check('边界取值：区间 [-1,8] 取 4 与 8 → 8', D.nearerBoundaryOf(4, 8, -1, 8) === 8);
  check('边界取值：并列时取第一次（确定性）', D.nearerBoundaryOf(-1, 8, -1, 8) === -1);
  (function () {
    // 统计验证「取更靠近边界」：边界取值法的**平均离最近边界的距离**应明显小于普通 roll
    // （普通 roll 在 [0,10] 上的平均距离是 2.5，实测约 2.6；边界取值法约 1.8，比例 ≈ 0.70）
    const N = 4000, R = [0, 10];
    let distB = 0, distP = 0, nearB = 0, nearP = 0;
    for (let i = 0; i < N; i++) {
      const b = D.rollAffixValueBoundary(R[0], R[1], 'linear');
      const p = D.rollAffixValue(R[0], R[1], 'linear');
      distB += Math.min(b - R[0], R[1] - b);
      distP += Math.min(p - R[0], R[1] - p);
      if (b <= 2 || b >= 8) nearB++;
      if (p <= 2 || p >= 8) nearP++;
    }
    check('边界取值的平均离边界距离显著更小（约 0.7 倍）',
      distB / N < distP / N * 0.85, JSON.stringify({ boundary: distB / N, plain: distP / N }));
    check('贴近两端的比例更高', nearB / N > nearP / N * 1.3, JSON.stringify({ boundary: nearB / N, plain: nearP / N }));
  })();
  // 真实开箱：突破件（神话）词条值也走边界取值
  await seed({ chest_king: 8, relic: 20 }, 2000000);
  const openRes = [];
  for (let i = 0; i < 6; i++) {
    const r = await POST(BASE + '/api/chest/open', { token: TOKP, chestId: 'chest_king', baseId: 'rod_bamboo' });
    if (r.status === 200 && r.data.item) openRes.push(r.data.item);
  }
  check('海王遗匣开箱产出神话件', openRes.length === 6 && openRes.every(m => m.quality === 'mythic'), String(openRes.length));
  check('突破件补满 4 条、未突破补满 3 条',
    openRes.every(m => m.breakthrough ? m.affixes.length === 4 : m.affixes.length === 3),
    JSON.stringify(openRes.map(m => ({ bt: m.breakthrough, n: m.affixes.length }))));

  // ==========================================================================
  section('⑥ 工坊熔炼');
  const mainComp = D.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: 12 }, { type: 'size', value: 3 }]);
  // 副件必须与主件**同部位**（v0.11.1 起）：这里用同为「竿身」的龙骨巨竿，它带技巧词缀，
  // 而竹制短竿的词缀池里没有技巧 → 正好用来验证「把副件独有的词缀搬到主件」的池外取值。
  const subComp = D.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }, { type: 'speed', value: -12 }]);
  const crossPartComp = D.instanceId('hook_ghost', 'epic', [{ type: 'skill', value: 10 }, { type: 'rare', value: -5 }, { type: 'size', value: 5 }]);
  const ws0 = await GET(BASE + '/api/workshop?token=' + encodeURIComponent(TOKP));
  check('读取工坊参数成功', ws0.status === 200 && !!ws0.data.cfg && Array.isArray(ws0.data.materials), JSON.stringify(ws0.data).slice(0, 100));
  check('材料→词缀对照：潮汐砂=钓速、龙鳞碎屑=双钓、反光假饵=技巧',
    ws0.data.materials.find(m => m.id === 'tide_sand').affix === 'speed' &&
    ws0.data.materials.find(m => m.id === 'dragon_scale').affix === 'double' &&
    ws0.data.materials.find(m => m.id === 'lure').affix === 'skill',
    JSON.stringify(ws0.data.materials));
  check('已有材料也分配了词缀（诱饵包/耐磨绳/残片）',
    ws0.data.materials.find(m => m.id === 'bait_pack').affix === 'rare' &&
    ws0.data.materials.find(m => m.id === 'rope').affix === 'size' &&
    ws0.data.materials.find(m => m.id === 'relic').affix === 'material',
    JSON.stringify(ws0.data.materials.map(m => m.id + ':' + m.affix)));
  check('新材料品质更高（潮汐砂 稀有 / 龙鳞碎屑 史诗）',
    ws0.data.materials.find(m => m.id === 'tide_sand').rarity === 'rare' &&
    ws0.data.materials.find(m => m.id === 'dragon_scale').rarity === 'epic',
    JSON.stringify(ws0.data.materials.map(m => m.id + ':' + m.rarity)));
  check('未登录读工坊 401', (await GET(BASE + '/api/workshop')).status === 401);
  // 把成功率设为必定成功、补缀必定成功，便于断言结果
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 100, rateMax: 100, failPerMaterial: 0, extraRatePerMaterial: 100, extraRateMax: 100 });
  await seed({ [mainComp]: 1, [subComp]: 1 }, 200000);
  const smelt1 = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill', materials: [], pearl: false,
  });
  check('熔炼成功（无投料）', smelt1.status === 200 && smelt1.data.success === true, JSON.stringify(smelt1.data).slice(0, 140));
  const item1 = smelt1.data.item;
  check('熔炼后主件只剩选中的两条词条', !!item1 && item1.affixes.length === 2 &&
    item1.affixes.some(a => a.type === 'speed') && item1.affixes.some(a => a.type === 'skill'),
    JSON.stringify(item1 && item1.affixes));
  check('副件的词缀被搬到主件（池外，按池外区间取值）',
    !!item1 && item1.affixes.find(a => a.type === 'skill').extra === true,
    JSON.stringify(item1 && item1.affixes));
  check('主件底材与品质保持不变', !!item1 && item1.baseId === 'rod_bamboo' && item1.quality === 'epic', JSON.stringify(item1 && { b: item1.baseId, q: item1.quality }));
  check('副件与主件都被消耗、新件入包',
    smelt1.data.inventory[subComp] === undefined && smelt1.data.inventory[mainComp] === undefined && smelt1.data.inventory[item1.id] === 1,
    JSON.stringify(smelt1.data.inventory));
  check('熔炼花费金币（基础 5000）', smelt1.data.gold === 5000 && smelt1.data.coins === 195000, JSON.stringify({ g: smelt1.data.gold, c: smelt1.data.coins }));
  // 投料 → 补一条主件池内的词缀（rod_bamboo 池 = 钓速 / 体型；选中的是 钓速 + 技巧 → 可补 体型）
  await seed({ [mainComp]: 1, [subComp]: 1, rope: 6, dragonpearl: 1 }, 200000);
  const smelt2 = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill', materials: [{ id: 'rope', qty: 4 }], pearl: true,
  });
  check('投料熔炼成功且补缀成功', smelt2.status === 200 && smelt2.data.success && smelt2.data.extraOk === true, JSON.stringify(smelt2.data).slice(0, 140));
  check('补的词缀来自主件词缀池（体型）', smelt2.data.extraType === 'size' && smelt2.data.item.affixes.some(a => a.type === 'size'),
    JSON.stringify(smelt2.data.item && smelt2.data.item.affixes));
  check('投料越多花费越高（4 份材料 + 宝珠）', smelt2.data.gold === 5000 + 4 * 900 + 20000, String(smelt2.data.gold));
  check('龙宫宝珠启用边界取值', smelt2.data.pearl === true && smelt2.data.rollBoundary === true, JSON.stringify({ p: smelt2.data.pearl, b: smelt2.data.rollBoundary }));
  check('材料与宝珠被消耗',
    (smelt2.data.inventory.rope || 0) === 2 && smelt2.data.inventory.dragonpearl === undefined,
    JSON.stringify(smelt2.data.inventory));
  // 校验类错误
  await seed({ [mainComp]: 1, [subComp]: 1, rope: 2 }, 200000);
  check('主副选中同类型词条被拒', (await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'size', subAffix: 'size',
  })).status === 400);
  // 潮汐砂 → 钓速；但这件主件熔炼后已经有钓速（选中的就是它）→ 该词缀已在结果里，必须被拒
  //（v0.11.5 起补缀不再受底材池限制，所以「补不了」只剩「结果里已经有了」这一种）
  await seed({ [mainComp]: 1, [subComp]: 1, tide_sand: 3 }, 200000);
  const smeltBadMat = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill', materials: [{ id: 'tide_sand', qty: 2 }],
  });
  check('材料方向与结果词缀重复时被拒（该词缀已经在熔炼结果里）',
    smeltBadMat.status === 400 && /无法补进|已经有/.test(smeltBadMat.data.error || ''), JSON.stringify(smeltBadMat.data));
  check('缺少副件被拒', (await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: D.instanceId('hook_barb', 'common', [{ type: 'size', value: 2 }]), mainAffix: 'speed', subAffix: 'size',
  })).status === 400);
  // —— v0.11.1：主副必须同部位 ——
  await seed({ [mainComp]: 1, [subComp]: 1, [crossPartComp]: 1 }, 200000);
  const crossPart = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: crossPartComp, mainAffix: 'speed', subAffix: 'skill',
  });
  check('跨部位熔炼被拒（主副必须同类型）',
    crossPart.status === 400 && /同一部位/.test(crossPart.data.error || ''), JSON.stringify(crossPart.data));
  await seed({ [mainComp]: 1, [subComp]: 1 }, 10);
  const smeltPoor = await POST(BASE + '/api/workshop/smelt', { token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill' });
  check('金币不足被拒', smeltPoor.status === 400 && /金币不足/.test(smeltPoor.data.error || ''), JSON.stringify(smeltPoor.data));
  // —— 失败分支：成功率设为 0 → 副件熔毁、主件被熔掉选中的那条词条（v0.11.3）——
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 0, failPerMaterial: 0, rateMin: 0 });
  await seed({ [mainComp]: 1, [subComp]: 1 }, 200000);
  const smeltFail = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill',
  });
  check('熔炼失败（成功率 0）', smeltFail.status === 200 && smeltFail.data.success === false, JSON.stringify(smeltFail.data).slice(0, 140));
  // mainComp = 竹制短竿 epic [speed+12, size+3]；失败后 speed 被熔掉，只剩 size+3 的那件退回背包
  const mainLeftId = D.instanceId('rod_bamboo', 'epic', [{ type: 'size', value: 3 }]);
  check('失败后副件熔毁、主件被熔掉选中的词条（其余词条原值保留）',
    smeltFail.data.inventory[mainLeftId] === 1 && smeltFail.data.inventory[mainComp] === undefined &&
    smeltFail.data.inventory[subComp] === undefined && !smeltFail.data.item,
    JSON.stringify(smeltFail.data.inventory));
  check('失败结果回传受损主件与被熔词条',
    !!smeltFail.data.mainAfter && smeltFail.data.mainAfter.id === mainLeftId &&
    smeltFail.data.removedAffix === 'speed' &&
    smeltFail.data.mainAfter.affixes.length === 1 && smeltFail.data.mainAfter.affixes[0].type === 'size',
    JSON.stringify({ m: smeltFail.data.mainAfter && smeltFail.data.mainAfter.id, r: smeltFail.data.removedAffix }));
  check('失败仍扣金币', smeltFail.data.coins === 195000, String(smeltFail.data.coins));
  // 单条词条的主件：失败后只剩底材本体（0 词条实例仍可展示/出售）
  const oneAffix = D.instanceId('hook_barb', 'rare', [{ type: 'skill', value: 4 }]);
  const oneSub = D.instanceId('hook_swallow', 'rare', [{ type: 'speed', value: 9 }]);
  await seed({ [oneAffix]: 1, [oneSub]: 1 }, 200000);
  const smeltFailOne = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: oneAffix, subId: oneSub, mainAffix: 'skill', subAffix: 'speed',
  });
  const bareId = 'hook_barb#rare#';
  check('主件只有一条词条时失败 → 变成 0 词条的底材本体（不销毁）',
    smeltFailOne.status === 200 && smeltFailOne.data.success === false &&
    smeltFailOne.data.inventory[bareId] === 1 && !smeltFailOne.data.inventory[oneAffix],
    JSON.stringify(smeltFailOne.data.inventory));

  // ==========================================================================
  section('⑥d 工坊熔炼 · 残片保留（海王遗匣神话主件）');
  // 主件：竹制短竿 神话 4 词条（池内 speed/size + 池外 rare/double）——海王遗匣突破件的形态。
  // 池外那两条要按真实宝匣产物标 src='bt'：v0.13 起「是不是突破词缀」以来源为依据
  // （见 D.affixKindOf），没有 @bt 标记的池外词缀会被判为「普通池外词缀/来源未证实」，
  // 不再计入残片保留公式的 breakthrough。
  const mythicMain = D.instanceId('rod_bamboo', 'mythic', [
    { type: 'speed', value: 12 }, { type: 'size', value: 3 },
    { type: 'rare', value: 5, src: 'bt' }, { type: 'double', value: 9, src: 'bt' },
  ]);
  const mythicSub = D.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }]);
  // 池外词缀只认「不在底材池内」的：speed/size 在池内，rare/double 在池外（顺序按实例规范化后）
  // v0.12.2 起词缀对象带范围来源 src（池外 = 'bt'），断言只比 type+value
  const sortAff = list => JSON.stringify(list.map(a => ({ type: a.type, value: a.value })).sort((a, b) => a.type < b.type ? -1 : 1));
  check('数据层：池外（突破）词缀识别正确',
    sortAff(D.smeltExtraAffixesOf('rod_bamboo', D.componentOf(mythicMain).affixes)) ===
      sortAff([{ type: 'rare', value: 5 }, { type: 'double', value: 9 }]),
    JSON.stringify(D.smeltExtraAffixesOf('rod_bamboo', D.componentOf(mythicMain).affixes)));
  // v0.13：每片概率改由公式给出（默认 10 - breakthrough * 0.5），总概率 = 片数 × 每片概率
  check('数据层：保留概率 = 片数 × 每片公式值，10 片封顶 100%',
    D.smeltRetainChance(0, 0) === 0 && D.smeltRetainChance(3, 0) === 30 && D.smeltRetainChance(10, 0) === 100 &&
    D.smeltRetainChance(99, 0) === 100, [0, 3, 10, 99].map(n => D.smeltRetainChance(n, 0)).join(','));
  check('数据层：默认公式 10 - breakthrough * 0.5（突破词缀越多每片越低）',
    D.retainChancePerRelic(0) === 10 && D.retainChancePerRelic(2) === 9 && D.retainChancePerRelic(3) === 8.5 &&
    D.smeltRetainChance(10, 2) === 90,
    [0, 2, 3].map(n => D.retainChancePerRelic(n)).join(',') + ' / 10片2突破=' + D.smeltRetainChance(10, 2));
  const wsR = await GET(BASE + '/api/workshop?token=' + encodeURIComponent(TOKP));
  check('工坊接口下发残片保留参数（公式 + 上限 10 片）',
    !!wsR.data.retain && typeof wsR.data.retain.formula === 'string' && /breakthrough/.test(wsR.data.retain.formula) &&
    wsR.data.retain.max === 10 && wsR.data.retain.relicId === 'relic',
    JSON.stringify(wsR.data.retain));
  // 成功率与花费不受残片影响：用「50% 基础成功率 + 0 投料影响」这组未被夹紧的配置对比
  //（只比数值，不断言本次掷骰结果 —— 成败是随机的）
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 50, failPerMaterial: 0, rateMin: 5, rateMax: 99, goldBase: 5000, goldPerMaterial: 900 });
  await seed({ [mythicMain]: 1, [mythicSub]: 1, rope: 20 }, 200000);
  const smeltNoRelic = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicMain, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill', materials: [{ id: 'rope', qty: 4 }],
  });
  await seed({ [mythicMain]: 1, [mythicSub]: 1, rope: 20, relic: 10 }, 200000);
  const smeltRelic = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicMain, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill', materials: [{ id: 'rope', qty: 4 }], relics: 10,
  });
  check('投入残片不改变成功率（也不改变补缀率与金币花费）',
    smeltRelic.status === 200 && smeltRelic.data.rate === smeltNoRelic.data.rate &&
    smeltRelic.data.extraRate === smeltNoRelic.data.extraRate && smeltRelic.data.gold === smeltNoRelic.data.gold &&
    smeltRelic.data.load.total === 4,
    JSON.stringify({ r1: smeltNoRelic.data.rate, r2: smeltRelic.data.rate, g1: smeltNoRelic.data.gold, g2: smeltRelic.data.gold }));
  check('残片不计入投料份数（load.total 与不带残片一致）',
    smeltRelic.data.load.total === 4 && smeltRelic.data.load.dominant === 'size',
    JSON.stringify(smeltRelic.data.load));
  // mythicMain 的底材池是 [钓速, 体型]，池外的 rare/double 即 2 条突破词缀
  // → 默认公式每片 10 - 2*0.5 = 9%，10 片 = 90%（不再是固定 100%）
  check('10 片残片 → 保留概率 = 10 × (10 - 2×0.5) = 90%',
    smeltRelic.data.relics === 10 && smeltRelic.data.breakthrough === 2 &&
    smeltRelic.data.perRelic === 9 && smeltRelic.data.retainChance === 90,
    JSON.stringify({ n: smeltRelic.data.relics, c: smeltRelic.data.retainChance, bt: smeltRelic.data.breakthrough }));
  // 保留结算断言：成功率设为 100% 必成功、公式设为常量 100 必保留，才能确定性检查「按原值保留池外词缀」
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 100, rateMax: 100, failPerMaterial: 0, retainFormula: '100' });
  await seed({ [mythicMain]: 1, [mythicSub]: 1, rope: 20, relic: 10 }, 200000);
  const smeltRetain = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicMain, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill', materials: [{ id: 'rope', qty: 4 }], relics: 10,
  });
  check('成功时保留池外（突破）词缀（按原值）',
    smeltRetain.status === 200 && smeltRetain.data.success === true && smeltRetain.data.retainOk === true &&
    sortAff(smeltRetain.data.retained) === sortAff([{ type: 'rare', value: 5 }, { type: 'double', value: 9 }]),
    JSON.stringify(smeltRetain.data.retained));
  check('保留后的主件 = 选中 2 条 + 补缀 1 条 + 保留的 2 条池外词缀（按类型去重）',
    !!smeltRetain.data.item && smeltRetain.data.item.affixes.length === 5 &&
    smeltRetain.data.item.affixes.filter(a => a.extra).length === 3 &&
    smeltRetain.data.item.affixes.some(a => a.type === 'rare' && a.value === 5) &&
    smeltRetain.data.item.affixes.some(a => a.type === 'double' && a.value === 9),
    JSON.stringify(smeltRetain.data.item && smeltRetain.data.item.affixes));
  check('保留不影响品质（熔炼结果仍是神话件，可继续重铸）',
    !!smeltRetain.data.item && smeltRetain.data.item.quality === 'mythic' && D.canRecast(smeltRetain.data.item),
    JSON.stringify({ q: smeltRetain.data.item && smeltRetain.data.item.quality }));
  check('残片按片数消耗（10 片全扣）',
    smeltRetain.data.inventory.relic === undefined, JSON.stringify({ relic: smeltRetain.data.inventory.relic }));
  // 失败时残片同样烧掉（与投料/副件一致）；v0.13 起投入残片还会**保护主件选中的那条词条**
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 0, failPerMaterial: 0, rateMin: 0 });
  await seed({ [mythicMain]: 1, [mythicSub]: 1, relic: 4 }, 200000);
  const smeltRelicFail = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicMain, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill', relics: 4,
  });
  check('失败时残片也消耗（4 片全烧）',
    smeltRelicFail.status === 200 && smeltRelicFail.data.success === false &&
    smeltRelicFail.data.inventory.relic === undefined,
    JSON.stringify({ inv: smeltRelicFail.data.inventory }));
  check('投入残片后失败不再熔毁主件选中的词条（残片新增的保护效果）',
    smeltRelicFail.data.protectAffix === true && smeltRelicFail.data.removedAffix === null &&
    !!smeltRelicFail.data.mainAfter && smeltRelicFail.data.mainAfter.affixes.length === 4,
    JSON.stringify({ p: smeltRelicFail.data.protectAffix, r: smeltRelicFail.data.removedAffix, n: smeltRelicFail.data.mainAfter && smeltRelicFail.data.mainAfter.affixes.length }));
  // 未投入残片时仍照旧熔掉选中词条（保护只由残片提供）
  await seed({ [mythicMain]: 1, [mythicSub]: 1 }, 200000);
  const smeltNoRelicFail = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicMain, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill',
  });
  check('未投入残片时失败仍熔掉选中词条（保护效果专属于残片）',
    smeltNoRelicFail.status === 200 && smeltNoRelicFail.data.success === false &&
    smeltNoRelicFail.data.protectAffix === false && smeltNoRelicFail.data.removedAffix === 'speed' &&
    !!smeltNoRelicFail.data.mainAfter && smeltNoRelicFail.data.mainAfter.affixes.length === 3,
    JSON.stringify({ p: smeltNoRelicFail.data.protectAffix, r: smeltNoRelicFail.data.removedAffix, n: smeltNoRelicFail.data.mainAfter && smeltNoRelicFail.data.mainAfter.affixes.length }));
  // —— 校验类拒绝 ——
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 100, rateMax: 100, failPerMaterial: 0 });
  await seed({ [mainComp]: 1, [subComp]: 1, relic: 20 }, 200000);
  const relicNonMythic = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill', relics: 3,
  });
  check('非神话主件投入残片被拒（只有海王遗匣产出可保留）',
    relicNonMythic.status === 400 && /海王遗匣/.test(relicNonMythic.data.error || ''), JSON.stringify(relicNonMythic.data));
  // 神话但没有池外词缀的主件（底材池内词条）→ 没有可保留的词条
  const mythicPoolOnly = D.instanceId('rod_bamboo', 'mythic', [{ type: 'speed', value: 12 }, { type: 'size', value: 3 }]);
  await seed({ [mythicPoolOnly]: 1, [mythicSub]: 1, relic: 20 }, 200000);
  const relicNoExtra = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicPoolOnly, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill', relics: 3,
  });
  check('神话主件但没有池外词缀时投入残片被拒',
    relicNoExtra.status === 400 && /没有池外/.test(relicNoExtra.data.error || ''), JSON.stringify(relicNoExtra.data));
  await seed({ [mythicMain]: 1, [mythicSub]: 1, relic: 2 }, 200000);
  const relicTooMany = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicMain, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill', relics: 11,
  });
  check('残片超过单次上限被拒（最多 10 片）',
    relicTooMany.status === 400 && /最多投入 10 片/.test(relicTooMany.data.error || ''), JSON.stringify(relicTooMany.data));
  await seed({ [mythicMain]: 1, [mythicSub]: 1, relic: 2 }, 200000);
  const relicShort = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mythicMain, subId: mythicSub, mainAffix: 'speed', subAffix: 'skill', relics: 5,
  });
  check('残片不足被拒',
    relicShort.status === 400 && /残片不足/.test(relicShort.data.error || ''), JSON.stringify(relicShort.data));
  // v0.13：残片保留参数改为「公式 + 上限」；公式可被后台改写（breakthrough = 主件突破词缀条数）
  const retainCfg = await POST(BASE + '/api/admin/smelt/config', { token: TOKA, retainFormula: '25 - breakthrough', retainMaxRelic: 4 });
  check('后台可调残片保留参数（公式 25-breakthrough / 上限 4 片）',
    retainCfg.status === 200 && retainCfg.data.smeltCfg.retainFormula === '25 - breakthrough' && retainCfg.data.smeltCfg.retainMaxRelic === 4,
    JSON.stringify(retainCfg.data.smeltCfg && { f: retainCfg.data.smeltCfg.retainFormula, m: retainCfg.data.smeltCfg.retainMaxRelic }));
  const retainCfgBad = await POST(BASE + '/api/admin/smelt/config', { token: TOKA, retainFormula: '10 - nosuchvar * 2' });
  check('保留概率公式引用未知变量被拒 400',
    retainCfgBad.status === 400 && /未知变量/.test(retainCfgBad.data.error || ''), JSON.stringify(retainCfgBad.data));
  const retainCfgBad2 = await POST(BASE + '/api/admin/smelt/config', { token: TOKA, retainFormula: '10 -' });
  check('保留概率公式语法错误被拒 400', retainCfgBad2.status === 400, JSON.stringify(retainCfgBad2.data));
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, retainFormula: '10 - breakthrough * 0.5' });
  // 后台配置
  check('非管理员改熔炼参数 403', (await POST(BASE + '/api/admin/smelt/config', { token: TOKP, baseRate: 50 })).status === 403);
  const smeltReset = await POST(BASE + '/api/admin/smelt/config', { token: TOKA, reset: true });
  check('恢复默认熔炼参数（基础 50% / 投料 -2 失败率）',
    smeltReset.status === 200 && smeltReset.data.smeltCfg.baseRate === 50 && smeltReset.data.smeltCfg.failPerMaterial === -2,
    JSON.stringify(smeltReset.data.smeltCfg));
  const smeltBad = await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 500 });
  check('熔炼参数越界被拒 400', smeltBad.status === 400, JSON.stringify(smeltBad.data));

  // ==========================================================================
  section('⑥e 工坊熔炼 · 副件区间 / 补缀越池与词条数上限（v0.11.5）');
  // 数据层：副件区间取自副件底材池（龙骨巨竿 技巧 8~14）
  check('数据层：副件搬来的词缀按副件区间取值（技巧 = 龙骨巨竿 8~14）',
    JSON.stringify(D.smeltRangeOf('rod_bamboo', 'rod_dragonbone', 'sub', 'skill')) === JSON.stringify([8, 14]),
    JSON.stringify(D.smeltRangeOf('rod_bamboo', 'rod_dragonbone', 'sub', 'skill')));
  check('数据层：主件选中的词缀仍按主件区间（钓速 = 竹制短竿 8~14）',
    JSON.stringify(D.smeltRangeOf('rod_bamboo', 'rod_dragonbone', 'main', 'speed')) === JSON.stringify([8, 14]),
    JSON.stringify(D.smeltRangeOf('rod_bamboo', 'rod_dragonbone', 'main', 'speed')));
  check('数据层：补缀词缀按池外（突破）区间取值（钓速池外 4~10，与主件池内 8~14 不同）',
    JSON.stringify(D.smeltRangeOf('rod_bamboo', 'rod_dragonbone', 'add', 'speed')) === JSON.stringify([4, 10]),
    JSON.stringify(D.smeltRangeOf('rod_bamboo', 'rod_dragonbone', 'add', 'speed')));
  check('数据层：补缀候选 = 全部词缀类型里结果还没有的那些（不再受底材池限制）',
    D.smeltAddableAffixes('rod_bamboo', ['speed', 'skill']).indexOf('double') >= 0 &&
    D.smeltAddableAffixes('rod_bamboo', ['speed', 'skill']).indexOf('rare') >= 0 &&
    D.smeltAddableAffixes('rod_bamboo', ['speed', 'skill']).indexOf('material') >= 0,
    JSON.stringify(D.smeltAddableAffixes('rod_bamboo', ['speed', 'skill'])));
  // 后台改底材/池外区间是否真正生效，看服务器回传的 ranges（见下段）；
  // 本文件顶部的 D 是**测试进程**里独立加载的一份 data.js，看不到服务器进程的配置改动。
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, baseRate: 100, rateMax: 100, failPerMaterial: 0, extraRatePerMaterial: 100, extraRateMax: 100, addAffixCap: 3 });
  const smeltWith = (body) => POST(BASE + '/api/workshop/smelt', Object.assign({
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill',
  }, body));
  // 后台改副件底材区间 → 副件搬词区间随之变化（证明副件区间用的是可配的底材区间，而非写死值）
  await POST(BASE + '/api/admin/component/config', { token: TOKA, affixRanges: { rod_dragonbone: { skill: [9, 13] } } });
  await seed({ [mainComp]: 1, [subComp]: 1 }, 200000);
  const smeltSubRng = await smeltWith({});
  check('后台改副件底材区间后，副件搬词区间同步（技巧 8~14 → 9~13）',
    smeltSubRng.status === 200 && JSON.stringify(smeltSubRng.data.ranges.sub) === JSON.stringify([9, 13]) &&
    smeltSubRng.data.item.affixes.every(a => a.type !== 'skill' || (a.value >= 9 && a.value <= 13)),
    JSON.stringify({ range: smeltSubRng.data.ranges && smeltSubRng.data.ranges.sub, affs: smeltSubRng.data.item && smeltSubRng.data.item.affixes }));
  await POST(BASE + '/api/admin/component/config', { token: TOKA, affixRanges: {} });
  // 后台改「池外词缀数值区间」→ 补缀区间同步（证明补缀用的就是宝匣突破件那套区间，不是独立副本）
  await POST(BASE + '/api/admin/component/config', { token: TOKA, extraAffixRanges: { double: [6, 7] } });
  await seed({ [mainComp]: 1, [subComp]: 1, dragon_scale: 4 }, 200000);
  const smeltAddRng = await smeltWith({ materials: [{ id: 'dragon_scale', qty: 2 }] });
  check('后台改池外区间后，补缀区间同步（双钓 3~8 → 6~7）且补出的数值落在新区间',
    smeltAddRng.status === 200 && smeltAddRng.data.extraType === 'double' && smeltAddRng.data.extraOk &&
    JSON.stringify(smeltAddRng.data.ranges.add) === JSON.stringify([6, 7]) &&
    smeltAddRng.data.item.affixes.every(a => a.type !== 'double' || (a.value >= 6 && a.value <= 7)),
    JSON.stringify({ range: smeltAddRng.data.ranges && smeltAddRng.data.ranges.add, affs: smeltAddRng.data.item && smeltAddRng.data.item.affixes }));
  await POST(BASE + '/api/admin/component/config', { token: TOKA, extraAffixRanges: {} });

  // 服务端执行：补一条**主件池外**的词缀（竹制短竿池 = 钓速/体型；补「双钓」= 池外），
  // 验证补缀成功、数值落在池外区间 [3,8]、结果词条数 3 条
  await seed({ [mainComp]: 1, [subComp]: 1, dragon_scale: 4 }, 200000);
  const smeltAny = await smeltWith({ materials: [{ id: 'dragon_scale', qty: 2 }] });
  check('补缀可越过底材池边界（补出主件池外的「双钓」词缀）',
    smeltAny.status === 200 && smeltAny.data.success && smeltAny.data.extraOk && smeltAny.data.extraType === 'double' &&
    !!smeltAny.data.item && smeltAny.data.item.affixes.some(a => a.type === 'double' && a.extra === true),
    JSON.stringify(smeltAny.data && { t: smeltAny.data.extraType, affs: smeltAny.data.item && smeltAny.data.item.affixes }));
  check('池外补缀的数值落在池外区间（双钓 3~8），且响应回传三条词缀各自的区间',
    !!smeltAny.data.item && smeltAny.data.item.affixes.every(a => a.type !== 'double' || (a.value >= 3 && a.value <= 8)) &&
    JSON.stringify(smeltAny.data.ranges.add) === JSON.stringify([3, 8]) &&
    JSON.stringify(smeltAny.data.ranges.sub) === JSON.stringify([8, 14]),
    JSON.stringify({ add: smeltAny.data.ranges && smeltAny.data.ranges.add, sub: smeltAny.data.ranges && smeltAny.data.ranges.sub }));
  // 词条数上限突破：稀有件品质上限 2，但补缀后允许到 3
  const rareMain = D.instanceId('rod_bamboo', 'rare', [{ type: 'speed', value: 12 }, { type: 'size', value: 3 }]);
  await seed({ [rareMain]: 1, [subComp]: 1, dragon_scale: 4 }, 200000);
  const smeltCap3 = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: rareMain, subId: subComp, mainAffix: 'speed', subAffix: 'skill', materials: [{ id: 'dragon_scale', qty: 2 }],
  });
  check('词条数上限可突破至 3（稀有件品质上限为 2，熔炼后 3 条）',
    smeltCap3.status === 200 && smeltCap3.data.success && !!smeltCap3.data.item &&
    smeltCap3.data.item.affixes.length === 3 && smeltCap3.data.item.quality === 'rare',
    JSON.stringify(smeltCap3.data.item && { q: smeltCap3.data.item.quality, n: smeltCap3.data.item.affixes.length }));
  // 词条数上限可后台收紧到 2 → 补缀被拒
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, addAffixCap: 2 });
  await seed({ [mainComp]: 1, [subComp]: 1, dragon_scale: 4 }, 200000);
  const smeltCap2 = await smeltWith({ materials: [{ id: 'dragon_scale', qty: 2 }] });
  check('补缀后词条数超过上限（上限收到 2）被拒',
    smeltCap2.status === 400 && /超过上限|上限/.test(smeltCap2.data.error || ''), JSON.stringify(smeltCap2.data));
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, addAffixCap: 3 });

  // 后台可关闭「副件区间」与「补缀按池外区间」→ 回退旧行为（都看服务器回传的 ranges）
  const v115Cfg = await POST(BASE + '/api/admin/smelt/config', {
    token: TOKA, subRangeFromSub: false, addAnyAffix: true, addAffixCap: 3, addAffixExtraRange: false,
  });
  check('后台可配置词缀搬移与补缀三项开关',
    v115Cfg.status === 200 && v115Cfg.data.smeltCfg.subRangeFromSub === false &&
    v115Cfg.data.smeltCfg.addAnyAffix === true && v115Cfg.data.smeltCfg.addAffixCap === 3 &&
    v115Cfg.data.smeltCfg.addAffixExtraRange === false, JSON.stringify(v115Cfg.data.smeltCfg));
  // 关闭「副件区间」：副件选「体型」→ 体型在**主件**池内 → 用主件区间 [-6,4]（不再是副件的 [4,12]）
  await seed({ [mainComp]: 1, [subComp]: 1 }, 200000);
  const smeltSubOff = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'size',
  });
  check('关闭「副件区间」后回退旧行为（主件池内按主件区间：体型 -6~4 而非副件的 4~12）',
    smeltSubOff.status === 200 && JSON.stringify(smeltSubOff.data.ranges.sub) === JSON.stringify([-6, 4]),
    JSON.stringify(smeltSubOff.data.ranges));
  // 关闭「补缀按池外区间」：补「体型」（在主件池内）→ 用主件区间 [-6,4]（池外的双钓仍用池外区间）
  await seed({ [mainComp]: 1, [subComp]: 1, rope: 4 }, 200000);
  const smeltAddOff = await smeltWith({ materials: [{ id: 'rope', qty: 2 }] });
  check('关闭「补缀按池外区间」后回退旧行为（主件池内按主件区间：体型 -6~4）',
    smeltAddOff.status === 200 && smeltAddOff.data.extraType === 'size' &&
    JSON.stringify(smeltAddOff.data.ranges.add) === JSON.stringify([-6, 4]),
    JSON.stringify({ t: smeltAddOff.data.extraType, r: smeltAddOff.data.ranges && smeltAddOff.data.ranges.add }));
  await seed({ [mainComp]: 1, [subComp]: 1, dragon_scale: 4 }, 200000);
  const smeltAddOffOut = await smeltWith({ materials: [{ id: 'dragon_scale', qty: 2 }] });
  check('关闭「补缀按池外区间」时，池外词缀仍按池外区间（双钓 3~8）',
    smeltAddOffOut.status === 200 && smeltAddOffOut.data.extraType === 'double' &&
    JSON.stringify(smeltAddOffOut.data.ranges.add) === JSON.stringify([3, 8]),
    JSON.stringify(smeltAddOffOut.data.ranges));
  // 关闭「补缀不受底材池限制」→ 池外词缀不再可补（候选退回主件池内）
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, addAnyAffix: false });
  await seed({ [mainComp]: 1, [subComp]: 1, dragon_scale: 4 }, 200000);
  const smeltPoolOnly = await smeltWith({ materials: [{ id: 'dragon_scale', qty: 2 }] });
  check('关闭「补缀不受底材池限制」后，池外词缀不可补缀（候选退回主件池内）',
    smeltPoolOnly.status === 400 && /无法补进|池/.test(smeltPoolOnly.data.error || ''), JSON.stringify(smeltPoolOnly.data));
  await POST(BASE + '/api/admin/smelt/config', { token: TOKA, subRangeFromSub: true, addAnyAffix: true, addAffixExtraRange: true });
  check('词缀搬移与补缀开关越界值被拒（addAffixCap 不在 1~6）',
    (await POST(BASE + '/api/admin/smelt/config', { token: TOKA, addAffixCap: 9 })).status === 400);
  check('非管理员改 v0.11.5 熔炼开关 403',
    (await POST(BASE + '/api/admin/smelt/config', { token: TOKP, subRangeFromSub: false })).status === 403);
  const v115Reset = await POST(BASE + '/api/admin/smelt/config', { token: TOKA, reset: true });
  check('恢复默认含 v0.11.5 开关（副件区间 / 任意补缀 / 上限 3 / 补缀按池外区间）',
    v115Reset.status === 200 && v115Reset.data.smeltCfg.subRangeFromSub === true &&
    v115Reset.data.smeltCfg.addAnyAffix === true && v115Reset.data.smeltCfg.addAffixCap === 3 &&
    v115Reset.data.smeltCfg.addAffixExtraRange === true, JSON.stringify(v115Reset.data.smeltCfg));

  // ==========================================================================
  section('⑦ 钓点地图坐标（后台可改）');
  const grounds0 = await GET(BASE + '/api/grounds');
  const dockPos = grounds0.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock').pos;
  check('内置钓点带出厂坐标', Array.isArray(dockPos) && dockPos.length === 2, JSON.stringify(dockPos));
  check('非管理员改坐标 403', (await POST(BASE + '/api/admin/spot/pos', { token: TOKP, groundId: 'stillwater', list: [{ spotId: 'dock', pos: [10, 10] }] })).status === 403);
  const setPos = await POST(BASE + '/api/admin/spot/pos', { token: TOKA, groundId: 'stillwater', list: [{ spotId: 'dock', pos: [12.5, 34.5] }] });
  check('保存钓点坐标成功', setPos.status === 200 && setPos.data.changed === 1, JSON.stringify(setPos.data).slice(0, 120));
  const grounds1 = await GET(BASE + '/api/grounds');
  const dockPos1 = grounds1.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock').pos;
  check('玩家端目录立即更新（且只改这一个钓点）',
    dockPos1[0] === 12.5 && dockPos1[1] === 34.5 &&
    grounds1.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'reef' || s.id === 'reed').pos[0] === grounds0.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'reed').pos[0],
    JSON.stringify(dockPos1));
  await POST(BASE + '/api/admin/spot/pos', { token: TOKA, groundId: 'stillwater', list: [{ spotId: 'dock', pos: [-50, 500] }] });
  const dockClamp = (await GET(BASE + '/api/grounds')).data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock').pos;
  check('越界坐标被夹到 2~98', dockClamp[0] === 2 && dockClamp[1] === 98, JSON.stringify(dockClamp));
  check('非法坐标格式被拒 400', (await POST(BASE + '/api/admin/spot/pos', { token: TOKA, groundId: 'stillwater', list: [{ spotId: 'dock', pos: ['a', 'b'] }] })).status === 400);
  await POST(BASE + '/api/admin/spot/pos', { token: TOKA, groundId: 'stillwater', list: [{ spotId: 'dock', pos: null }] });
  const dockReset = (await GET(BASE + '/api/grounds')).data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock').pos;
  check('pos=null 恢复出厂坐标', dockReset[0] === 61 && dockReset[1] === 34, JSON.stringify(dockReset));

  // ==========================================================================
  // v0.13：原「服务端优雅版本更新」功能已整体删除（后台入口 + 前端横幅 + 服务端接口）
  section('⑧ 版本更新功能已移除');
  check('后台更新列表接口不存在（404）', (await GET(BASE + '/api/admin/update/list?token=' + encodeURIComponent(TOKA))).status === 404);
  check('发布更新接口不存在（404）', (await POST(BASE + '/api/admin/update/start', { token: TOKA, bat: 'run.bat', dryRun: true })).status === 404);
  check('取消更新接口不存在（404）', (await POST(BASE + '/api/admin/update/cancel', { token: TOKA })).status === 404);
  const worldNoUpd = await GET(BASE + '/api/admin/world?token=' + encodeURIComponent(TOKA));
  check('后台 world 不再下发 updateBats / updateState',
    worldNoUpd.data.updateBats === undefined && worldNoUpd.data.updateState === undefined,
    JSON.stringify({ b: worldNoUpd.data.updateBats, s: worldNoUpd.data.updateState }));
  check('版本接口不再下发更新中状态', (await GET(BASE + '/api/version')).data.update === undefined);

  // ==========================================================================
  section('⑨ 存档修复脚本');
  const FIX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-fix-test-'));
  fs.mkdirSync(path.join(FIX_DIR, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(FIX_DIR, 'accounts', 'old.json'), JSON.stringify({
    username: 'old', name: '老存档', coins: 5,
    inventory: { 'reel_turbo#rare#big-8,spd+30': 2, crucian: 1 },
    bd: { rod: { compId: 'rod_dragonbone#epic#size+8,big+10,spd-12', name: '旧名', affixes: [], rare: 'big' } },
    rodSlots: [null, { name: '旧竿', bd: { hook: { compId: 'hook_steel#rare#big+8,spd-5', name: 'x', affixes: [], rare: 'big' } } }],
  }, null, 2));
  fs.writeFileSync(path.join(FIX_DIR, 'market.json'), JSON.stringify({ listingSeq: 2, listings: [{ lid: 1, seller: 'old', id: 'reel_turbo#rare#big-8,spd+30', name: '旧', qty: 1, price: 9 }] }));
  fs.writeFileSync(path.join(FIX_DIR, 'economy.json'), JSON.stringify({ shopSales: { crucian: { m: 1 }, ghost: { m: 1 } }, priceLog: { ghost: [] }, tradeLog: {} }));
  const fixRun = spawnSync(NODE, [path.join('tools', 'fix-save-v011.js'), '--data', FIX_DIR, '--no-backup'], { cwd: ROOT, encoding: 'utf8' });
  check('修复脚本零错误退出', fixRun.status === 0, String(fixRun.status) + ' ' + (fixRun.stderr || '').slice(0, 200));
  const fixedAcc = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'accounts', 'old.json'), 'utf8'));
  check('背包里的旧签名已改为 skl 规范形',
    !!fixedAcc.inventory['reel_turbo#rare#spd+30,skl-8'] && fixedAcc.inventory['reel_turbo#rare#big-8,spd+30'] === undefined,
    JSON.stringify(fixedAcc.inventory));
  check('装配与钓竿槽位一起修复并刷新名称/品质',
    fixedAcc.bd.rod.compId === 'rod_dragonbone#epic#skl+10,size+8,spd-12' && fixedAcc.bd.rod.rare === 'epic' &&
    fixedAcc.rodSlots[1].bd.hook.compId === 'hook_steel#rare#skl+8,spd-5',
    JSON.stringify({ bd: fixedAcc.bd.rod, slot: fixedAcc.rodSlots[1].bd.hook.compId }));
  const fixedMarket = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'market.json'), 'utf8'));
  check('市集挂单 id 已规范化', fixedMarket.listings[0].id === 'reel_turbo#rare#spd+30,skl-8', fixedMarket.listings[0].id);
  const fixedEco = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'economy.json'), 'utf8'));
  check('经济域清理失效键', !fixedEco.shopSales.ghost && !fixedEco.priceLog.ghost && !!fixedEco.shopSales.crucian);
  const fixAgain = spawnSync(NODE, [path.join('tools', 'fix-save-v011.js'), '--data', FIX_DIR, '--no-backup'], { cwd: ROOT, encoding: 'utf8' });
  check('脚本幂等（二次运行报告无需修复）', fixAgain.status === 0 && /无需修复/.test(fixAgain.stdout), (fixAgain.stdout || '').slice(-120));
  const dryRunOut = spawnSync(NODE, [path.join('tools', 'fix-save-v011.js'), '--data', FIX_DIR, '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  check('--dry-run 不写盘（演练提示）', dryRunOut.status === 0 && /演练/.test(dryRunOut.stdout), (dryRunOut.stdout || '').slice(0, 80));

  // ==========================================================================
  section('⑨b 启动迁移：钓竿槽位 / 整竿挂单里的旧签名');
  {
    // 直接往数据目录里放一份「旧版存档」（含钓竿槽位与整竿挂单），重启服务器后应由启动迁移规范化
    const migKey = 'v_legacy';
    const legacyPart = 'reel_turbo#rare#spd+37,big-5';
    const legacyRod = 'rodset:reel=' + legacyPart;
    fs.writeFileSync(path.join(TMP_DATA, 'accounts', migKey + '.json'), JSON.stringify({
      username: migKey, name: '旧存档', salt: 'x', pass: 'y', coins: 10,
      inventory: { [legacyPart]: 2, crucian: 1 },
      bd: {},
      rodSlots: [null, { name: '旧竿', bd: { reel: { compId: legacyPart, name: '旧', affixes: [], rare: 'rare' } } }],
    }, null, 2));
    // market.json 可能还没落盘（没人动过市集）：按需创建
    const mkPath = path.join(TMP_DATA, 'market.json');
    const mk = fs.existsSync(mkPath) ? JSON.parse(fs.readFileSync(mkPath, 'utf8')) : { listingSeq: 1, listings: [] };
    mk.listings = (mk.listings || []).concat([{ lid: 9001, seller: migKey, sellerName: '旧存档', id: legacyRod, name: '整根钓竿（1 件）', qty: 1, price: 100, t: Date.now(), expireAt: Date.now() + 3600000, hours: 6 }]);
    fs.writeFileSync(mkPath, JSON.stringify(mk, null, 2));
    await flushWait();  // 等过落盘防抖（saveAccount 1s / saveSessions 2s）
    killTree(srv); srv = null;
    await new Promise(r => setTimeout(r, 400));
    check('重启（加载旧存档）成功', await startServer());
    // 启动迁移只改内存 + 标记脏，真正写盘走 1 秒防抖（saveAccount → flushAccounts）；
    // 这里轮询等待迁移结果落盘，而不是重启后立刻读文件（否则读到的还是迁移前的旧内容）。
    const migAccPath = path.join(TMP_DATA, 'accounts', migKey + '.json');
    await waitFor(function () {
      try {
        const a = JSON.parse(fs.readFileSync(migAccPath, 'utf8'));
        return !!(a.inventory && a.inventory['reel_turbo#rare#spd+37,skl-5'] && !a.inventory[legacyPart]);
      } catch (e) { return false; }
    }, { timeout: 6000 });
    const migAcc = JSON.parse(fs.readFileSync(migAccPath, 'utf8'));
    check('启动迁移规范化了背包键', !!migAcc.inventory['reel_turbo#rare#spd+37,skl-5'] && !migAcc.inventory[legacyPart],
      JSON.stringify(Object.keys(migAcc.inventory)));
    check('启动迁移规范化了钓竿槽位里的配件',
      !!(migAcc.rodSlots && migAcc.rodSlots[1] && migAcc.rodSlots[1].bd && migAcc.rodSlots[1].bd.reel &&
         migAcc.rodSlots[1].bd.reel.compId === 'reel_turbo#rare#spd+37,skl-5'),
      JSON.stringify(migAcc.rodSlots && migAcc.rodSlots[1]));
    const mkAfter = JSON.parse(fs.readFileSync(mkPath, 'utf8'));
    const rodListing = (mkAfter.listings || []).find(function (l) { return l.lid === 9001; });
    check('启动迁移规范化了整竿挂单（含内部配件签名）',
      !!rodListing && rodListing.id === 'rodset:reel=reel_turbo#rare#spd+37,skl-5', rodListing && rodListing.id);
    fs.unlinkSync(path.join(TMP_DATA, 'accounts', migKey + '.json'));
    const mkClean = JSON.parse(fs.readFileSync(mkPath, 'utf8'));
    mkClean.listings = (mkClean.listings || []).filter(function (l) { return l.lid !== 9001; });
    fs.writeFileSync(mkPath, JSON.stringify(mkClean, null, 2));
  }

  // ==========================================================================
  section('⑥b 工坊 · 重铸（沉船宝匣残片重 roll 神话件词条）');
  {
    const myth = D.instanceId('rod_bamboo', 'mythic', [{ type: 'speed', value: 9 }, { type: 'size', value: 3 }, { type: 'skill', value: 4 }, { type: 'rare', value: 2 }]);
    const epicComp = D.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: 9 }, { type: 'size', value: 3 }]);
    await seed({}, 100000);
    const ws2 = await GET(BASE + '/api/workshop?token=' + encodeURIComponent(TOKP));
    check('工坊接口下发重铸参数（材料自动识别：只列残片）',
      !!ws2.data.recast && ws2.data.recast.relicId === 'relic' && ws2.data.recast.relicNeed === 10 && ws2.data.recast.quality === 'mythic',
      JSON.stringify(ws2.data.recast));
    check('非神话组件不可重铸', (await (async function () {
      await seed({ [epicComp]: 1, relic: 50 }, 100000);
      return POST(BASE + '/api/workshop/recast', { token: TOKP, id: epicComp });
    })()).status === 400);
    // 残片不足 → 拒绝
    await seed({ [myth]: 1, relic: 3 }, 100000);
    const poor = await POST(BASE + '/api/workshop/recast', { token: TOKP, id: myth });
    check('残片不足被拒', poor.status === 400 && /残片不足/.test(poor.data.error || ''), JSON.stringify(poor.data));
    // 正常重铸：词条类型与条数不变、数值重 roll、扣 10 残片
    await seed({ [myth]: 1, relic: 12 }, 100000);
    const before = D.componentOf(myth);
    const rc = await POST(BASE + '/api/workshop/recast', { token: TOKP, id: myth });
    check('重铸成功', rc.status === 200 && !!rc.data.item, JSON.stringify(rc.data).slice(0, 140));
    const after = rc.data.item;
    check('重铸保持品质 / 底材 / 词条类型与条数',
      after.quality === before.quality && after.baseId === before.baseId &&
      after.affixes.length === before.affixes.length &&
      after.affixes.every(function (a, i) { return a.type === before.affixes[i].type; }),
      JSON.stringify({ before: before.affixes, after: after.affixes }));
    check('重铸消耗残片（12 → 2）', rc.data.inventory.relic === 2, JSON.stringify(rc.data.inventory));
    check('重铸消耗旧件、产出新件',
      rc.data.inventory[myth] === undefined && rc.data.inventory[after.id] === 1, JSON.stringify(rc.data.inventory));
    check('重铸返回前后对照', Array.isArray(rc.data.before) && rc.data.before.length === before.affixes.length,
      JSON.stringify(rc.data.before));
    // 池外词缀仍按池外区间取值（技巧在竹制短竿池外 → 2~6）
    const skillAff = after.affixes.find(function (a) { return a.type === 'skill'; });
    check('重铸后池外词缀仍落在池外区间内', !!skillAff && skillAff.value >= 2 && skillAff.value <= 6, JSON.stringify(skillAff));
    // 后台可改重铸参数
    check('非管理员改重铸参数 403', (await POST(BASE + '/api/admin/smelt/config', { token: TOKP, recastRelic: 5 })).status === 403);
    const setRc = await POST(BASE + '/api/admin/smelt/config', { token: TOKA, recastRelic: 4, recastGold: 100, recastMinValue: 1 });
    check('保存重铸参数（4 残片 + 100 金币 + 保底不降级）',
      setRc.status === 200 && setRc.data.smeltCfg.recastRelic === 4 && setRc.data.smeltCfg.recastMinValue === 1,
      JSON.stringify(setRc.data.smeltCfg));
    const ws3 = await GET(BASE + '/api/workshop?token=' + encodeURIComponent(TOKP));
    check('玩家端看到新重铸花费', ws3.data.recast.relicNeed === 4 && ws3.data.recast.gold === 100 && ws3.data.recast.minValue === true,
      JSON.stringify(ws3.data.recast));
    // 金币不足：先把残片补够（否则会先报残片不足），再把金币压到阈值以下
    await seed({ [after.id]: 1, relic: 10 }, 50);
    const gc = await POST(BASE + '/api/workshop/recast', { token: TOKP, id: after.id });
    check('金币不足时被拒', gc.status === 400 && /金币不足/.test(gc.data.error || ''), JSON.stringify(gc.data));
    // 恢复默认，避免影响后续用例
    await POST(BASE + '/api/admin/smelt/config', { token: TOKA, reset: true });
  }

  // ==========================================================================
  section('⑥c 渔获纪录贴图：后台可调缩放（≤500%）与 xy 偏移');
  {
    const w1 = await GET(BASE + '/api/admin/world?token=' + encodeURIComponent(TOKA));
    check('默认贴图设置（175% / 0,0）',
      w1.data.recordsCfg.scale === 175 && w1.data.recordsCfg.x === 0 && w1.data.recordsCfg.y === 0,
      JSON.stringify(w1.data.recordsCfg));
    check('缩放上限为 500%', (w1.data.recordsLimits || {}).scaleMax === 500, JSON.stringify(w1.data.recordsLimits));
    const bad = await POST(BASE + '/api/admin/records/config', { token: TOKA, scale: 900, x: 0, y: 0 });
    check('超过 500% 被拒', bad.status === 400 && /缩放/.test(bad.data.error || ''), JSON.stringify(bad.data));
    check('偏移越界被拒', (await POST(BASE + '/api/admin/records/config', { token: TOKA, scale: 200, x: 9999, y: 0 })).status === 400);
    check('非管理员改贴图设置 403', (await POST(BASE + '/api/admin/records/config', { token: TOKP, scale: 200 })).status === 403);
    const ok = await POST(BASE + '/api/admin/records/config', { token: TOKA, scale: 320, x: -24, y: 36 });
    check('保存 320% / -24,36 成功',
      ok.status === 200 && ok.data.recordsCfg.scale === 320 && ok.data.recordsCfg.x === -24 && ok.data.recordsCfg.y === 36,
      JSON.stringify(ok.data.recordsCfg));
    const ver = await GET(BASE + '/api/version');
    check('贴图设置随 /api/version 下发（玩家端即时生效）',
      ver.data.recordsCfg && ver.data.recordsCfg.scale === 320, JSON.stringify(ver.data.recordsCfg));
    check('恢复默认成功', (await POST(BASE + '/api/admin/records/config', { token: TOKA, reset: true })).data.recordsCfg.scale === 175);
  }

  // ==========================================================================
  section('⑨c 龙宫宝珠清理脚本');
  {
    const CLEAN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-pearl-test-'));
    fs.mkdirSync(path.join(CLEAN_DIR, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(CLEAN_DIR, 'records.json'), JSON.stringify({
      bigRecords: { dragonpearl: { id: 'dragonpearl', name: '龙宫宝珠', size: 28.5, who: '甲', t: 1 }, tuna: { id: 'tuna', name: '黄金枪鱼', size: 300, who: '乙', t: 2 } },
      smallRecords: { dragonpearl: { id: 'dragonpearl', name: '龙宫宝珠', size: 6, who: '丙', t: 3 } },
      topCatches: { dragonpearl: [{ size: 28.5, who: '甲', t: 1 }] },
      topSmall: { dragonpearl: [{ size: 6, who: '丙', t: 3 }] },
      globalMax: { id: 'dragonpearl', name: '龙宫宝珠', size: 28.5, who: '甲', t: 1 },
    }, null, 2));
    fs.writeFileSync(path.join(CLEAN_DIR, 'accounts', 'p.json'), JSON.stringify({
      username: 'p', coins: 1,
      codex: { dragonpearl: { count: 3, first: 1 }, tuna: { count: 1 } },
      autoSell: { items: { dragonpearl: { on: true, minPct: 150, keep: 0 }, tuna: { on: true, minPrice: 100, keep: 0 } } },
    }, null, 2));
    const dry = spawnSync(NODE, [path.join('tools', 'clean-dragonpearl.js'), '--data', CLEAN_DIR, '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
    check('清理脚本 --dry-run 不写盘', dry.status === 0 && /演练/.test(dry.stdout), (dry.stdout || '').slice(-80));
    check('演练未改动记录文件', !!JSON.parse(fs.readFileSync(path.join(CLEAN_DIR, 'records.json'), 'utf8')).bigRecords.dragonpearl);
    const run = spawnSync(NODE, [path.join('tools', 'clean-dragonpearl.js'), '--data', CLEAN_DIR, '--no-backup'], { cwd: ROOT, encoding: 'utf8' });
    check('清理脚本零错误退出', run.status === 0, String(run.status) + ' ' + (run.stderr || '').slice(0, 160));
    const rec = JSON.parse(fs.readFileSync(path.join(CLEAN_DIR, 'records.json'), 'utf8'));
    check('榜单里的龙宫宝珠被清空',
      !rec.bigRecords.dragonpearl && !rec.smallRecords.dragonpearl && !rec.topCatches.dragonpearl && !rec.topSmall.dragonpearl,
      JSON.stringify({ b: Object.keys(rec.bigRecords), s: Object.keys(rec.smallRecords) }));
    check('其他鱼种的纪录保留', !!rec.bigRecords.tuna);
    check('全场最大按剩余纪录重算（黄金枪鱼 300cm）',
      !!rec.globalMax && rec.globalMax.id === 'tuna' && rec.globalMax.size === 300, JSON.stringify(rec.globalMax));
    const acc = JSON.parse(fs.readFileSync(path.join(CLEAN_DIR, 'accounts', 'p.json'), 'utf8'));
    check('自动售出里的龙宫宝珠规则被清掉、其它规则保留',
      !(acc.autoSell.items || {}).dragonpearl && !!acc.autoSell.items.tuna, JSON.stringify(acc.autoSell));
    check('图鉴条目默认保留（--codex 才删）', !!acc.codex.dragonpearl, JSON.stringify(Object.keys(acc.codex)));
    const run2 = spawnSync(NODE, [path.join('tools', 'clean-dragonpearl.js'), '--data', CLEAN_DIR, '--no-backup', '--codex'], { cwd: ROOT, encoding: 'utf8' });
    const acc2 = JSON.parse(fs.readFileSync(path.join(CLEAN_DIR, 'accounts', 'p.json'), 'utf8'));
    check('--codex 会同时清掉图鉴条目', run2.status === 0 && !acc2.codex.dragonpearl, JSON.stringify(Object.keys(acc2.codex)));
    try { fs.rmSync(CLEAN_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  // ==========================================================================
  section('⑩ 重启后配置持久化');
  await flushWait();  // 等过落盘防抖（saveAccount 1s / saveSessions 2s）
  killTree(srv);
  srv = null;
  await waitFor(function () { return !srv && true; }, { timeout: 1000 });
  await new Promise(r => setTimeout(r, 400));
  const ok2 = await startServer();
  check('服务器重启成功', ok2);
  const lgP2 = await POST(BASE + '/api/login', { username: 'v_player', password: 'v123456' });
  const TOKP2 = lgP2.data && lgP2.data.token;
  const mallAfter = await GET(BASE + '/api/mall?token=' + encodeURIComponent(TOKP2));
  check('商城配置持久化（自定义商品与刷新时间仍在）',
    mallAfter.data.items.length === 1 && mallAfter.data.items[0].id === 'rope' && /^\d{1,2}:\d{2}$/.test(mallAfter.data.refreshTime),
    JSON.stringify(mallAfter.data).slice(0, 140));
  const wsAfter = await GET(BASE + '/api/workshop?token=' + encodeURIComponent(TOKP2));
  check('熔炼参数持久化（恢复默认后的 50% / -2）',
    wsAfter.data.cfg.baseRate === 50 && wsAfter.data.cfg.failPerMaterial === -2, JSON.stringify(wsAfter.data.cfg));
  const groundsAfter = await GET(BASE + '/api/grounds');
  check('钓点坐标持久化（dock 已恢复出厂 61,34）',
    groundsAfter.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock').pos[0] === 61,
    JSON.stringify(groundsAfter.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock').pos));
  const chestAfter = await GET(BASE + '/api/chest?token=' + encodeURIComponent(TOKP2));
  check('宝匣成本持久化（恢复出厂 100 / 300000）',
    chestAfter.data.chests.find(c => c.id === 'chest_king').costRelic === 100);
  const verAfter = await GET(BASE + '/api/version');
  check('纪录贴图设置持久化（恢复默认 175%）', verAfter.data.recordsCfg.scale === 175, JSON.stringify(verAfter.data.recordsCfg));

  // ==========================================================================
  section('⑪ 自动配装求解器（纯函数：前端与浏览器共用同一份）');
  const AB = (base, q, affs) => D.instanceId(base, q, affs);
  // 竿身两件：A 钓速 20；B 钓速 10 + 双钓 8（双钓更好、钓速更差）
  const abA = AB('rod_bamboo', 'common', [{ type: 'speed', value: 20 }]);
  const abB = AB('rod_bamboo', 'common', [{ type: 'speed', value: 10 }, { type: 'double', value: 8 }]);
  // 钩两件：C 双钓 12；D 技巧 9
  const abC = AB('hook_barb', 'common', [{ type: 'double', value: 12 }]);
  const abD = AB('hook_barb', 'common', [{ type: 'skill', value: 9 }]);
  const abCand = () => ({ rod: [abA, abB], hook: [abC, abD] });
  const abPlan = (o) => D.autoBuildPlan(Object.assign({ parts: ['rod', 'hook'], candidates: abCand() }, o));

  const p1 = abPlan({ order: ['speed', 'double'] });
  check('优先级：钓速优先 → 竿身取钓速最高的那件',
    p1.picks.rod === abA && p1.vec.speed === 20, JSON.stringify({ p: p1.picks, v: p1.vec }));
  const p2 = abPlan({ order: ['double', 'speed'] });
  check('优先级：双钓优先 → 竿身换成「钓速 10 + 双钓 8」那件',
    p2.picks.rod === abB && p2.vec.double === 20 && p2.vec.speed === 10, JSON.stringify({ p: p2.picks, v: p2.vec }));
  check('总属性 = 各部位逐项求和（双钓 8 + 12）', p2.vec.double === 20, JSON.stringify(p2.vec));
  const p3 = abPlan({ order: ['double', 'speed'], min: { speed: 20 } });
  check('目标下限生效：钓速 ≥ 20 时双钓让位（钓速 20 / 双钓 12）',
    p3.vec.speed === 20 && p3.vec.double === 12 && !Object.keys(p3.miss).length, JSON.stringify(p3.vec));
  const p4 = abPlan({ order: ['double', 'speed'], min: { speed: 99 } });
  check('目标配不出来时如实回报（relaxed=all + miss + 把该属性尽量做高）',
    p4.relaxed === 'all' && p4.miss.speed === 20 && p4.vec.speed === 20,
    JSON.stringify({ r: p4.relaxed, m: p4.miss, v: p4.vec }));
  check('目标上限生效（钓速 ≤ 10 → 只能选钓速 10 的那件）',
    abPlan({ order: ['speed', 'double'], max: { speed: 10 } }).vec.speed === 10, '');
  const p6 = abPlan({ order: ['speed', 'double'], max: { speed: 10 }, min: { speed: 20 } });
  check('上下限冲突 → 放宽上限并标注 relaxed=max（先保下限）',
    p6.relaxed === 'max' && p6.vec.speed === 20, JSON.stringify({ r: p6.relaxed, v: p6.vec }));
  check('未勾选的属性不参与目标比较',
    abPlan({ order: ['speed', 'double'], enabled: { speed: true, double: false } }).picks.rod === abA, '');
  check('可达上限探针：钓速 ≥ 20 约束下双钓最高 12',
    D.autoBuildPeek({ parts: ['rod', 'hook'], candidates: abCand(), min: { speed: 20 } }, 'double') === 12, '');
  check('可达上限探针：不限目标时钓速最高 20',
    D.autoBuildPeek({ parts: ['rod', 'hook'], candidates: abCand() }, 'speed') === 20, '');
  check('部位不匹配 / 非法候选 id 被忽略（只留下合法的那件）', (function () {
    const r = D.autoBuildPlan({ parts: ['rod'], candidates: { rod: [abC, 'null#common#spd+5', 'bogus', abA] } });
    return r.picks.rod === abA && r.vec.double === 0;
  })(), '');
  check('属性完全相同的两件只算一次（同向量去重）', (function () {
    const dup = AB('rod_bamboo', 'common', [{ type: 'speed', value: 20 }]);
    const r = D.autoBuildPlan({ parts: ['rod'], candidates: { rod: [abA, dup] } });
    return r.vec.speed === 20 && r.picks.rod === abA;
  })(), '');
  const abBig = (function () {
    const cands = {};
    D.ROD_PARTS.forEach(function (p) {
      const base = D.COMPONENT_BASES.find(b => b.part === p.key).id;
      const arr = [];
      for (let i = 0; i < 60; i++) {
        arr.push(D.instanceId(base, 'epic', [
          { type: D.AFFIX_TYPES[i % 6], value: 1 + (i % 17) },
          { type: D.AFFIX_TYPES[(i + 3) % 6], value: (i % 5) - 2 },
        ]));
      }
      cands[p.key] = arr;
    });
    const t0 = Date.now();
    const r = D.autoBuildPlan({ candidates: cands, order: ['speed', 'double', 'skill', 'rare', 'material', 'size'] });
    return { ms: Date.now() - t0, ok: !!(r && r.picks && Object.keys(r.picks).length === 7) };
  })();
  check('7 部位 × 60 候选（420 件）也能在 1.5 秒内求解',
    abBig.ok && abBig.ms < 1500, JSON.stringify(abBig));

  // —— 目标上限在大背包下必须被遵守 + 可达区间（下限/上限探针）——
  // 回归：前沿按优先级字典序截断时，被截掉的尾巴恰好是「上限以内的最优解」，
  // solve 于是退回「放弃上限取最大」——面板上就是「上面设了钓速上限，下面仍按最高钓速显示」。
  const AB_ORD = ['speed', 'double', 'skill', 'rare', 'material', 'size'];
  const abCapCands = (function () {
    const cands = {};
    D.ROD_PARTS.forEach(function (p) {
      const base = D.COMPONENT_BASES.find(b => b.part === p.key).id;
      const arr = [];
      for (let i = 0; i < 60; i++) {
        arr.push(D.instanceId(base, 'epic', [
          { type: D.AFFIX_TYPES[i % 6], value: 10 + (i % 17) },
          { type: D.AFFIX_TYPES[(i + 3) % 6], value: (i % 5) - 2 },
        ]));
      }
      cands[p.key] = arr;
    });
    return cands;
  })();
  const abFree = D.autoBuildPlan({ candidates: abCapCands, order: AB_ORD });
  const abCapV = Math.max(1, Math.round(abFree.vec.speed * 0.6));
  const abCapSol = D.autoBuildPlan({ candidates: abCapCands, order: AB_ORD, max: { speed: abCapV } });
  check('大背包下目标上限被遵守（不再退回最高钓速）',
    abCapSol.relaxed === null && abCapSol.vec.speed <= abCapV && abCapSol.vec.speed > 0,
    JSON.stringify({ cap: abCapV, v: abCapSol.vec.speed, relaxed: abCapSol.relaxed }));
  check('上限以内仍贴着上限求最优（不是掉到极值）',
    abCapSol.vec.speed >= abCapV * 0.8, JSON.stringify({ cap: abCapV, v: abCapSol.vec.speed }));
  const abRngFree = D.autoBuildRange({ candidates: abCapCands, order: AB_ORD }, 'speed');
  const abRngCap = D.autoBuildRange({ candidates: abCapCands, order: AB_ORD, max: { speed: abCapV } }, 'skill');
  check('可达区间 = {下限, 上限}，无约束时包住最优解',
    !!abRngFree && abRngFree.max >= abRngFree.min && abRngFree.min <= abFree.vec.speed && abFree.vec.speed <= abRngFree.max,
    JSON.stringify({ r: abRngFree, v: abFree.vec.speed }));
  check('其余属性设了目标时，可达区间随之收紧但仍合法',
    !!abRngCap && abRngCap.max >= abRngCap.min && abRngCap.max > 0, JSON.stringify(abRngCap));
  check('上限低于可达下限时如实回报 relaxed=max（不假装配得出来）', (function () {
    const r = D.autoBuildPlan({ candidates: abCapCands, order: AB_ORD, max: { speed: abRngFree.min - 5 } });
    return r.relaxed === 'max';
  })(), '');
  check('可达区间探针不会拖慢一次面板刷新（6 属性 ×2 端点 < 1.2 秒）', (function () {
    const t0 = Date.now();
    D.AFFIX_TYPES.forEach(function (t) { D.autoBuildRange({ candidates: abCapCands, order: AB_ORD, maxStates: 80 }, t); });
    return Date.now() - t0 < 1200;
  })(), '');

  // ---- 收尾 ----
  await flushWait();  // 等过落盘防抖（saveAccount 1s / saveSessions 2s）
  killTree(srv);
  console.log('\n============================');
  console.log('v0.11 测试汇总：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：'); failed.forEach(f => console.log('  - ' + f)); }
  console.log(fail ? 'V011 TESTS FAILED' : 'V011 TESTS PASS');
  console.log('============================');
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(FIX_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常：', e);
  if (srv) killTree(srv);
  process.exit(1);
});
