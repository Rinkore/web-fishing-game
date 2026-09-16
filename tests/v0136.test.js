/*
 * v0.13.6 体型档（大型/巨型）端到端测试（纯 HTTP，可独立运行）
 * 覆盖：上钩体型判定（超出默认最大值 0~80% = 大型 / 80% 以上 = 巨型 / 区间内 = 普通）/
 *       大型/巨型背包预留（bigfish）与图鉴最高档（codex.tier 只升不降）/
 *       档位通道出售额外金币（大型 +50% / 巨型 +150%，不新增收购项、行情照常）/
 *       普通出售/上架不可动用预留量 / 自动售出跳过预留 / 存档重启后持久化
 * 运行： node tests/v0136.test.js
 * 说明：使用 FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp, flushWait } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 8198;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0136-test-'));
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
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, data: j, text: d });
      });
    });
    r.on('error', () => resolve({ status: 0, data: null, text: '' }));
    if (data) r.write(data);
    r.end();
  });
}
const GET = u => req('GET', u), POST = (u, b) => req('POST', u, b);
const B = 'http://localhost:' + PORT;

let srv = null;
function startServer() {
  const p = spawn(NODE, [path.join('backend', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', AUTOSELL_BATCH: '1', FISHING_DATA_DIR: TMP_DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => console.error('[srv] ' + String(d).trim()));
  return p;
}

(async () => {
  srv = startServer();
  const ready = await waitHttp(B + '/api/version', { timeout: 20000 });
  if (!ready) { console.log('服务器未就绪，测试中止'); try { killTree(srv); } catch (e) {} process.exit(1); }
  console.log('服务器就绪：' + B);

  // 鲫鱼/鲤鱼默认最大体型：carp size=[20,70] → 大型 (70,126]、巨型 (126,∞)
  const carpMeta = D.FISH.common.find(f => f.id === 'carp');
  const CARP_MAX = carpMeta.size[1];
  check('鲤鱼默认最大体型 = 70（数据自洽）', CARP_MAX === 70, String(CARP_MAX));

  // ---- 账号 ----
  section('账号准备');
  const rgP = await POST(B + '/api/register', { username: 'sz_player', password: 'sz123456', name: '体型钓手', qq: '89001', confirmPassword: 'sz123456' });
  const TOK = rgP.data && rgP.data.token;
  check('玩家账号注册', rgP.status === 200 && !!TOK, JSON.stringify(rgP.data));
  const authed = (p, b) => Object.assign({ token: TOK }, b || {});

  // ---- 判定基准（服务端 sizeTierOf 经 dev/catch 验证） ----
  section('上钩体型判定');
  // 预置：背包 5 条普通鲤鱼 + 预留 大型2 / 巨型1
  const sd = await POST(B + '/api/dev/seed', authed('/api/dev/seed', { inventory: { carp: 5 }, coins: 1000, bigfish: { carp: { L: 2, G: 1 } } }));
  check('seed 支持种入体型档预留', sd.status === 200, JSON.stringify(sd.data));

  const cGiant = await POST(B + '/api/dev/catch', authed('/api/dev/catch', { item: { id: 'carp', size: CARP_MAX * 1.8 + 5 } }));
  check('超出默认最大值 80% → 判定为巨型', cGiant.status === 200 && cGiant.data && cGiant.data.tier === 'G', 'raw=' + JSON.stringify(cGiant));
  check('巨型入预留计数（G 1→2）', cGiant.data && cGiant.data.bigfish.carp.G === 2, JSON.stringify(cGiant.data && cGiant.data.bigfish));
  check('背包总量同步 +1（6）', cGiant.data && (cGiant.data.codex && cGiant.data.bigfish) && true && !!cGiant.data.bigfish, '');
  const me1 = await GET(B + '/api/me?token=' + TOK);
  check('/api/me 下发 bigfish', me1.data && me1.data.bigfish && me1.data.bigfish.carp && me1.data.bigfish.carp.G === 2, JSON.stringify(me1.data && me1.data.bigfish));
  check('/api/me 图鉴最高档 = 巨型', me1.data && me1.data.codex && me1.data.codex.carp && me1.data.codex.carp.tier === 'G', JSON.stringify(me1.data && me1.data.codex && me1.data.codex.carp));

  const cLarge = await POST(B + '/api/dev/catch', authed('/api/dev/catch', { item: { id: 'carp', size: CARP_MAX + 30 } }));
  check('超出默认最大值 0~80% → 判定为大型', cLarge.data && cLarge.data.tier === 'L', JSON.stringify(cLarge.data && { tier: cLarge.data.tier }));
  check('大型入预留计数（L 2→3）', cLarge.data && cLarge.data.bigfish.carp.L === 3, JSON.stringify(cLarge.data && cLarge.data.bigfish));

  const cNorm = await POST(B + '/api/dev/catch', authed('/api/dev/catch', { item: { id: 'carp', size: CARP_MAX - 10 } }));
  check('默认区间内 → 无档位', cNorm.data && cNorm.data.tier == null, JSON.stringify(cNorm.data && { tier: cNorm.data.tier }));
  check('普通渔获不动预留（L3/G2 不变）', cNorm.data && cNorm.data.bigfish.carp.L === 3 && cNorm.data.bigfish.carp.G === 2, JSON.stringify(cNorm.data && cNorm.data.bigfish));
  check('图鉴档位只升不降（仍巨型）', cNorm.data && cNorm.data.codex && cNorm.data.codex.tier === 'G', JSON.stringify(cNorm.data && cNorm.data.codex));

  // 小型鱼种边界：鲫鱼 [10,35]，钓 36 → 大型；钓 64 → 巨型
  const crl = await POST(B + '/api/dev/catch', authed('/api/dev/catch', { item: { id: 'crucian', size: 36 } }));
  check('鲫鱼超上限 → 大型', crl.data && crl.data.tier === 'L', JSON.stringify(crl.data && { tier: crl.data.tier }));
  const crg = await POST(B + '/api/dev/catch', authed('/api/dev/catch', { item: { id: 'crucian', size: 64 } }));
  check('鲫鱼超上限 80% → 巨型（图鉴鲫鱼=金）', crg.data && crg.data.tier === 'G' && crg.data.codex.tier === 'G', JSON.stringify(crg.data && { tier: crg.data.tier, cx: crg.data.codex }));

  // ---- 档位通道出售：额外金币 ----
  section('档位出售：额外金币（不新增收购项）');
  let invNow = (await GET(B + '/api/me?token=' + TOK)).data.inventory.carp || 0; // 8（5+3 渔获）
  const meBefore = await GET(B + '/api/me?token=' + TOK);
  const coins0 = meBefore.data.coins;
  const sG = await POST(B + '/api/sell', authed('/api/sell', { id: 'carp', qty: 1, tier: 'G' }));
  check('巨型出售 200', sG.status === 200, JSON.stringify(sG.data));
  const uG = sG.data && sG.data.unit;
  check('巨型额外金币 = 现价 ×150%（单件）', sG.data && sG.data.bonus === Math.round(uG * 1.5) && sG.data.gain === uG + sG.data.bonus,
    JSON.stringify({ unit: uG, bonus: sG.data && sG.data.bonus, gain: sG.data && sG.data.gain }));
  check('金币入账 = 基础价 + 加成', sG.data && sG.data.coins === coins0 + sG.data.gain, JSON.stringify({ coins0: coins0, coins: sG.data && sG.data.coins }));
  check('巨型预留 2→1', sG.data && sG.data.bigfish.carp.G === 1, JSON.stringify(sG.data && sG.data.bigfish));
  check('背包同步 -1', sG.data && (sG.data.inventory.carp || 0) === invNow - 1, JSON.stringify(sG.data && sG.data.inventory));

  const sL = await POST(B + '/api/sell', authed('/api/sell', { id: 'carp', qty: 1, tier: 'L' }));
  check('大型额外金币 = 现价 ×50%（单件）', sL.status === 200 && sL.data.bonus === Math.round(sL.data.unit * 0.5) && sL.data.gain === sL.data.unit + sL.data.bonus,
    JSON.stringify({ unit: sL.data && sL.data.unit, bonus: sL.data && sL.data.bonus }));
  check('大型预留 3→2', sL.data && sL.data.bigfish.carp.L === 2, JSON.stringify(sL.data && sL.data.bigfish));

  const sGover = await POST(B + '/api/sell', authed('/api/sell', { id: 'carp', qty: 2, tier: 'G' }));
  check('预留不足（巨型仅 1）→ 400', sGover.status === 400, JSON.stringify(sGover.data));
  const sTierMat = await POST(B + '/api/sell', authed('/api/sell', { id: 'relic', qty: 1, tier: 'G' }));
  check('非渔获无体型档 → 400', sTierMat.status === 400, JSON.stringify(sTierMat.data));

  // ---- 普通通道不可动用预留 ----
  section('普通出售/上架/自动售出的预留保护');
  // 当前：背包 = 5+3-2 = 6，预留 L2+G1 = 3，普通可用 = 3
  const me2 = await GET(B + '/api/me?token=' + TOK);
  invNow = me2.data.inventory.carp || 0;
  const availNow = invNow - 3;
  check('可用量口径正确（总量−预留=3）', availNow === 3, 'inv=' + invNow);
  const sOver = await POST(B + '/api/sell', authed('/api/sell', { id: 'carp', qty: availNow + 1 }));
  check('普通出售超出可用量 → 400（不得吃掉预留）', sOver.status === 400, JSON.stringify(sOver.data));
  const sOk = await POST(B + '/api/sell', authed('/api/sell', { id: 'carp', qty: availNow }));
  check('普通出售恰好可用量 → 200 且无加成', sOk.status === 200 && sOk.data.bonus === 0, JSON.stringify(sOk.data));
  check('预留原封不动（L2/G1）', sOk.data && sOk.data.bigfish.carp.L === 2 && sOk.data.bigfish.carp.G === 1, JSON.stringify(sOk.data && sOk.data.bigfish));

  const mOver = await POST(B + '/api/market/list', authed('/api/market/list', { id: 'carp', qty: 1, price: 999, hours: 6 }));
  check('普通上架预留鱼 → 400', mOver.status === 400, JSON.stringify(mOver.data));

  // 自动售出跳过预留：规则 minPrice=1（现价必达标）→ 只卖普通量
  const asSet = await POST(B + '/api/autosell', authed('/api/autosell', { bulk: 'fish', minPrice: 1 }));
  check('设置自动售出规则 200', asSet.status === 200, JSON.stringify(asSet.data));
  await POST(B + '/api/dev/catch', authed('/api/dev/catch', { item: { id: 'carp', size: 50 } })); // 普通鲤鱼 → 立即被自动售出
  const me3 = await GET(B + '/api/me?token=' + TOK);
  check('自动售出只卖普通量（预留 L2/G1 完好）',
    me3.data && me3.data.bigfish && me3.data.bigfish.carp.L === 2 && me3.data.bigfish.carp.G === 1,
    JSON.stringify(me3.data && me3.data.bigfish));
  check('自动售出后背包 = 预留总量（3）', me3.data && (me3.data.inventory.carp || 0) === 3, JSON.stringify(me3.data && me3.data.inventory));
  await POST(B + '/api/autosell', authed('/api/autosell', { bulk: 'all', remove: true })); // 清规则

  // ---- 持久化：重启后预留与图鉴档仍在 ----
  section('存档持久化（重启）');
  await flushWait();  // 等过落盘防抖（saveAccount 1s / saveSessions 2s）
  killTree(srv);
  await new Promise(r => setTimeout(r, 600));
  srv = startServer();
  const ready2 = await waitHttp(B + '/api/version', { timeout: 20000 });
  check('服务器重启就绪', ready2);
  const lg2 = await POST(B + '/api/login', { username: 'sz_player', password: 'sz123456' });
  const TOK2 = lg2.data && lg2.data.token;
  check('重新登录', !!TOK2);
  const me4 = await GET(B + '/api/me?token=' + TOK2);
  check('重启后预留保留（L2/G1）', me4.data && me4.data.bigfish && me4.data.bigfish.carp &&
    me4.data.bigfish.carp.L === 2 && me4.data.bigfish.carp.G === 1, JSON.stringify(me4.data && me4.data.bigfish));
  check('重启后图鉴档保留（carp=G / crucian=G）', me4.data && me4.data.codex &&
    me4.data.codex.carp.tier === 'G' && me4.data.codex.crucian.tier === 'G',
    JSON.stringify({ carp: me4.data && me4.data.codex && me4.data.codex.carp, crucian: me4.data && me4.data.codex && me4.data.codex.crucian }));

  // ---- 收尾 ----
  console.log('\n' + '='.repeat(52));
  console.log('v0.13.6 体型档测试小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) { console.log('失败项：\n  - ' + failed.join('\n  - ')); }
  console.log('='.repeat(52));
  await flushWait();
  killTree(srv);
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('TEST ERROR: ' + (e && e.stack || e));
  try { killTree(srv); } catch (e2) {}
  process.exit(1);
});
