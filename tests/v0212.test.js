/*
 * v0.21.2 回归 —— 好友身份消歧 / 申请中止语义 / 远洋悬赏可配（上交物品 + 任意奖励）/ 分图钓点坐标
 * 覆盖：
 *   · 好友：/api/friends/relations 三组 id；申请/玩家视图都带 @账号名（username）；cancel/reject 无对应申请时报 400
 *   · 悬赏：上交类进度按持有量实时判定（以前永远 0 → 领不了）；上交物品由配置决定；奖励物品清单可配
 *   · 后台：悬赏需求类型 / 上交物品 / 奖励物品的校验（未知类型、非法物品必须被拒）
 *   · 钓点：两张图（近岸 + 远洋）坐标互不干扰，/api/grounds 的 map 字段供前端分图
 * 认证：全部走 Authorization: Bearer。
 * 运行：node tests/v0212.test.js（需要 FISHING_DEV=1，套件自行设置）
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
const PORT = 8296;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0212-'));
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
async function getT(p, t) { return request(p, { headers: BEARER(t) }); }
async function postT(p, b, t) { return request(p, { method: 'POST', body: b, headers: BEARER(t) }); }
async function post(p, b) { return request(p, { method: 'POST', body: b }); }
async function registerAccount(username, name) {
  const payload = { username: username, password: 'v0212-test-1234', name: name, qq: '829600' };
  let r = await post('/api/register', payload);
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
function openStream(token) {
  const r = http.get('http://127.0.0.1:' + PORT + '/events', { headers: BEARER(token) }, res => { res.resume(); });
  r.on('error', () => {});
  return r;
}

let srv = null;
const streams = [];
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

  const uniq = String(Date.now() % 100000);
  const ids = { a: 'v212a' + uniq, b: 'v212b' + uniq };
  await registerAccount(ids.a, '甲钓手' + uniq);
  await registerAccount(ids.b, '乙钓手' + uniq);
  const tokens = {};
  for (const k of ['a', 'b']) {
    const l = await post('/api/login', { username: ids[k], password: 'v0212-test-1234' });
    tokens[k] = l.data && l.data.token;
  }
  check('两个账号登录成功', !!tokens.a && !!tokens.b);
  streams.push(openStream(tokens.a), openStream(tokens.b));
  await new Promise(r => setTimeout(r, 600));

  // ---- 1. 好友身份消歧 + 中止语义 ----
  const rel0 = await getT('/api/friends/relations', tokens.a);
  check('关系速查接口可用且三组齐全',
    rel0.status === 200 && rel0.data && Array.isArray(rel0.data.friends) && Array.isArray(rel0.data.in) && Array.isArray(rel0.data.out),
    JSON.stringify(rel0.data || {}));
  check('未登录不能取关系速查（401）', (await getT('/api/friends/relations', 'bad-token')).status === 401);
  const req1 = await postT('/api/friends', { target: ids.b, action: 'request' }, tokens.a);
  check('A → B 发出好友请求', req1.status === 200, JSON.stringify(req1.data || {}));
  const fa = await getT('/api/friends?q=', tokens.a);
  const fb = await getT('/api/friends?q=', tokens.b);
  const outRow = (fa.data.requests.out || [])[0] || {};
  const inRow = (fb.data.requests.in || [])[0] || {};
  check('发出申请行带 @账号名（同名玩家可分辨）', outRow.username === ids.b, JSON.stringify(outRow));
  check('收到申请行带 @账号名', inRow.username === ids.a, JSON.stringify(inRow));
  const fbPlayer = (fb.data.players || []).find(x => x.id === ids.a) || {};
  check('玩家视图也带 username', fbPlayer.username === ids.a, JSON.stringify(fbPlayer));
  const relA = await getT('/api/friends/relations', tokens.a);
  const relB = await getT('/api/friends/relations', tokens.b);
  check('A 的关系速查里 B 在 out、B 的里 A 在 in',
    relA.data.out.indexOf(ids.b) >= 0 && relA.data.in.length === 0 && relB.data.in.indexOf(ids.a) >= 0 && relB.data.out.length === 0,
    JSON.stringify({ a: relA.data, b: relB.data }));
  // 没有申请时的 cancel / reject 必须报错（旧版静默 200，界面会说「已撤回」但其实什么都没发生）
  const badCancel = await postT('/api/friends', { target: ids.a, action: 'cancel' }, tokens.b);
  check('没有待撤回的申请时 cancel 报 400', badCancel.status === 400, JSON.stringify(badCancel.data || {}));
  const badReject = await postT('/api/friends', { target: ids.b, action: 'reject' }, tokens.a);
  check('没有待处理申请时 reject 报 400', badReject.status === 400, JSON.stringify(badReject.data || {}));
  const cancelOk = await postT('/api/friends', { target: ids.b, action: 'cancel' }, tokens.a);
  check('撤回自己的申请成功', cancelOk.status === 200, JSON.stringify(cancelOk.data || {}));
  const fb2 = await getT('/api/friends?q=', tokens.b);
  check('撤回后对方的收到列表清空', (fb2.data.requests.in || []).length === 0, JSON.stringify(fb2.data.requests || {}));
  check('重复撤回被拒（不再假装成功）',
    (await postT('/api/friends', { target: ids.b, action: 'cancel' }, tokens.a)).status === 400);
  // B 侧确实有 A 的待处理申请 → reject 应当成功（严格校验不能把正常路径一起拒掉）
  await postT('/api/friends', { target: ids.b, action: 'request' }, tokens.a);
  const rejectOk = await postT('/api/friends', { target: ids.a, action: 'reject' }, tokens.b);
  check('确实有待处理申请时 reject 成功', rejectOk.status === 200, JSON.stringify(rejectOk.data || {}));
  await postT('/api/friends', { target: ids.b, action: 'request' }, tokens.a);
  await postT('/api/friends', { target: ids.a, action: 'accept' }, tokens.b);
  const relA2 = await getT('/api/friends/relations', tokens.a);
  check('成为好友后关系速查进入 friends 组', relA2.data.friends.indexOf(ids.b) >= 0, JSON.stringify(relA2.data));
  check('不能加自己为好友（400）',
    (await postT('/api/friends', { target: ids.a, action: 'request' }, tokens.a)).status === 400,
    JSON.stringify((await postT('/api/friends', { target: ids.a, action: 'request' }, tokens.a)).data || {}));

  // ---- 2. 悬赏：上交物品（进度 / 领取 / 扣料 / 奖励入账） ----
  const qTpl = (D.SEA.quests || []).find(t => t.id === 'q_submit_scale');
  check('出厂模板：上贡悬赏改通用 submit + 上交物品字段',
    !!qTpl && qTpl.kind === 'submit' && qTpl.submit && qTpl.submit.id === 'deepscale' && qTpl.submit.count === 8,
    JSON.stringify(qTpl || {}));
  const today = new Date().toDateString();
  // 种一条上交类悬赏 + 正好够的材料 → 进度必须自动变 1（旧版这条进度永远是 0，一辈子领不了）
  await postT('/api/dev/seed', { inventory: { deepscale: 8 }, sea: { quests: { day: today, list: [{ id: 'q_submit_scale', kind: 'submit', progress: 0, claimed: false }] } } }, tokens.a);
  const sq = await getT('/api/sea', tokens.a);
  const qv = (sq.data.quests || []).find(q => q.id === 'q_submit_scale') || {};
  check('持有量足够 → 上交类悬赏进度自动推进', qv.progress === 1 && qv.need === 1, JSON.stringify(qv));
  check('上交要求随条目下发（物品名 + 数量 + 持有量）',
    !!qv.submit && qv.submit.id === 'deepscale' && qv.submit.name === D.itemName('deepscale') && qv.submit.count === 8 && qv.submit.have === 8,
    JSON.stringify(qv.submit || {}));
  const claim1 = await postT('/api/sea/quest/claim', { id: 'q_submit_scale' }, tokens.a);
  check('上交类悬赏可领取', claim1.status === 200, JSON.stringify((claim1.data && claim1.data.error) || {}));
  check('领取后标记已领取', ((claim1.data.sea.quests || []).find(q => q.id === 'q_submit_scale') || {}).claimed === true);
  const invAfter = ((await getT('/api/me', tokens.a)).data || {}).inventory || {};
  check('领取时按配置扣掉上交物品（8 片深海鳞片归零）', !invAfter.deepscale, JSON.stringify(invAfter.deepscale));
  await postT('/api/dev/seed', { inventory: { deepscale: 0 }, sea: { quests: { day: today, list: [{ id: 'q_submit_scale', kind: 'submit', progress: 1, claimed: false }] } } }, tokens.a);
  const claimPoor = await postT('/api/sea/quest/claim', { id: 'q_submit_scale' }, tokens.a);
  check('材料不足时领取被拒（400）', claimPoor.status === 400, JSON.stringify(claimPoor.data || {}));

  // ---- 3. 后台：悬赏配置校验 + 落地（需求类型 / 上交物品 / 奖励物品） ----
  const otp = await provisionAdmin(srv, TMP_DATA, ids.a);
  const admLogin = await post('/api/admin/login', { username: ids.a, password: 'v0212-test-1234', otp: otp });
  const AT = admLogin.data && admLogin.data.token;
  check('管理员登录成功', !!AT);
  const badKind = await postT('/api/admin/settings', { seaCfg: { sea: { quests: [{ id: 'q_voyage', kind: 'not_a_kind' }] } } }, AT);
  check('未知需求类型被拒', badKind.status === 400, JSON.stringify(badKind.data || {}));
  const badSubmit = await postT('/api/admin/settings', { seaCfg: { sea: { quests: [{ id: 'q_voyage', kind: 'submit', submit: { id: 'no_such_item', count: 3 } }] } } }, AT);
  check('非法上交物品被拒', badSubmit.status === 400, JSON.stringify(badSubmit.data || {}));
  const badReward = await postT('/api/admin/settings', { seaCfg: { sea: { quests: [{ id: 'q_voyage', reward: { items: { no_such_item: 1 } } }] } } }, AT);
  check('非法奖励物品被拒', badReward.status === 400, JSON.stringify(badReward.data || {}));
  const okCfg = await postT('/api/admin/settings', { seaCfg: { sea: { quests: [
    { id: 'q_voyage', title: '上贡遗物：交 3 个宝匣残片', kind: 'submit', need: 1, submit: { id: 'relic', count: 3 },
      reward: { coins: 12345, chartfrag: 0, deepscale: 0, items: { chest_king: 2, tide_sand: 4 } } },
  ] } } }, AT);
  check('「上交指定物品 + 任意奖励」配置被接受', okCfg.status === 200, JSON.stringify(okCfg.data || {}));
  // 管理员登录会重置该账号的普通会话（安全策略）→ 重新登录玩家端；配置已落库，与登录态无关
  const relogin = await post('/api/login', { username: ids.a, password: 'v0212-test-1234' });
  tokens.a = relogin.data && relogin.data.token;
  check('管理员登录后玩家端可重新登录', !!tokens.a);
  await postT('/api/dev/seed', { inventory: { relic: 3 }, sea: { quests: { day: today, list: [{ id: 'q_voyage', kind: 'submit', progress: 0, claimed: false }] } } }, tokens.a);
  const sq2 = await getT('/api/sea', tokens.a);
  const qv2 = (sq2.data.quests || []).find(q => q.id === 'q_voyage') || {};
  check('玩家端读到新标题与上交物品',
    qv2.title === '上贡遗物：交 3 个宝匣残片' && !!qv2.submit && qv2.submit.id === 'relic' && qv2.submit.count === 3,
    JSON.stringify(qv2));
  check('玩家端读到新奖励清单（金币 + 两件物品）',
    !!qv2.reward && qv2.reward.coins === 12345 && qv2.reward.items && qv2.reward.items.chest_king === 2 && qv2.reward.items.tide_sand === 4,
    JSON.stringify(qv2.reward || {}));
  const claimRelic = await postT('/api/sea/quest/claim', { id: 'q_voyage' }, tokens.a);
  check('按新配置领取成功', claimRelic.status === 200, JSON.stringify((claimRelic.data && claimRelic.data.error) || {}));
  const inv2 = ((await getT('/api/me', tokens.a)).data || {}).inventory || {};
  check('奖励按清单入账、上交物品按配置扣除',
    (inv2.chest_king || 0) === 2 && (inv2.tide_sand || 0) === 4 && !(inv2.relic > 0), JSON.stringify(inv2));

  // ---- 4. 分图钓点：两张图的坐标互不干扰（回到后台，重新登录管理员） ----
  const otp2 = await provisionAdmin(srv, TMP_DATA, ids.a);
  const AT2 = ((await post('/api/admin/login', { username: ids.a, password: 'v0212-test-1234', otp: otp2 })).data || {}).token;
  check('管理员可再次登录', !!AT2);
  check('恢复出厂配置成功',
    (await postT('/api/admin/settings', { seaCfg: {} }, AT2)).status === 200);
  const gMap = (((await request('/api/grounds')).data.grounds) || []).find(g => g.id === 'map') || { spots: [] };
  const nearSpot = gMap.spots.find(s => s.map !== 'voyage');
  const voySpot = gMap.spots.find(s => s.map === 'voyage');
  check('世界地图同时含近岸与远洋钓点（前端据此分图）', !!nearSpot && !!voySpot,
    JSON.stringify({ near: nearSpot && nearSpot.id, voy: voySpot && voySpot.id }));
  const posPost = await postT('/api/admin/spot/pos', { groundId: 'map',
    list: [{ spotId: nearSpot.id, pos: [11, 12] }, { spotId: voySpot.id, pos: [77, 78] }] }, AT2);
  check('两张图的坐标一起保存成功', posPost.status === 200, JSON.stringify(posPost.data || {}));
  const spots2 = ((((await request('/api/grounds')).data.grounds) || []).find(g => g.id === 'map') || { spots: [] }).spots;
  const near2 = spots2.find(s => s.id === nearSpot.id) || {};
  const voy2 = spots2.find(s => s.id === voySpot.id) || {};
  check('近岸点坐标只落在近岸点身上', Array.isArray(near2.pos) && near2.pos[0] === 11 && near2.pos[1] === 12, JSON.stringify(near2.pos));
  check('远洋点坐标只落在远洋点身上（与近岸不混）',
    Array.isArray(voy2.pos) && voy2.pos[0] === 77 && voy2.pos[1] === 78 && voy2.map === 'voyage', JSON.stringify(voy2));

  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项' + (fail ? '：' + failed.join(' / ') : ''));
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  streams.forEach(s => { try { s.destroy(); } catch (e) {} });
  if (srv) killTree(srv);
});
