/*
 * v0.14.0 回归（纯 HTTP，不依赖浏览器）
 * 覆盖：
 *   · 市集暂时屏蔽鱼类上架（/api/market/list 拒绝鱼类；材料等照常；已有挂单仍可下架）
 *   · 自动售出「体型档」开关：默认关＝只卖普通量、大鱼留；开启后按「普通量 → 大型 → 巨型」顺序动用，含加成
 *   · 保留量（keep）在开启后按「持有总量」口径生效（超出的部分才卖，且优先卖普通量）
 *   · 手动按档位出售的金币加成口径（大型 +50% / 巨型 +150%）
 * 运行： node tests/v0140.test.js
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口；
 *       AUTOSELL_BATCH=1 让自动售出每 1 条即可打包成交，便于确定性断言。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8241;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0140-test-'));

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

// 鲫鱼基准体型上限 35cm：>35 且 ≤63 = 大型，>63 = 巨型
const FISH = 'crucian';
const SIZE_L = 50, SIZE_G = 999;
const catchFish = (token, size) => POST('/api/dev/catch', size
  ? { token: token, item: { id: FISH, kind: 'fish', rarity: 'common', size: size } }
  : { token: token, item: { id: FISH, kind: 'fish', rarity: 'common' } });
const meOf = async token => (await GET('/api/me?token=' + token)).data || {};
const bigOf = (me, id) => (me.bigfish && me.bigfish[id]) || null;

let srv = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA, AUTOSELL_BATCH: '1' }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v140_a', password: 'abcd1234', name: '回归甲', qq: '39401' });
  const tok = rA.data.token;
  check('账号就绪', !!tok, JSON.stringify(rA.data));

  // ---------------- 市集：暂时屏蔽鱼类上架 ----------------
  section('市集：鱼类暂时不能上架（材料等照常）');
  await POST('/api/dev/seed', { token: tok, inventory: { crucian: 3, relic: 3 }, coins: 100000 });
  const fishList = await POST('/api/market/list', { token: tok, id: FISH, qty: 1, price: 10, hours: 6 });
  check('鱼类上架被拒（400）', fishList.status === 400, JSON.stringify(fishList.data));
  check('拒绝原因说明是「暂时」且给出替代去处',
    /暂时不能/.test((fishList.data || {}).error || '') && /收购|档位/.test((fishList.data || {}).error || ''),
    JSON.stringify(fishList.data));
  const matList = await POST('/api/market/list', { token: tok, id: 'relic', qty: 1, price: 5000, hours: 6 });
  check('材料上架照常成功（只屏蔽鱼类）', matList.status === 200 && !!(matList.data && matList.data.listing), JSON.stringify(matList.data));
  const lid = matList.data && matList.data.listing ? matList.data.listing.lid : null;
  const cancel = await POST('/api/market/cancel', { token: tok, lid: lid });
  check('已有挂单仍可下架（不影响存量）', cancel.status === 200, JSON.stringify(cancel.data));

  // ---------------- 自动售出：默认不动体型档 ----------------
  section('自动售出：默认只卖普通量，大型/巨型留');
  await POST('/api/dev/seed', { token: tok, inventory: {} });      // 清空背包，数字从零开始
  await catchFish(tok, null);                                     // 普通 ×1
  await catchFish(tok, SIZE_G);                                   // 巨型 ×1
  let me = await meOf(tok);
  check('前置：持有 1 普通 + 1 巨型', (me.inventory[FISH] || 0) === 2 && (bigOf(me, FISH) || {}).G === 1,
    JSON.stringify({ inv: me.inventory[FISH], bf: bigOf(me, FISH) }));
  const rule = await POST('/api/autosell', { token: tok, id: FISH, on: true, keep: 0, minPct: null, minPrice: null });
  check('建立无条件规则（不看价格、保留 0）', rule.status === 200, JSON.stringify(rule.data && rule.data.error));
  const get0 = await GET('/api/autosell?token=' + tok);
  check('体型档开关默认关闭', get0.status === 200 && get0.data.tier === false, JSON.stringify(get0.data && get0.data.tier));
  await catchFish(tok, null);                                     // 上一条新鱼 → 触发自动售出（AUTOSELL_BATCH=1 立刻打包）
  await sleep(300);
  me = await meOf(tok);
  check('关闭时：普通量被卖掉、巨型预留不动',
    (me.inventory[FISH] || 0) === 1 && (bigOf(me, FISH) || {}).G === 1,
    JSON.stringify({ inv: me.inventory[FISH], bf: bigOf(me, FISH) }));

  // ---------------- 自动售出：开启体型档 ----------------
  section('自动售出：开启「体型档」后连大鱼一起卖（含加成）');
  const unit = (await GET('/shop')).data[FISH].price;
  const coinsBefore = (await meOf(tok)).coins;
  const on = await POST('/api/autosell', { token: tok, tier: true });
  check('开关打开并返回新状态', on.status === 200 && on.data.tier === true, JSON.stringify(on.data && on.data.tier));
  check('保存开关本身就会跑一次自动售出（大鱼当场成交）', !!on.data.sold, JSON.stringify(on.data && on.data.sold));
  const gain = on.data.sold && on.data.sold[0] ? on.data.sold[0].gain : 0;
  const expect = unit + Math.round(unit * 1.5);
  check('巨型按 +150% 结算（' + unit + ' × 1 + 加成 ' + Math.round(unit * 1.5) + ' = ' + expect + '）', gain === expect,
    'gain=' + gain + ' expect=' + expect + ' | sold=' + JSON.stringify(on.data.sold));
  me = await meOf(tok);
  check('巨型预留随之清空、背包里这条鱼没了',
    !bigOf(me, FISH) && !(me.inventory[FISH] > 0) && me.coins === coinsBefore + expect,
    JSON.stringify({ inv: me.inventory[FISH], bf: bigOf(me, FISH), coins: me.coins, before: coinsBefore }));
  check('/api/me 也带上了开关状态（前端刷新后能还原）', !!(me.autoSell && me.autoSell.tier === true), JSON.stringify(me.autoSell));

  // ---------------- 顺序：保留量按「持有总量」算，且优先卖普通量 ----------------
  section('开启后：保留量按持有总量生效，普通量优先、巨型最后');
  await POST('/api/dev/seed', { token: tok, inventory: {} });
  // 先立规则（保留 1 条、开体型档）再上鱼：否则每上一条就按上一条规则（保留 0）当场卖光
  await POST('/api/autosell', { token: tok, id: FISH, on: true, keep: 1, minPct: null, minPrice: null, tier: true });
  await catchFish(tok, null);            // 普通 ×1：总量 1 = 保留量 → 不卖
  await sleep(200);
  me = await meOf(tok);
  check('总量等于保留量时不卖（保留量按持有总量算）',
    (me.inventory[FISH] || 0) === 1 && !bigOf(me, FISH), JSON.stringify({ inv: me.inventory[FISH], bf: bigOf(me, FISH) }));
  await catchFish(tok, SIZE_L);          // 大型 ×1：超出 1 条 → 优先卖普通量
  await sleep(200);
  me = await meOf(tok);
  check('多出一条大型时先卖掉普通量（大型留着）',
    (me.inventory[FISH] || 0) === 1 && (bigOf(me, FISH) || {}).L === 1 && !(bigOf(me, FISH) || {}).G,
    JSON.stringify({ inv: me.inventory[FISH], bf: bigOf(me, FISH) }));
  await catchFish(tok, SIZE_G);          // 巨型 ×1：再超 1 条 → 动用大型，巨型最后
  await sleep(200);
  me = await meOf(tok);
  check('再超一条时卖大型、留下巨型（普通量 → 大型 → 巨型 的动用顺序）',
    (me.inventory[FISH] || 0) === 1 && !(bigOf(me, FISH) || {}).L && (bigOf(me, FISH) || {}).G === 1,
    JSON.stringify({ inv: me.inventory[FISH], bf: bigOf(me, FISH) }));

  // ---------------- 手动档位出售的金币加成口径 ----------------
  section('手动按档位出售：加成口径');
  await POST('/api/dev/seed', { token: tok, inventory: {} });
  await catchFish(tok, SIZE_L);
  const unit2 = (await GET('/shop')).data[FISH].price;
  const coins2 = (await meOf(tok)).coins;
  const sellL = await POST('/api/sell', { token: tok, id: FISH, qty: 1, tier: 'L' });
  check('大型出售 = 单价 + 50% 加成',
    sellL.status === 200 && sellL.data.bonus === Math.round(unit2 * 0.5) && sellL.data.gain === unit2 + Math.round(unit2 * 0.5),
    JSON.stringify(sellL.data && { unit: sellL.data.unit, bonus: sellL.data.bonus, gain: sellL.data.gain }));
  const me2 = await meOf(tok);
  check('金币按含加成后的金额到账', me2.coins === coins2 + unit2 + Math.round(unit2 * 0.5),
    JSON.stringify({ coins: me2.coins, before: coins2 }));
  const sellAgain = await POST('/api/sell', { token: tok, id: FISH, qty: 1 });
  check('普通通道没有该档量时被拒（预留量动不了）', sellAgain.status === 400, JSON.stringify(sellAgain.data));

  console.log('\nv0.14.0 回归小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：' + failed.join(' / ')); }
}
main().then(async () => {
  killTree(srv);
  process.exit(fail ? 1 : 0);
}).catch(async e => {
  console.error('TEST ERROR', e && e.stack || e);
  killTree(srv);
  process.exit(1);
});
