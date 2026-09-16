/*
 * v0.13.9 回归（纯 HTTP，可独立运行）：自动售出「合计打包」口径 + 库存快照版本号 + 库存写入收口
 * 覆盖：
 *   · 打包阈值对「已启用物品的可卖余量合计」判定（不再逐件判定）：单件都不够、合计够 → 一次结清
 *   · 价格未达标的余量不计入合计（否则会把合计永远顶在阈值之上 → 每上一条鱼推一次）
 *   · 保留量参与合计、同一条鱼不重复卖
 *   · invRev：每次库存写入自增、随 HTTP 快照与 SSE assets 下发（客户端据它丢弃过期快照）
 *   · 开箱后立即落盘（不等 1s 防抖；连开时进程被强杀不再整批丢件）
 *   · 交易二次校验改用「可用量」：设好交易后把普通量卖掉，确认时不得把大型/巨型预留交易走
 *   · 大型/巨型预留减到 0 时清掉 bigfish 残键；开发种子接口过滤 0 件
 * 运行： node tests/v0139.test.js
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1；AUTOSELL_BATCH=3 固定阈值。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 8202;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0139-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// 最小 SSE 监听
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

let srv = null;
function startServer() {
  const p = spawn(NODE, [path.join('backend', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA, AUTOSELL_BATCH: '3' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

let TOK = null;
const me = async (tok) => (await GET(B + '/api/me?token=' + (tok || TOK))).data || {};
const inv = async () => (await me()).inventory || {};
const have = async (id) => (await inv())[id] || 0;
const asPost = (body) => POST(B + '/api/autosell', Object.assign({ token: TOK }, body || {}));
const asClear = () => asPost({ bulk: 'all', remove: true });
// 投放物品：size 给大值可带出大型/巨型预留（与线上同一条上鱼链路）
function grant(id, n, size) {
  const list = [];
  for (let i = 0; i < (n || 1); i++) list.push(POST(B + '/api/dev/catch', { token: TOK, item: { id: id, kind: 'fish', rarity: 'common', size: size } }));
  return Promise.all(list);
}
const accountFile = () => path.join(TMP_DATA, 'accounts', 'v139_a.json');

async function main() {
  srv = startServer();
  const ready = await waitHttp(B + '/api/version', { timeout: 20000 });
  if (!ready) { console.log('服务器启动失败'); process.exit(1); }

  const reg = await POST(B + '/api/register', { username: 'v139_a', password: 'as123456', name: '回归甲', qq: '39101' });
  check('注册账号', reg.status === 200 && !!(reg.data && reg.data.token), JSON.stringify(reg.data));
  TOK = reg.data && reg.data.token;

  // ---------------- 合计打包 ----------------
  section('打包阈值：对「已启用物品合计」判定（v0.13.9 新口径）');
  await asClear();
  await grant('crucian', 2);
  await grant('carp', 2);
  check('先攒着：两条鱼各 2 条、无规则 → 都在背包', await have('crucian') === 2 && await have('carp') === 2, JSON.stringify(await inv()));
  const sseMsgs = [];
  const sse = sseListen(TOK, sseMsgs);
  await sleep(400);
  // 阈值 3：单件都不够（2 < 3），合计 4 ≥ 3 → 一次结清两件
  const blended = await asPost({ bulk: 'fish', minPrice: 1 });
  check('单件都不足阈值、合计够 → 一次结清两件（旧逐件口径会一条都不卖）',
    !!(blended.data && blended.data.sold && blended.data.sold.length === 2),
    JSON.stringify(blended.data && blended.data.sold));
  const invAfter = await inv();
  check('两件都整包清空', !invAfter.crucian && !invAfter.carp, JSON.stringify(invAfter));
  await sleep(400);
  const sseAssets = sseMsgs.filter(m => m && m.type === 'assets' && m.inventory);
  check('自动售出推送的 assets 带 invRev（客户端据此丢弃过期快照）',
    sseAssets.length > 0 && sseAssets.every(m => typeof m.invRev === 'number'),
    JSON.stringify(sseAssets.slice(0, 2)));
  // v0.13.9 补：播报只留「卖了什么 + 进账多少」，括号里的细则（规则命中 / 合计与阈值）不再下发
  const asNotices = sseMsgs.filter(m => m && m.type === 'notice' && /自动售出/.test(String(m.msg || '')));
  check('自动售出播报不含括号细则（横幅不再占两行）',
    asNotices.length > 0 && asNotices.every(m => String(m.msg).indexOf('（') < 0),
    JSON.stringify(asNotices.map(m => m.msg).slice(0, 2)));
  try { sse.destroy(); } catch (e) {}

  section('价格未达标的余量不计入合计');
  await asClear();
  await grant('crucian', 2);
  await grant('carp', 2);
  await asPost({ id: 'crucian', minPrice: 1 });
  const blocked = await asPost({ id: 'carp', minPrice: 999999 });
  check('鲫鱼可卖 2、鲤鱼价格永不达标 → 合计只算 2 < 3，一条都不卖',
    await have('crucian') === 2 && await have('carp') === 2 && !(blocked.data && blocked.data.sold),
    JSON.stringify({ sold: blocked.data && blocked.data.sold, inv: await inv() }));
  const unblocked = await asPost({ id: 'carp', minPrice: 1 });
  check('鲤鱼价格线放开 → 合计 4 成包，两条一起卖',
    !!(unblocked.data && unblocked.data.sold && unblocked.data.sold.length === 2) && await have('crucian') === 0 && await have('carp') === 0,
    JSON.stringify(unblocked.data && unblocked.data.sold));

  section('保留量参与合计');
  await asClear();
  await grant('crucian', 5);
  await grant('carp', 5);
  await asPost({ bulk: 'fish', minPrice: 1, keep: 2 });
  check('各 5 条、保留 2 → 可卖各 3，合计 6 成包 → 各卖 3 留 2（不重复卖同一条鱼）',
    await have('crucian') === 2 && await have('carp') === 2, JSON.stringify(await inv()));

  // ---------------- invRev ----------------
  section('库存快照版本号 invRev');
  const me0 = await me();
  check('/api/me 下发 invRev（数字）', typeof me0.invRev === 'number', String(me0.invRev));
  await grant('crucian', 1);
  const me1 = await me();
  check('库存写入后 rev 单调递增', me1.invRev > me0.invRev, me0.invRev + ' → ' + me1.invRev);
  const sellOne = await POST(B + '/api/sell', { token: TOK, id: 'crucian', qty: 1 });
  check('/api/sell 响应带 invRev 且 ≥ 当前值',
    sellOne.status === 200 && typeof sellOne.data.invRev === 'number' && sellOne.data.invRev >= me1.invRev,
    JSON.stringify({ rev: sellOne.data && sellOne.data.invRev, before: me1.invRev }));
  // ⚠️ 登录会顶掉旧会话（单会话规则）→ 必须换用新 token，否则后续请求全是「未登录」
  const prof = await POST(B + '/api/login', { username: 'v139_a', password: 'as123456' });
  check('/api/login 的 profile 也带 invRev',
    !!(prof.data && prof.data.profile && typeof prof.data.profile.invRev === 'number'),
    JSON.stringify(prof.data && prof.data.profile && prof.data.profile.invRev));
  TOK = (prof.data && prof.data.token) || TOK;

  // ---------------- 开箱：立即落盘 + rev ----------------
  section('开箱：立即落盘（不等 1s 防抖）+ 响应带 invRev');
  await POST(B + '/api/dev/seed', { token: TOK, inventory: { relic: 40 }, coins: 200000 });
  const craft = await POST(B + '/api/chest/craft', { token: TOK, chestId: 'chest_deep', qty: 2 });
  check('合成宝匣成功且响应带 invRev', craft.status === 200 && typeof craft.data.invRev === 'number', JSON.stringify(craft.data && craft.data.invRev));
  const opened = await POST(B + '/api/chest/open', { token: TOK, chestId: 'chest_deep', part: 'rod' });
  check('开箱成功（拿到组件）', opened.status === 200 && !!(opened.data && opened.data.item && opened.data.item.id), JSON.stringify(opened.data && opened.data.error));
  // 落盘检查：立刻读账号文件（不等 1s 防抖窗口）
  const diskNow = (function () {
    try { return JSON.parse(fs.readFileSync(accountFile(), 'utf8')); } catch (e) { return null; }
  })();
  check('刚开出的组件已立即落盘（同一次请求内）',
    !!(diskNow && diskNow.inventory && diskNow.inventory[opened.data.item.id] >= 1),
    JSON.stringify({ item: opened.data.item.id, disk: diskNow && diskNow.inventory }));
  check('落盘文件里不写 invRev（只活内存）', !!(diskNow && diskNow.invRev === undefined), JSON.stringify(diskNow && diskNow.invRev));
  check('开箱响应带全量 inventory 与 invRev',
    !!(opened.data.inventory && typeof opened.data.invRev === 'number' && opened.data.inventory[opened.data.item.id] >= 1),
    JSON.stringify(opened.data.invRev));

  // ---------------- 交易二次校验用可用量 ----------------
  section('交易确认：二次校验用可用量（不得把大型/巨型预留交易走）');
  const regB = await POST(B + '/api/register', { username: 'v139_b', password: 'as123456', name: '回归乙', qq: '39102' });
  const TOKB = regB.data && regB.data.token;
  check('对手账号就绪', !!TOKB, JSON.stringify(regB.data));
  const bMsgs = []; const sseB = sseListen(TOKB, bMsgs);
  const aMsgs = []; const sseA = sseListen(TOK, aMsgs);
  await sleep(400);
  await asClear();
  // 整体覆写背包：carp:0 被过滤掉 → 鲤鱼清空（与管理员快照同口径，不留 0 件键）
  await POST(B + '/api/dev/seed', { token: TOK, inventory: { crucian: 0, carp: 0 } });
  await grant('carp', 1);                     // 普通 1 条
  await grant('carp', 1, 999);                // 巨型 1 条（预留，普通通道动不了）
  const invBefore = await inv();
  check('持有 2 条鲤鱼：1 普通 + 1 巨型预留',
    invBefore.carp === 2 && (await me()).bigfish && (await me()).bigfish.carp && (await me()).bigfish.carp.G === 1,
    JSON.stringify({ inv: invBefore, bf: (await me()).bigfish }));
  const invite = await POST(B + '/api/trade/invite', { token: TOK, target: 'v139_b' });
  const TID = invite.data && invite.data.tradeId;
  check('发起交易邀请', invite.status === 200 && !!TID, JSON.stringify(invite.data));
  const resp = await POST(B + '/api/trade/respond', { token: TOKB, tradeId: TID, accept: true });
  check('对方接受', resp.status === 200, JSON.stringify(resp.data && resp.data.error));
  const setA = await POST(B + '/api/trade/set', { token: TOK, tradeId: TID, items: [{ id: 'carp', qty: 1 }] });
  check('我方放入 1 条鲤鱼（此时可用量 1，通过）', setA.status === 200, JSON.stringify(setA.data && setA.data.error));
  await POST(B + '/api/trade/set', { token: TOKB, tradeId: TID, items: [] });
  // 关键：把普通量卖掉，只剩巨型预留 → 可用量 0，但总量仍为 1
  const sold = await POST(B + '/api/sell', { token: TOK, id: 'carp', qty: 1 });
  check('普通量卖掉成功（此时总量 1 = 全预留，可用量 0）', sold.status === 200, JSON.stringify(sold.data && sold.data.error));
  const confirmA = await POST(B + '/api/trade/confirm', { token: TOK, tradeId: TID });
  check('我方单独确认通过（等待对方）', confirmA.status === 200, JSON.stringify(confirmA.data));
  const confirmB = await POST(B + '/api/trade/confirm', { token: TOKB, tradeId: TID });
  await sleep(300);
  const invEnd = await inv();
  check('双方确认后交易被拒（总量够但可用量不够 → 不能交易走预留的巨型鱼）',
    confirmB.status === 400 && invEnd.carp === 1 && (await me()).bigfish.carp && (await me()).bigfish.carp.G === 1,
    JSON.stringify({ status: confirmB.status, err: confirmB.data && confirmB.data.error, inv: invEnd, bf: (await me()).bigfish }));
  try { sseA.destroy(); sseB.destroy(); } catch (e) {}

  // ---------------- bigfish 清键 / 种子过滤 ----------------
  section('预留计数与背包写入收口');
  await POST(B + '/api/trade/cancel', { token: TOK, tradeId: TID });
  const sellG = await POST(B + '/api/sell', { token: TOK, id: 'carp', qty: 1, tier: 'G' });
  check('按巨型通道卖掉最后一条 → 背包与 bigfish 都干净',
    sellG.status === 200 && !(await inv()).carp && !((await me()).bigfish || {}).carp,
    JSON.stringify({ inv: await inv(), bf: (await me()).bigfish }));
  await POST(B + '/api/dev/seed', { token: TOK, inventory: { crucian: 2, carp: 0, bass: -3 } });
  const seeded = await inv();
  check('开发种子过滤 0 / 负数（不留下 0 件键）',
    !seeded.carp && !seeded.bass && seeded.crucian === 2, JSON.stringify(seeded));

  console.log('\nv0.13.9 回归小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败项：\n  - ' + failed.join('\n  - '));
}

main().catch(function (e) {
  fail++;
  console.log('\n  TEST ERROR  ' + (e && e.stack || e));
}).finally(function () {
  try { if (srv) killTree(srv); } catch (e) {}
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
});
