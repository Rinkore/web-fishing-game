/*
 * v0.13 新增功能端到端测试（纯 HTTP + 数据目录断言，可独立运行）
 * 覆盖：
 *   ① 稀有度（rare 词缀改名 + 新效果：普通品质权重 × K/(K+R)，K 后台可配）
 *   ② 后台真实钓点战利品表试算（GET /api/admin/loot/spots + POST /api/admin/loot/test）
 *   ③ 材料催化词缀范围：分部位硬约束（上限不得高于该部位最高、下限不得低于最低）+ 一键预设
 *   ④ 熔炼残片保留概率改为公式控制（默认 10 - breakthrough * 0.5，后台可改）
 *   ⑤ 残片新增效果：投入 ≥1 片时，熔炼失败不熔毁主件选中的词条
 *   ⑥ 熔炼搬来的附件词缀范围被带走：后续重铸仍按附件区间取值（不是结果底材的区间）
 *   ⑦ 旧存档迁移：无 @src 的旧件按数值回填真实范围来源
 *   ⑧ 池外词缀的来源识别：突破 / 催化 / 普通池外三分（不得把附件词缀当作突破词缀）
 *   ⑨ 后台「版本更新」功能已整体移除
 * 运行： node tests/v013.test.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 8191;
const BASE = 'http://localhost:' + PORT;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v013-test-'));
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
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, data: j, text: d }); });
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

  await POST(BASE + '/api/register', { username: 'y_admin', password: 'y123456', name: '管理员', qq: '99101' });
  const lgA = await POST(BASE + '/api/admin/login', { username: 'y_admin', password: 'y123456' });
  const TOKA = lgA.data && lgA.data.token;
  await POST(BASE + '/api/register', { username: 'y_player', password: 'y123456', name: '玩家', qq: '99102' });
  const lgP = await POST(BASE + '/api/login', { username: 'y_player', password: 'y123456' });
  const TOKP = lgP.data && lgP.data.token;
  check('管理员与玩家登录', !!TOKA && !!TOKP);
  const seed = (inv, coins) => POST(BASE + '/api/dev/seed', { token: TOKP, inventory: inv || {}, coins: coins == null ? 9000000 : coins });
  const cfg = b => POST(BASE + '/api/admin/smelt/config', Object.assign({ token: TOKA }, b));
  const set = b => POST(BASE + '/api/admin/settings', Object.assign({ token: TOKA }, b));

  // ==========================================================================
  section('① 稀有度：改名 + 新效果（普通品质权重 × K/(K+R)）');
  check('词缀标签已更名为「稀有度」', D.AFFIX_LABEL.rare === '稀有度' && !/稀有概率/.test(JSON.stringify(D.AFFIX_LABEL)), JSON.stringify(D.AFFIX_LABEL));
  check('内部 id/短码保持不变（rare）', D.AFFIX_CODES.rare === 'rare' && D.AFFIX_TYPES.indexOf('rare') >= 0, D.AFFIX_CODES.rare);
  check('数据层：R=0 时系数为 1（无影响）', D.rareCommonMult(0, 2) === 1, String(D.rareCommonMult(0, 2)));
  check('数据层：K/(K+R) 正确（K=2、R=3 → 0.4）', Math.abs(D.rareCommonMult(3, 2) - 0.4) < 1e-9, String(D.rareCommonMult(3, 2)));
  check('数据层：K 缺省为 2', D.RARE_K_DEFAULT === 2 && D.rareKOf({}) === 2 && D.rareKOf({ k: 0 }) === 2, String(D.rareKOf({})));
  const w0 = await GET(BASE + '/api/admin/world?token=' + encodeURIComponent(TOKA));
  check('后台 world 下发 rareK 与默认值', w0.data.rareK === 2 && w0.data.rareKDefault === 2, JSON.stringify({ k: w0.data.rareK, d: w0.data.rareKDefault }));

  // ==========================================================================
  section('② 真实钓点战利品表试算');
  const spots = await GET(BASE + '/api/admin/loot/spots?token=' + encodeURIComponent(TOKA));
  check('钓点列表来自实际存在的钓点', spots.status === 200 && spots.data.spots.length >= 9 &&
    spots.data.spots.every(s => /^[a-z]+:[a-z]+$/.test(s.key)),
    JSON.stringify((spots.data.spots || []).slice(0, 3)));
  check('非管理员读钓点列表 403', (await GET(BASE + '/api/admin/loot/spots?token=' + encodeURIComponent(TOKP))).status === 403);
  const spotKey = spots.data.spots.find(s => /:dock$/.test(s.key)) ? spots.data.spots.find(s => /:dock$/.test(s.key)).key : spots.data.spots[0].key;
  const t0 = await POST(BASE + '/api/admin/loot/test', { token: TOKA, spotKey: spotKey, rare: 0 });
  const t2 = await POST(BASE + '/api/admin/loot/test', { token: TOKA, spotKey: spotKey, rare: 2 });
  const t6 = await POST(BASE + '/api/admin/loot/test', { token: TOKA, spotKey: spotKey, rare: 6 });
  check('试算返回该钓点的完整掉落表', t0.status === 200 && t0.data.rows.length >= 5 && !!t0.data.spot.name, JSON.stringify(t0.data).slice(0, 140));
  check('R=0 无影响（系数 1，普通占比不变）', t0.data.mult === 1 && t0.data.commonAfter === t0.data.commonBefore, JSON.stringify({ m: t0.data.mult, b: t0.data.commonBefore, a: t0.data.commonAfter }));
  check('R=2、K=2 → 系数 0.5', t2.data.mult === 0.5, String(t2.data.mult));
  check('R=6、K=2 → 系数 0.25', t6.data.mult === 0.25, String(t6.data.mult));
  check('稀有度越高，普通品质占比越低（单调）',
    t0.data.commonAfter > t2.data.commonAfter && t2.data.commonAfter > t6.data.commonAfter,
    JSON.stringify([t0.data.commonAfter, t2.data.commonAfter, t6.data.commonAfter]));
  check('稀有度只降普通条目，不改变稀有/史诗条目权重',
    (() => {
      const rares = t0.data.rows.filter(r => !r.common && !/component/.test(r.pick));
      return rares.length > 0 && rares.every(r => {
        const m2 = t2.data.rows.find(x => x.pick === r.pick);
        return m2 && m2.weight === r.weight;
      });
    })(), JSON.stringify(t0.data.rows.filter(r => !r.common).slice(0, 3)));
  check('未知钓点被拒 400', (await POST(BASE + '/api/admin/loot/test', { token: TOKA, spotKey: 'nope:nope', rare: 3 })).status === 400);
  check('K 可配置并即时生效', (await set({ rareK: 4 })).status === 200 && (await POST(BASE + '/api/admin/loot/test', { token: TOKA, spotKey: spotKey, rare: 4 })).data.mult === 0.5);
  check('K 非法值被拒（0 / 负数 / 非数字）',
    (await set({ rareK: 0 })).status === 400 && (await set({ rareK: -3 })).status === 400 && (await set({ rareK: 'abc' })).status === 400);
  await set({ rareK: 2 });

  // ==========================================================================
  section('③ 材料催化词缀范围：分部位约束 + 一键预设');
  const envRodSpeed = D.catalystEnvelopeOf('rod', 'speed');
  check('数据层：包络 = 该部位所有底材区间的并集（竿身钓速 -18 ~ 22）',
    JSON.stringify(envRodSpeed) === JSON.stringify([-18, 22]), JSON.stringify(envRodSpeed));
  check('数据层：该部位没有的词缀 → 无包络（竿身双钓 = null）', D.catalystEnvelopeOf('rod', 'double') === null, String(D.catalystEnvelopeOf('rod', 'double')));
  check('数据层：一键预设 = 各部位包络', JSON.stringify(D.catalystPreset().rod.speed) === JSON.stringify(envRodSpeed), JSON.stringify(D.catalystPreset().rod));
  check('后台 world 下发一键预设与各部位包络',
    !!w0.data.catalystPreset && !!w0.data.catalystEnvelopes && JSON.stringify(w0.data.catalystEnvelopes.rod.speed) === JSON.stringify(envRodSpeed),
    JSON.stringify(w0.data.catalystEnvelopes && w0.data.catalystEnvelopes.rod));
  check('催化上限高于该部位最高值 → 拒绝 400',
    (await cfg({ catalystRanges: { rod: { speed: [0, envRodSpeed[1] + 1] } } })).status === 400,
    JSON.stringify((await cfg({ catalystRanges: { rod: { speed: [0, envRodSpeed[1] + 1] } } })).data));
  check('催化下限低于该部位最低值 → 拒绝 400',
    (await cfg({ catalystRanges: { rod: { speed: [envRodSpeed[0] - 1, 0] } } })).status === 400);
  check('恰好等于包络 → 接受 200',
    (await cfg({ catalystRanges: { rod: { speed: envRodSpeed, skill: D.catalystEnvelopeOf('rod', 'skill') } } })).status === 200);
  check('对该部位不存在的词缀配置催化 → 拒绝 400（应留空走突破区间）',
    (await cfg({ catalystRanges: { rod: { double: [1, 5] } } })).status === 400);
  const presetSave = await cfg({ catalystRanges: D.catalystPreset() });
  check('一键预设整表保存成功', presetSave.status === 200, JSON.stringify(presetSave.data).slice(0, 140));
  // 催化补缀实际按催化区间取值，且不超过该部位上限。
  // 投料方向必须选「熔炼结果里还没有的词缀」：主件选钓速、副件搬体型 → 用反光假饵（→技巧）。
  const envRodSkill = D.catalystEnvelopeOf('rod', 'skill');
  await cfg({ baseRate: 100, rateMax: 100, failPerMaterial: 0, extraRatePerMaterial: 100, extraRateMax: 100, catalystRanges: { rod: { skill: envRodSkill } } });
  const cMain = D.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: 12 }, { type: 'size', value: 3 }]);
  const cSub = D.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }, { type: 'speed', value: -12 }]);
  await seed({ [cMain]: 1, [cSub]: 1, lure: 8 }, 200000);
  const cSmelt = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: cMain, subId: cSub, mainAffix: 'speed', subAffix: 'size', materials: [{ id: 'lure', qty: 4 }],
  });
  const cAff = cSmelt.data && cSmelt.data.item && cSmelt.data.item.affixes.find(a => a.type === 'skill');
  check('催化补缀的词条落在催化区间内且不超过该部位上限',
    !!cAff && cAff.src === 'ct' && cAff.value >= envRodSkill[0] && cAff.value <= envRodSkill[1],
    JSON.stringify({ aff: cAff, env: envRodSkill, resp: cSmelt.data && cSmelt.data.extraType }));
  await cfg({ catalystRanges: {} });

  // ==========================================================================
  section('④ 残片保留概率：公式控制（默认 10 - breakthrough * 0.5）');
  check('出厂默认公式', D.SMELT_DEFAULTS.retainFormula === '10 - breakthrough * 0.5', D.SMELT_DEFAULTS.retainFormula);
  check('数据层：每片概率随突破词缀数递减（0→10 / 2→9 / 3→8.5）',
    D.retainChancePerRelic(0) === 10 && D.retainChancePerRelic(2) === 9 && D.retainChancePerRelic(3) === 8.5,
    [0, 2, 3].map(n => D.retainChancePerRelic(n)).join(','));
  check('数据层：总概率 = 片数 × 每片，封顶 100%（10 片 2 突破 = 90%）',
    D.smeltRetainChance(10, 2) === 90 && D.smeltRetainChance(10, 0) === 100 && D.smeltRetainChance(99, 0) === 100,
    String(D.smeltRetainChance(10, 2)));
  check('数据层：公式可改（20 - breakthrough）', (function () {
    const bak = D.getSmeltCfg().retainFormula;
    D.setSmeltCfg({ retainFormula: '20 - breakthrough' });
    const r = D.retainChancePerRelic(2) === 18 && D.smeltRetainChance(10, 2) === 100;
    D.setSmeltCfg({ retainFormula: bak });
    return r;
  })());
  check('数据层：非法公式自动回退默认（不让概率失控）', (function () {
    const bak = D.getSmeltCfg().retainFormula;
    D.setSmeltCfg({ retainFormula: '10 - nosuchvar * 3' });
    const r = D.getSmeltCfg().retainFormula === D.SMELT_DEFAULTS.retainFormula;
    D.setSmeltCfg({ retainFormula: bak });
    return r;
  })());
  const rfBad = await cfg({ retainFormula: '10 - nosuchvar * 3' });
  check('后台保存引用未知变量的公式 → 拒绝 400', rfBad.status === 400 && /未知变量/.test(rfBad.data.error || ''), JSON.stringify(rfBad.data));
  const rfBad2 = await cfg({ retainFormula: '10 -' });
  check('后台保存语法错误的公式 → 拒绝 400', rfBad2.status === 400, JSON.stringify(rfBad2.data));
  const rfOk = await cfg({ retainFormula: '12 - breakthrough * 0.5' });
  check('后台保存合法公式 → 200 且读回一致',
    rfOk.status === 200 && rfOk.data.smeltCfg.retainFormula === '12 - breakthrough * 0.5',
    JSON.stringify(rfOk.data.smeltCfg && rfOk.data.smeltCfg.retainFormula));
  await cfg({ retainFormula: '10 - breakthrough * 0.5' });

  // ==========================================================================
  section('⑤ 残片保护：失败不熔毁主件选中词条');
  const mainComp = D.instanceId('rod_bamboo', 'mythic', [
    { type: 'speed', value: 12 }, { type: 'size', value: 3 }, { type: 'rare', value: 5 }, { type: 'double', value: 9 },
  ]);
  const subComp = D.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }]);
  await cfg({ baseRate: 0, rateMin: 0, failPerMaterial: 0 });
  await seed({ [mainComp]: 1, [subComp]: 1 }, 200000);
  const failNoRelic = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill',
  });
  check('未投入残片：失败熔掉选中词条（保护仅由残片提供）',
    failNoRelic.status === 200 && failNoRelic.data.success === false &&
    failNoRelic.data.protectAffix === false && failNoRelic.data.removedAffix === 'speed' &&
    failNoRelic.data.mainAfter.affixes.length === 3,
    JSON.stringify({ p: failNoRelic.data.protectAffix, r: failNoRelic.data.removedAffix, n: failNoRelic.data.mainAfter.affixes.length }));
  await seed({ [mainComp]: 1, [subComp]: 1, relic: 3 }, 200000);
  const failOneRelic = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mainComp, subId: subComp, mainAffix: 'speed', subAffix: 'skill', relics: 1,
  });
  check('投入 1 片残片：失败时选中词条被保护（不熔毁）',
    failOneRelic.status === 200 && failOneRelic.data.success === false &&
    failOneRelic.data.protectAffix === true && failOneRelic.data.removedAffix === null &&
    failOneRelic.data.mainAfter.affixes.length === 4,
    JSON.stringify({ p: failOneRelic.data.protectAffix, r: failOneRelic.data.removedAffix, n: failOneRelic.data.mainAfter.affixes.length }));
  check('保护后主件词条数值与来源原样保留',
    failOneRelic.data.mainAfter.affixes.some(a => a.type === 'speed' && a.value === 12) &&
    failOneRelic.data.mainAfter.affixes.some(a => a.type === 'rare' && a.value === 5),
    JSON.stringify(failOneRelic.data.mainAfter.affixes));
  check('残片仍按片数消耗（投入 1 片）', failOneRelic.data.inventory.relic === 2, String(failOneRelic.data.inventory.relic));

  // ==========================================================================
  section('⑥ 熔炼搬来的附件词缀：范围来源被带走（后续重铸仍按附件区间）');
  // 主件竹制短竿（池：钓速 8~14 / 体型 -6~4），副件龙骨巨竿（池：技巧 8~14 / 体型 4~12 / 钓速 -18~-8）
  // 熔炼搬来的「技巧」在竹制短竿池外：若后续重铸按结果底材区间（池外→突破 2~6）就是旧 bug。
  const mMain = D.instanceId('rod_bamboo', 'mythic', [{ type: 'speed', value: 12 }, { type: 'size', value: 3 }]);
  const mSub = D.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }]);
  await cfg({ baseRate: 100, rateMax: 100, failPerMaterial: 0, recastPearl: 1, recastGold: 0, recastMinValue: 0 });
  await seed({ [mMain]: 1, [mSub]: 1 }, 200000);
  const mMelt = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: mMain, subId: mSub, mainAffix: 'speed', subAffix: 'skill',
  });
  const mItem = mMelt.data.item;
  check('熔炼成功且结果的副件词缀记录了范围来源（@副件底材）',
    !!mItem && /@rod_dragonbone/.test(mItem.id), mItem && mItem.id);
  const subSkillRange = D.affixSrcRangeOf('rod_dragonbone', 'skill', 'rod');
  const btSkillRange = D.affixSrcRangeOf('bt', 'skill', 'rod');
  check('副件区间与突破区间确实不同（8~14 vs 2~6）',
    JSON.stringify(subSkillRange) === JSON.stringify([8, 14]) && JSON.stringify(btSkillRange) === JSON.stringify([2, 6]),
    JSON.stringify({ sub: subSkillRange, bt: btSkillRange }));
  // 后续重铸：必须一直落在副件区间，而不是结果底材的池外（突破）区间
  let cur = mItem.id, vals = [];
  for (let i = 0; i < 40; i++) {
    await seed({ [cur]: 1, dragonpearl: 400 }, 200000);   // v0.16.0：重铸材料改为龙宫宝珠
    const rc = await POST(BASE + '/api/workshop/recast', { token: TOKP, id: cur });
    if (rc.status !== 200) break;
    vals.push(rc.data.item.affixes.find(a => a.type === 'skill').value);
    cur = rc.data.id;
  }
  check('40 次重铸后技巧始终落在附件（副件）区间 8~14，且从未落到突破区间 2~6',
    vals.length >= 20 && vals.every(v => v >= subSkillRange[0] && v <= subSkillRange[1]) &&
    vals.some(v => v > btSkillRange[1]),
    JSON.stringify({ n: vals.length, vals: vals.slice(0, 12), sub: subSkillRange, bt: btSkillRange }));
  check('重铸保持范围来源不变（@rod_dragonbone 一直在）', /@rod_dragonbone/.test(cur), cur);

  // ==========================================================================
  section('⑦ 旧存档迁移：无 @src 的旧件按数值回填真实范围来源');
  // 龙骨巨竿的池内钓速区间是 [-18,-8]；spd+12 落在区间外 → 说明这条是从竹制短竿（8~14）搬来的
  const legacyMoved = D.componentOf('rod_dragonbone#mythic#spd+12,skl+10');
  const legSpd = legacyMoved.affixes.find(a => a.type === 'speed');
  check('数值超出本底材区间的旧词缀 → 迁移到能容纳它的附件底材',
    legSpd.src === 'rod_bamboo', JSON.stringify(legacyMoved.affixes));
  check('迁移后该词缀按附件区间取值（8~14，而不是龙骨竿的 -18~-8）',
    JSON.stringify(D.affixSrcRangeOf(legSpd.src, 'speed', 'rod')) === JSON.stringify([8, 14]),
    JSON.stringify(D.affixSrcRangeOf(legSpd.src, 'speed', 'rod')));
  const legacyNormal = D.componentOf('rod_dragonbone#mythic#skl+12,size+12');
  check('数值本来就落在本底材区间的旧词缀 → 保持底材来源（行为不变）',
    legacyNormal.affixes.every(a => a.src === 'rod_dragonbone'), JSON.stringify(legacyNormal.affixes));
  check('池外类型（本部位没有的词缀）仍判为突破', D.componentOf('rod_bamboo#mythic#spd+12,dbl+7').affixes.find(a => a.type === 'double').src === 'bt',
    JSON.stringify(D.componentOf('rod_bamboo#mythic#spd+12,dbl+7').affixes));

  // ==========================================================================
  section('⑧ 池外词缀的来源识别：突破 / 催化 / 普通池外三分');
  // 池外词缀 = 该类型不在所属底材的词缀池内。它按**真实来源**再分三类：
  //   突破词缀：只有海王遗匣在池外补足才产生（src='bt'）
  //   催化词缀：工坊投入催化剂补缀产生（src='ct'）
  //   普通池外词缀：熔炼从附件（副件）搬来（src=附件底材 id），或来源无法证实
  // 关键回归：**不能只看「不在词缀池内」就当作突破词缀**。
  check('数据层：分类函数已导出', typeof D.affixKindOf === 'function' && typeof D.extraKindName === 'function' && typeof D.breakthroughCountOf === 'function',
    JSON.stringify({ k: typeof D.affixKindOf, n: typeof D.extraKindName, b: typeof D.breakthroughCountOf }));
  // 熔炼搬来的附件词缀：范围来源记的是附件底材（在附件池内 = 可证），不是突破
  const movedMeta = D.componentOf('rod_bamboo#mythic#spd+12,skl+10@rod_dragonbone');
  const movedSk = movedMeta.affixes.find(a => a.type === 'skill');
  check('熔炼搬来的附件词缀 → 普通池外（不是突破词缀）',
    D.affixKindOf(movedSk) === 'extra' && D.extraKindName(movedSk) === '池外词缀' && movedSk.src === 'rod_dragonbone',
    JSON.stringify({ kind: D.affixKindOf(movedSk), name: D.extraKindName(movedSk), src: movedSk.src }));
  check('突破计数不含附件搬来的词缀', D.breakthroughCountOf(movedMeta.affixes) === 0, String(D.breakthroughCountOf(movedMeta.affixes)));
  // 海王遗匣突破件：src='bt' 且经签名字面记录 → 突破词缀
  const btItem = D.genBreakthrough('rod_bamboo', { hitCount: 4, chance: 1 });
  const btExtras = btItem.affixes.filter(a => a.extra);
  check('海王遗匣池外补足的词缀 → 突破词缀',
    btExtras.length > 0 && btExtras.every(a => D.affixKindOf(a) === 'breakthrough' && D.extraKindName(a) === '突破词缀'),
    JSON.stringify(btExtras.map(a => ({ t: a.type, k: D.affixKindOf(a), src: a.src }))));
  check('突破计数 = 突破词缀条数', D.breakthroughCountOf(btItem.affixes) === btExtras.length,
    JSON.stringify({ n: D.breakthroughCountOf(btItem.affixes), extra: btExtras.length }));
  // 催化剂补缀：未配置催化区间时来源仍记 'ct'（催化词缀），且取值回退池外区间
  const addSpec = D.smeltRangeEx('rod_bamboo', 'rod_dragonbone', 'add', 'skill', { part: 'rod' });
  check('催化剂补缀的来源一律是催化（未配置催化区间时亦然）', addSpec.src === 'ct', JSON.stringify(addSpec));
  check('催化未配置区间时取值仍回退池外区间（与旧版一致）',
    JSON.stringify(addSpec.range) === JSON.stringify(D.extraAffixRangeOf('skill')), JSON.stringify(addSpec.range));
  check('催化词缀识别为催化',
    D.affixKindOf({ extra: true, src: 'ct', srcExplicit: true, type: 'skill' }) === 'catalyst' &&
    D.extraKindName({ extra: true, src: 'ct', srcExplicit: true, type: 'skill' }) === '催化词缀');
  // 来源无法证实的池外词缀（后台定制 / 旧存档）：不冒充突破
  const cusMeta = D.componentOf('rod_bamboo#mythic#spd+12,dbl+9');
  check('来源无法证实的池外词缀 → 普通池外（不冒充突破）',
    D.affixKindOf(cusMeta.affixes.find(a => a.type === 'double')) === 'extra',
    JSON.stringify(cusMeta.affixes));
  check('池内词缀 kind = pool', D.affixKindOf(movedMeta.affixes.find(a => a.type === 'speed')) === 'pool');
  // 后台显式关闭「副件区间」时（旧行为），副件搬来的池外词缀的取值范围回退池外区间，
  // 但身份上仍不得宣称突破（explicit=false → 不写回签名 → 识别为普通池外词缀）
  const legacyRange = (function () {
    const bak = D.getSmeltCfg().subRangeFromSub;
    D.setSmeltCfg({ subRangeFromSub: false });
    const spec = D.smeltRangeEx('rod_bamboo', 'rod_dragonbone', 'sub', 'skill', { part: 'rod', src: 'rod_dragonbone', srcExplicit: true });
    D.setSmeltCfg({ subRangeFromSub: bak });
    return spec;
  })();
  check('旧行为（关闭副件区间）下副件词缀不冒充突破词缀',
    legacyRange.src === 'bt' && legacyRange.explicit === false &&
    JSON.stringify(legacyRange.range) === JSON.stringify(D.extraAffixRangeOf('skill')),
    JSON.stringify(legacyRange));
  // 端到端：熔炼搬词的结果必须记附件底材、不得变成 @bt
  await cfg({ baseRate: 100, rateMax: 100, failPerMaterial: 0, catalystRanges: {} });
  const kindMain = D.instanceId('rod_bamboo', 'mythic', [{ type: 'speed', value: 12 }, { type: 'size', value: 3 }]);
  const kindSub = D.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }]);
  await seed({ [kindMain]: 1, [kindSub]: 1 }, 200000);
  const kindMelt = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: kindMain, subId: kindSub, mainAffix: 'speed', subAffix: 'skill',
  });
  const kindSk = kindMelt.data.item && kindMelt.data.item.affixes.find(a => a.type === 'skill');
  check('端到端：熔炼搬词结果记附件底材而非 @bt，且识别为普通池外',
    kindMelt.status === 200 && !!kindSk && kindSk.src === 'rod_dragonbone' &&
    !/@bt/.test(kindMelt.data.item.id) && D.affixKindOf(kindSk) === 'extra',
    JSON.stringify({ id: kindMelt.data.item && kindMelt.data.item.id, kind: kindSk && D.affixKindOf(kindSk) }));
  check('端到端：该次熔炼的 breakthrough 不把附件词缀算进去（=0）',
    kindMelt.data.breakthrough === 0, String(kindMelt.data.breakthrough));
  // 端到端：催化剂补缀产出催化词缀
  await seed({ [kindMain]: 1, [kindSub]: 1, lure: 8 }, 200000);
  const kindCat = await POST(BASE + '/api/workshop/smelt', {
    token: TOKP, mainId: kindMain, subId: kindSub, mainAffix: 'speed', subAffix: 'size', materials: [{ id: 'lure', qty: 4 }],
  });
  const kindCatAff = kindCat.data.item && kindCat.data.item.affixes.find(a => a.type === 'skill');
  check('端到端：催化剂补缀产出催化词缀（不是突破词缀）',
    kindCat.data.extraOk === true && !!kindCatAff && D.affixKindOf(kindCatAff) === 'catalyst',
    JSON.stringify({ t: kindCat.data.extraType, k: kindCatAff && D.affixKindOf(kindCatAff), src: kindCatAff && kindCatAff.src }));
  // 签名稳定性：推断出来的来源绝不写回签名（否则会固化成「突破词缀」）
  [['rod_bamboo#common#spd+20', '池内超范围（推断）'],
   ['rod_dragonbone#mythic#spd+12,skl+10', '推断出附件来源'],
   ['rod_bamboo#mythic#spd+12,skl+10@rod_dragonbone', '显式附件来源'],
   ['rod_bamboo#mythic#spd+12,dbl+9@bt', '显式突破']].forEach(function (pair) {
    const n1 = D.normalizeItemId(pair[0]), n2 = D.normalizeItemId(n1);
    check('签名幂等且不把推断来源写回：' + pair[1], n1 === n2 && !/@rod_carbon|@rod_bamboo/.test(n1), pair[0] + ' -> ' + n1);
  });

  // ==========================================================================
  section('⑨ 后台「版本更新」功能已整体移除');
  check('更新列表接口 404', (await GET(BASE + '/api/admin/update/list?token=' + encodeURIComponent(TOKA))).status === 404);
  check('发布更新接口 404', (await POST(BASE + '/api/admin/update/start', { token: TOKA, bat: 'run.bat', dryRun: true })).status === 404);
  check('取消更新接口 404', (await POST(BASE + '/api/admin/update/cancel', { token: TOKA })).status === 404);
  const wEnd = await GET(BASE + '/api/admin/world?token=' + encodeURIComponent(TOKA));
  check('world 不再下发 update 相关字段',
    wEnd.data.updateBats === undefined && wEnd.data.updateState === undefined &&
    wEnd.data.updateBannerMs === undefined && wEnd.data.updateGraceMs === undefined);
  check('版本接口不再下发更新状态', (await GET(BASE + '/api/version')).data.update === undefined);
  const idx = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
  check('前端页面不再含更新横幅元素', !/update-banner/.test(idx));

  // ==========================================================================
  section('⑨ 配置持久化（重启后仍生效）');
  await set({ rareK: 3.5 });
  await cfg({ retainFormula: '15 - breakthrough', retainMaxRelic: 7 });
  // 账号/存档落盘是 1 秒防抖（saveAccount → flushAccounts），会话落盘是 2 秒防抖（saveSessions）；
  // taskkill 会跳过退出钩子，必须等过最长的防抖窗口再杀，否则还没写盘。
  await new Promise(r => setTimeout(r, 2600));
  killTree(srv); srv = null;
  await new Promise(r => setTimeout(r, 800));
  check('重启成功', await startServer());
  const wRe = await GET(BASE + '/api/admin/world?token=' + encodeURIComponent(TOKA));
  check('重启后 rareK 保留（3.5）', wRe.data && wRe.data.rareK === 3.5, String(wRe.data && wRe.data.rareK));
  check('重启后保留概率公式保留（15 - breakthrough）',
    wRe.data.smeltCfg.retainFormula === '15 - breakthrough', String(wRe.data.smeltCfg.retainFormula));
  check('重启后残片上限保留（7）', wRe.data.smeltCfg.retainMaxRelic === 7, String(wRe.data.smeltCfg.retainMaxRelic));

  killTree(srv);
  console.log('\n' + '='.repeat(60));
  console.log('v0.13 测试小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败项：\n' + failed.map(f => '  - ' + f).join('\n'));
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); killTree(srv); process.exit(1); });
