/*
 * 全量功能端到端测试（服务器权威架构）
 * 覆盖：静态数据 / 服务端钓鱼循环与掷骰 / 钓竿配置 API / 账号会话 /
 *       真实多人联机 / 资产持久化与防伪造 / 静态服务与安全
 * 运行： node tests/e2e.test.js
 */
'use strict';
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const P1 = 8101, P2 = 8102;

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Windows 下 kill() 偶发不生效，用 taskkill 强制结束进程树
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
const GET = u => req('GET', u);
const POST = (u, b) => req('POST', u, b);

function sse(tok, port, sink) {
  const r = http.get('http://localhost:' + port + '/events?token=' + tok, res => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { sink.push(JSON.parse(line.slice(6))); } catch (e) {} }
      }
    });
  });
  r.on('error', () => {});
  return r;
}

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-test-'));

function start(port) {
  // FISHING_DEV=1：开放 /api/dev/*（确定性回归用）；正常部署（run.bat）不开启
  // FISHING_DATA_DIR：测试数据写入临时目录，不触碰真实 backend/data
  return spawn(NODE, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
}

// 静态数据：直接 require UMD 版 data.js（前后端共用同一文件，后端 require 即所得）
function loadData() { return require(path.join(ROOT, 'frontend', 'js', 'data.js')); }

(async () => {
  console.log('钓鱼小游戏 · 全量功能测试（服务器权威）');
  console.log('Node ' + process.version);
  // 每轮从干净数据开始（上次崩溃可能残留）
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}

  // ---------- 1. 静态数据 ----------
  section('1. 静态数据完整性（前后端共享目录）');
  const D = loadData();
  check('钓场总数 4（3 普通 + 1 活动）', D.GROUNDS.length === 4 && D.GROUNDS.filter(g => g.type === 'normal').length === 3 && D.GROUNDS.filter(g => g.type === 'event').length === 1);
  check('钓竿部位 7 且含饰品栏位', D.ROD_PARTS.length === 7 && D.ROD_PARTS.some(p => p.isCharm));
  check('每个部位至少 1 个组件底材', D.ROD_PARTS.every(p => D.COMPONENT_BASES.some(c => c.part === p.key)));
  check('底材词缀类型均有展示标签与数值区间', D.COMPONENT_BASES.every(b => b.pool.length > 0 && b.pool.every(a => !!D.AFFIX_LABEL[a.type] && a.min <= a.max)));
  check('组件掉落产出合法实例（可被识别）', (function () { for (let i = 0; i < 300; i++) { const c = D.rollComponent(); if (!c || !D.componentOf(c.id) || !D.isInstance(c.id)) return false; } return true; })());
  check('组件实例词条数在品质上限内（1 / 2 / 3）', (function () {
    for (let i = 0; i < 600; i++) {
      const c = D.rollComponent();
      if (c.affixes.length < 1 || c.affixes.length > D.QUALITY[c.quality].cap) return false;
    }
    return true;
  })());
  check('组件实例规范化：词条乱序仍得同签名', D.instanceId('rod_bamboo', 'rare', [{ type: 'size', value: -3 }, { type: 'speed', value: 12 }]) === D.instanceId('rod_bamboo', 'rare', [{ type: 'speed', value: 12 }, { type: 'size', value: -3 }]));
  check('底材（模板）不可直接出售，组件实例可出售', !D.isSellable('rod_bamboo') && D.isSellable(D.instanceId('rod_bamboo', 'common', [{ type: 'speed', value: 10 }])));
  check('导航已实现入口 10 个（钓鱼/钓竿配置/渔场/背包/商店/市集/交易/图鉴/大鱼榜/反馈）', D.NAV.filter(n => n.implemented).length === 10, 'got ' + D.NAV.filter(n => n.implemented).map(n => n.id).join(','));
  check('导航未实现占位入口 2 个（商城/收藏）', D.NAV.filter(n => !n.implemented).length === 2, 'got ' + D.NAV.filter(n => !n.implemented).map(n => n.id).join(','));
  check('共享目录暴露版本号', typeof D.VERSION === 'string' && /^v\d/.test(D.VERSION), String(D.VERSION));

  // ---------- 2. 服务端钓鱼循环 ----------
  let srv = start(P1);
  await sleep(900);

  const ra = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_a', password: 'pass1234', name: '测试甲' });
  const rb = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_b', password: 'pass5678', name: '测试乙' });
  check('注册成功返回 token', ra.status === 200 && !!ra.data.token && rb.status === 200);
  let tokA = ra.data.token, tokB = rb.data.token;

  section('2. 服务端钓鱼循环（掷骰/入库全在服务器）');
  check('未连接实时流时开钓被拒', (await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokB, groundId: 'stillwater', spotId: 'dock' })).status === 400);
  const sinkA = [], sinkB = [];
  const cliA = sse(tokA, P1, sinkA);
  const cliB = sse(tokB, P1, sinkB);
  await sleep(400);
  check('A 连接后收到 init 快照', sinkA.some(m => m.type === 'init' && m.you === 'tester_a'));
  check('非法钓点被拒 400', (await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'stillwater', spotId: 'not-exist' })).status === 400);
  check('活动钓场（锁定）被拒 400', (await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'frostmoon', spotId: 'ice' })).status === 400);
  const fs1 = await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'stillwater', spotId: 'dock' });
  check('合法钓点开钓成功且基础间隔 3000ms', fs1.status === 200 && fs1.data.ok === true && fs1.data.interval === 3000, JSON.stringify(fs1.data));
  await sleep(300);
  check('B 收到 A 的在线状态与钓点（服务器维护）', sinkB.some(m => m.type === 'players' && m.players.some(p => p.id === 'tester_a' && p.status === 'fishing' && p.groundId === 'stillwater')));

  const invBefore = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.inventory;
  const catchMark = sinkA.length;
  await sleep(13000); // 基础间隔 3s → 约 4 竿、约 90% 上钩率，至少 2 次渔获（留足概率波动余量，降低偶发失败）
  const myCatches = sinkA.slice(catchMark).filter(m => m.type === 'catch');
  check('服务器循环自动抛竿（13s 内 ≥2 次渔获推送）', myCatches.length >= 2, String(myCatches.length));
  check('渔获含物品与钓点信息', myCatches.every(m => m.entry.item && m.entry.item.id && m.entry.ground === '静水湖'));
  check('B 收到 A 的渔获动态广播', sinkB.some(m => m.type === 'feed' && m.entry.who === '测试甲'));
  const invAfter = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.inventory;
  check('渔获已服务器入库（背包增加）', Object.keys(invAfter).length > Object.keys(invBefore).length, JSON.stringify({ before: invBefore, after: invAfter }));
  // 前十大 + 小鱼纪录
  const fishId = Object.keys(invAfter).find(function (id) { return D.fishTierOf(id); }) || 'crucian';
  const topC = await GET('http://localhost:' + P1 + '/api/records/top?id=' + fishId);
  check('前十大接口返回捕获记录', topC.status === 200 && topC.data.top.length >= 1, JSON.stringify(topC.data).slice(0, 120));
  const recSmall = await GET('http://localhost:' + P1 + '/api/records');
  check('小鱼纪录随渔获生成', recSmall.status === 200 && Object.keys(recSmall.data.small || {}).length > 0);
  // 近期渔获（recent）：换大件概率最高的礁石区（~54%/竿），轮询等待广播
  await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'sunset', spotId: 'reef' });
  const recentMark = sinkB.length;
  let sawRecent = false, waitedRecent = 0;
  while (!sawRecent && waitedRecent < 20000) {
    await sleep(1000); waitedRecent += 1000;
    sawRecent = sinkB.slice(recentMark).some(m => m.type === 'players' && m.players.some(p => p.id === 'tester_a' && p.recent));
  }
  check('近期渔获（recent）出现在玩家列表', sawRecent, '等待 ' + waitedRecent / 1000 + 's');
  const codexAfter = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.codex || {};
  check('图鉴记录个人最大/最小体型', Object.keys(codexAfter).some(function (k) { return codexAfter[k].max != null && codexAfter[k].min != null; }));

  section('体型加成不设固定上限（回归：+55% 远古巨鲟应能超 520cm）');
  const szRoll = await POST('http://localhost:' + P1 + '/api/dev/rollsize', { token: tokA, range: [150, 400], size: 55, n: 500 });
  check('体型 roll 接口可用', szRoll.status === 200 && Array.isArray(szRoll.data.rolls));
  check('+55% 体型最高可超 520cm（旧版 1.3x 封顶）', szRoll.data.max > 520, 'max=' + szRoll.data.max);
  check('体型加成可达范围上限 ×(1+加成)（150~400 ×1.55 → 接近 620）', szRoll.data.max > 600, 'max=' + szRoll.data.max);
  const szNeg = await POST('http://localhost:' + P1 + '/api/dev/rollsize', { token: tokA, range: [150, 400], size: -50, n: 200 });
  check('负体型词缀缩小体型且不为负', szNeg.data.rolls.every(function (v) { return v >= 1; }));

  section('版本接口（前端缓存守卫数据源）');
  const ver = await GET('http://localhost:' + P1 + '/api/version');
  check('GET /api/version 返回版本号与构建日期', ver.status === 200 && typeof ver.data.version === 'string' && !!ver.data.build);
  check('服务器版本与共享目录一致', ver.data.version === D.VERSION, ver.data.version + ' vs ' + D.VERSION);

  section('反馈意见：一天 CD + 花金币立即结束 CD');
  const fb0 = await GET('http://localhost:' + P1 + '/api/feedback?token=' + tokA);
  check('反馈状态查询返回 CD 与跳过费用', fb0.status === 200 && !!fb0.data.status && fb0.data.status.skipCost === 10000);
  await POST('http://localhost:' + P1 + '/api/dev/seed', { token: tokA, coins: 20000 });
  const fb1 = await POST('http://localhost:' + P1 + '/api/feedback/submit', { token: tokA, text: '第一条测试反馈', kind: 'bug' });
  check('首次提交反馈成功', fb1.status === 200 && fb1.data.entry && fb1.data.entry.text === '第一条测试反馈');
  check('提交后进入 24 小时冷却', fb1.data.status.ready === false && fb1.data.status.remainingMs > 23 * 3600 * 1000, JSON.stringify(fb1.data.status));
  const fb2 = await POST('http://localhost:' + P1 + '/api/feedback/submit', { token: tokA, text: '冷却中再提交' });
  check('冷却中重复提交被拒 429', fb2.status === 429, 'status=' + fb2.status);
  const coinsBefore = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.coins;
  const fbSkip = await POST('http://localhost:' + P1 + '/api/feedback/skip', { token: tokA });
  check('花 10000 金币结束 CD 成功', fbSkip.status === 200 && fbSkip.data.status.ready === true);
  check('结束 CD 扣除 10000 金币', fbSkip.data.coins === coinsBefore - 10000, coinsBefore + ' -> ' + fbSkip.data.coins);
  const fb3 = await POST('http://localhost:' + P1 + '/api/feedback/submit', { token: tokA, text: '结束 CD 后第二条' });
  check('结束 CD 后可再次提交', fb3.status === 200 && fb3.data.ok === true);
  const fbMine = await GET('http://localhost:' + P1 + '/api/feedback?token=' + tokA);
  check('我的反馈列表含两条记录', (fbMine.data.mine || []).length === 2, JSON.stringify((fbMine.data.mine || []).map(function (f) { return f.text; })));

  section('钓速词缀即时调整服务器循环');
  // 组件安装 = 消耗道具：先经 dev 接口发放组件实例入包（实例签名 = 底材#品质#词条）
  const reelInst = D.instanceId('reel_electric', 'common', [{ type: 'speed', value: 25 }]);   // reel_electric#common#spd+25
  const hookInst = D.instanceId('hook_steel', 'rare', [{ type: 'big', value: 8 }, { type: 'speed', value: -5 }]);
  check('dev 发放电动卷线器实例', (await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: reelInst }, ground: '静水湖', spot: '老旧码头' })).status === 200);
  check('dev 发放精钢鱼钩实例', (await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: hookInst }, ground: '静水湖', spot: '老旧码头' })).status === 200);
  check('未持有组件时装备被拒 400', (await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: D.instanceId('rod_carbon', 'rare', [{ type: 'speed', value: 20 }, { type: 'material', value: -10 }]) })).status === 400);
  const bdR = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'reel', compId: reelInst });
  check('装备电动卷线器成功（实例签名入库）', bdR.status === 200 && bdR.data.ok === true && bdR.data.bd.reel.compId === reelInst);
  const meAfterBd = await GET('http://localhost:' + P1 + '/api/me?token=' + tokA);
  check('安装消耗组件道具（背包实例已扣除）', !meAfterBd.data.inventory[reelInst], JSON.stringify(meAfterBd.data.inventory));
  check('响应返回服务器词缀汇总 +25% 钓速', bdR.data.effects && bdR.data.effects.speed === 25, JSON.stringify(bdR.data.effects));
  check('正在钓鱼时钓速即时生效（2250ms）', bdR.data.interval === 2250, String(bdR.data.interval));
  check('未知组件被拒 400', (await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: 'nope' })).status === 400);
  check('组件与部位不匹配被拒 400', (await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'hook', compId: reelInst })).status === 400);
  check('未知部位被拒 400', (await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'nope', compId: null })).status === 400);
  const bdH = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'hook', compId: hookInst });
  check('装备精钢鱼钩（大鱼+8%；钓速=电动25+钩-5=20，负词条生效）', bdH.status === 200 && bdH.data.effects.big === 8 && bdH.data.effects.speed === 20, JSON.stringify(bdH.data.effects));

  const stopMark = sinkA.length;
  check('停止钓鱼成功', (await POST('http://localhost:' + P1 + '/api/fishing/stop', { token: tokA })).status === 200);
  await sleep(4000); // 若未真正停止，2250ms 间隔至少再产 1 竿
  check('停止后服务器不再产出渔获', sinkA.slice(stopMark).every(m => m.type !== 'catch'), sinkA.slice(stopMark).map(m => m.type).join(','));
  await sleep(300);
  check('停止后状态 idle 同步到 B', sinkB.some(m => m.type === 'players' && m.players.some(p => p.id === 'tester_a' && p.status === 'idle')));
  check('未登录开钓被拒 401', (await POST('http://localhost:' + P1 + '/api/fishing/start', { token: 'bad', groundId: 'stillwater', spotId: 'dock' })).status === 401);
  check('未登录配置钓竿被拒 401', (await POST('http://localhost:' + P1 + '/api/bd/set', { token: 'bad', part: 'rod' })).status === 401);

  // ---------- 3. 账号系统 ----------
  section('3. 账号：注册 / 登录 / 会话');
  const dupRes = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_a', password: 'another123' });
  check('重复用户名被拒 409', dupRes.status === 409, 'status=' + dupRes.status);
  const dupCase = await POST('http://localhost:' + P1 + '/api/register', { username: 'TESTER_A', password: 'another123' });
  check('用户名大小写不敏感（同账号视为重复）409', dupCase.status === 409);
  check('非法用户名被拒 400', (await POST('http://localhost:' + P1 + '/api/register', { username: 'ab', password: 'abcd' })).status === 400);
  check('过短密码被拒 400', (await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_c', password: '1' })).status === 400);
  check('错误密码登录失败 401', (await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_a', password: 'bad' })).status === 401);
  const lg = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_a', password: 'pass1234' });
  check('正确密码登录成功', lg.status === 200 && !!lg.data.token);
  check('顶号：再次登录后注册会话 token 失效', (await GET('http://localhost:' + P1 + '/api/me?token=' + ra.data.token)).status === 401);
  tokA = lg.data.token; // 后续改用新会话 token
  check('无 token 取资料被拒 401', (await GET('http://localhost:' + P1 + '/api/me')).status === 401);
  check('伪造 token 取资料被拒 401', (await GET('http://localhost:' + P1 + '/api/me?token=fake123')).status === 401);
  // 顶号：同账号二次登录使旧会话失效
  const rc3 = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_c', password: 'pass1234' });
  check('第三个账号注册成功', rc3.status === 200);
  const lgC1 = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_c', password: 'pass1234' });
  const lgC2 = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_c', password: 'pass1234' });
  check('同账号二次登录成功（顶号）', lgC2.status === 200);
  check('旧 token 被顶号失效 401', (await GET('http://localhost:' + P1 + '/api/me?token=' + lgC1.data.token)).status === 401);
  check('新 token 可用', (await GET('http://localhost:' + P1 + '/api/me?token=' + lgC2.data.token)).status === 200);

  // ---------- 4. 资产持久化与防伪造 ----------
  section('4. 资产持久化 + 客户端不可伪造（服务器权威）');
  check('dev 种子接口在 FISHING_DEV=1 下可用', (await POST('http://localhost:' + P1 + '/api/dev/seed', { token: tokA, coins: 1234, inventory: { carp: 9, koi: 1 } })).status === 200);
  const meSeeded = await GET('http://localhost:' + P1 + '/api/me?token=' + tokA);
  check('种子后 coins/inventory 正确', meSeeded.data.coins === 1234 && meSeeded.data.inventory.carp === 9);
  // 关键安全回归：客户端不能再伪造资产
  await POST('http://localhost:' + P1 + '/api/profile', { token: tokA, coins: 99999, inventory: { carp: 999 } });
  const meForge = await GET('http://localhost:' + P1 + '/api/me?token=' + tokA);
  check('/api/profile 上报 coins 被忽略（仍 1234）', meForge.data.coins === 1234, String(meForge.data.coins));
  check('/api/profile 上报 inventory 被忽略（仍 carp 9）', meForge.data.inventory.carp === 9, JSON.stringify(meForge.data.inventory));
  await POST('http://localhost:' + P1 + '/api/profile', { token: tokA, name: '测试甲改' });
  check('显示名可经 /api/profile 修改', (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.name === '测试甲改');
  // v0.8 存储拆分：账号按文件落在 accounts/<key>.json；世界域拆为 market/records/economy/config
  const uf = path.join(TMP_DATA, 'accounts', 'tester_a.json');
  check('账号已落盘 accounts/tester_a.json', fs.existsSync(uf));
  const raw = fs.readFileSync(uf, 'utf8');
  check('密码以 salt+hash 存储（不存明文）', raw.includes('pwHash') && raw.includes('salt') && !raw.includes('pass1234'));
  check('旧版 users.json 不再写入（已迁移到 accounts/）', !fs.existsSync(path.join(TMP_DATA, 'users.json')));

  cliA.destroy();
  await sleep(400);
  check('A 断线后 B 在线列表移除 A', sinkB.some(m => m.type === 'players' && !m.players.some(p => p.id === 'tester_a')));

  cliB.destroy();
  killTree(srv);
  await sleep(500);

  srv = start(P2);
  await sleep(900);
  const lg2 = await POST('http://localhost:' + P2 + '/api/login', { username: 'tester_a', password: 'pass1234' });
  check('重启服务器后仍可登录', lg2.status === 200);
  const me2 = await GET('http://localhost:' + P2 + '/api/me?token=' + (lg2.data && lg2.data.token));
  check('重启后 coins 持久化 = 1234', me2.data && me2.data.coins === 1234);
  check('重启后 inventory 持久化', me2.data && me2.data.inventory && me2.data.inventory.carp === 9);
  check('重启后钓竿配置持久化（ reel=电动卷线器, hook=精钢鱼钩）', !!(me2.data && me2.data.bd && me2.data.bd.reel && me2.data.bd.reel.compId === reelInst && me2.data.bd.hook && me2.data.bd.hook.compId === hookInst), JSON.stringify(me2.data && me2.data.bd));
  check('重启后显示名持久化', me2.data && me2.data.name === '测试甲改');
  killTree(srv);

  // ---------- 5. 市集历史订单 ----------
  srv = start(P1);
  await sleep(800);
  section('5. 市集历史订单');
  const lgA5 = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_a', password: 'pass1234' });
  const lgB5 = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_b', password: 'pass5678' });
  check('重启后双方可再登录', lgA5.status === 200 && lgB5.status === 200);
  check('B 补充库存（dev seed）', (await POST('http://localhost:' + P1 + '/api/dev/seed', { token: lgB5.data.token, inventory: { carp: 5 } })).status === 200);
  const lb5 = await POST('http://localhost:' + P1 + '/api/market/list', { token: lgB5.data.token, id: 'carp', qty: 5, price: 10 });
  check('B 上架 5 ×carp @10', lb5.status === 200 && !!lb5.data.listing);
  const ab5 = await POST('http://localhost:' + P1 + '/api/market/buy', { token: lgA5.data.token, lid: lb5.data.listing.lid });
  check('A 购买 5 ×carp 成功（支出 50）', ab5.status === 200 && ab5.data.total === 50);
  const mhA = await GET('http://localhost:' + P1 + '/api/market/history?token=' + lgA5.data.token);
  check('历史订单含 A 的买入记录', mhA.status === 200 && mhA.data.trades.some(function (t) { return t.buyer === 'tester_a' && t.id === 'carp' && t.qty === 5; }), JSON.stringify(mhA.data.trades).slice(0, 140));
  const mhB = await GET('http://localhost:' + P1 + '/api/market/history?token=' + lgB5.data.token);
  check('历史订单含 B 的卖出记录（含税额 5）', mhB.status === 200 && mhB.data.trades.some(function (t) { return t.seller === 'tester_b' && t.qty === 5 && t.tax === 5; }), JSON.stringify(mhB.data.trades).slice(0, 140));
  // 市集/记录/经济域各自独立落盘
  check('世界域已拆分为 market/records/economy.json',
    ['market.json', 'records.json', 'economy.json'].every(f => fs.existsSync(path.join(TMP_DATA, f))),
    '存在：' + fs.readdirSync(TMP_DATA).join(','));

  // ---------- 6. 挂单上限与过期退回 ----------
  section('6. 挂单上限（40）与过期退回');
  killTree(srv);
  srv = spawn(NODE, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(8103), FISHING_DEV: '1', LISTING_TTL_MS: '1500', FISHING_DATA_DIR: TMP_DATA }) });
  await sleep(800);
  const lgA6 = await POST('http://localhost:8103/api/login', { username: 'tester_a', password: 'pass1234' });
  check('补充库存 45 条鲫鱼', (await POST('http://localhost:8103/api/dev/seed', { token: lgA6.data.token, inventory: { crucian: 45 } })).status === 200);
  check('上架 1 条（TTL 环境变量覆盖有效期）', (await POST('http://localhost:8103/api/market/list', { token: lgA6.data.token, id: 'crucian', qty: 1, price: 1 })).status === 200);
  await sleep(2200);
  const swept = await GET('http://localhost:8103/api/market');
  check('A 的过期挂单已下架退回', swept.status === 200 && !swept.data.listings.some(function (l) { return l.seller === 'tester_a'; }), JSON.stringify(swept.data.listings).slice(0, 100));
  const meExp = await GET('http://localhost:8103/api/me?token=' + lgA6.data.token);
  check('过期物品退回背包（45 条鲫鱼）', meExp.data.inventory.crucian === 45, JSON.stringify(meExp.data.inventory));
  check('过期不退上架费（1184 − 1 费 = 1183）', meExp.data.coins === 1183, String(meExp.data.coins));
  let capOk = 0;
  for (let i = 0; i < 40; i++) {
    const r = await POST('http://localhost:8103/api/market/list', { token: lgA6.data.token, id: 'crucian', qty: 1, price: 1 });
    if (r.status === 200) capOk++;
  }
  check('可连续挂满 40 个挂单', capOk === 40, String(capOk));
  const overCap = await POST('http://localhost:8103/api/market/list', { token: lgA6.data.token, id: 'crucian', qty: 1, price: 1 });
  check('第 41 个挂单被拒 400（超上限）', overCap.status === 400 && /上限/.test(overCap.data.error || ''));
  killTree(srv);

  // ---------- 7. 静态服务与前端资源 ----------
  section('7. 静态服务与安全');
  srv = start(P1);
  await sleep(900);
  const idx = await GET('http://localhost:' + P1 + '/');
  check('首页可访问 200', idx.status === 200 && idx.text.includes('钓鱼网站'));
  check('首页含登录/注册界面', idx.text.includes('auth-card') && idx.text.includes('auth-user'));
  for (const f of ['/css/style.css', '/js/config.js', '/js/data.js', '/js/net.js', '/js/engine.js', '/js/ui.js']) {
    const r = await GET('http://localhost:' + P1 + f);
    check('静态资源可访问 ' + f, r.status === 200 && r.text.length > 0);
  }
  check('CSS 含登录遮罩样式', (await GET('http://localhost:' + P1 + '/css/style.css')).text.includes('.auth-overlay'));
  check('前端引入顺序正确 config->data->engine->net->ui', (function () { const t = idx.text; return t.indexOf('js/config.js') < t.indexOf('js/data.js') && t.indexOf('js/data.js') < t.indexOf('js/engine.js') && t.indexOf('js/engine.js') < t.indexOf('js/net.js') && t.indexOf('js/net.js') < t.indexOf('js/ui.js'); })());
  check('/data 目录被拦截 403', (await GET('http://localhost:' + P1 + '/data/users.json')).status === 403);
  check('已知未知路径返回 404', (await GET('http://localhost:' + P1 + '/nope-xyz')).status === 404);
  killTree(srv);

  // ---------- 8. 数据目录默认落在用户「文档」 ----------
  section('8. 数据目录：默认用户文档 + 旧目录自动搬迁');
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-home-'));
  const DOCS = path.join(HOME, 'Documents');
  fs.mkdirSync(DOCS, { recursive: true });
  const EXPECT_DATA = path.join(DOCS, 'web-fishing-game');
  // 造一个「项目内旧数据目录」(backend/data)：启动后应被搬到 Documents
  const projData = path.join(ROOT, 'backend', 'data');
  let projBackup = null;
  try {
    if (fs.existsSync(projData)) { projBackup = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-proj-')); fs.cpSync(projData, projBackup, { recursive: true }); }
    fs.rmSync(projData, { recursive: true, force: true });
    fs.mkdirSync(path.join(projData, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(projData, 'accounts', 'reloctest.json'),
      JSON.stringify({ username: 'reloctest', salt: 'aa', pwHash: 'x', name: '搬迁测试', coins: 777, inventory: {}, bd: {}, codex: {}, catchCount: 0, createdAt: 1 }));

    const env8 = Object.assign({}, process.env, { PORT: String(P1 + 40), FISHING_DEV: '1', HOME: HOME, USERPROFILE: HOME });
    delete env8.FISHING_DATA_DIR; // 走默认目录解析
    srv = spawn(NODE, ['backend/server.js'], { cwd: ROOT, env: env8 });
    await sleep(1400);
    check('数据目录默认解析到用户文档/web-fishing-game', fs.existsSync(EXPECT_DATA));
    check('旧项目内数据已搬迁到文档目录', fs.existsSync(path.join(EXPECT_DATA, 'accounts', 'reloctest.json')));
    const relocVer = await GET('http://localhost:' + (P1 + 40) + '/api/version');
    check('搬迁后服务器正常启动并响应', relocVer.status === 200 && !!relocVer.data.version);
    killTree(srv);
  } finally {
    // 复原：删掉测试造的旧目录，恢复原数据（即使上面抛错也保证执行）
    killTree(srv);
    try { fs.rmSync(projData, { recursive: true, force: true }); } catch (e) {}
    if (projBackup) { try { fs.cpSync(projBackup, projData, { recursive: true }); } catch (e) {} }
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) {}
  }

  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) console.log('失败项：\n  - ' + failed.join('\n  - '));
  console.log(fail === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');
  console.log('============================');
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200);
})();
