/*
 * v0.20.0 战利品组回归 —— 「组」作为一条战利品放进钓点掉落池
 * 覆盖：
 *   · /api/admin/loot/group 新建 / 修改 / 删除（名字 + 组内条目 + 独立权重）
 *   · 非法输入：空条目 / 未知鱼 / 未知材料 / 嵌套组 / 重名 / 权重越界
 *   · 组条目 pool pick = 'group:<id>'：合法组可用，未知组被拒
 *   · /api/admin/loot/test 产出分布把组展开成具体条目（占比 = 池权重 × 组内占比），并标出来源组
 *   · 玩家端 /api/grounds 下发的是展开后的具体条目（不含 group:）
 *   · 删除组后，各钓点池里指向它的条目被一并清理
 * 认证：全部走 Authorization: Bearer（URL/请求体禁带凭据）。
 * 运行：node tests/v0200-loot.test.js（套件自行设置 FISHING_DEV=1）
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp, waitFor } = require('./_util.js');
const registrationProof = require('./_registration.js');
const { provisionAdmin } = require('./_admin.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8283;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-loot-test-'));
const DATA = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function request(pathname, options) {
  options = options || {};
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = Object.assign({}, options.headers || {});
  if (body) headers['Content-Type'] = 'application/json';
  return new Promise(resolve => {
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method: options.method || 'GET', headers: headers }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, data: data, body: out });
      });
    });
    r.on('error', () => resolve({ status: 0, data: null, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
const BEARER = t => ({ Authorization: 'Bearer ' + t });
const getT = (p, t) => request(p, { headers: BEARER(t) });
const postT = (p, body, t) => request(p, { method: 'POST', body: body, headers: BEARER(t) });
const post = (p, body) => request(p, { method: 'POST', body: body });
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
async function registerAccount(username) {
  const payload = { username: username, password: 'loot-test-1234', name: '战利品组测试', qq: '828300' };
  let r = await post('/api/register', payload);
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}

let srv = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

  const uniq = String(Date.now() % 100000);
  const admUser = 'admloot' + uniq;
  await registerAccount(admUser);
  const otp = await provisionAdmin(srv, TMP_DATA, admUser);
  const admLogin = await post('/api/admin/login', { username: admUser, password: 'loot-test-1234', otp: otp });
  let AT = admLogin.data && admLogin.data.token;
  check('管理员登录成功', !!AT, JSON.stringify(admLogin.data));

  const fishId = DATA.FISH.common[0].id;
  const matId = DATA.MATERIALS[0].id;

  // ---- 1. 新建战利品组 ----
  const gid = 'lootg' + uniq;
  const save = await postT('/api/admin/loot/group', { group: { id: gid, name: '宝箱', weight: 7, items: [
    { pick: 'fish:' + fishId, weight: 3 }, { pick: 'material:' + matId, weight: 1 },
  ] } }, AT);
  check('新建战利品组成功（名字 + 组内条目 + 独立权重）',
    save.status === 200 && save.data.ok && save.data.groups.some(g => g.id === gid && g.name === '宝箱' && g.weight === 7 && g.items.length === 2),
    JSON.stringify(save.data));
  const listed = await getT('/api/admin/loot/groups', AT);
  check('GET /api/admin/loot/groups 能读回该组',
    listed.status === 200 && (listed.data.groups || []).some(g => g.id === gid), JSON.stringify(listed.data));

  // ---- 2. 非法输入 ----
  const badEmpty = await postT('/api/admin/loot/group', { group: { id: gid + 'x', name: '空组', weight: 1, items: [] } }, AT);
  check('组内没有任何条目被拒', badEmpty.status === 400 && /至少/.test(badEmpty.data.error), JSON.stringify(badEmpty.data));
  const badFish = await postT('/api/admin/loot/group', { group: { id: gid + 'y', name: '怪鱼组', weight: 1, items: [{ pick: 'fish:nope', weight: 1 }] } }, AT);
  check('未知鱼类被拒', badFish.status === 400 && /未知鱼类/.test(badFish.data.error), JSON.stringify(badFish.data));
  const nested = await postT('/api/admin/loot/group', { group: { id: gid + 'z', name: '套娃组', weight: 1, items: [{ pick: 'group:' + gid, weight: 1 }] } }, AT);
  check('组内不允许再嵌组', nested.status === 400 && /只能放/.test(nested.data.error), JSON.stringify(nested.data));
  const dupName = await postT('/api/admin/loot/group', { group: { id: gid + 'd', name: '宝箱', weight: 1, items: [{ pick: 'fish:' + fishId, weight: 1 }] } }, AT);
  check('同名战利品组被拒', dupName.status === 400 && /同名/.test(dupName.data.error), JSON.stringify(dupName.data));
  const zeroW = await postT('/api/admin/loot/group', { group: { id: gid + 'w', name: '零权重组', weight: 1, items: [{ pick: 'fish:' + fishId, weight: 0 }] } }, AT);
  check('组内总权重为 0 被拒', zeroW.status === 400 && /总权重/.test(zeroW.data.error), JSON.stringify(zeroW.data));

  // ---- 3. 放进钓点掉落池 ----
  const spot = (await getT('/api/admin/loot/spots', AT)).data.spots.find(s => s.key === 'map:dock');
  check('能取到 map:dock 钓点', !!spot, JSON.stringify(spot));
  const withGroup = await postT('/api/admin/spot/pool', { groundId: 'map', spotId: 'dock', pool: [
    { pick: 'group:' + gid, weight: 10 }, { pick: 'component:', weight: 1 },
  ] }, AT);
  check('掉落池接受 group:<id> 条目', withGroup.status === 200 && withGroup.data.ok, JSON.stringify(withGroup.data));
  const unknown = await postT('/api/admin/spot/pool', { groundId: 'map', spotId: 'dock', pool: [{ pick: 'group:' + gid + 'nope', weight: 1 }] }, AT);
  check('未知战利品组被拒', unknown.status === 400 && /未知战利品组/.test(unknown.data.error), JSON.stringify(unknown.data));

  // ---- 4. 产出分布：先 roll 组，再 roll 组内条目（展开后占比 = 池权重 × 组内占比）----
  const test = await postT('/api/admin/loot/test', { spotKey: 'map:dock', rare: 0 }, AT);
  const rows = (test.data && test.data.rows) || [];
  const asFish = rows.find(r => r.pick === 'fish:' + fishId);
  const asMat = rows.find(r => r.pick === 'material:' + matId);
  check('产出分布把组展开成具体条目', !!asFish && !!asMat, JSON.stringify(rows));
  // 池子 = 组(10) + 组件(1)：组整体占 10/11，组内鱼 3 / 材料 1 → 组内仍应是 75% / 25%
  const inGroup = asFish && asMat ? asFish.beforePct / (asFish.beforePct + asMat.beforePct) : 0;
  check('展开后的占比 = 池内组权重 × 组内占比（组内鱼 3/4、材料 1/4）',
    asFish && asMat && Math.abs(inGroup - 0.75) < 0.005 && Math.abs(asFish.beforePct + asMat.beforePct - 90.91) < 0.02,
    JSON.stringify({ fish: asFish && asFish.beforePct, mat: asMat && asMat.beforePct, inGroup: inGroup }));
  check('展开后的条目带来源组名', asFish && asFish.group === '宝箱', JSON.stringify(asFish));

  const zeroPool = await postT('/api/admin/spot/pool', { groundId: 'map', spotId: 'dock', pool: [{ pick: 'component:', weight: 0 }] }, AT);
  check('拒绝全零权重钓点池', zeroPool.status === 400);
  await postT('/api/admin/settings', { dropCfg: { material: 300 } }, AT);
  const boost = await postT('/api/admin/loot/test', { spotKey: 'map:dock', rare: 0 }, AT);
  const grouped = boost.data.rows.filter(r => r.group === '宝箱');
  check('材料倍率只改变组内抽取，保持组在外层的独立权重', grouped.length === 2 && Math.abs(grouped.reduce((n, r) => n + r.beforePct, 0) - 90.91) < .02 && Math.abs(grouped[0].beforePct - grouped[1].beforePct) < .02, JSON.stringify(grouped));
  const boostGrounds = (await request('/api/grounds')).data;
  const boostedDock = boostGrounds.grounds[0].spots.find(s => s.id === 'dock').pool;
  check('玩家图鉴概率与两层倍率一致', Math.abs(boostedDock.filter(r => r.group).reduce((n, r) => n + r.weight, 0) - 10) < .001);
  await postT('/api/admin/settings', { resetDropCfg: true }, AT);

  // ---- 5. 玩家端目录下发的是展开后的具体条目 ----
  const rb = await registerAccount('lootview' + uniq);
  const lb = await post('/api/login', { username: 'lootview' + uniq, password: 'loot-test-1234' });
  const tokB = lb.data && lb.data.token;
  check('玩家注册登录成功', rb.status === 200 && !!tokB);
  const grounds = await getT('/api/grounds', tokB);
  const dockPool = ((grounds.data.grounds[0].spots || []).find(s => s.id === 'dock') || {}).pool || [];
  check('玩家端池子里不含 group: 条目（已展开成具体产出）',
    dockPool.length === 3 && !dockPool.some(e => String(e.pick).indexOf('group:') === 0) &&
    dockPool.some(e => e.pick === 'fish:' + fishId) && dockPool.some(e => e.pick === 'component:'),
    JSON.stringify(dockPool));

  // ---- 6. 修改组后即时生效 ----
  const upd = await postT('/api/admin/loot/group', { group: { id: gid, name: '宝箱', weight: 7, items: [
    { pick: 'fish:' + fishId, weight: 1 },
  ] } }, AT);
  check('修改组内条目成功', upd.status === 200 && upd.data.ok, JSON.stringify(upd.data));
  const test2 = await postT('/api/admin/loot/test', { spotKey: 'map:dock', rare: 0 }, AT);
  const rows2 = (test2.data && test2.data.rows) || [];
  const onlyFish = rows2.find(r => r.pick === 'fish:' + fishId);
  check('组内只剩鱼时，该组产出全部落在鱼上',
    onlyFish && !rows2.some(r => r.pick === 'material:' + matId) && Math.abs(onlyFish.beforePct - 90.91) < 0.02,
    JSON.stringify(rows2));

  // 唯一产出保护 + 真正的定时钓鱼结算。
  await postT('/api/admin/spot/pool', { groundId: 'map', spotId: 'dock', pool: [{ pick: 'group:' + gid, weight: 10 }] }, AT);
  const protectedDel = await postT('/api/admin/loot/group', { action: 'delete', id: gid }, AT);
  check('不能删除钓点唯一有效产出组', protectedDel.status === 400 && /唯一/.test(protectedDel.data.error));
  await postT('/api/admin/spot/rate', { groundId: 'map', spotId: 'dock', biteRate: 100, intervalMs: 100 }, AT);
  const stream = http.get('http://127.0.0.1:' + PORT + '/events', { headers: BEARER(tokB) }, res => res.resume());
  stream.on('error', () => {});
  await waitFor(async () => (await getT('/api/players/page', tokB)).data?.players?.some(p => p.id === 'lootview' + uniq), { timeout: 5000 });
  const start = await postT('/api/fishing/start', { groundId: 'map', spotId: 'dock' }, tokB);
  check('真实钓鱼可在含组的池中开始', start.status === 200);
  const caught = await waitFor(async () => ((await getT('/api/codex', tokB)).data?.codex?.[fishId]?.count || 0) >= 3, { timeout: 6000 });
  await postT('/api/fishing/stop', {}, tokB); stream.destroy();
  check('真实定时结算抽到组内物品并更新图鉴', !!caught);
  await postT('/api/admin/spot/pool', { groundId: 'map', spotId: 'dock', pool: [{ pick: 'group:' + gid, weight: 10 }, { pick: 'component:', weight: 1 }] }, AT);
  // 重启后不依赖进程内数据。
  killTree(srv);
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' } });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });
  const newOtp = await provisionAdmin(srv, TMP_DATA, admUser);
  AT = (await post('/api/admin/login', { username: admUser, password: 'loot-test-1234', otp: newOtp })).data.token;
  const persisted = (await getT('/api/admin/loot/groups', AT)).data.groups.find(g => g.id === gid);
  const persistedPool = (await postT('/api/admin/loot/test', { spotKey: 'map:dock' }, AT)).data.rows;
  check('组名称、条目与默认权重重启后保留', persisted && persisted.name === '宝箱' && persisted.weight === 7 && persisted.items.length === 1);
  check('钓点引用与组内产出重启后保留', persistedPool.some(r => r.group === '宝箱' && r.pick === 'fish:' + fishId));

  // ---- 7. 删除组：池里指向它的条目一并清理 ----
  const del = await postT('/api/admin/loot/group', { action: 'delete', id: gid }, AT);
  check('删除战利品组成功', del.status === 200 && del.data.ok && !del.data.groups.some(g => g.id === gid), JSON.stringify(del.data));
  const after = await postT('/api/admin/loot/test', { spotKey: 'map:dock', rare: 0 }, AT);
  const rows3 = (after.data && after.data.rows) || [];
  check('删组后池子里不再残留指向它的条目',
    rows3.length === 1 && rows3[0].pick === 'component:', JSON.stringify(rows3));

  console.log('\n===== v0200-loot 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 =====');
  if (failed.length) { console.log('失败明细：'); failed.forEach(n => console.log('  - ' + n)); }
}

main().catch(e => { fail++; console.error('TEST ERROR:', e); }).finally(() => {
  if (srv) killTree(srv);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
});
