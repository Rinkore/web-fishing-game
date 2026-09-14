/*
 * 宝匣合成（沉船打捞）端到端测试（纯 HTTP，可独立运行）
 * 覆盖：档位目录 / 合成（残片+金币，含批量上限与各种不足）/ 开箱（随机基底·自选部位·自选底材）/
 *       四档产出规格（词条数与品质）/ 突破件（池外词缀、恒正、突破标签）/ 突破保底（含脏值兜底）/
 *       宝匣禁售给系统商店但可上市集 / 后台宝匣配置读写与持久化
 * 运行： node tests/chest.test.js
 * 说明：使用 FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开启 /api/dev/seed。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 轮询等待工具（测试内部不依赖固定 sleep）：就绪即继续，超时才失败
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 8181;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-chest-test-'));
// 与服务端共用同一份游戏目录：测试里直接用它解析/校验产出的组件实例
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
const B = 'http://localhost:' + PORT;

let srv = null;

(async () => {
  srv = spawn(NODE, [path.join('backend', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', d => console.error('[srv] ' + String(d).trim()));

  const ready = await waitHttp(B + '/api/version', { timeout: 20000 });
  if (!ready) { console.log('服务器未就绪，测试中止'); try { killTree(srv); } catch (e) {} process.exit(1); }
  console.log('服务器就绪：' + B);

  // ---- 账号：首个登录后台的账号自动成为管理员 ----
  section('账号准备');
  const rgA = await POST(B + '/api/register', { username: 'ch_admin', password: 'ch123456', name: '宝匣管理员', qq: '88001' });
  check('管理员账号注册', rgA.status === 200 && !!(rgA.data && rgA.data.token), JSON.stringify(rgA.data));
  const lgA = await POST(B + '/api/admin/login', { username: 'ch_admin', password: 'ch123456' });
  const TOKA = lgA.data && lgA.data.token;
  check('管理员登录（引导授权）', lgA.status === 200 && !!TOKA, JSON.stringify(lgA.data));
  const rgP = await POST(B + '/api/register', { username: 'ch_player', password: 'ch123456', name: '捞宝人', qq: '88002' });
  const TOKP = rgP.data && rgP.data.token;
  check('玩家账号注册', rgP.status === 200 && !!TOKP, JSON.stringify(rgP.data));

  // 发资源：残片 + 金币（dev 接口整体替换背包）
  async function seed(inv, coins) {
    return POST(B + '/api/dev/seed', { token: TOKP, inventory: inv, coins: coins });
  }

  // ---- 档位目录 ----
  section('档位目录 /api/chest');
  const c0 = await GET(B + '/api/chest?token=' + TOKP);
  check('未登录 401', (await GET(B + '/api/chest')).status === 401);
  check('目录 200 且四档齐全', c0.status === 200 && Array.isArray(c0.data.chests) && c0.data.chests.length === 4,
    JSON.stringify(c0.data && c0.data.chests && c0.data.chests.length));
  const byId = {};
  (c0.data.chests || []).forEach(function (c) { byId[c.id] = c; });
  check('档位 id 为 Ⅰ~Ⅳ', ['chest_wreck', 'chest_deep', 'chest_abyss', 'chest_king'].every(k => !!byId[k]),
    Object.keys(byId).join(','));
  check('四种模式齐备（random/part/base/base）',
    byId.chest_wreck.mode === 'random' && byId.chest_deep.mode === 'part' &&
    byId.chest_abyss.mode === 'base' && byId.chest_king.mode === 'base');
  check('残片名与持有量下发', c0.data.relicName === '沉船宝匣残片' && c0.data.relicHave === 0);
  check('默认无保底（pityN=0）', c0.data.pityN === 0);
  check('消耗递增（残片与金币都随档位上升）',
    byId.chest_wreck.costRelic < byId.chest_deep.costRelic &&
    byId.chest_deep.costRelic < byId.chest_abyss.costRelic &&
    byId.chest_abyss.costRelic < byId.chest_king.costRelic &&
    byId.chest_wreck.costCoins < byId.chest_deep.costCoins &&
    byId.chest_deep.costCoins < byId.chest_abyss.costCoins &&
    byId.chest_abyss.costCoins < byId.chest_king.costCoins);

  // ---- 合成 ----
  section('合成：残片 + 金币');
  await seed({}, 0);
  const craftNoRelic = await POST(B + '/api/chest/craft', { token: TOKP, chestId: 'chest_wreck', qty: 1 });
  check('残片不足 400', craftNoRelic.status === 400, JSON.stringify(craftNoRelic.data));

  await seed({ relic: 8 }, 0);
  const craftNoCoins = await POST(B + '/api/chest/craft', { token: TOKP, chestId: 'chest_wreck', qty: 1 });
  check('金币不足 400', craftNoCoins.status === 400, JSON.stringify(craftNoCoins.data));

  await seed({ relic: 8 }, 8000);
  const craft1 = await POST(B + '/api/chest/craft', { token: TOKP, chestId: 'chest_wreck', qty: 1 });
  check('合成成功 200', craft1.status === 200 && craft1.data.ok === true, JSON.stringify(craft1.data));
  check('残片扣光（8 → 0）', craft1.data.inventory.relic == null, JSON.stringify(craft1.data.inventory));
  check('宝匣入包 ×1', craft1.data.inventory.chest_wreck === 1, JSON.stringify(craft1.data.inventory));
  check('金币扣光（8000 → 0）', craft1.data.coins === 0, String(craft1.data.coins));
  check('目录内持有量随之更新', (craft1.data.chests.find(c => c.id === 'chest_wreck') || {}).have === 1);

  await seed({ relic: 100 }, 100000);
  const craft10 = await POST(B + '/api/chest/craft', { token: TOKP, chestId: 'chest_wreck', qty: 10 });
  check('批量合成 ×10 成功', craft10.status === 200 && craft10.data.inventory.chest_wreck === 10);
  check('批量按 10 倍扣料', craft10.data.inventory.relic === 20 && craft10.data.coins === 20000,
    JSON.stringify({ relic: craft10.data.inventory.relic, coins: craft10.data.coins }));

  await seed({ relic: 100000 }, 10000000);
  const craftHuge = await POST(B + '/api/chest/craft', { token: TOKP, chestId: 'chest_wreck', qty: 9999 });
  check('单次批量上限 99（防误点清空残片）',
    craftHuge.data.inventory.chest_wreck === 99 && craftHuge.data.inventory.relic === 100000 - 99 * 8,
    JSON.stringify({ chest: craftHuge.data.inventory.chest_wreck, relic: craftHuge.data.inventory.relic }));

  const craftBad = await POST(B + '/api/chest/craft', { token: TOKP, chestId: 'no_such_chest', qty: 1 });
  check('未知宝匣 400', craftBad.status === 400);

  const craftBadQty = await POST(B + '/api/chest/craft', { token: TOKP, chestId: 'chest_wreck', qty: 0 });
  check('数量 0 → 按 1 处理', craftBadQty.status === 200 &&
    craftBadQty.data.inventory.chest_wreck === craftHuge.data.inventory.chest_wreck + 1);

  // ---- 开箱：目标选择 ----
  section('开箱：目标选择');
  await seed({ chest_wreck: 1, chest_deep: 1 }, 1000);
  const openNoChest = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_abyss' });
  check('没有该宝匣 400', openNoChest.status === 400, JSON.stringify(openNoChest.data));

  const openBadPart = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_deep', part: 'no_such_part' });
  check('Ⅱ档未知部位 400', openBadPart.status === 400, JSON.stringify(openBadPart.data));
  check('Ⅱ档失败不扣宝匣（仍持有 1）',
    (await GET(B + '/api/chest?token=' + TOKP)).data.chests.find(c => c.id === 'chest_deep').have === 1);

  const openOk = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_deep', part: 'rod' });
  check('Ⅱ档开箱成功', openOk.status === 200 && !!openOk.data.item, JSON.stringify(openOk.data && openOk.data.item && openOk.data.item.id));
  check('Ⅱ档产出属于所选部位（竿身）', openOk.data.item.part === 'rod', openOk.data.item.part);
  check('Ⅱ档消耗宝匣 ×1', openOk.data.inventory.chest_deep == null);
  check('产出组件入包', openOk.data.inventory[openOk.data.item.id] === 1);
  check('产出词条数 ≥2（保底生效）', openOk.data.item.affixes.length >= 2, String(openOk.data.item.affixes.length));
  check('产出是合法实例（签名可往返）',
    !!D.instanceOf(openOk.data.item.id) && D.instanceId(openOk.data.item.baseId, openOk.data.item.quality, openOk.data.item.affixes) === openOk.data.item.id);

  // 自选底材：Ⅲ 档指定底材，产出底材必须一致
  await seed({ chest_abyss: 6 }, 1000000);
  let abyssOk = true, abyssAffixOk = true, abyssQualityOk = true, abyssSample = '';
  for (const bid of ['rod_bamboo', 'rod_carbon', 'charm_trident']) {
    const r = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_abyss', baseId: bid });
    if (r.status !== 200 || r.data.item.baseId !== bid) abyssOk = false;
    if (r.status === 200) {
      abyssSample = r.data.item.id;
      const base = D.componentBase(bid);
      if (r.data.item.affixes.length !== Math.min(base.pool.length, D.QUALITY.epic.cap)) abyssAffixOk = false;
      if (r.data.item.quality !== 'epic') abyssQualityOk = false;
    }
  }
  check('Ⅲ档自选底材：产出底材与所选一致', abyssOk, abyssSample);
  check('Ⅲ档必定史诗', abyssQualityOk);
  check('Ⅲ档词条填满池内（min(池长,3)）', abyssAffixOk,
    'rod_bamboo→2 / rod_carbon→3 / charm_trident→3');

  const openBadBase = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_abyss', baseId: 'nope' });
  check('Ⅲ档未知底材 400', openBadBase.status === 400);

  // ---- Ⅰ档：随机基底 + 词条 ≥2 ----
  section('Ⅰ档规格：随机基底 + 词条 ≥2');
  await seed({ chest_wreck: 60 }, 1000000);
  const wreckIds = {}, wreckFew = [];
  for (let i = 0; i < 60; i++) {
    const r = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_wreck' });
    if (r.status !== 200) { wreckFew.push('open-fail'); continue; }
    wreckIds[r.data.item.baseId] = (wreckIds[r.data.item.baseId] || 0) + 1;
    if (r.data.item.affixes.length < 2) wreckFew.push(r.data.item.id);
    if (r.data.item.quality === 'common') wreckFew.push('common:' + r.data.item.id);
  }
  check('Ⅰ档 60 次开箱全部 ≥2 词条', wreckFew.length === 0, wreckFew.slice(0, 3).join(','));
  check('Ⅰ档基底确实随机（出现 ≥5 种底材）', Object.keys(wreckIds).length >= 5, String(Object.keys(wreckIds).length));
  check('Ⅰ档从不产出「普通」品质（cap=1 装不下 2 条）', !wreckFew.some(x => String(x).indexOf('common:') === 0));

  // ---- Ⅳ档：神话 + 突破件 ----
  section('Ⅳ档规格：必定神话 + 50% 突破');
  await seed({ chest_king: 80 }, 10000000);
  let notMythic = 0, badCount = 0, extraBad = 0, extraDup = 0, btOk = true, c3 = 0, c4 = 0, extraSample = '';
  for (let i = 0; i < 80; i++) {
    const r = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_king', baseId: 'rod_bamboo' });
    if (r.status !== 200) { badCount++; continue; }
    const it = r.data.item;
    if (it.quality !== 'mythic') notMythic++;
    if (it.affixes.length === 3) c3++;
    else if (it.affixes.length === 4) c4++;
    else badCount++;
    // 突破标记必须与「条数越过史诗 3 条上限」一致
    if (!!it.breakthrough !== (it.affixes.length > D.QUALITY.epic.cap)) btOk = false;
    // maxAffixes 不得小于实际条数（否则前端会显示「4/3 词条」）
    if (it.maxAffixes < it.affixes.length) btOk = false;
    const types = {};
    it.affixes.forEach(function (a) {
      if (types[a.type]) extraDup++;
      types[a.type] = 1;
      if (a.extra) {
        extraSample = JSON.stringify(a);
        if (a.value <= 0) extraBad++;                       // 池外词缀恒为正
        if (!D.AFFIX_TYPES.includes(a.type)) extraBad++;     // 必须是合法词缀类型
      }
    });
    // 池内词缀不得被标记为 extra
    const poolTypes = {};
    D.componentBase(it.baseId).pool.forEach(function (p) { poolTypes[p.type] = 1; });
    it.affixes.forEach(function (a) { if (a.extra && poolTypes[a.type]) extraBad++; });
    if (it.affixes.some(function (a) { return a.extra; }) && !it.affixes.some(function (a) { return a.extra; })) extraBad++;
  }
  check('Ⅳ档必定神话', notMythic === 0, 'notMythic=' + notMythic);
  check('Ⅳ档条数只出现 3 或 4', badCount === 0, 'bad=' + badCount);
  check('Ⅳ档 3/4 条都出现（50% 掷骰生效）', c3 > 0 && c4 > 0, '3条=' + c3 + ' 4条=' + c4);
  check('突破标记 = 条数越过史诗 3 条上限', btOk);
  check('词缀类型不重复', extraDup === 0, String(extraDup));
  check('池外词缀恒为正且类型合法', extraBad === 0, extraSample);

  // 2 条池底材（竹制短竿）：未中 = 2 池内 + 1 池外；中 = 2 池内 + 2 池外
  await seed({ chest_king: 20 }, 10000000);
  let pairOk = true, pairSample = '';
  for (let i = 0; i < 20; i++) {
    const r = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_king', baseId: 'rod_bamboo' });
    if (r.status !== 200) { pairOk = false; continue; }
    const it = r.data.item;
    const extras = it.affixes.filter(function (a) { return a.extra; }).length;
    const wantExtras = it.affixes.length - 2; // 池长 2
    pairSample = it.id;
    if (extras !== wantExtras) pairOk = false;
  }
  check('2 条池底材：池外词缀条数 = 总条数 − 池长', pairOk, pairSample);

  // 4 条池底材（海王徽记）必满池、不掷骰、无池外
  await seed({ chest_king: 12 }, 10000000);
  let hwOk = true, hwSample = '';
  for (let i = 0; i < 12; i++) {
    const r = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_king', baseId: 'charm_trident' });
    if (r.status !== 200) { hwOk = false; continue; }
    hwSample = r.data.item.id;
    if (r.data.item.affixes.length !== 4) hwOk = false;
    if (r.data.item.affixes.some(function (a) { return a.extra; })) hwOk = false;
    if (!r.data.item.breakthrough) hwOk = false;
  }
  check('海王徽记（唯一 4 条池）必出满池 4 条、无池外、标记突破', hwOk, hwSample);

  // ---- 突破保底 ----
  section('突破保底');
  const badPity = await POST(B + '/api/admin/settings', { token: TOKA, chestCfg: { pityN: 999 } });
  check('保底次数越界 400', badPity.status === 400, JSON.stringify(badPity.data));
  const badPity2 = await POST(B + '/api/admin/settings', { token: TOKA, chestCfg: { pityN: 'abc' } });
  check('保底次数非数字 400', badPity2.status === 400);
  const noAuth = await POST(B + '/api/admin/settings', { token: TOKP, chestCfg: { pityN: 3 } });
  check('非管理员不能改宝匣配置 403', noAuth.status === 403);

  const setPity0 = await POST(B + '/api/admin/settings', { token: TOKA, chestCfg: { pityN: 0 } });
  check('保底 0 = 关闭', setPity0.status === 200 && setPity0.data.chestCfg.pityN === 0, JSON.stringify(setPity0.data));
  check('配置下发到玩家端', (await GET(B + '/api/version')).data.chestCfg.pityN === 0);

  // pityN=1 → 每次都是保底触发，必出突破件
  const setPity1 = await POST(B + '/api/admin/settings', { token: TOKA, chestCfg: { pityN: 1 } });
  check('保底 1 保存成功', setPity1.status === 200 && setPity1.data.chestCfg.pityN === 1);
  await seed({ chest_king: 5 }, 10000000);
  let forcedAll = true, forcedFlag = true, forcedSample = '';
  for (let i = 0; i < 5; i++) {
    const r = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_king', baseId: 'rod_bamboo' });
    forcedSample = JSON.stringify(r.data && { bt: r.data.item && r.data.item.breakthrough, forced: r.data.forced, n: r.data.item && r.data.item.affixes.length });
    if (!r.data || !r.data.item || !r.data.item.breakthrough) forcedAll = false;
    if (!r.data || r.data.forced !== true) forcedFlag = false;
  }
  check('保底 1：2 条池底材每次都出 4 条突破件', forcedAll, forcedSample);
  check('保底 1：响应标记 forced=true', forcedFlag, forcedSample);
  check('突破后保底计数清零', (await GET(B + '/api/chest?token=' + TOKP)).data.chests.find(c => c.id === 'chest_king').pityNow === 0);

  // pityN=3 → 不可能出现「连续 3 次未突破」
  await POST(B + '/api/admin/settings', { token: TOKA, chestCfg: { pityN: 3 } });
  await seed({ chest_king: 40 }, 10000000);
  let run = 0, maxRun = 0, sawBreak = 0;
  for (let i = 0; i < 40; i++) {
    const r = await POST(B + '/api/chest/open', { token: TOKP, chestId: 'chest_king', baseId: 'rod_bamboo' });
    if (r.data && r.data.item && r.data.item.breakthrough) { run = 0; sawBreak++; }
    else { run++; if (run > maxRun) maxRun = run; }
  }
  check('保底 3：连续未突破次数不超过 2', maxRun <= 2, 'maxRun=' + maxRun);
  check('保底 3：期间仍然出现过突破件', sawBreak > 0, 'breaks=' + sawBreak);

  // 清空 = 关闭
  const clearPity = await POST(B + '/api/admin/settings', { token: TOKA, chestCfg: { pityN: '' } });
  check('留空 = 关闭保底', clearPity.status === 200 && clearPity.data.chestCfg.pityN === 0, JSON.stringify(clearPity.data));

  // ---- 交易约束 ----
  section('交易：禁售系统商店 / 可上市集');
  await seed({ chest_wreck: 3, relic: 1 }, 200000);
  const sellChest = await POST(B + '/api/sell', { token: TOKP, id: 'chest_wreck', qty: 1 });
  check('系统商店拒收宝匣 400', sellChest.status === 400, JSON.stringify(sellChest.data));
  check('拒收后宝匣未被扣掉', (await GET(B + '/api/chest?token=' + TOKP)).data.chests.find(c => c.id === 'chest_wreck').have === 3);
  const sellRelic = await POST(B + '/api/sell', { token: TOKP, id: 'relic', qty: 1 });
  check('残片仍可正常卖给系统商店', sellRelic.status === 200 && sellRelic.data.gain > 0, JSON.stringify(sellRelic.data));

  const listChest = await POST(B + '/api/market/list', { token: TOKP, id: 'chest_wreck', qty: 2, price: 20000, hours: 6 });
  check('宝匣可上架市集', listChest.status === 200 && !!listChest.data.listing, JSON.stringify(listChest.data));
  check('上架扣掉 2 个宝匣', (await GET(B + '/api/chest?token=' + TOKP)).data.chests.find(c => c.id === 'chest_wreck').have === 1);
  const mk = await GET(B + '/api/market');
  const listed = (mk.data.listings || []).find(l => l.id === 'chest_wreck');
  check('挂单出现在市集列表且带名称', !!listed && listed.name === '沉船宝匣', JSON.stringify(listed && listed.name));

  // 市集买入宝匣 → 进背包且可开箱
  const lgB = await POST(B + '/api/register', { username: 'ch_buyer', password: 'ch123456', name: '买家', qq: '88003' });
  const TOKB = lgB.data && lgB.data.token;
  check('买家账号注册', !!TOKB);
  await POST(B + '/api/dev/seed', { token: TOKB, inventory: {}, coins: 100000 });
  const buy = await POST(B + '/api/market/buy', { token: TOKB, lid: listed.lid, qty: 1 });
  check('买家可买入宝匣', buy.status === 200, JSON.stringify(buy.data));
  const buyerChest = await GET(B + '/api/chest?token=' + TOKB);
  check('买入的宝匣进入买家背包', buyerChest.data.chests.find(c => c.id === 'chest_wreck').have === 1);
  const buyerOpen = await POST(B + '/api/chest/open', { token: TOKB, chestId: 'chest_wreck' });
  check('买入的宝匣可直接开箱', buyerOpen.status === 200 && !!buyerOpen.data.item, JSON.stringify(buyerOpen.data && buyerOpen.data.item && buyerOpen.data.item.id));

  // ---- 后台宝匣配置 ----
  section('后台宝匣配置');
  const adminLogin = await POST(B + '/api/admin/login', { username: 'ch_admin', password: 'ch123456' });
  const TOKA2 = adminLogin.data && adminLogin.data.token;
  await POST(B + '/api/admin/settings', { token: TOKA2, chestCfg: { pityN: 4 } });
  const w0 = await GET(B + '/api/admin/world?token=' + TOKA2);
  check('后台读回宝匣配置', w0.data.chestCfg && w0.data.chestCfg.pityN === 4, JSON.stringify(w0.data.chestCfg));
  check('后台下发档位清单', Array.isArray(w0.data.chests) && w0.data.chests.length === 4);
  check('后台下发保底上限', w0.data.chestPityMax === 50, String(w0.data.chestPityMax));
  check('后台下发池外词缀默认区间', !!w0.data.extraAffixDefaults && !!w0.data.extraAffixDefaults.speed,
    JSON.stringify(w0.data.extraAffixDefaults));

  // 神话品质必须无法混入钓鱼掉落池（否则宝匣的价值主张被稀释）
  const tryMythicDrop = await POST(B + '/api/admin/component/config', {
    token: TOKA2, qualityWeights: { common: 1, rare: 1, epic: 1, mythic: 100 },
  });
  check('神话品质无法写入钓鱼掉落权重（请求本身可成功）', tryMythicDrop.status === 200, JSON.stringify(tryMythicDrop.data));
  check('写入后 qualityWeights 中没有 mythic',
    !((tryMythicDrop.data.componentCfg || {}).qualityWeights || {}).mythic,
    JSON.stringify((tryMythicDrop.data.componentCfg || {}).qualityWeights));
  // 还原默认权重
  await POST(B + '/api/admin/component/config', { token: TOKA2, qualityWeights: { common: 0.62, rare: 0.30, epic: 0.08 } });

  // 池外词缀区间可覆盖，且非法值被过滤
  const saveExtra = await POST(B + '/api/admin/component/config', {
    token: TOKA2, extraAffixRanges: { speed: [2, 5], big: [5, 2], nope: [1, 2] },
  });
  check('池外区间保存 200', saveExtra.status === 200, JSON.stringify(saveExtra.data));
  const saved = (saveExtra.data.componentCfg || {}).extraAffixRanges || {};
  check('合法项保留', Array.isArray(saved.speed) && saved.speed[0] === 2 && saved.speed[1] === 5, JSON.stringify(saved.speed));
  check('min>max 被丢弃', saved.big === undefined, JSON.stringify(saved.big));
  check('未知词缀类型被丢弃', saved.nope === undefined);
  // 还原默认
  await POST(B + '/api/admin/component/config', { token: TOKA2, extraAffixRanges: {} });

  // 配置持久化：重启后仍在
  section('配置持久化');
  killTree(srv);
  await new Promise(r => setTimeout(r, 600));
  srv = spawn(NODE, [path.join('backend', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  const ready2 = await waitHttp(B + '/api/version', { timeout: 20000 });
  check('服务器重启就绪', ready2);
  const v2 = await GET(B + '/api/version');
  check('宝匣保底次数重启后保留（4）', v2.data.chestCfg.pityN === 4, JSON.stringify(v2.data.chestCfg));
  const lgAgain = await POST(B + '/api/admin/login', { username: 'ch_admin', password: 'ch123456' });
  const w2 = await GET(B + '/api/admin/world?token=' + (lgAgain.data && lgAgain.data.token));
  check('后台配置重启后保留', w2.data.chestCfg && w2.data.chestCfg.pityN === 4, JSON.stringify(w2.data.chestCfg));

  // ---- 收尾 ----
  console.log('\n' + '='.repeat(52));
  console.log('宝匣测试小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) { console.log('失败项：\n  - ' + failed.join('\n  - ')); }
  console.log('='.repeat(52));
  killTree(srv);
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('TEST ERROR: ' + (e && e.stack || e));
  try { killTree(srv); } catch (e2) {}
  process.exit(1);
});
