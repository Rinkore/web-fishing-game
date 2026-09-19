/*
 * v0.21.0 回归 —— 好友双向化 / 编队出海 / 远洋悬赏 / 锚地 / 新海上事件配置
 * 覆盖：
 *   · 好友：request → 对方 freqIn 收到 → accept 双向成为好友；reject / cancel / remove 路径
 *   · 编队：非好友拒邀 → 互为好友后邀请 → 接受 → 成员可见 → 离开转移队长 → 解散
 *   · 悬赏：每日 3 条（去重、池内）→ 出航推进 voyage 进度 → 领取奖励；submit 类扣鳞片；未完成拒领
 *   · 锚地：材料不足拒 → 下锚续期 + 追加增益 → 限次后拒绝
 *   · 临时海域名称：出航必有 name；旧海域缺 name 查询时兜底补名
 *   · 后台：新事件概率（whirlpool/wreck）与锚地/夜光潮配置校验
 * 认证：全部走 Authorization: Bearer。
 * 运行：node tests/v0210.test.js（需要 FISHING_DEV=1，套件自行设置）
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
const PORT = 8285;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0210-'));
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
  const payload = { username: username, password: 'v0210-test-1234', name: '回归测试', qq: '828500' };
  let r = await post('/api/register', payload);
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
// 实时连接：players 在线注册靠 SSE 握手（/api/friends 的 players 视图只列在线玩家）
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
  const names = { a: 'v210a' + uniq, b: 'v210b' + uniq };
  for (const k of ['a', 'b']) await registerAccount(names[k]);
  const tokens = {};
  for (const k of ['a', 'b']) {
    const l = await post('/api/login', { username: names[k], password: 'v0210-test-1234' });
    tokens[k] = l.data && l.data.token;
  }
  check('两个账号登录成功', !!tokens.a && !!tokens.b);
  streams.push(openStream(tokens.a), openStream(tokens.b));
  await new Promise(r => setTimeout(r, 800));
  // 好友/编队里的 id 就是小写账号 key（服务端身份口径），不是 /api/me 的展示字段
  const ids = { a: names.a, b: names.b };

  // ---- 1. 好友双向化 ----
  const bad1 = await postT('/api/friends', { target: names.b, action: 'accept' }, tokens.a);
  check('没有请求时 accept 被拒', bad1.status === 400, JSON.stringify(bad1.data || {}));
  const req1 = await postT('/api/friends', { target: names.b, action: 'request' }, tokens.a);
  check('A → B 发出好友请求', req1.status === 200, JSON.stringify(req1.data || {}));
  const fb = await getT('/api/friends', tokens.b);
  check('B 的收到列表能看到 A', fb.data.requests.in.some(x => x.id === ids.a), JSON.stringify(fb.data.requests || {}));
  const fa1 = await getT('/api/friends', tokens.a);
  check('A 的发出列表能看到 B', fa1.data.requests.out.some(x => x.id === ids.b), JSON.stringify(fa1.data.requests || {}));
  const fbPlayers = fb.data.players.find(x => x.id === ids.a);
  check('B 的玩家视图带 reqIn 标记', !!fbPlayers && fbPlayers.reqIn === true);
  // B 先拒绝 A，再让 A 重发、B 接受
  const rej = await postT('/api/friends', { target: names.a, action: 'reject' }, tokens.b);
  check('B 拒绝 A 的请求', rej.status === 200, JSON.stringify(rej.data || {}));
  const fc1 = await getT('/api/friends', tokens.a);
  check('A 的发出申请被清除（拒绝后）', !fc1.data.requests.out.some(x => x.id === ids.b));
  const fb2 = await getT('/api/friends', tokens.b);
  check('B 的收到列表里 A 已消失', !fb2.data.requests.in.some(x => x.id === ids.a));
  // A 重发申请后撤回，再重发、B 接受
  await postT('/api/friends', { target: names.b, action: 'request' }, tokens.a);
  const cancel = await postT('/api/friends', { target: names.b, action: 'cancel' }, tokens.a);
  const fbC = await getT('/api/friends', tokens.b);
  check('A 撤回申请后 B 的收到列表清空', cancel.status === 200 && !fbC.data.requests.in.some(x => x.id === ids.a));
  await postT('/api/friends', { target: names.b, action: 'request' }, tokens.a);
  const acc = await postT('/api/friends', { target: names.a, action: 'accept' }, tokens.b);
  check('B 接受 A 的请求', acc.status === 200, JSON.stringify(acc.data || {}));
  const [fa2, fb3] = await Promise.all([getT('/api/friends', tokens.a), getT('/api/friends', tokens.b)]);
  check('双方好友列表各含对方（双向）',
    fa2.data.friends.some(x => x.id === ids.b) && fb3.data.friends.some(x => x.id === ids.a));
  check('接受后双方待处理申请清空',
    !fa2.data.requests.out.some(x => x.id === ids.b) && !fb3.data.requests.in.some(x => x.id === ids.a));
  // 双向解除：B 移除 A
  await postT('/api/friends', { target: names.a, action: 'remove' }, tokens.b);
  const [fa3, fb4] = await Promise.all([getT('/api/friends', tokens.a), getT('/api/friends', tokens.b)]);
  check('移除后双方好友列表都不再含对方（双向解除）',
    !fa3.data.friends.some(x => x.id === ids.b) && !fb4.data.friends.some(x => x.id === ids.a));

  // ---- 2. 编队出海 ----
  const inv0 = await postT('/api/party', { action: 'invite', target: names.b }, tokens.a);
  check('未建队邀请被拒', inv0.status === 400, JSON.stringify(inv0.data || {}));
  const crt = await postT('/api/party', { action: 'create' }, tokens.a);
  check('A 创建编队', crt.status === 200 && crt.data.party && crt.data.party.members.length === 1, JSON.stringify(crt.data || {}));
  const inv1 = await postT('/api/party', { action: 'invite', target: names.b }, tokens.a);
  check('非好友邀请被拒（编队限互为好友）', inv1.status === 400 && /好友/.test(inv1.data.error || ''), JSON.stringify(inv1.data || {}));
  // 重新互加好友
  await postT('/api/friends', { target: names.b, action: 'request' }, tokens.a);
  await postT('/api/friends', { target: names.a, action: 'accept' }, tokens.b);
  const inv2 = await postT('/api/party', { action: 'invite', target: names.b }, tokens.a);
  check('互为好友后邀请成功', inv2.status === 200, JSON.stringify(inv2.data || {}));
  const pb0 = await getT('/api/party', tokens.b);
  check('B 的编队查询带邀请（含队长名）', !!pb0.data.invite && pb0.data.invite.leaderName, JSON.stringify(pb0.data || {}));
  const acc2 = await postT('/api/party', { action: 'accept' }, tokens.b);
  check('B 接受邀请入队（2/4）', acc2.status === 200 && acc2.data.party.members.length === 2, JSON.stringify(acc2.data || {}));
  const pa1 = await getT('/api/party', tokens.a);
  check('A 视角能看到 B 在队里', pa1.data.party.members.some(m => m.id === ids.b));
  const lv1 = await postT('/api/party', { action: 'leave' }, tokens.b);
  check('B 离开编队', lv1.status === 200, JSON.stringify(lv1.data || {}));
  const pa2 = await getT('/api/party', tokens.a);
  check('队长未变、成员回到 1 人', pa2.data.party.leader === ids.a && pa2.data.party.members.length === 1);
  // B 再入队，A 解散
  await postT('/api/party', { action: 'invite', target: names.b }, tokens.a);
  await postT('/api/party', { action: 'accept' }, tokens.b);
  const dis = await postT('/api/party', { action: 'disband' }, tokens.a);
  check('队长解散编队', dis.status === 200, JSON.stringify(dis.data || {}));
  const [pa3, pb1] = await Promise.all([getT('/api/party', tokens.a), getT('/api/party', tokens.b)]);
  check('解散后双方都无队伍', !pa3.data.party && !pb1.data.party);

  // ---- 2.5 编队共享出航（v0.21.0 后补）----
  // 重新建队 + 互邀入队
  await postT('/api/party', { action: 'create' }, tokens.a);
  await postT('/api/party', { action: 'invite', target: names.b }, tokens.a);
  await postT('/api/party', { action: 'accept' }, tokens.b);
  await postT('/api/dev/seed', { sea: { charts: 1 } }, tokens.a);
  const voyZ = await postT('/api/sea/voyage', {}, tokens.a);
  const zoneA = voyZ.data.zone;
  check('队长出航成功（共享用海域）', voyZ.status === 200 && !!zoneA, JSON.stringify(voyZ.data && voyZ.data.error || ''));
  const pz0 = await getT('/api/party', tokens.b);
  check('成员视角带队友共享海域', (pz0.data.memberZones || []).some(z => z.groundId === zoneA.groundId), JSON.stringify((pz0.data.memberZones || []).map(z => z.groundId)));
  const joinZ = await postT('/api/fishing/start', { groundId: zoneA.groundId, spotId: zoneA.spots[0].id }, tokens.b);
  check('成员可进队长海域下竿', joinZ.status === 200, JSON.stringify(joinZ.data || {}));
  await postT('/api/fishing/stop', {}, tokens.b);
  // B 离队后不再共享
  await postT('/api/party', { action: 'leave' }, tokens.b);
  const joinZ2 = await postT('/api/fishing/start', { groundId: zoneA.groundId, spotId: zoneA.spots[0].id }, tokens.b);
  check('非成员下竿队长海域被拒', joinZ2.status === 400 && /临时海域/.test(joinZ2.data.error || ''), JSON.stringify(joinZ2.data || {}));
  // 后台编队管理
  await postT('/api/party', { action: 'invite', target: names.b }, tokens.a);
  await postT('/api/party', { action: 'accept' }, tokens.b);

  // ---- 3. 远洋每日悬赏 ----
  const sq = await getT('/api/sea', tokens.a);
  const quests = sq.data.quests || [];
  const idsQ = quests.map(q => q.id);
  check('每日悬赏生成 3 条', quests.length === 3, JSON.stringify(idsQ));
  check('悬赏不重复且都在奖池内', new Set(idsQ).size === 3 && idsQ.every(id => (D.SEA.quests || []).some(t => t.id === id)), JSON.stringify(idsQ));
  const claimUn = await postT('/api/sea/quest/claim', { id: 'q_not_exist' }, tokens.a);
  check('领取不存在的悬赏被拒（404）', claimUn.status === 404, JSON.stringify(claimUn.data || {}));
  const claim0 = await postT('/api/sea/quest/claim', { id: quests[0].id }, tokens.a);
  check('未完成的悬赏拒领（400）', claim0.status === 400, JSON.stringify(claim0.data || {}));
  // 种入已完成 voyage 悬赏 → 出航推进 → 领取
  const meA = await getT('/api/me', tokens.a);
  await postT('/api/dev/seed', { sea: { charts: 1, quests: { day: new Date().toDateString(), list: [{ id: 'q_voyage', kind: 'voyage', progress: 1, claimed: false }] } } }, tokens.a);
  const voy = await postT('/api/sea/voyage', {}, tokens.a);
  check('出航成功且海域带名称', voy.status === 200 && !!voy.data.zone && !!voy.data.zone.name, JSON.stringify(voy.data && voy.data.zone || {}));
  check('海域钓点为真名（非「渔场·甲/乙」占位符）', voy.data.zone.spots.every(sp => !/渔场\s*·\s*[甲乙]/.test(sp.name)) && voy.data.zone.spots.length === 2, JSON.stringify(voy.data.zone && voy.data.zone.spots.map(x => x.name)));
  const sq2 = await getT('/api/sea', tokens.a);
  const qv = (sq2.data.quests || []).find(q => q.id === 'q_voyage');
  check('出航推进 voyage 悬赏进度到 2/2', !!qv && qv.progress === 2 && qv.need === 2, JSON.stringify(qv || {}));
  const coinsBefore = sq2.data.coins, fragBefore = sq2.data.chartfrag;
  const claim1 = await postT('/api/sea/quest/claim', { id: 'q_voyage' }, tokens.a);
  check('悬赏领取成功', claim1.status === 200, JSON.stringify(claim1.data && claim1.data.error || {}));
  const sq3 = await getT('/api/sea', tokens.a);
  const qv2 = (sq3.data.quests || []).find(q => q.id === 'q_voyage');
  check('领取后标记 claimed，金币与碎片入账',
    qv2 && qv2.claimed === true && sq3.data.coins === coinsBefore + 30000 && sq3.data.chartfrag === fragBefore + 4,
    JSON.stringify({ coins: sq3.data.coins, frag: sq3.data.chartfrag }));
  const claim2 = await postT('/api/sea/quest/claim', { id: 'q_voyage' }, tokens.a);
  check('重复领取被拒', claim2.status === 400, JSON.stringify(claim2.data || {}));
  // items 类奖励：潮汐寻宝（tide_sand×5 + relic×8，背包此前为空 → 恰好等于奖励值）
  await postT('/api/dev/seed', { sea: { quests: { day: new Date().toDateString(), list: [{ id: 'q_tide_hunter', kind: 'sea_event', progress: 3, claimed: false }] } } }, tokens.a);
  const claimI = await postT('/api/sea/quest/claim', { id: 'q_tide_hunter' }, tokens.a);
  const meI = await getT('/api/me', tokens.a);
  check('items 类奖励入账（潮汐砂+5 / 宝匣残片+8）',
    claimI.status === 200 && meI.data.inventory.tide_sand === 5 && meI.data.inventory.relic === 8,
    JSON.stringify({ ts: meI.data.inventory && meI.data.inventory.tide_sand, relic: meI.data.inventory && meI.data.inventory.relic }));
  // submit 类：无鳞片拒领，补料后领取并扣鳞片
  await postT('/api/dev/seed', { coins: 100000, inventory: { deepscale: 0 }, sea: { quests: { day: new Date().toDateString(), list: [{ id: 'q_submit_scale', kind: 'submit_deepscale', progress: 1, claimed: false }] } } }, tokens.a);
  const claim3 = await postT('/api/sea/quest/claim', { id: 'q_submit_scale' }, tokens.a);
  check('上贡类悬赏无鳞片时拒领', claim3.status === 400 && /鳞片/.test(claim3.data.error || ''), JSON.stringify(claim3.data || {}));
  await postT('/api/dev/seed', { inventory: { deepscale: 30 } }, tokens.a);
  const claim4 = await postT('/api/sea/quest/claim', { id: 'q_submit_scale' }, tokens.a);
  const sq4 = await getT('/api/sea', tokens.a);
  check('补足鳞片后领取成功且扣 8 片', claim4.status === 200 && sq4.data.deepscale === 22, JSON.stringify({ st: claim4.status, ds: sq4.data.deepscale }));

  // ---- 4. 锚地 ----
  const anc0 = await postT('/api/sea/anchor', { zoneId: 'nope' }, tokens.a);
  check('对不存在海域下锚被拒（404）', anc0.status === 404, JSON.stringify(anc0.data || {}));
  await postT('/api/dev/seed', { coins: 1000000, inventory: { deepscale: 0 }, sea: { charts: 1 } }, tokens.a);
  const voy2 = await postT('/api/sea/voyage', {}, tokens.a);
  const zoneId = voy2.data.zone && voy2.data.zone.id;
  check('第二片海域出航成功', voy2.status === 200 && !!zoneId);
  const anc1 = await postT('/api/sea/anchor', { zoneId: zoneId }, tokens.a);
  check('无鳞片下锚被拒', anc1.status === 400 && /鳞片/.test(anc1.data.error || ''), JSON.stringify(anc1.data || {}));
  await postT('/api/dev/seed', { inventory: { deepscale: 30 } }, tokens.a);
  const expBefore = voy2.data.zone.expire;
  const anc2 = await postT('/api/sea/anchor', { zoneId: zoneId }, tokens.a);
  const zoneAfter = anc2.data && anc2.data.sea && anc2.data.sea.zones.find(z => z.id === zoneId);
  check('下锚成功：续期（≥+20h）+ anchors=1 + 钓点增益追加 double',
    anc2.status === 200 && zoneAfter && zoneAfter.expire > expBefore + 20 * 3600 * 1000 && zoneAfter.anchors === 1 &&
    zoneAfter.spots.every(s => (s.buffs || []).some(b => b.type === 'double')),
    JSON.stringify(zoneAfter || anc2.data || {}));
  const anc3 = await postT('/api/sea/anchor', { zoneId: zoneId }, tokens.a);
  const zone3 = anc3.data && anc3.data.sea && anc3.data.sea.zones.find(z => z.id === zoneId);
  check('第二次下锚成功（anchors=2，增益不重复叠加类型）',
    anc3.status === 200 && zone3 && zone3.anchors === 2 &&
    zone3.spots.every(s => (s.buffs || []).filter(b => b.type === 'double').length === 1),
    JSON.stringify(zone3 && zone3.anchors));
  for (let i = 0; i < 2; i++) await postT('/api/sea/anchor', { zoneId: zoneId }, tokens.a);
  const ancEnd = await postT('/api/sea/anchor', { zoneId: zoneId }, tokens.a);
  check('超过限次（默认 3 次）后下锚被拒', ancEnd.status === 400, JSON.stringify(ancEnd.data || {}));

  // ---- 5. 临时海域名称兜底 ----
  await postT('/api/dev/seed', { sea: { charts: 1, zones: [{ id: 'zlegacy', mood: 'normal', expire: Date.now() + 3600 * 1000, spots: [] }] } }, tokens.a);
  const sLegacy = await getT('/api/sea', tokens.a);
  const lg = (sLegacy.data.zones || []).find(z => z.id === 'zlegacy');
  check('旧海域缺 name 时查询兜底补名', !!lg && typeof lg.name === 'string' && lg.name.length > 0, JSON.stringify(lg || {}));

  // ---- 6. 后台：新事件与锚地/夜光潮配置 ----
  const admUser = 'v210adm' + uniq;
  await registerAccount(admUser);
  const otp = await provisionAdmin(srv, TMP_DATA, admUser);
  const admLogin = await post('/api/admin/login', { username: admUser, password: 'v0210-test-1234', otp: otp });
  const AT = admLogin.data && admLogin.data.token;
  check('管理员登录成功', !!AT);
  const cfgOk = await postT('/api/admin/settings', { seaCfg: { sea: { events: { whirlpool: 4, wreck: 2 }, anchor: { coins: 60000, scales: 4, maxTimes: 5, extendMin: 720 }, nightglow: { on: false, rare: 20 } } } }, AT);
  check('后台保存漩涡/沉船/锚地/夜光潮配置', cfgOk.status === 200, JSON.stringify(cfgOk.data || {}).slice(0, 140));
  const sCfg = await getT('/api/sea', tokens.a);
  check('玩家端生效（whirlpool=4 / wreck=2 / anchor.coins=60000 / glow off）',
    sCfg.data.cfg.sea.events.whirlpool === 4 && sCfg.data.cfg.sea.events.wreck === 2 &&
    sCfg.data.cfg.sea.anchor.coins === 60000 && sCfg.data.cfg.sea.nightglow.on === false,
    JSON.stringify(sCfg.data.cfg && sCfg.data.cfg.sea || {}));
  const cfgBad = await postT('/api/admin/settings', { seaCfg: { sea: { anchor: { maxTimes: 999 } } } }, AT);
  check('非法锚地配置被整体拒绝（400）', cfgBad.status === 400, JSON.stringify(cfgBad.data || {}));
  const cfgQ = await postT('/api/admin/settings', { seaCfg: { sea: { quests: [
    { id: 'q_ocean_catch', need: 12, reward: { coins: 9000 } },
    { id: 'q_bad_id', need: 5 },
  ] } } }, AT);
  check('悬赏配置含未知条目被拒（400）', cfgQ.status === 400, JSON.stringify(cfgQ.data || {}));
  await postT('/api/dev/seed', { sea: { quests: { day: new Date().toDateString(), list: [{ id: 'q_ocean_catch', kind: 'catch_ocean', progress: 0, claimed: false }] } } }, tokens.a); // seed 强制当日含该悬赏（奖池随机滚 3/7）
  const cfgQ2 = await postT('/api/admin/settings', { seaCfg: { sea: { quests: [{ id: 'q_ocean_catch', need: 12, reward: { coins: 9000 } }] } } }, AT);
  check('后台保存悬赏配置', cfgQ2.status === 200, JSON.stringify(cfgQ2.data || {}).slice(0, 120));
  const sQ = await getT('/api/sea', tokens.a);
  const q12 = (sQ.data.quests || []).find(q => q.id === 'q_ocean_catch');
  check('悬赏编辑生效（need=12, 奖励金币=9000）', !!q12 && q12.need === 12 && q12.reward.coins === 9000, JSON.stringify(q12 || {}));
  const parties0 = await getT('/api/admin/parties', AT);
  check('后台编队列表可见（1 支）', parties0.status === 200 && parties0.data.parties.length === 1, JSON.stringify(parties0.data || {}).slice(0, 160));
  const disAdm = await postT('/api/admin/party/disband', { id: parties0.data.parties[0].id }, AT);
  check('后台解散编队', disAdm.status === 200, JSON.stringify(disAdm.data || {}));
  const pAfter = await getT('/api/party', tokens.a);
  check('被解散后玩家无队伍', !pAfter.data.party);
  await postT('/api/admin/settings', { seaCfg: {} }, AT);
  const sReset = await getT('/api/sea', tokens.a);
  check('恢复出厂（whirlpool 回 3 / anchor 回 50000）',
    sReset.data.cfg.sea.events.whirlpool === 3 && sReset.data.cfg.sea.anchor.coins === 50000,
    JSON.stringify(sReset.data.cfg && sReset.data.cfg.sea && sReset.data.cfg.sea.anchor || {}));
  const qReset = (sReset.data.quests || []).find(q => q.id === 'q_ocean_catch');
  check('恢复出厂后悬赏需求回默认（15）', !!qReset && qReset.need === 15, JSON.stringify(qReset || {}));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.error('失败明细：\n  - ' + failed.join('\n  - ')); process.exitCode = 1; }
}
function cleanup() {
  streams.forEach(s => { try { s.destroy(); } catch (e) {} });
  if (srv) { try { killTree(srv); } catch (e) {} }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
main().then(() => { cleanup(); process.exit(process.exitCode || 0); })
  .catch(e => { console.error('TEST ERROR', e && e.message || e); cleanup(); process.exit(1); });
