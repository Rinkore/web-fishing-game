/*
 * v0.21.3 回归（纯 HTTP）—— 编队变动收回临时海域 / 海域钓点分散落位
 * 覆盖：
 *   · 解散：正在队友海域垂钓的成员被立刻停竿（presence 回 idle）+ 收到 seaEvict 推送 + 不能再进去下竿
 *   · 被踢：同上（kick 路径）
 *   · 主动离队：同上（leave 路径）
 *   · 换队（accept 到别的队）：原队队友的海域同样收回
 *   · 海域主人自己不受影响（解散后仍在自己海域里钓着）
 *   · D.seaZoneLayout：多片海域的钓点两两不重叠，且避开三个固定远洋钓点
 * 认证：Authorization: Bearer（与 v0210 同口径）。
 * 运行：node tests/v0213.test.js（需要 FISHING_DEV=1，套件自行设置）
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp, waitFor } = require('./_util.js');
const registrationProof = require('./_registration.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8298;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0213-'));
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
async function registerAccount(username, name) {
  const payload = { username: username, password: 'v0213-test-1234', name: name || '回归测试', qq: '829800' };
  let r = await post('/api/register', payload);
  // 同 IP 第 4 个注册起要过验证（registration-guard：attempts > 3）→ 403 + code REGISTRATION_CHALLENGE，
  // 解完谜题再发一次（状态码是 403，不能只看 200）
  if (r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
// 实时连接：既让账号算「在线」（presence 才有它），又把原始推送留着给断言用
function openStream(token) {
  const box = { text: '' };
  const r = http.get('http://127.0.0.1:' + PORT + '/events', { headers: BEARER(token) }, res => {
    res.setEncoding('utf8');
    res.on('data', c => { box.text += c; if (box.text.length > 400000) box.text = box.text.slice(-200000); });
  });
  r.on('error', () => {});
  box.req = r;
  return box;
}
// 某个账号当前在不在钓、在哪个钓点（服务端权威 presence）
async function presenceOf(name, token) {
  const r = await getT('/api/players/page?size=50&q=' + encodeURIComponent(name), token);
  const p = ((r.data && r.data.players) || []).find(x => x.username === name || x.name === name);
  return p || null;
}
async function befriend(aTok, aKey, bTok, bKey) {
  await postT('/api/friends', { target: bKey, action: 'request' }, aTok);
  const acc = await postT('/api/friends', { target: aKey, action: 'accept' }, bTok);
  return acc.status === 200;
}
// 出航（注意：/api/dev/seed 的 sea 是**整体替换**，会把已有的临时海域一起清掉，
// 所以一个账号在同一段用例里只出航一次，拿到的 zone 直接复用）
async function voyage(token) {
  await postT('/api/dev/seed', { sea: { charts: 1 } }, token);
  const r = await postT('/api/sea/voyage', {}, token);
  return { status: r.status, zone: r.data && r.data.zone, error: r.data && r.data.error };
}
async function joinParty(leaderTok, leaderName, memberTok, memberName) {
  // 上一段用例可能把建队的人留在队里：先让它离队（没队时服务端会拒绝，忽略即可）
  await postT('/api/party', { action: 'leave' }, leaderTok);
  await postT('/api/party', { action: 'leave' }, memberTok);
  const c = await postT('/api/party', { action: 'create' }, leaderTok);
  if (c.status !== 200) return c;
  const i = await postT('/api/party', { action: 'invite', target: memberName }, leaderTok);
  if (i.status !== 200) return i;
  return postT('/api/party', { action: 'accept' }, memberTok);
}

let srv = null;
const streams = [];
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

  const uniq = String(Date.now() % 100000);
  const names = { a: 'v213a' + uniq, b: 'v213b' + uniq, c: 'v213c' + uniq };
  const shown = { a: '甲' + uniq, b: '乙' + uniq, c: '丙' + uniq };
  for (const k of ['a', 'b', 'c']) await registerAccount(names[k], shown[k]);
  const tokens = {};
  for (const k of ['a', 'b', 'c']) {
    const l = await post('/api/login', { username: names[k], password: 'v0213-test-1234' });
    tokens[k] = l.data && l.data.token;
  }
  check('三个账号登录成功', !!tokens.a && !!tokens.b && !!tokens.c);
  const sa = openStream(tokens.a), sb = openStream(tokens.b), sc = openStream(tokens.c);
  streams.push(sa, sb, sc);
  await new Promise(r => setTimeout(r, 800));
  const fAB = await befriend(tokens.a, names.a, tokens.b, names.b);
  const fAC = await befriend(tokens.a, names.a, tokens.c, names.c);
  const fBC = await befriend(tokens.b, names.b, tokens.c, names.c);
  check('三对互为好友（编队邀请的前置）', fAB && fAC && fBC);

  // ---- 1. 解散：正在队友海域里的成员被立刻收回；海域主人不受影响 ----
  const j1 = await joinParty(tokens.a, names.a, tokens.b, names.b);
  check('A 建队 + 邀请 B + B 入队', j1.status === 200 && j1.data.party && j1.data.party.members.length === 2, JSON.stringify(j1.data || {}));
  const v1 = await voyage(tokens.a);
  check('队长出航拿到临时海域', v1.status === 200 && !!v1.zone, JSON.stringify(v1.error || {}));
  const z1 = v1.zone;
  const st1 = await postT('/api/fishing/start', { groundId: z1.groundId, spotId: z1.spots[0].id }, tokens.b);
  check('B 在队时能进 A 的海域下竿', st1.status === 200, JSON.stringify(st1.data || {}));
  const pB0 = await presenceOf(shown.b, tokens.a);
  check('B 的 presence 显示在 A 的海域里钓鱼', !!pB0 && pB0.status === 'fishing' && pB0.groundId === z1.groundId, JSON.stringify(pB0 || {}));
  const stA0 = await postT('/api/fishing/start', { groundId: z1.groundId, spotId: z1.spots[1].id }, tokens.a);
  check('海域主人在自己海域下竿', stA0.status === 200, JSON.stringify(stA0.data || {}));
  sb.text = '';
  const dis1 = await postT('/api/party', { action: 'disband' }, tokens.a);
  check('队长解散编队', dis1.status === 200, JSON.stringify(dis1.data || {}));
  const gotEvict = await waitFor(() => /seaEvict/.test(sb.text), { timeout: 4000, interval: 120 });
  check('解散后 B 收到 seaEvict 推送（客户端据此弹窗）', gotEvict === true, sb.text.slice(-200));
  const idleB = await waitFor(async () => {
    const p = await presenceOf(shown.b, tokens.a);
    return !!p && p.status === 'idle' && !p.groundId;
  }, { timeout: 4000, interval: 150 });
  check('解散后 B 被停竿（presence 回 idle）', idleB === true, JSON.stringify(await presenceOf(shown.b, tokens.a) || {}));
  const restB = await postT('/api/fishing/start', { groundId: z1.groundId, spotId: z1.spots[0].id }, tokens.b);
  check('解散后 B 不能再进该海域下竿', restB.status === 400, JSON.stringify(restB.data || {}));
  const ownA = await presenceOf(shown.a, tokens.a);
  check('海域主人自己不受影响（仍在自己海域里钓着）', !!ownA && ownA.status === 'fishing' && ownA.groundId === z1.groundId, JSON.stringify(ownA || {}));

  // ---- 2. 被踢：同样立刻收回 ----
  const j2 = await joinParty(tokens.b, names.b, tokens.a, names.a);
  check('B 建队 + A 入队（换队长）', j2.status === 200, JSON.stringify(j2.data || {}));
  const v2 = await voyage(tokens.b);
  check('B 出航拿到自己的海域', v2.status === 200 && !!v2.zone, JSON.stringify(v2.error || {}));
  const z2 = v2.zone;
  const st2 = await postT('/api/fishing/start', { groundId: z2.groundId, spotId: z2.spots[0].id }, tokens.a);
  check('A 在队友 B 的海域下竿', st2.status === 200, JSON.stringify(st2.data || {}));
  sa.text = '';
  const kicked = await postT('/api/party', { action: 'kick', target: names.a }, tokens.b);
  check('队长踢人成功', kicked.status === 200, JSON.stringify(kicked.data || {}));
  const kickedEvict = await waitFor(() => /seaEvict/.test(sa.text), { timeout: 4000, interval: 120 });
  check('被踢后 A 收到 seaEvict 推送', kickedEvict === true, sa.text.slice(-200));
  const idleA = await waitFor(async () => {
    const p = await presenceOf(shown.a, tokens.a);
    return !!p && p.status === 'idle';
  }, { timeout: 4000, interval: 150 });
  check('被踢后 A 被停竿', idleA === true, JSON.stringify(await presenceOf(shown.a, tokens.a) || {}));
  const restA = await postT('/api/fishing/start', { groundId: z2.groundId, spotId: z2.spots[0].id }, tokens.a);
  check('被踢后 A 不能再进 B 的海域', restA.status === 400, JSON.stringify(restA.data || {}));

  // ---- 3. 主动离队：把自己的下竿权收掉 ----
  const j3 = await joinParty(tokens.b, names.b, tokens.c, names.c);
  check('B 建队 + C 入队', j3.status === 200, JSON.stringify(j3.data || {}));
  const v3 = await voyage(tokens.b);
  const z3 = v3.zone;
  check('B 再次出航（清掉上一片，拿到新海域）', v3.status === 200 && !!z3, JSON.stringify(v3.error || {}));
  const st3 = await postT('/api/fishing/start', { groundId: z3.groundId, spotId: z3.spots[0].id }, tokens.c);
  check('C 在 B 的海域下竿', st3.status === 200, JSON.stringify(st3.data || {}));
  sc.text = '';
  const lv3 = await postT('/api/party', { action: 'leave' }, tokens.c);
  check('C 主动离队', lv3.status === 200, JSON.stringify(lv3.data || {}));
  const leftEvict = await waitFor(() => /seaEvict/.test(sc.text), { timeout: 4000, interval: 120 });
  check('离队后 C 收到 seaEvict 推送', leftEvict === true, sc.text.slice(-200));
  const idleC = await waitFor(async () => {
    const p = await presenceOf(shown.c, tokens.c);
    return !!p && p.status === 'idle';
  }, { timeout: 4000, interval: 150 });
  check('离队后 C 被停竿', idleC === true, JSON.stringify(await presenceOf(shown.c, tokens.c) || {}));

  // ---- 4. 换队：原队队友的海域同样收回 ----
  const j4 = await joinParty(tokens.b, names.b, tokens.c, names.c);
  check('C 重新入 B 的队', j4.status === 200, JSON.stringify(j4.data || {}));
  const v4 = await voyage(tokens.b);
  const z4 = v4.zone;
  check('B 出航（换队用例的海域）', v4.status === 200 && !!z4, JSON.stringify(v4.error || {}));
  const st4 = await postT('/api/fishing/start', { groundId: z4.groundId, spotId: z4.spots[0].id }, tokens.c);
  check('C 在 B 的海域下竿（换队前置）', st4.status === 200, JSON.stringify(st4.data || {}));
  await postT('/api/party', { action: 'create' }, tokens.a);
  await postT('/api/party', { action: 'invite', target: names.c }, tokens.a);
  sc.text = '';
  const swap = await postT('/api/party', { action: 'accept' }, tokens.c);
  check('C 接受 A 的新队邀请（换队）', swap.status === 200, JSON.stringify(swap.data || {}));
  const swapEvict = await waitFor(() => /seaEvict/.test(sc.text), { timeout: 4000, interval: 120 });
  check('换队后 C 收到 seaEvict（原队海域不再共享）', swapEvict === true, sc.text.slice(-200));
  const restC = await postT('/api/fishing/start', { groundId: z4.groundId, spotId: z4.spots[0].id }, tokens.c);
  check('换队后 C 不能再进原队海域', restC.status === 400, JSON.stringify(restC.data || {}));

  // ---- 5. 后台解散也收回（海域主人仍不受影响）----
  const v5 = await voyage(tokens.a);
  const z5 = v5.zone;
  check('A 出航（后台解散用例的海域）', v5.status === 200 && !!z5, JSON.stringify(v5.error || {}));
  const st5 = await postT('/api/fishing/start', { groundId: z5.groundId, spotId: z5.spots[0].id }, tokens.c);
  check('C 在 A 海域下竿（后台解散用例前置）', st5.status === 200, JSON.stringify(st5.data || {}));
  const st5a = await postT('/api/fishing/start', { groundId: z5.groundId, spotId: z5.spots[1].id }, tokens.a);
  check('A 在自己的海域下竿', st5a.status === 200, JSON.stringify(st5a.data || {}));
  const { provisionAdmin } = require('./_admin.js');
  const admName = 'v213adm' + uniq;
  const admReg = await registerAccount(admName, '管理员' + uniq);
  check('管理员账号注册成功', admReg.status === 200, JSON.stringify(admReg.data || {}).slice(0, 160));
  const otp = await provisionAdmin(srv, TMP_DATA, admName);
  const admLogin = await post('/api/admin/login', { username: admName, password: 'v0213-test-1234', otp: otp });
  const AT = admLogin.data && admLogin.data.token;
  check('管理员登录成功', !!AT, JSON.stringify(admLogin.data || {}));
  const plist = await getT('/api/admin/parties', AT);
  const pOfC = ((plist.data && plist.data.parties) || []).find(x => (x.members || []).some(m => m.id === names.c));
  check('后台能看到含 C 的编队', !!pOfC, JSON.stringify((plist.data && plist.data.parties) || []));
  sc.text = '';
  const admDis = await postT('/api/admin/party/disband', { id: pOfC && pOfC.id }, AT);
  check('后台解散编队成功', admDis.status === 200, JSON.stringify(admDis.data || {}));
  const admEvict = await waitFor(() => /seaEvict/.test(sc.text), { timeout: 4000, interval: 120 });
  check('后台解散后成员也收到 seaEvict', admEvict === true, sc.text.slice(-200));
  const stillA = await presenceOf(shown.a, tokens.a);
  check('后台解散时海域主人自己不受影响（仍在钓）', !!stillA && stillA.status === 'fishing', JSON.stringify(stillA || {}));

  // ---- 6. 队友共享海域的「地图口径」来源（v0.21.3：/api/sea 与 /api/party 同源）----
  // 重新组队：A 建队拉 C，A 出航 → C 的 /api/sea 里应该出现 A 的海域；C 离队后应立刻消失
  await postT('/api/party', { action: 'disband' }, tokens.a);   // 上一条用例的队伍已被后台解散，这里只是兜底
  await joinParty(tokens.a, names.a, tokens.c, names.c);
  const v6 = await voyage(tokens.a);
  const z6 = v6.zone;
  check('A 出航（共享海域口径用例）', v6.status === 200 && !!z6, JSON.stringify(v6.error || {}));
  const seaC0 = await getT('/api/sea', tokens.c);
  const pz0 = (seaC0.data.partyZones || []).filter(z => z.groundId === z6.groundId);
  check('/api/sea 带上队友共享海域（地图据此画节点）', pz0.length === 1 && pz0[0].ownerName === shown.a, JSON.stringify(seaC0.data.partyZones || []));
  const seaA0 = await getT('/api/sea', tokens.a);
  check('海域主人的 /api/sea 不含自己的海域（自己在 zones 里）',
    !(seaA0.data.partyZones || []).length && (seaA0.data.zones || []).some(z => z.groundId === z6.groundId),
    JSON.stringify({ pz: seaA0.data.partyZones || [], zones: (seaA0.data.zones || []).map(z => z.groundId) }));
  await postT('/api/party', { action: 'leave' }, tokens.c);
  const seaC1 = await getT('/api/sea', tokens.c);
  check('离队后 /api/sea 的共享海域清空（地图节点随之消失）', !(seaC1.data.partyZones || []).length, JSON.stringify(seaC1.data.partyZones || []));
  const seaX = await getT('/api/sea', tokens.b);
  check('不在任何队伍时没有共享海域', !(seaX.data.partyZones || []).length, JSON.stringify(seaX.data.partyZones || {}));

  // ---- 7. 海域钓点落位（纯函数）----
  const anchors = D.SEA.zoneAnchors;
  check('海域锚点表存在且至少 6 个（够 6 片海域不撞位）', Array.isArray(anchors) && anchors.length >= 6, JSON.stringify(anchors || null));
  const pts = [];
  for (let i = 0; i < anchors.length; i++) D.seaZoneLayout(i, 2).spots.forEach(p => pts.push(p));
  let overlap = null;
  for (let i = 0; i < pts.length && !overlap; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[i][0] - pts[j][0]) < 12 && Math.abs(pts[i][1] - pts[j][1]) < 8) { overlap = [pts[i], pts[j]]; break; }
    }
  }
  check('多片海域的钓点两两不重叠（名牌不糊在一起）', !overlap, JSON.stringify(overlap || []));
  const fixedSpots = [[26, 73], [62, 44], [85, 26]];   // 近海渔场 / 深海鱼礁 / 海沟裂谷
  let nearFixed = null;
  pts.forEach(p => fixedSpots.forEach(f => {
    if (Math.abs(p[0] - f[0]) < 12 && Math.abs(p[1] - f[1]) < 8) nearFixed = [p, f];
  }));
  check('海域钓点不与固定远洋钓点撞位', !nearFixed, JSON.stringify(nearFixed || []));
  const lay0 = D.seaZoneLayout(0, 2), lay0b = D.seaZoneLayout(0, 2);
  check('同一片海域两次取位稳定（重绘不跳位）', JSON.stringify(lay0.spots) === JSON.stringify(lay0b.spots));
  const layBig = D.seaZoneLayout(0, 4).spots;
  check('4 个钓点也铺得开（无重叠）', layBig.length === 4 &&
    layBig.every((p, i) => layBig.every((q, j) => i === j || Math.abs(p[0] - q[0]) >= 6 || Math.abs(p[1] - q[1]) >= 5)), JSON.stringify(layBig));
  check('坐标都在地图内（4%~96%）', pts.every(p => p[0] >= 4 && p[0] <= 96 && p[1] >= 3 && p[1] <= 97), JSON.stringify(pts.filter(p => !(p[0] >= 4 && p[0] <= 96 && p[1] >= 3 && p[1] <= 97))));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.error('失败明细：\n  - ' + failed.join('\n  - ')); process.exitCode = 1; }
}
function cleanup() {
  streams.forEach(s => { try { s.req.destroy(); } catch (e) {} });
  if (srv) { try { killTree(srv); } catch (e) {} }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
main().then(() => { cleanup(); process.exit(process.exitCode || 0); })
  .catch(e => { console.error('TEST ERROR', e && e.message || e); cleanup(); process.exit(1); });
