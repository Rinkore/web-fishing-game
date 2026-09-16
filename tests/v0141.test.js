/*
 * v0.14.1 回归（纯 HTTP，不依赖浏览器）
 * 覆盖：
 *   · 基准体型口径：data.js 的 size = [min,max]，基准上限＝size[1]（服务端大型/巨型阈值同源）；
 *     记录页「基准 x~ycm」小字与排行榜「超出基准 %」都按它算，断言两者数学一致
 *   · 后台「删单条纪录」/api/admin/records/delone：日/周/总 × 最大/最小 按名次删；
 *     陈旧条目（who/size/t 对不上）→ 409 不误删；名次越界 → 409；未知鱼种 → 400；非管理员 → 403
 *   · purge=1：同一条（同钓者 + 同尺寸）从该鱼其它榜单与「最大纪录」里一并清掉，全场最大随之重算
 *   · 删空的榜会收尾（当日榜回到空数组）；整鱼种清空的旧接口仍可用
 *   · 删除会广播 recordsDirty（玩家端记录页即时刷新的依据）
 * 运行： node tests/v0141.test.js
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
const PORT = 8242;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0141-test-'));
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
// 最小 SSE 监听：抓 recordsDirty / records 广播
function sseListen(tok, sink) {
  const r = http.request({ hostname: 'localhost', port: PORT, path: '/events?token=' + encodeURIComponent(tok), method: 'GET' }, res => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        try {
          const m = JSON.parse(line.slice(6));
          if (m && m.type === 'batch' && Array.isArray(m.list)) m.list.forEach(x => sink.push(x));
          else sink.push(m);
        } catch (e) {}
      }
    });
  });
  r.on('error', () => {});
  r.end();
  return r;
}

const FISH = 'crucian';               // 鲫鱼：基准 [10,35]cm → 基准上限 35（>35 大型、>63 巨型）
const BASE = D.itemOf(FISH).size;
const catchFish = (token, size) => POST('/api/dev/catch', { token: token, item: { id: FISH, kind: 'fish', rarity: 'common', size: size } });
const board = async range => ((await GET('/api/records/top?id=' + FISH + '&range=' + (range || 'day'))).data || {}).top || [];
const recordsOf = async () => (await GET('/api/records')).data || {};

let srv = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  // ---------------- 基准体型口径 ----------------
  section('基准体型：本地数据与服务端口径一致');
  check('鲫鱼基准 = [10,35]cm', Array.isArray(BASE) && BASE[0] === 10 && BASE[1] === 35, JSON.stringify(BASE));
  const pctOf = size => Math.round((size - BASE[1]) / BASE[1] * 1000) / 10;
  check('50cm → +42.9%（>0% 大型）', pctOf(50) === 42.9, String(pctOf(50)));
  check('70cm → +100%（>80% 巨型）', pctOf(70) === 100, String(pctOf(70)));
  check('20cm → −42.9%（小于基准上限）', pctOf(20) === -42.9, String(pctOf(20)));

  // ---------------- 前置数据 ----------------
  section('前置：三个玩家各钓一条（日榜 / 周榜 / 总榜同时入榜）');
  const A = (await POST('/api/register', { username: 'v141_a', password: 'abcd1234', name: '甲', qq: '40001' })).data;
  const B = (await POST('/api/register', { username: 'v141_b', password: 'abcd1234', name: '乙', qq: '40002' })).data;
  const C = (await POST('/api/register', { username: 'v141_c', password: 'abcd1234', name: '丙', qq: '40003' })).data;
  check('三个账号就绪', !!(A && A.token && B && B.token && C && C.token));
  await POST('/api/register', { username: 'v141_admin', password: 'abcd1234', name: '后台', qq: '40004' });
  const adm = (await POST('/api/admin/login', { username: 'v141_admin', password: 'abcd1234' })).data || {};
  check('管理员登录（首个账号自动成为管理员）', !!adm.token, JSON.stringify(adm).slice(0, 120));
  const atok = adm.token;

  await catchFish(A.token, 40);
  await catchFish(B.token, 45);
  await catchFish(C.token, 20);
  const day0 = await board('day');
  check('当日榜 3 条且按尺寸降序', day0.length === 3 && day0[0].size === 45 && day0[1].size === 40 && day0[2].size === 20,
    JSON.stringify(day0.map(x => x.size)));
  check('周榜同样 3 条（入桶两处都写）', (await board('week')).length === 3);
  check('总榜同样 3 条', (await board('all')).length === 3);

  // ---------------- 单条删除：校验 ----------------
  section('删单条：权限 / 入参与「陈旧条目」防护');
  check('未带管理员 token → 403', (await POST('/api/admin/records/delone', { id: FISH, range: 'day', index: 0 })).status === 403);
  check('未知鱼种 → 400', (await POST('/api/admin/records/delone', { token: atok, id: 'not_a_fish', range: 'day', index: 0 })).status === 400);
  check('名次越界 → 409', (await POST('/api/admin/records/delone', { token: atok, id: FISH, range: 'day', index: 9 })).status === 409);
  const stale = await POST('/api/admin/records/delone',
    { token: atok, id: FISH, range: 'day', index: 1, who: '甲', size: 999, t: day0[1].t });
  check('who/size/t 对不上 → 409（不误删）', stale.status === 409 && /刷新/.test((stale.data || {}).error || ''), JSON.stringify(stale.data));
  check('409 之后榜没被动过', (await board('day')).length === 3);

  // ---------------- 单条删除：日榜（不 purge） ----------------
  section('删单条：只摘日榜这一条，其它榜不动');
  const sse = [];
  sseListen(A.token, sse);
  await sleep(700);
  const del1 = await POST('/api/admin/records/delone',
    { token: atok, id: FISH, range: 'day', index: 1, who: day0[1].who, size: day0[1].size, t: day0[1].t });
  check('删掉日榜第 2 名（甲 40cm）', del1.status === 200 && (del1.data.removed || {}).size === 40, JSON.stringify(del1.data).slice(0, 160));
  const day1 = await board('day');
  check('日榜剩 2 条：[45, 20]', day1.length === 2 && day1[0].size === 45 && day1[1].size === 20, JSON.stringify(day1.map(x => x.size)));
  check('总榜仍是 3 条（没勾 purge 就不动别的榜）', (await board('all')).length === 3);
  check('周榜仍是 3 条', (await board('week')).length === 3);
  await sleep(900);
  check('删除广播了 recordsDirty / records（玩家端记录页即时刷新）',
    sse.some(m => m.type === 'recordsDirty') && sse.some(m => m.type === 'records'),
    JSON.stringify(sse.map(m => m.type).slice(-6)));

  // ---------------- 单条删除：purge 清影子 ----------------
  section('删单条 + purge：同一条从其它榜单 / 纪录头衔一起清');
  const dayB = await board('day');
  const del2 = await POST('/api/admin/records/delone',
    { token: atok, id: FISH, range: 'day', index: 1, who: dayB[1].who, size: dayB[1].size, t: dayB[1].t, purge: 1 });
  check('清掉丙 20cm（日榜第 2 名）+ purge', del2.status === 200 && (del2.data.purge || {}).boards >= 2,
    JSON.stringify(del2.data).slice(0, 200));
  check('总榜也少了一条（丙被一并清掉）', (await board('all')).length === 2, JSON.stringify((await board('all')).map(x => x.who)));
  check('周榜同样少一条', (await board('week')).length === 2);

  // ---------------- 删到空：桶收尾 ----------------
  section('删到空：榜回到空数组，服务端桶收尾');
  const dayNow = await board('day');
  for (let i = dayNow.length - 1; i >= 0; i--) {
    await POST('/api/admin/records/delone',
      { token: atok, id: FISH, range: 'day', index: i, who: dayNow[i].who, size: dayNow[i].size, t: dayNow[i].t });
  }
  check('当日榜已空（不再返回幽灵条目）', (await board('day')).length === 0);
  check('周榜还有 2 条（日桶清空不影响周桶）', (await board('week')).length === 2);

  // ---------------- 最大纪录头衔 ----------------
  section('purge 命中纪录头衔：最大纪录与全场最大一起重算');
  const rec1 = await recordsOf();
  check('前置：最大纪录是乙 45cm', (rec1.records[FISH] || {}).size === 45, JSON.stringify(rec1.records[FISH]));
  check('前置：全场最大也是这条', (rec1.globalMax || {}).id === FISH, JSON.stringify(rec1.globalMax));
  const allB = await board('all');
  const idxB = allB.findIndex(x => x.who === '乙');
  check('总榜里能找到乙', idxB >= 0, JSON.stringify(allB.map(x => x.who)));
  const del3 = await POST('/api/admin/records/delone',
    { token: atok, id: FISH, range: 'all', index: idxB, who: allB[idxB].who, size: allB[idxB].size, t: allB[idxB].t, purge: 1 });
  check('删除成功且命中纪录头衔', del3.status === 200 && (del3.data.purge || {}).big === 1, JSON.stringify(del3.data.purge));
  const rec2 = await recordsOf();
  check('最大纪录已清（丙 20cm 的纪录也早被 purge 掉 → 该鱼无纪录）', !rec2.records[FISH], JSON.stringify(rec2.records[FISH]));
  check('全场最大重算后不再是该鱼', !rec2.globalMax || rec2.globalMax.id !== FISH, JSON.stringify(rec2.globalMax));

  // ---------------- 整鱼种清空仍可用 ----------------
  section('旧接口（整鱼种清空）仍可用');
  const all2 = await POST('/api/admin/records/delete', { token: atok, id: FISH });
  check('整鱼种清空返回计数', all2.status === 200 && !!all2.data.removed, JSON.stringify(all2.data).slice(0, 140));
  check('总榜/周榜都空了', (await board('all')).length === 0 && (await board('week')).length === 0);
  try { sse.destroy(); } catch (e) {}

  killTree(srv);
  await sleep(400);
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败明细：\n' + failed.map(x => '  - ' + x).join('\n'));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); killTree(srv); process.exit(1); });
