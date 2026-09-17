/*
 * v0.16.2 回归（纯 HTTP，不依赖浏览器）
 * 覆盖：
 *   · 存档快照系统：策略（是否启用 / 间隔分钟 / 保留份数，含夹取）+ 立即备份 + 列表摘要 + 单人回档
 *     —— 回档必须二次确认（confirm:true），只覆盖资产（金币 / 背包 / 图鉴 / 钓竿槽位 / 捕获数），
 *        密码 / 权限 / 挂单上限保持不变；快照名非法与不存在都要挡住；非管理员一律 403
 *   · 保留份数：超出 keep 的旧快照被裁掉，且每个账号各自独立
 *   · 后台背包管控：快照接口接受**全部物品**（含宝匣）与改过词条的组件实例
 *   · 熔炼概率纯函数（每条词缀的落成概率 / 完全成功概率）
 * 运行： node tests/v0162.test.js
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8263;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0162-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
function req(method, p, body) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}
const GET = p => req('GET', p), POST = (p, b) => req('POST', p, b);

let srv = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  // ---------------- 熔炼概率纯函数 ----------------
  section('熔炼概率：每条词缀的落成概率 + 完全成功概率');
  const pr = D.smeltSuccessProbs({ rate: 75, extraRate: 48 }, true);
  check('保留 / 副件搬入 = 熔炼成功率', pr.keep === 75, JSON.stringify(pr));
  check('补缀新增 = 熔炼成功率 × 补缀命中（75% × 48% = 36%）', pr.add === 36, JSON.stringify(pr));
  check('完全成功（有补缀）= 补缀那条的概率', pr.full === 36, JSON.stringify(pr));
  check('完全成功（无补缀）= 熔炼成功率', D.smeltSuccessProbs({ rate: 75, extraRate: 0 }, false).full === 75);
  check('概率被夹在 0~100', D.smeltSuccessProbs({ rate: 150, extraRate: 200 }, true).full === 100 &&
    D.smeltSuccessProbs({ rate: -5, extraRate: 10 }, true).full === 0, JSON.stringify(D.smeltSuccessProbs({ rate: 150, extraRate: 200 }, true)));

  // ---------------- 前置：两个账号 + 管理员引导 ----------------
  const rA = await POST('/api/register', { username: 'v162a', password: 'abcd1234', name: '存档甲', qq: '42101' });
  const rB = await POST('/api/register', { username: 'v162b', password: 'abcd1234', name: '存档乙', qq: '42102' });
  const tokA = rA.data.token, tokB = rB.data.token;
  const adm = await POST('/api/admin/login', { username: 'v162a', password: 'abcd1234' });
  const AT = adm.data && adm.data.token;
  check('三个账号就绪（含管理员引导）', !!tokA && !!tokB && !!AT);

  // ---------------- 策略读写 ----------------
  section('存档策略：默认值 / 保存 / 夹取');
  const w0 = await GET('/api/admin/world?token=' + AT);
  check('默认策略：启用 · 30 分钟 · 保留 5 份',
    !!w0.data.snapshotCfg && w0.data.snapshotCfg.enabled === true && w0.data.snapshotCfg.intervalMin === 30 && w0.data.snapshotCfg.keep === 5,
    JSON.stringify(w0.data.snapshotCfg));
  const s1 = await POST('/api/admin/snapshot/config', { token: AT, cfg: { enabled: true, intervalMin: 7, keep: 3 } });
  check('保存策略返回夹取后的配置', s1.status === 200 && s1.data.cfg.intervalMin === 7 && s1.data.cfg.keep === 3, JSON.stringify(s1.data));
  const s2 = await POST('/api/admin/snapshot/config', { token: AT, cfg: { intervalMin: 0, keep: 999 } });
  check('越界夹取：间隔 ≥1 分钟、份数 ≤50', s2.data.cfg.intervalMin === 1 && s2.data.cfg.keep === 50, JSON.stringify(s2.data.cfg));
  await POST('/api/admin/snapshot/config', { token: AT, cfg: { enabled: true, intervalMin: 5, keep: 2 } });
  const sBad = await POST('/api/admin/snapshot/config', { token: tokB, cfg: { keep: 9 } });
  check('非管理员不能改策略', sBad.status === 403, String(sBad.status));

  // ---------------- 备份 / 列表 ----------------
  section('立即备份 + 快照列表');
  await POST('/api/dev/seed', { token: tokB, coins: 4242, inventory: { crucian: 3, relic: 11, chest_deep: 2 } });
  const n1 = await POST('/api/admin/users/snapshot-now', { token: AT, target: 'v162b' });
  check('单账号备份成功', n1.status === 200 && n1.data.count === 1, JSON.stringify(n1.data));
  const l1 = await GET('/api/admin/users/snapshots?token=' + AT + '&key=v162b');
  check('列表带摘要（金币 / 种类 / 件数 / 大小 / 时间）',
    l1.data.count === 1 && l1.data.snapshots[0].coins === 4242 && l1.data.snapshots[0].kinds === 3 &&
    l1.data.snapshots[0].total === 16 && l1.data.snapshots[0].size > 0 && l1.data.snapshots[0].ts > 0,
    JSON.stringify(l1.data.snapshots));
  const nAll = await POST('/api/admin/users/snapshot-now', { token: AT });
  check('全服备份覆盖两个账号', nAll.data.count >= 2, JSON.stringify(nAll.data));
  const lA = await GET('/api/admin/users/snapshots?token=' + AT + '&key=v162a');
  check('每个账号各自一份目录（互不串）', lA.data.count >= 1 && lA.data.key === 'v162a', JSON.stringify({ a: lA.data.count, b: l1.data.count }));
  const lNo = await GET('/api/admin/users/snapshots?token=' + AT + '&key=nobody');
  check('未知账号 404', lNo.status === 404, String(lNo.status));
  const lForbid = await GET('/api/admin/users/snapshots?token=' + tokB + '&key=v162b');
  check('非管理员不能看快照列表', lForbid.status === 403, String(lForbid.status));

  // ---------------- 回档 ----------------
  section('回档：二次确认 / 只覆盖资产 / 回档前自动留一份');
  await sleep(1100);
  await POST('/api/dev/seed', { token: tokB, coins: 999999, inventory: { carp: 5 } });
  const meBefore = (await GET('/api/me?token=' + tokB)).data;
  check('前置：资产已被改掉', meBefore.coins === 999999 && !meBefore.inventory.crucian, JSON.stringify({ c: meBefore.coins, i: Object.keys(meBefore.inventory) }));
  const snap = l1.data.snapshots[0].name;
  const rNoConfirm = await POST('/api/admin/users/rollback', { token: AT, target: 'v162b', snap: snap });
  check('缺 confirm 一律拒绝（400）', rNoConfirm.status === 400, JSON.stringify(rNoConfirm.data));
  const rBadName = await POST('/api/admin/users/rollback', { token: AT, target: 'v162b', snap: '../../config.json', confirm: true });
  check('快照名非法（路径穿越尝试）被挡', rBadName.status === 400, JSON.stringify(rBadName.data));
  const rNoFile = await POST('/api/admin/users/rollback', { token: AT, target: 'v162b', snap: '1000000000000.json', confirm: true });
  check('不存在的快照 404', rNoFile.status === 404, String(rNoFile.status));
  const rOk = await POST('/api/admin/users/rollback', { token: AT, target: 'v162b', snap: snap, confirm: true });
  check('回档成功并回传新的资产', rOk.status === 200 && rOk.data.coins === 4242, JSON.stringify(rOk.data && { c: rOk.data.coins }));
  const meAfter = (await GET('/api/me?token=' + tokB)).data;
  check('金币回到快照时点', meAfter.coins === 4242, String(meAfter.coins));
  check('背包回到快照时点（含宝匣与材料）',
    meAfter.inventory.crucian === 3 && meAfter.inventory.relic === 11 && meAfter.inventory.chest_deep === 2 && !meAfter.inventory.carp,
    JSON.stringify(meAfter.inventory));
  const l2 = await GET('/api/admin/users/snapshots?token=' + AT + '&key=v162b');
  check('回档前自动留了一份「回档前」快照（金币 999999 那份还在）',
    l2.data.snapshots.some(function (s) { return s.coins === 999999; }), JSON.stringify(l2.data.snapshots.map(function (s) { return s.coins; })));
  const rForbid = await POST('/api/admin/users/rollback', { token: tokB, target: 'v162b', snap: snap, confirm: true });
  check('非管理员不能回档', rForbid.status === 403, String(rForbid.status));
  // 身份类字段不受回档影响：管理员标记与挂单上限保持现状
  await POST('/api/admin/users/update', { token: AT, target: 'v162b', listingCap: 7 });
  await POST('/api/admin/users/rollback', { token: AT, target: 'v162b', snap: snap, confirm: true });
  const usersList = (await GET('/api/admin/users?token=' + AT)).data.users || [];
  const bRow = usersList.find(function (u) { return u.key === 'v162b'; }) || {};
  check('回档不动身份类字段（挂单上限仍是回档前设的 7）', bRow.listingCap === 7 && bRow.capSet === true, JSON.stringify({ cap: bRow.listingCap, set: bRow.capSet }));

  // ---------------- 保留份数 ----------------
  section('保留份数：超出 keep 丢最旧的（每人各自算）');
  for (let i = 0; i < 3; i++) { await POST('/api/admin/users/snapshot-now', { token: AT, target: 'v162b' }); await sleep(1100); }
  const l3 = await GET('/api/admin/users/snapshots?token=' + AT + '&key=v162b');
  check('keep=2 时只剩最近 2 份', l3.data.count === 2, String(l3.data.count));
  const ts = l3.data.snapshots.map(function (s) { return s.ts; });
  check('留下的确实是最新的两份（时间戳递减）', ts[0] > ts[1], JSON.stringify(ts));

  // ---------------- 后台背包管控（全部物品 + 改词条后的实例） ----------------
  section('后台背包：全部物品可加 + 组件实例改词条后仍合法');
  const inst = 'reel_electric#epic#spd+31,size+9';
  const instMeta = D.itemOf(inst);
  check('前置：该实例签名能被目录解析（史诗卷线器，两条词条）',
    instMeta.kind === 'component' && instMeta.rarity === 'epic' && (instMeta.affixes || []).length === 2, JSON.stringify({ k: instMeta.kind, r: instMeta.rarity }));
  const pay = { token: AT, target: 'v162b', coins: 5000, inventory: { crucian: 2, chest_king: 1, tide_sand: 4, [inst]: 1 } };
  const sv = await POST('/api/admin/users/snapshot', pay);
  check('保存含宝匣 + 定制实例的快照', sv.status === 200, JSON.stringify(sv.data));
  const meC = (await GET('/api/me?token=' + tokB)).data;
  check('宝匣（神话）进了背包', meC.inventory.chest_king === 1, JSON.stringify(meC.inventory));
  check('改过词条的组件实例进了背包且词条保留',
    meC.inventory[inst] === 1 && (D.itemOf(inst).affixes || []).length === 2, JSON.stringify(Object.keys(meC.inventory)));
  const svBad = await POST('/api/admin/users/snapshot', { token: AT, target: 'v162b', inventory: { 'not_a_real_item_id': 1 } });
  check('未知物品仍被挡（400）', svBad.status === 400, JSON.stringify(svBad.data));

  // ---------------- 重铸手续费：按消耗的宝珠数计（v0.16.3） ----------------
  section('重铸手续费：每颗宝珠 × 后台单价（不是每次固定价）');
  check('纯函数：4 颗 × 10000 = 40000', (function () {
    D.setSmeltCfg({ recastGold: 10000 });
    const a = D.recastGoldFor(4);
    D.setSmeltCfg(null);
    return a === 40000 && D.recastGoldFor(0) === 0;
  })());
  await POST('/api/admin/smelt/config', { token: AT, recastGold: 1000, recastPearl: 1 });
  const wsNow = await GET('/api/workshop?token=' + tokB);
  check('/api/workshop 下发的是「每颗宝珠的单价」',
    !!wsNow.data.recast && wsNow.data.recast.goldPerPearl === 1000 && wsNow.data.recast.pearlBase === 1,
    JSON.stringify(wsNow.data.recast));
  // 一件神话件（3 条词条）+ 宝珠；先只给 100 金币，指定第 3 条 → 共 4 颗 → 手续费 4000
  const MYTH = 'reel_electric#mythic#spd+10,skl+3,size+8';
  await POST('/api/dev/seed', { token: tokB, inventory: { [MYTH]: 1, dragonpearl: 10 }, coins: 100 });
  const poor = await POST('/api/workshop/recast', { token: tokB, id: MYTH, affixIndex: 2 });
  check('金币不足时按「4 颗 × 1000 = 4000」拦下', poor.status === 400 && /4000/.test(poor.data.error || ''), JSON.stringify(poor.data));
  await POST('/api/admin/users/update', { token: AT, target: 'v162b', coins: 5000 });
  const okCast = await POST('/api/workshop/recast', { token: tokB, id: MYTH, affixIndex: 2 });
  check('材料够时成交：宝珠 4 颗 + 手续费 4000',
    okCast.status === 200 && okCast.data.pearlNeed === 4 && okCast.data.gold === 4000,
    JSON.stringify(okCast.data && { p: okCast.data.pearlNeed, g: okCast.data.gold }));
  check('金币按 4000 扣（5000 → 1000）', okCast.data.coins === 1000, String(okCast.data.coins));
  check('宝珠按 4 颗扣（10 → 6）', okCast.data.inventory.dragonpearl === 6, JSON.stringify(okCast.data.inventory));
  await POST('/api/admin/smelt/config', { token: AT, recastGold: 0 });   // 还原：只收宝珠

  // ---------------- 后台改钓竿装配（v0.16.3） ----------------
  section('后台：直接改玩家某个部位装的是哪件（含非法件拦住）');
  const RODCOMP = 'rod_bamboo#common#spd+14';
  const BADPART = 'reel_electric#common#spd+14';   // 卷线器，装到竿身必须被拒
  await POST('/api/dev/seed', { token: tokB, inventory: { [RODCOMP]: 1, [BADPART]: 1 }, coins: 100 });
  const snapBd = await GET('/api/admin/users/snapshot?token=' + AT + '&key=v162b');
  check('快照接口下发 bd（后端能看见玩家装了什么）', !!snapBd.data.bd, JSON.stringify(snapBd.data.bd));
  const setRod = await POST('/api/admin/users/snapshot', { token: AT, target: 'v162b', bd: { rod: { compId: RODCOMP } } });
  check('装上竿身组件成功', setRod.status === 200 && setRod.data.bd.rod.compId === RODCOMP, JSON.stringify(setRod.data && setRod.data.bd && setRod.data.bd.rod));
  const meRod = await GET('/api/me?token=' + tokB);
  check('玩家端 /api/me 也看到这件装配', meRod.data.bd && meRod.data.bd.rod && meRod.data.bd.rod.compId === RODCOMP,
    JSON.stringify(meRod.data.bd && meRod.data.bd.rod));
  const badRod = await POST('/api/admin/users/snapshot', { token: AT, target: 'v162b', bd: { rod: { compId: BADPART } } });
  check('部位不匹配的组件被拦（400 不是竿身）', badRod.status === 400 && /不是/.test(badRod.data.error || ''), JSON.stringify(badRod.data));
  const badPart = await POST('/api/admin/users/snapshot', { token: AT, target: 'v162b', bd: { nosuchpart: { compId: null } } });
  check('未知部位被拦（400）', badPart.status === 400, JSON.stringify(badPart.data));
  const clearRod = await POST('/api/admin/users/snapshot', { token: AT, target: 'v162b', bd: { rod: { compId: null } } });
  check('卸下后回到标准件', clearRod.status === 200 && clearRod.data.bd.rod.compId === null, JSON.stringify(clearRod.data && clearRod.data.bd && clearRod.data.bd.rod));

  killTree(srv);
  await sleep(300);
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败明细：\n' + failed.map(function (x) { return '  - ' + x; }).join('\n'));
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); try { killTree(srv); } catch (x) {} process.exit(1); });
