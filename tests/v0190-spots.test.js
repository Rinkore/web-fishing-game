/*
 * v0.19.0 世界地图钓点重构回归 —— 取消「钓场」分层后的钓点目录与管理
 * 覆盖：
 *   · /api/grounds 目录：唯一隐式钓场 'map' + 全部新钓点（含出海图 map:'voyage' 与锁定点）
 *   · 旧钓场（stillwater/rapids/sunset/ocean/frostmoon）不再存在
 *   · 钓鱼开始：map:dock 正常开钓；锁定点 map:ice 拒绝；出海点船级门槛照旧生效
 *   · 管理端点在隐式钓场下照常工作：spot/pos、spot/rate、spot/pool、spot/add、spot/remove
 *   · 新增 spot/lock：锁定后立即停掉该点钓鱼循环，解锁后可再钓
 *   · 删点只停该钓点的玩家（同钓场其他点不受影响）
 * 认证：全部走 Authorization: Bearer（v0.16.4 起 URL/请求体禁带凭据）。
 * 运行：node tests/v0190-spots.test.js（需要 FISHING_DEV=1，套件自行设置）
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');
const registrationProof = require('./_registration.js');
const { provisionAdmin } = require('./_admin.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8281;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-spots-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

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
async function getT(pathname, token) { return request(pathname, { headers: BEARER(token) }); }
async function postT(pathname, body, token) {
  return request(pathname, { method: 'POST', body: body, headers: BEARER(token) });
}
async function post(pathname, body) { return request(pathname, { method: 'POST', body: body }); }
async function registerAccount(username) {
  const payload = { username: username, password: 'spots-test-1234', name: '钓点测试', qq: '828100' };
  let r = await post('/api/register', payload);
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}
function openStream(token) {
  const r = http.get('http://127.0.0.1:' + PORT + '/events', { headers: BEARER(token) }, res => { res.resume(); });
  r.on('error', () => {});
  return r;
}
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }

let srv = null;
const streams = [];
async function fishingCount(AT) {
  const r = await getT('/api/admin/overview', AT);
  return r.data && r.data.fishingCount;
}
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

  const uniq = String(Date.now() % 100000);
  const ra = await registerAccount('v190s' + uniq + 'a');
  const rb = await registerAccount('v190s' + uniq + 'b');
  check('注册两个测试账号成功', ra.status === 200 && rb.status === 200);
  const la = await post('/api/login', { username: 'v190s' + uniq + 'a', password: 'spots-test-1234' });
  const lb = await post('/api/login', { username: 'v190s' + uniq + 'b', password: 'spots-test-1234' });
  const tokA = la.data && la.data.token, tokB = lb.data && lb.data.token;
  check('两个账号登录成功', !!tokA && !!tokB);
  streams.push(openStream(tokA), openStream(tokB));
  await new Promise(r => setTimeout(r, 800));

  // ---- 1. 目录形态：唯一隐式钓场 ----
  const g0 = await getT('/api/grounds', tokA);
  const grounds = g0.data && g0.data.grounds;
  check('/api/grounds 返回 200', g0.status === 200 && Array.isArray(grounds));
  check('目录里只有一个隐式钓场 map（旧钓场全部移除）',
    grounds.length === 1 && grounds[0].id === 'map' &&
    !grounds.some(g => ['stillwater', 'rapids', 'sunset', 'ocean', 'frostmoon'].includes(g.id)),
    JSON.stringify(grounds.map(g => g.id)));
  const spots = grounds[0].spots || [];
  const spotById = {};
  spots.forEach(s => { spotById[s.id] = s; });
  check('内置钓点齐全（近岸 10 + 出海 3）', spots.length === 13, '实际 ' + spots.length);
  check('钓点带地图坐标 pos（百分比）', spots.every(s => Array.isArray(s.pos) && s.pos.length === 2));
  check('出海图钓点带 map:voyage 与船级门槛',
    spotById.trench && spotById.trench.map === 'voyage' && spotById.trench.minShip === 4);
  check('霜月冰窟为锁定钓点', spotById.ice && spotById.ice.locked === true);
  const catalogSpotIds = {};
  D.GROUNDS.forEach(g => (g.spots || []).forEach(s => { catalogSpotIds[s.id] = 1; }));
  check('前后端目录一致（data.js 与服务端下发同源）',
    spots.every(s => catalogSpotIds[s.id]) && Object.keys(catalogSpotIds).length === spots.length);

  // ---- 2. 开钓：正常点 / 锁定点 / 船级门槛 ----
  const st1 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'dock' }, tokA);
  check('map:dock 正常开钓', st1.status === 200 && st1.data.ok !== false, JSON.stringify(st1.data));
  const st2 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'ice' }, tokB);
  check('锁定钓点拒绝开钓（霜月冰窟）', st2.status !== 200, JSON.stringify(st2.data));
  const st3 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'trench' }, tokB);
  check('出海钓点船级门槛生效（1 级船拒海沟）', st3.status !== 200 && /船级/.test(st3.data && st3.data.error || ''), JSON.stringify(st3.data));
  const st4 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'shore' }, tokB);
  check('近海渔场 1 级船可钓', st4.status === 200, JSON.stringify(st4.data));

  // ---- 3. 管理端点：隐式钓场下照常工作 ----
  const admUser = 'adm190s' + uniq;
  await registerAccount(admUser);
  const otp = await provisionAdmin(srv, TMP_DATA, admUser);
  const admLogin = await post('/api/admin/login', { username: admUser, password: 'spots-test-1234', otp: otp });
  const AT = admLogin.data && admLogin.data.token;
  check('管理员登录成功', !!AT);

  const w0 = await getT('/api/admin/world', AT);
  check('后台 world 配置含唯一钓场与钓点',
    w0.data && w0.data.grounds && w0.data.grounds.length === 1 && w0.data.grounds[0].spots.length >= 13);

  const pos1 = await postT('/api/admin/spot/pos', { groundId: 'map', list: [
    { spotId: 'dock', pos: [60.5, 45.5] }, { spotId: 'reed', pos: [70, 58] },
  ] }, AT);
  check('保存钓点坐标成功', pos1.data && pos1.data.ok && pos1.data.changed === 2, JSON.stringify(pos1.data));
  const g1 = await getT('/api/grounds', tokA);
  const afterPos = {};
  (g1.data.grounds[0].spots || []).forEach(s => { afterPos[s.id] = s; });
  check('坐标下发到玩家目录', afterPos.dock && afterPos.dock.pos[0] === 60.5 && afterPos.reed.pos[1] === 58,
    JSON.stringify(afterPos.dock && afterPos.dock.pos));

  const rate1 = await postT('/api/admin/spot/rate', { groundId: 'map', spotId: 'dock', biteRate: 50 }, AT);
  check('钓点独立上鱼率保存成功', rate1.data && rate1.data.ok && rate1.data.biteRate === 50, JSON.stringify(rate1.data));
  const rate2 = await postT('/api/admin/spot/rate', { groundId: 'map', spotId: 'dock', biteRate: 200 }, AT);
  check('上鱼率越界被拒', rate2.status !== 200);

  const pool1 = await postT('/api/admin/spot/pool', { groundId: 'map', spotId: 'dock',
    pool: [{ pick: 'fish:crucian', weight: 10 }, { pick: 'component:', weight: 5 }] }, AT);
  check('钓点掉落池保存成功', pool1.data && pool1.data.ok && pool1.data.pool.length === 2, JSON.stringify(pool1.data));

  const add1 = await postT('/api/admin/spot/add', { groundId: 'map', id: 'testcove', name: '试验湾',
    preset: 'economy', fill: true }, AT);
  check('新建钓点成功（一键填充）', add1.data && add1.data.ok && (add1.data.spot.pool || []).length > 0, JSON.stringify(add1.data));
  const addDup = await postT('/api/admin/spot/add', { groundId: 'map', id: 'testcove', name: '试验湾' }, AT);
  check('重复钓点 id 被拒', addDup.status !== 200);
  const addVoy = await postT('/api/admin/spot/add', { groundId: 'map', id: 'testsea', name: '试航区',
    map: 'voyage', minShip: 2 }, AT);
  check('新建出海图钓点（map/minShip 生效）', addVoy.data && addVoy.data.ok &&
    addVoy.data.spot.map === 'voyage' && addVoy.data.spot.minShip === 2, JSON.stringify(addVoy.data));

  // ---- 4. spot/lock：锁定即停该点，解锁恢复 ----
  const st5 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'reed' }, tokA);
  check('A 在芦苇荡开钓（准备锁定实验）', st5.status === 200);
  const lock1 = await postT('/api/admin/spot/lock', { groundId: 'map', spotId: 'reed', locked: true }, AT);
  check('锁定钓点成功', lock1.data && lock1.data.ok && lock1.data.locked === true, JSON.stringify(lock1.data));
  // B 此前已在近海渔场开钓且不受影响：全局只剩 B 一人在钓
  check('锁定后该点玩家被停竿（其他钓点不受影响）', (await fishingCount(AT)) === 1);
  const st6 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'reed' }, tokA);
  check('锁定点拒绝再开钓', st6.status !== 200);
  const unlock1 = await postT('/api/admin/spot/lock', { groundId: 'map', spotId: 'reed', locked: false }, AT);
  check('解锁成功', unlock1.data && unlock1.data.ok && unlock1.data.locked === false);
  const st7 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'reed' }, tokA);
  check('解锁后可再钓', st7.status === 200);

  // ---- 5. 删点只停该钓点的玩家 ----
  const st8 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'testcove' }, tokB);
  check('B 在新建钓点开钓', st8.status === 200);
  check('当前两人钓鱼中', (await fishingCount(AT)) === 2);
  const rm1 = await postT('/api/admin/spot/remove', { groundId: 'map', spotId: 'testcove' }, AT);
  check('删除钓点成功（后台新建的钓点直接移除、不可恢复）', rm1.data && rm1.data.ok && rm1.data.restorable === false, JSON.stringify(rm1.data));
  check('删点后只剩该点外的 1 人在钓（A 的芦苇荡不受影响）', (await fishingCount(AT)) === 1);
  const g2 = await getT('/api/grounds', tokA);
  const ids2 = (g2.data.grounds[0].spots || []).map(s => s.id);
  check('目录里已无被删钓点', !ids2.includes('testcove'));
  const rm2 = await postT('/api/admin/spot/pos', { groundId: 'map', list: [{ spotId: 'testcove', pos: [10, 10] }] }, AT);
  check('对不存在钓点保存坐标不报错', rm2.data && rm2.data.ok);

  // ---- 6. 内置钓点删除后可恢复 ----
  const rm3 = await postT('/api/admin/spot/remove', { groundId: 'map', spotId: 'falls' }, AT);
  check('删除内置钓点记录删除名单', rm3.data && rm3.data.ok && rm3.data.restorable === true, JSON.stringify(rm3.data));
  const rst = await postT('/api/admin/ground/restore', { groundId: 'map', spotId: 'falls' }, AT);
  check('被删内置钓点可恢复', rst.data && rst.data.ok, JSON.stringify(rst.data));
  const g3 = await getT('/api/grounds', tokA);
  check('恢复后目录重新包含钓点', (g3.data.grounds[0].spots || []).some(s => s.id === 'falls'));

  console.log('\n===== v0190-spots 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 =====');
  if (failed.length) { console.log('失败明细：'); failed.forEach(n => console.log('  - ' + n)); }
}

main().catch(e => { fail++; console.error('TEST ERROR:', e); }).finally(() => {
  streams.forEach(s => { try { s.destroy(); } catch (e) {} });
  if (srv) killTree(srv);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
});
