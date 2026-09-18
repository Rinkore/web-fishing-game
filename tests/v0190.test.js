/*
 * v0.19.0 远洋（出海）回归 —— 方案 C（船系统）+ 方案 E（随机海域）功能测试板
 * 覆盖：
 *   · /api/sea 查询：船初始状态（1 级木划艇、0 经验、0 海图）
 *   · 船级门槛：海沟裂谷拒 1 级船、近海渔场放行；升级失败（经验不足）与成功路径
 *   · 海图合成：碎片不足拒绝 / 3 碎片 → 1 海图
 *   · 临时海域：无图拒出航 / 出航生成私有海域（groundId 内嵌归属）/ 他人海域拒下竿
 *   · 惰性沉没：dev/seed 种入过期海域后 GET 即清掉
 * 认证：v0.16.4 起 URL/请求体一律禁止携带会话凭据，全部走 Authorization: Bearer。
 * 运行：node tests/v0190.test.js（需要 FISHING_DEV=1，套件自行设置）
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
const PORT = 8273;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-sea-test-'));
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
  const payload = { username: username, password: 'sea-test-1234', name: '远洋测试', qq: '827300' };
  let r = await post('/api/register', payload);
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}
// 实时连接：startFishingSession 要求 players 里有该账号（与浏览器在线等价）。
// 无 'error' 处理的话，服务器重启/keep-alive 重置连接会把整个测试进程炸掉。
function openStream(token) {
  const r = http.get('http://127.0.0.1:' + PORT + '/events', { headers: BEARER(token) }, res => { res.resume(); });
  r.on('error', () => {});
  return r;
}
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }

let srv = null;
const streams = [];
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

  // ---- 登录两个玩家 + 建实时连接 ----
  // 账号名带随机后缀：注册防护按「同名/同源」限频，重跑套件不被 409/403 卡住
  const uniq = String(Date.now() % 100000);
  const ra = await registerAccount('v190a' + uniq);
  const rb = await registerAccount('v190b' + uniq);
  check('注册两个测试账号成功', ra.status === 200 && rb.status === 200, JSON.stringify({ ra: ra.status, rb: rb.status }));
  const la = await post('/api/login', { username: 'v190a' + uniq, password: 'sea-test-1234' });
  const lb = await post('/api/login', { username: 'v190b' + uniq, password: 'sea-test-1234' });
  const tokA = la.data && la.data.token, tokB = lb.data && lb.data.token;
  check('两个账号登录成功', !!tokA && !!tokB);
  streams.push(openStream(tokA), openStream(tokB));
  await new Promise(r => setTimeout(r, 800)); // 等 SSE 握手注册 players

  // ---- 1. 初始状态 ----
  const s0 = await getT('/api/sea', tokA);
  check('未登录查询被拒', (await request('/api/sea')).status === 401);
  check('初始船：1 级木划艇 / 0 经验 / 0 海图 / 无临时海域',
    s0.status === 200 && s0.data.ship.lv === 1 && s0.data.ship.name === '木划艇' &&
    s0.data.ship.xp === 0 && s0.data.ship.xpNeed === D.SHIP.xpNeed[1] &&
    s0.data.charts === 0 && Array.isArray(s0.data.zones) && s0.data.zones.length === 0,
    JSON.stringify(s0.data || {}).slice(0, 200));

  // ---- 2. 船级门槛与钓点放行 ----
  const gTrench = await postT('/api/fishing/start', { groundId: 'map', spotId: 'trench' }, tokA);
  check('1 级船下竿海沟裂谷被拒（船级不足）', gTrench.status === 400 && /船级不足/.test(gTrench.data.error), JSON.stringify(gTrench.data));
  const gShore = await postT('/api/fishing/start', { groundId: 'map', spotId: 'shore' }, tokA);
  check('1 级船可下竿近海渔场', gShore.status === 200 && gShore.data.interval > 0, JSON.stringify(gShore.data));
  await postT('/api/fishing/stop', {}, tokA);

  // ---- 3. 升级 / 合成 / 出航的失败路径 ----
  const upNoXp = await postT('/api/sea/ship/up', {}, tokA);
  check('经验不足时升级被拒', upNoXp.status === 400 && /经验不足/.test(upNoXp.data.error), JSON.stringify(upNoXp.data));
  const chNoFrag = await postT('/api/sea/chart', {}, tokA);
  check('碎片不足时合成被拒', chNoFrag.status === 400 && /海图碎片不足/.test(chNoFrag.data.error), JSON.stringify(chNoFrag.data));
  const vgNoChart = await postT('/api/sea/voyage', {}, tokA);
  check('没有海图时出航被拒', vgNoChart.status === 400 && /未知海图/.test(vgNoChart.data.error), JSON.stringify(vgNoChart.data));

  // ---- 4. 海图合成 ----
  await postT('/api/dev/seed', { inventory: { chartfrag: 2 } }, tokA);
  const chShort = await postT('/api/sea/chart', {}, tokA);
  check('碎片 2/3 时合成仍被拒', chShort.status === 400, JSON.stringify(chShort.data));
  await postT('/api/dev/seed', { inventory: { chartfrag: 3 } }, tokA);
  const chOk = await postT('/api/sea/chart', {}, tokA);
  check('3 碎片合成 1 张海图', chOk.status === 200 && chOk.data.sea.charts === 1 && chOk.data.sea.chartfrag === 0, JSON.stringify(chOk.data && chOk.data.sea));

  // ---- 5. 惰性沉没 + 出航 ----
  await postT('/api/dev/seed', { sea: { charts: 1, zones: [{ id: 'zold', name: '过期海', mood: 'normal', expire: Date.now() - 1000, spots: [] }] } }, tokA);
  const sPurge = await getT('/api/sea', tokA);
  check('过期海域在查询时被惰性清除', sPurge.status === 200 && sPurge.data.zones.length === 0 && sPurge.data.charts === 1, JSON.stringify(sPurge.data && sPurge.data.zones));
  const vgOk = await postT('/api/sea/voyage', {}, tokA);
  const zone = vgOk.data && vgOk.data.zone;
  check('出航成功生成临时海域（2 钓点 / 合法心情 / 未来过期）',
    vgOk.status === 200 && zone && zone.groundId.indexOf('sea:v190a') === 0 &&
    zone.spots.length === 2 && zone.spots.every(s => Array.isArray(s.buffs)) &&
    D.SEA.moods.some(m => m.id === zone.mood) && zone.expire > Date.now(),
    JSON.stringify(vgOk.data).slice(0, 220));
  const vgChartless = await postT('/api/sea/voyage', {}, tokA);
  check('海图用完后再次出航被拒', vgChartless.status === 400, JSON.stringify(vgChartless.data));
  if (!zone) { console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项（海域未生成，后续用例跳过）'); if (fail) process.exitCode = 1; return; }

  // ---- 6. 临时海域下竿与归属校验 ----
  const zf = await postT('/api/fishing/start', { groundId: zone.groundId, spotId: zone.spots[0].id }, tokA);
  check('主人可在临时海域下竿', zf.status === 200 && zf.data.interval > 0, JSON.stringify(zf.data));
  const zfB = await postT('/api/fishing/start', { groundId: zone.groundId, spotId: zone.spots[0].id }, tokB);
  check('他人海域下竿被拒（归属内嵌 groundId）', zfB.status === 400 && /临时海域/.test(zfB.data.error), JSON.stringify(zfB.data));
  await postT('/api/fishing/stop', {}, tokA);

  // ---- 7. 船升级成功路径与深水门槛 ----
  await postT('/api/dev/seed', { ship: { lv: 1, xp: 40 }, coins: 20000, inventory: { deepscale: 5 } }, tokA);
  const sPre = await getT('/api/sea', tokA);
  check('经验攒够后 xpOk 亮起', sPre.data.ship.xpOk === true && sPre.data.ship.upCoins === 20000 && sPre.data.ship.upScale === 5, JSON.stringify(sPre.data.ship));
  const upOk = await postT('/api/sea/ship/up', {}, tokA);
  check('升级成功：2 级近海帆船，金币与鳞片扣除', upOk.status === 200 && upOk.data.sea.ship.lv === 2 &&
    upOk.data.sea.coins === 0 && upOk.data.sea.deepscale === 0, JSON.stringify(upOk.data && upOk.data.sea && upOk.data.sea.ship));
  const gReef = await postT('/api/fishing/start', { groundId: 'map', spotId: 'reef' }, tokA);
  check('2 级船仍进不了深海鱼礁（需 3 级）', gReef.status === 400 && /船级不足/.test(gReef.data.error), JSON.stringify(gReef.data));
  await postT('/api/dev/seed', { ship: { lv: 4, xp: 0 } }, tokA);
  const gTrench4 = await postT('/api/fishing/start', { groundId: 'map', spotId: 'trench' }, tokA);
  check('4 级船可下竿海沟裂谷', gTrench4.status === 200, JSON.stringify(gTrench4.data));
  await postT('/api/fishing/stop', {}, tokA);

  // ---- 8. 静态数据守卫 ----
  const ocean = { spots: D.GROUNDS[0].spots.filter(sp => sp.map === 'voyage') };
  check('远洋渔场 3 钓点且船级门槛递增', ocean && ocean.spots.length === 3 &&
    ocean.spots[0].minShip === 1 && ocean.spots[1].minShip === 3 && ocean.spots[2].minShip === 4);
  check('新海鱼进目录且海王在稀有池', D.FISH.rare.some(f => f.id === 'leviathan') && D.fishTierOf('leviathan') === 'rare');
  check('新材料进目录（海图碎片/深海鳞片）', !!D.itemOf('chartfrag') && !!D.itemOf('deepscale'));

  // ---- 9. 后台远洋配置（settings 通道 + 校验 + 恢复出厂） ----
  // admin-init 会 kickUserSessions：必须用独立管理员账号，不能复用 tokA（否则玩家会话被踢，后续用例 401）。
  const admUser = 'v190adm' + uniq;
  const admReg = await registerAccount(admUser);
  check('管理员账号注册成功', admReg.status === 200, JSON.stringify(admReg.data || {}).slice(0, 140));
  const otp = await provisionAdmin(srv, TMP_DATA, admUser);
  const admLogin = await post('/api/admin/login', { username: admUser, password: 'sea-test-1234', otp: otp });
  const AT = admLogin.data && admLogin.data.token;
  check('管理员登录成功', !!AT, JSON.stringify(admLogin.data || {}).slice(0, 120));
  const cfgSet = await postT('/api/admin/settings', { seaCfg: { sea: { chartCost: 4, zoneTtlMin: 90 } } }, AT);
  check('后台保存远洋配置成功', cfgSet.status === 200 && cfgSet.data.seaCfg.sea.chartCost === 4, JSON.stringify(cfgSet.data || {}).slice(0, 120));
  const sCfg = await getT('/api/sea', tokA);
  check('玩家端 /api/sea 立即生效（chartCost=4 + cfg 下发）', sCfg.data.chartCost === 4 && sCfg.data.cfg.sea.chartCost === 4, JSON.stringify(sCfg.data.chartCost));
  const badSet = await postT('/api/admin/settings', { seaCfg: { sea: { chartCost: 0 } } }, AT);
  check('非法配置被整体拒绝（400）', badSet.status === 400 && /海图成本/.test(badSet.data.error), JSON.stringify(badSet.data || {}));
  const worldCfg = await getT('/api/admin/world', AT);
  check('后台 world 快照携带 seaCfg 与生效值', worldCfg.status === 200 && worldCfg.data.seaCfg && worldCfg.data.sea.chartCost === 4, JSON.stringify(worldCfg.data && worldCfg.data.sea));
  await postT('/api/admin/settings', { seaCfg: {} }, AT);
  const sReset = await getT('/api/sea', tokA);
  check('恢复出厂（chartCost 回 3）', sReset.data.chartCost === 3, String(sReset.data.chartCost));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.error('失败明细：\n  - ' + failed.join('\n  - ')); process.exitCode = 1; }
}
function cleanup() {
  streams.forEach(s => { try { s.destroy(); } catch (e) {} });
  if (srv) { try { killTree(srv); } catch (e) {} }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanup);
process.on('unhandledRejection', e => { console.error(e); cleanup(); process.exit(1); });
main().catch(e => { console.error(e); process.exitCode = 1; });
