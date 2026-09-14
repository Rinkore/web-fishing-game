/*
 * 全量功能端到端测试（服务器权威架构）
 * 覆盖：静态数据 / 服务端钓鱼循环与掷骰 / 钓竿配置 API / 账号会话 /
 *       真实多人联机 / 资产持久化与防伪造 / 静态服务与安全
 * 运行： node tests/e2e.test.js
 */
'use strict';
const os = require('os');
// 轮询等待工具（测试内部不依赖固定 sleep）：就绪即继续，超时才失败
const { waitFor, waitHttp, waitPage } = require('./_util.js');
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
// 递归复制目录：不用 fs.cpSync（Windows 下复制含大文件的目录会让 node 进程 fail-fast 崩溃，
// 退出码 0xC0000409；同样的内容放临时目录却正常，属环境/文件系统怪癖），逐文件复制稳定可靠。
function copyDirSafe(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (e) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSafe(s, d);
    else fs.copyFileSync(s, d);
  });
}
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

// 启动前清理端口占用：Windows 下测试进程被强杀时 taskkill 可能失败，残留的旧服务器会占住端口，
// 导致下一次运行的所有请求打到「陈旧的服务器实例」上（表现为大面积 未登录/数据不符）。
function killPortOccupant(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + port + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
      { stdio: 'ignore' });
  } catch (e) {}
}
function start(port) {
  // FISHING_DEV=1：开放 /api/dev/*（确定性回归用）；正常部署（run.bat）不开启
  // FISHING_DATA_DIR：测试数据写入临时目录，不触碰真实 backend/data
  killPortOccupant(port);
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
  check('导航已实现入口 11 个（钓鱼/钓竿配置/渔场/背包/商店/市集/交易/图鉴/大鱼榜/反馈/日志）', D.NAV.filter(n => n.implemented).length === 11, 'got ' + D.NAV.filter(n => n.implemented).map(n => n.id).join(','));
  check('导航未实现占位入口 1 个（商城）', D.NAV.filter(n => !n.implemented).length === 1 && D.NAV.find(n => !n.implemented).id === 'mall', 'got ' + D.NAV.filter(n => !n.implemented).map(n => n.id).join(','));
  check('「收藏」占位已替换为「日志」功能入口', !D.NAV.some(n => n.id === 'collect') && !!D.NAV.find(n => n.id === 'logs' && n.implemented));
  check('共享目录暴露版本号', typeof D.VERSION === 'string' && /^v\d/.test(D.VERSION), String(D.VERSION));
  // roll=0 拒绝：0 值词条无意义，roll 到 0 重 roll 一次；仍为 0 时落到区间内最近 ±1
  check('词条 roll 不产生 0 值（跨 0 区间 3000 次抽样）', (function () {
    for (let i = 0; i < 3000; i++) if (D.rollAffixValue(-5, 5, 'linear') === 0) return false;
    for (let i = 0; i < 3000; i++) if (D.rollAffixValue(-3, 6, 'normal') === 0) return false;
    for (let i = 0; i < 3000; i++) if (D.rollAffixValue(-8, 2, 'skew') === 0) return false;
    return true;
  })());
  check('词条 roll 仍落在区间内（含负值区间）', (function () {
    for (let i = 0; i < 2000; i++) {
      const v = D.rollAffixValue(-9, -2, 'linear');
      if (v < -9 || v > -2) return false;
    }
    return true;
  })());
  check('roll=0 修复后组件掉落无 0 值词条（800 件）', (function () {
    for (let i = 0; i < 800; i++) {
      const c = D.rollComponent();
      if (c.affixes.some(a => a.value === 0)) return false;
    }
    return true;
  })());

  // ---------- 2. 服务端钓鱼循环 ----------
  let srv = start(P1);
  check('服务器就绪（轮询 /shop）', await waitHttp('http://localhost:' + P1 + '/shop', { timeout: 20000 }));

  const ra = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_a', password: 'pass1234', name: '测试甲', qq: '10007' });
  const rb = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_b', password: 'pass5678', name: '测试乙', qq: '10008' });
  check('注册成功返回 token', ra.status === 200 && !!ra.data.token && rb.status === 200);
  let tokA = ra.data.token, tokB = rb.data.token;

  section('2. 服务端钓鱼循环（掷骰/入库全在服务器）');
  check('未连接实时流时开钓被拒', (await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokB, groundId: 'stillwater', spotId: 'dock' })).status === 400);
  const sinkA = [], sinkB = [];
  const cliA = sse(tokA, P1, sinkA);
  const cliB = sse(tokB, P1, sinkB);
  await sleep(400);
  check('A 连接后收到 init 快照', sinkA.some(m => m.type === 'init' && m.you === 'tester_a'));
  // 图鉴产地依赖钓场目录：init 必须下发完整钓场目录（含管理后台覆盖），否则新客户端用硬编码默认值
  const initMsg = sinkA.find(m => m.type === 'init');
  check('init 快照携带钓场目录（4 钓场）', !!(initMsg && Array.isArray(initMsg.groundCfg) && initMsg.groundCfg.length === 4), initMsg ? String(initMsg.groundCfg && initMsg.groundCfg.length) : 'no init');
  check('init 钓场目录含掉落池条目', !!(initMsg && initMsg.groundCfg[0].spots[0].pool.length > 0));
  // 热更新：init 必须带服务器版本号——重启换版本后 SSE 自动重连，客户端据此发现自己是旧前端并强刷
  check('init 快照携带服务器版本号（热更新信号）', !!(initMsg && initMsg.version === D.VERSION),
    initMsg ? String(initMsg.version) + ' vs ' + D.VERSION : 'no init');
  // 兜底接口：前端进入游戏时主动拉取钓场目录（后进入/刷新的玩家也能看到增益）
  const gr = await GET('http://localhost:' + P1 + '/api/grounds');
  check('GET /api/grounds 返回完整钓场目录', gr.status === 200 && Array.isArray(gr.data.grounds) && gr.data.grounds.length === 4);
  check('/api/grounds 目录含钓点与掉落池', !!(gr.data.grounds[0].spots[0] && gr.data.grounds[0].spots[0].pool.length > 0));
  check('非法钓点被拒 400', (await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'stillwater', spotId: 'not-exist' })).status === 400);
  check('活动钓场（锁定）被拒 400', (await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'frostmoon', spotId: 'ice' })).status === 400);
  const fs1 = await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'stillwater', spotId: 'dock' });
  check('合法钓点开钓成功且基础间隔 3000ms', fs1.status === 200 && fs1.data.ok === true && fs1.data.interval === 3000, JSON.stringify(fs1.data));
  // 钓速明细：基础值来自后台配置，实际值含词缀/钓点增益/全服加成（前端状态条据此展示）
  check('开钓返回钓速明细（基础/实际/加成拆分）', !!(fs1.data.castInfo && fs1.data.castInfo.baseMs === 3000
    && fs1.data.castInfo.interval === 3000 && fs1.data.castInfo.globalBonus === 0
    && fs1.data.castInfo.affixSpeed === 0 && fs1.data.castInfo.buffSpeed === 0), JSON.stringify(fs1.data.castInfo));
  check('钓速明细带上鱼率（默认公式 90）', !!(fs1.data.castInfo && fs1.data.castInfo.biteRate === 90 && fs1.data.castInfo.biteOverride === false), JSON.stringify(fs1.data.castInfo && { bite: fs1.data.castInfo.biteRate }));
  await sleep(300);
  check('B 收到 A 的在线状态与钓点（服务器维护）', sinkB.some(m => m.type === 'players' && m.players.some(p => p.id === 'tester_a' && p.status === 'fishing' && p.groundId === 'stillwater')));

  const invBefore = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.inventory;
  const catchMark = sinkA.length;
  // 轮询等待至少 2 次渔获（基础间隔 3s、约 90% 上钩率）：达标即继续，超时才判定失败
  await waitFor(() => sinkA.slice(catchMark).filter(m => m.type === 'catch').length >= 2, { timeout: 25000, interval: 120 });
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

  // ---------- 排行榜：每人仅保留最好一条 + 前十小 + 全场最大 ----------
  section('排行榜去重 / 前十小 / 全场最大纪录');
  const dupFish = 'crucian';
  const dupBefore = sinkA.length;
  // A 连钓 3 条同种鱼：大 50 / 小 10 / 中 30 → 大鱼榜留 50，小鱼榜留 10，各只 1 条
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'fish', id: dupFish, rarity: 'common', size: 50 }, ground: '静水湖', spot: '老旧码头' });
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'fish', id: dupFish, rarity: 'common', size: 10 }, ground: '静水湖', spot: '老旧码头' });
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'fish', id: dupFish, rarity: 'common', size: 30 }, ground: '静水湖', spot: '老旧码头' });
  await sleep(200);
  const topBig = await GET('http://localhost:' + P1 + '/api/records/top?id=' + dupFish);
  const mineBig = topBig.data.top.filter(function (r) { return r.who === '测试甲'; });
  check('大鱼榜同一玩家只保留一条', mineBig.length === 1, JSON.stringify(topBig.data.top));
  check('大鱼榜保留该玩家最大的一条（50cm）', mineBig.length === 1 && mineBig[0].size === 50, JSON.stringify(mineBig));
  const topSm = await GET('http://localhost:' + P1 + '/api/records/top?id=' + dupFish + '&kind=small');
  check('前十小接口返回 kind=small', topSm.status === 200 && topSm.data.kind === 'small');
  const mineSm = topSm.data.top.filter(function (r) { return r.who === '测试甲'; });
  check('小鱼榜同一玩家只保留一条', mineSm.length === 1, JSON.stringify(topSm.data.top));
  check('小鱼榜保留该玩家最小的一条（10cm）', mineSm.length === 1 && mineSm[0].size === 10, JSON.stringify(mineSm));
  check('小鱼榜按体型升序', topSm.data.top.every(function (r, i, a) { return i === 0 || a[i - 1].size <= r.size; }), JSON.stringify(topSm.data.top));
  const recAll = await GET('http://localhost:' + P1 + '/api/records');
  check('全服快照含全场最大纪录', !!recAll.data.globalMax && typeof recAll.data.globalMax.size === 'number', JSON.stringify(recAll.data.globalMax));
  const gmSize = recAll.data.globalMax.size;
  const bigger = Math.round(gmSize) + 50;
  const gmMark = sinkB.length;
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'fish', id: 'tuna', rarity: 'big', size: bigger }, ground: '落日海湾', spot: '礁石区' });
  await sleep(300);
  check('破纪录后全场最大已更新', (await GET('http://localhost:' + P1 + '/api/records')).data.globalMax.size === bigger, String(bigger));
  check('订阅者收到 globalRecord 广播', sinkB.slice(gmMark).some(function (m) { return m.type === 'globalRecord' && m.record && m.record.size === bigger; }),
    JSON.stringify(sinkB.slice(gmMark).map(function (m) { return m.type; })));

  // 近期渔获（recent）：换大件概率最高的礁石区（~54%/竿），轮询等待广播
  await POST('http://localhost:' + P1 + '/api/fishing/start', { token: tokA, groundId: 'sunset', spotId: 'reef' });
  const recentMark = sinkB.length;
  const sawRecent = await waitFor(() => sinkB.slice(recentMark).some(m => m.type === 'players' && m.players.some(p => p.id === 'tester_a' && p.recent)),
    { timeout: 20000, interval: 300 });
  check('近期渔获（recent）出现在玩家列表', sawRecent, '超时 20s');
  const codexAfter = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.codex || {};
  check('图鉴记录个人最大/最小体型', Object.keys(codexAfter).some(function (k) { return codexAfter[k].max != null && codexAfter[k].min != null; }));

  section('体型加成不设固定上限（回归：+55% 远古巨鲟应能超 520cm）');
  // 用 linear 模型做确定性验证：本节的命题是「加成不设上限」，与体型分布无关；
  // 默认的 normal 分布下极值要靠运气（正态截断到 [0,1]，500 次未必能采到接近上限的值）。
  const szRoll = await POST('http://localhost:' + P1 + '/api/dev/rollsize', { token: tokA, range: [150, 400], size: 55, n: 500, model: 'linear' });
  check('体型 roll 接口可用', szRoll.status === 200 && Array.isArray(szRoll.data.rolls));
  check('+55% 体型最高可超 520cm（旧版 1.3x 封顶）', szRoll.data.max > 520, 'max=' + szRoll.data.max);
  check('体型加成可达范围上限 ×(1+加成)（150~400 ×1.55 → 接近 620）', szRoll.data.max > 600, 'max=' + szRoll.data.max);
  // 默认（正态）模型：全部落在 基准范围 ×(1+加成) 之内，且均值贴近区间中值 ×(1+加成)
  const szDef = await POST('http://localhost:' + P1 + '/api/dev/rollsize', { token: tokA, range: [150, 400], size: 55, n: 500 });
  check('未指定 model 时用当前配置（默认正态）', szDef.data.model === 'normal', String(szDef.data.model));
  const szDefMean = szDef.data.rolls.reduce(function (a, b) { return a + b; }, 0) / szDef.data.rolls.length;
  check('正态模型均值贴近区间中值 ×1.55（275×1.55≈426）', Math.abs(szDefMean - 426.25) < 25, 'mean=' + szDefMean.toFixed(1));
  check('正态模型不越界（150×1.55 = 232.5 起）', szDef.data.rolls.every(function (v) { return v >= 232 && v <= 620; }),
    'min=' + Math.min.apply(null, szDef.data.rolls) + ' max=' + szDef.data.max);
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

  section('组件订阅提醒：条件匹配 + 定向推送 subalert');
  // 停止 A 的自动钓鱼，避免随机掉落干扰判定（本段只经 dev 接口注入组件）
  await POST('http://localhost:' + P1 + '/api/fishing/stop', { token: tokA });
  const subInst = D.instanceId('reel_electric', 'common', [{ type: 'speed', value: 25 }]);
  const subOtherBase = D.instanceId('hook_steel', 'common', [{ type: 'speed', value: 25 }]);
  const subLowVal = D.instanceId('reel_electric', 'common', [{ type: 'speed', value: 12 }]);
  let subMark = sinkA.length;
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: subInst } });
  await sleep(250);
  check('未配置订阅时不推送 subalert', !sinkA.slice(subMark).some(m => m.type === 'subalert'));
  check('订阅非法词条类型被拒 400', (await POST('http://localhost:' + P1 + '/api/subscribe', { token: tokA, on: true, affixType: 'nope' })).status === 400);
  check('订阅非法底材被拒 400', (await POST('http://localhost:' + P1 + '/api/subscribe', { token: tokA, on: true, baseId: 'nope' })).status === 400);
  check('订阅数值区间反了被拒 400', (await POST('http://localhost:' + P1 + '/api/subscribe', { token: tokA, on: true, min: 10, max: 5 })).status === 400);
  const subSave = await POST('http://localhost:' + P1 + '/api/subscribe', { token: tokA, on: true, baseId: 'reel_electric', affixType: 'speed', min: 20, max: 30, badge: true, blink: true });
  check('订阅保存成功（条件回显）', subSave.status === 200 && subSave.data.cfg.on === true && subSave.data.cfg.baseId === 'reel_electric' && subSave.data.cfg.min === 20 && subSave.data.cfg.max === 30, JSON.stringify(subSave.data));
  const subGet = await GET('http://localhost:' + P1 + '/api/subscribe?token=' + tokA);
  check('订阅随账号持久化（GET 回读一致）', subGet.status === 200 && subGet.data.cfg.affixType === 'speed' && subGet.data.cfg.blink === true);
  subMark = sinkA.length;
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: subInst } });
  await sleep(250);
  check('命中订阅推送 subalert（含底材与词条数值）', sinkA.slice(subMark).some(m => m.type === 'subalert' && m.item && m.item.baseId === 'reel_electric' && (m.item.affixes || []).some(a => a.type === 'speed' && a.value === 25)));
  subMark = sinkA.length;
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: subOtherBase } });
  await sleep(250);
  check('底材不匹配不推送', !sinkA.slice(subMark).some(m => m.type === 'subalert'));
  subMark = sinkA.length;
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: subLowVal } });
  await sleep(250);
  check('词条数值超出区间不推送', !sinkA.slice(subMark).some(m => m.type === 'subalert'));
  await POST('http://localhost:' + P1 + '/api/subscribe', { token: tokA, on: false });
  subMark = sinkA.length;
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: subInst } });
  await sleep(250);
  check('关闭订阅后不再推送', !sinkA.slice(subMark).some(m => m.type === 'subalert'));

  section('卸下组件放回背包（不再摧毁）');
  const bdOff = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'reel', compId: null });
  check('卸下卷线器成功', bdOff.status === 200 && !bdOff.data.bd.reel.compId);
  check('卸下的组件放回背包', !!(bdOff.data.inventory && bdOff.data.inventory[reelInst] >= 1), JSON.stringify(bdOff.data.inventory));
  // 卷线器 +25% 卸下后不再计入；钩仍是 -5%，故钓速 = -5
  check('卸下后卷线器加成移除（仅剩钩 -5%）', bdOff.data.effects.speed === -5, JSON.stringify(bdOff.data.effects));
  // 换装：给背包两件竿身，装上 A 再换 B，A 应回到背包（可循环取用）
  const rodA = D.instanceId('rod_bamboo', 'common', [{ type: 'speed', value: 10 }]);
  const rodB = D.instanceId('rod_carbon', 'rare', [{ type: 'speed', value: 20 }, { type: 'material', value: -10 }]);
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: rodA } });
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: rodB } });
  const eq1 = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: rodA });
  check('先装上竿身 A', eq1.status === 200 && eq1.data.bd.rod.compId === rodA);
  const eq2 = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: rodB });
  check('换装竿身 B 成功', eq2.status === 200 && eq2.data.bd.rod.compId === rodB);
  check('被换下的旧组件回到背包', (eq2.data.inventory[rodA] || 0) >= 1, JSON.stringify(eq2.data.inventory));
  check('换装后仍持有新组件扣除（B 已不在背包）', !eq2.data.inventory[rodB], JSON.stringify(eq2.data.inventory));
  // 复原：把卷线器重新装上（后续重启持久化测试依赖 reel=电动卷线器）
  const reEq = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'reel', compId: reelInst });
  check('重新装回卷线器', reEq.status === 200 && reEq.data.bd.reel.compId === reelInst);

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
  const dupRes = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_a', password: 'another123', qq: '10009' });
  check('重复用户名被拒 409', dupRes.status === 409, 'status=' + dupRes.status);
  const dupCase = await POST('http://localhost:' + P1 + '/api/register', { username: 'TESTER_A', password: 'another123', qq: '10010' });
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
  const rc3 = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_c', password: 'pass1234', qq: '10011' });
  check('第三个账号注册成功', rc3.status === 200);
  const lgC1 = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_c', password: 'pass1234', qq: '10011' });
  const lgC2 = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_c', password: 'pass1234', qq: '10011' });
  check('同账号二次登录成功（顶号）', lgC2.status === 200);
  check('旧 token 被顶号失效 401', (await GET('http://localhost:' + P1 + '/api/me?token=' + lgC1.data.token)).status === 401);
  check('新 token 可用', (await GET('http://localhost:' + P1 + '/api/me?token=' + lgC2.data.token)).status === 200);

  section('注册校验：QQ 必填 + 确认密码');
  check('缺少 QQ 号被拒 400', (await POST('http://localhost:' + P1 + '/api/register', { username: 'noqq_user', password: 'pass1234', qq: '' })).status === 400);
  check('QQ 号格式非法被拒 400', (await POST('http://localhost:' + P1 + '/api/register', { username: 'badqq_user', password: 'pass1234', qq: 'abc' })).status === 400);
  check('确认密码不一致被拒 400', (await POST('http://localhost:' + P1 + '/api/register', { username: 'mismatch_user', password: 'pass1234', confirmPassword: 'other999', qq: '123456' })).status === 400);
  const okReg = await POST('http://localhost:' + P1 + '/api/register', { username: 'goodqq_user', password: 'pass1234', confirmPassword: 'pass1234', qq: '123456' });
  check('QQ 与确认密码合法时注册成功', okReg.status === 200 && !!okReg.data.token);
  check('响应 profile 含 QQ 号', okReg.data.profile.qq === '123456', JSON.stringify(okReg.data.profile.qq));

  section('登出：会话失效 + 实时连接断开');
  const loTok = okReg.data.token;
  check('登出前 token 可用', (await GET('http://localhost:' + P1 + '/api/me?token=' + loTok)).status === 200);
  check('登出返回成功', (await POST('http://localhost:' + P1 + '/api/logout', { token: loTok })).status === 200);
  check('登出后 token 失效 401', (await GET('http://localhost:' + P1 + '/api/me?token=' + loTok)).status === 401);
  check('登出后可用账号密码重新登录', (await POST('http://localhost:' + P1 + '/api/login', { username: 'goodqq_user', password: 'pass1234' })).status === 200);
  check('无 token 登出也返回成功（幂等）', (await POST('http://localhost:' + P1 + '/api/logout', {})).status === 200);

  section('双钓：叠加值 A → 概率 P=A/(A+100)，最多 3 条');
  const dc0 = await POST('http://localhost:' + P1 + '/api/dev/doublecount', { token: tokA, A: 0, n: 50 });
  check('A=0 时不追加（始终 1 条）', dc0.status === 200 && dc0.data.dist['1'] === 50, JSON.stringify(dc0.data.dist));
  const dc50 = await POST('http://localhost:' + P1 + '/api/dev/doublecount', { token: tokA, A: 50, n: 4000 });
  check('A=50 时存在 2 条与 3 条的情况', dc50.status === 200 && dc50.data.dist['2'] > 0 && dc50.data.dist['3'] > 0, JSON.stringify(dc50.data.dist));
  check('A=50 时从不出现 4 条（最多 3 条）', !dc50.data.dist['4'], JSON.stringify(dc50.data.dist));
  // P=1/3：理论 1条=0.667,2条=0.222,3条=0.111, E=1.444
  check('A=50 分布接近理论值（±0.06）', Math.abs(dc50.data.p1 - 2 / 3) < 0.06 && Math.abs(dc50.data.p2 - 2 / 9) < 0.06 && Math.abs(dc50.data.p3 - 1 / 9) < 0.06,
    JSON.stringify({ p1: dc50.data.p1, p2: dc50.data.p2, p3: dc50.data.p3 }));
  check('A=50 期望上钩数 ≈ 1.444', Math.abs(dc50.data.mean - (1 + 1 / 3 + 1 / 9)) < 0.06, String(dc50.data.mean));


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



  section('钓竿存档 / 槽位购买 / 配件锁定 / 整竿市集');
  // 静态章节结束时关掉了服务器，这里重新拉起（数据目录不变，账号仍在）
  srv = start(P1);
  await waitHttp('http://localhost:' + P1 + '/shop', { timeout: 20000 });
  const rodLoginA = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_a', password: 'pass1234' });
  const rodLoginB = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_b', password: 'pass5678' });
  tokA = rodLoginA.data.token; tokB = rodLoginB.data.token;
  check('钓竿章节重新登录（前章重启过服务器）', !!tokA && !!tokB);
  await POST('http://localhost:' + P1 + '/api/dev/seed', { token: tokA, coins: 6000000 });
  const rodInst1 = D.instanceId('rod_carbon', 'rare', [{ type: 'speed', value: 18 }, { type: 'material', value: -8 }, { type: 'size', value: 3 }]);
  const rodInst2 = D.instanceId('reel_turbo', 'rare', [{ type: 'speed', value: 30 }, { type: 'big', value: -8 }]);
  for (const id of [rodInst1, rodInst2]) await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: id } });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: rodInst1 });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'reel', compId: rodInst2 });
  const equippedCount = function (bd) { return Object.keys(bd || {}).filter(function (k) { return bd[k] && bd[k].compId; }).length; };
  const meRod0 = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data;
  check('初始钓竿槽位 1 个（免费）且给出下一槽位价格', meRod0.rodSlotsCount === 1 && meRod0.nextRodSlotPrice === 10000,
    JSON.stringify({ c: meRod0.rodSlotsCount, p: meRod0.nextRodSlotPrice }));
  check('槽位上限 8 根', meRod0.rodSlotsMax === 8, String(meRod0.rodSlotsMax));
  check('未存槽位时标记为散件装配', meRod0.rodActiveSlot === -1, String(meRod0.rodActiveSlot));
  check('被钓竿占用的实例随资料下发（用于锁定标记）', meRod0.rodLocked && meRod0.rodLocked[rodInst1] === 1 && meRod0.rodLocked[rodInst2] === 1, JSON.stringify(meRod0.rodLocked));
  const coinsBeforeSlot = meRod0.coins;
  const buySlot1 = await POST('http://localhost:' + P1 + '/api/rod/slot/buy', { token: tokA });
  check('购买第 2 个槽位扣 1w', buySlot1.status === 200 && buySlot1.data.price === 10000 && buySlot1.data.coins === coinsBeforeSlot - 10000,
    JSON.stringify(buySlot1.data));
  check('下一个槽位价格递增为 5w', buySlot1.data.nextRodSlotPrice === 50000, String(buySlot1.data.nextRodSlotPrice));
  for (let i = 0; i < 6; i++) await POST('http://localhost:' + P1 + '/api/rod/slot/buy', { token: tokA });
  check('买满 8 个槽位后再买被拒 400', (await POST('http://localhost:' + P1 + '/api/rod/slot/buy', { token: tokA })).status === 400);
  check('未购买槽位保存被拒 400', (await POST('http://localhost:' + P1 + '/api/rod/save', { token: tokA, slot: 9, name: 'x' })).status === 400);
  // —— 保存 = 当前这根直接占用槽位（保持装戴），并可改名 ——
  const saved = await POST('http://localhost:' + P1 + '/api/rod/save', { token: tokA, slot: 1, name: '钓速竿' });
  check('保存钓竿：占用槽位且保持装戴', saved.status === 200 && saved.data.rodSlots[1] && saved.data.rodSlots[1].name === '钓速竿'
    && equippedCount(saved.data.bd) >= 2 && saved.data.rodActiveSlot === 1, JSON.stringify({ n: equippedCount(saved.data.bd), active: saved.data.rodActiveSlot }));
  check('使用中的槽位带 active 标记', saved.data.rodSlots[1].active === true);
  check('存档后配件被锁定（占用 1 件）', saved.data.rodLocked[rodInst1] === 1, JSON.stringify(saved.data.rodLocked));
  const sellLocked = await POST('http://localhost:' + P1 + '/api/sell', { token: tokA, id: rodInst1, qty: 1 });
  check('锁定配件无法在系统商店出售', sellLocked.status === 400 && /锁定/.test(sellLocked.data.error || ''), JSON.stringify(sellLocked.data));
  const listLocked = await POST('http://localhost:' + P1 + '/api/market/list', { token: tokA, id: rodInst1, qty: 1, price: 500 });
  check('锁定配件无法上架市集', listLocked.status === 400 && /锁定/.test(listLocked.data.error || ''), JSON.stringify(listLocked.data));
  const rnCur = await POST('http://localhost:' + P1 + '/api/rod/name', { token: tokA, name: '主战竿' });
  check('命名当前钓竿并同步槽位名', rnCur.status === 200 && rnCur.data.rodName === '主战竿'
    && rnCur.data.rodSlots[1].name === '主战竿', JSON.stringify({ n: rnCur.data.rodName, s: rnCur.data.rodSlots[1].name }));
  check('使用中的钓竿直接改名被拒（避免与槽位不一致）', (await POST('http://localhost:' + P1 + '/api/rod/save', { token: tokA, slot: 2, name: 'x' })).status === 400);
  // —— 收起：腾出装戴位但保留槽位（配件继续锁定）——
  const stow = await POST('http://localhost:' + P1 + '/api/rod/stow', { token: tokA });
  check('收起当前钓竿：装戴清空、槽位保留', stow.status === 200 && stow.data.fromSlot === 1 && equippedCount(stow.data.bd) === 0
    && stow.data.rodSlots[1] && stow.data.rodSlots[1].name === '主战竿' && stow.data.rodSlots[1].active === false, JSON.stringify({ from: stow.data.fromSlot, active: stow.data.rodSlots[1] && stow.data.rodSlots[1].active }));
  check('收起后配件仍锁定在槽位钓竿里', stow.data.rodLocked[rodInst1] === 1, JSON.stringify(stow.data.rodLocked));
  // —— 装配第二根（散件）→ 占用槽位 2 ——
  for (const id of [rodInst1, rodInst2]) await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: id } });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: rodInst1 });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'reel', compId: rodInst2 });
  const saved2 = await POST('http://localhost:' + P1 + '/api/rod/save', { token: tokA, slot: 2, name: '二号竿' });
  check('第二根钓竿占用槽位 2', saved2.status === 200 && saved2.data.rodSlots[2] && saved2.data.rodSlots[2].name === '二号竿' && saved2.data.rodActiveSlot === 2,
    JSON.stringify({ slot2: saved2.data.rodSlots[2] && saved2.data.rodSlots[2].name, active: saved2.data.rodActiveSlot }));
  // —— 切换使用槽位 1：槽位 2 必须保持占用（不再腾空）——
  const useRod = await POST('http://localhost:' + P1 + '/api/rod/use', { token: tokA, slot: 1 });
  check('切换使用槽位钓竿：装戴恢复且原槽位不被腾空', useRod.status === 200 && equippedCount(useRod.data.bd) >= 2
    && useRod.data.rodSlots[1].active === true && !!useRod.data.rodSlots[2] && useRod.data.rodSlots[2].name === '二号竿',
    JSON.stringify({ active: useRod.data.rodSlots[1].active, slot2: useRod.data.rodSlots[2] && useRod.data.rodSlots[2].name }));
  check('切回的钓竿带名字', useRod.data.rodName === '主战竿', String(useRod.data.rodName));
  check('重复使用同一槽位被拒 400', (await POST('http://localhost:' + P1 + '/api/rod/use', { token: tokA, slot: 1 })).status === 400);
  // —— 整竿上架 → 买家整根获得（进槽位，不拆散）——
  const rodList = await POST('http://localhost:' + P1 + '/api/market/list', { token: tokA, rodSlot: 2, price: 9000, hours: 6 });
  check('整根钓竿可上架市集（1 件整体）', rodList.status === 200 && rodList.data.listing && /^rodset:/.test(rodList.data.listing.id) && rodList.data.listing.qty === 1,
    JSON.stringify(rodList.data).slice(0, 200));
  check('上架后槽位 2 释放', !rodList.data.rodSlots[2], JSON.stringify(rodList.data.rodSlots[2]));
  const rodId = rodList.data.listing.id;
  check('整竿公开目录识别为 rod 类型', (function () { const m = D.itemOf(rodId); return m.kind === 'rod' && m.parts.length >= 2; })());
  await POST('http://localhost:' + P1 + '/api/dev/seed', { token: tokB, coins: 20000 });
  const coinsB0 = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokB)).data.coins;
  const invB0 = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokB)).data.inventory;
  const coinsA0 = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.coins;
  const buyRod = await POST('http://localhost:' + P1 + '/api/market/buy', { token: tokB, lid: rodList.data.listing.lid });
  check('买家购买整竿成功', buyRod.status === 200, JSON.stringify(buyRod.data).slice(0, 120));
  const meB = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokB)).data;
  const gotRod = (meB.rodSlots || []).find(function (x) { return x && x.count >= 2; });
  check('整根钓竿整体进入槽位（不再拆散成配件）', !!gotRod, JSON.stringify((meB.rodSlots || []).map(function (x) { return x && x.name; })));
  check('买家背包未增加散装配件', JSON.stringify(meB.inventory) === JSON.stringify(invB0), JSON.stringify({ before: invB0, after: meB.inventory }));
  check('买家扣款 9000', meB.coins === coinsB0 - 9000, coinsB0 + ' -> ' + meB.coins);
  check('卖家到账 8100（扣 10% 税）', (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.coins === coinsA0 + 8100,
    coinsA0 + ' -> ' + (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.coins);
  // —— 槽位已满时不能购买整竿 ——
  await POST('http://localhost:' + P1 + '/api/rod/stow', { token: tokA }); // 先收起使用中的钓竿（保留槽位）
  for (const id of [rodInst1, rodInst2]) await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: id } });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: rodInst1 });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'reel', compId: rodInst2 });
  const saved3 = await POST('http://localhost:' + P1 + '/api/rod/save', { token: tokA, slot: 3, name: '三号竿' });
  check('第三根占用槽位 3', saved3.status === 200 && !!saved3.data.rodSlots[3]);
  const list3 = await POST('http://localhost:' + P1 + '/api/market/list', { token: tokA, rodSlot: 3, price: 4000, hours: 6 });
  const buyFull = await POST('http://localhost:' + P1 + '/api/market/buy', { token: tokB, lid: list3.data.listing.lid });
  check('买家槽位已满 → 购买整竿被拒 400', buyFull.status === 400 && /槽位已满/.test(buyFull.data.error || ''), JSON.stringify(buyFull.data));
  // —— 下架：整根优先回槽位（不再拆散）——
  const beforeCancel = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data;
  await POST('http://localhost:' + P1 + '/api/market/cancel', { token: tokA, lid: list3.data.listing.lid });
  const afterCancel = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data;
  const backRod = (afterCancel.rodSlots || []).find(function (x) { return x && x.name === '三号竿'; });
  check('整竿下架后整根回到槽位', !!backRod, JSON.stringify((afterCancel.rodSlots || []).map(function (x) { return x && x.name; })));
  check('下架不再把整竿拆成散件', JSON.stringify(afterCancel.inventory) === JSON.stringify(beforeCancel.inventory), JSON.stringify({ before: beforeCancel.inventory, after: afterCancel.inventory }));
  // —— 删除未使用的槽位：配件退回背包（解锁）——
  const backSlot = (afterCancel.rodSlots || []).findIndex(function (x) { return x && x.name === '三号竿'; });
  check('退回的整竿保留原名', backSlot >= 0, JSON.stringify((afterCancel.rodSlots || []).map(function (x) { return x && x.name; })));
  const del1 = await POST('http://localhost:' + P1 + '/api/rod/delete', { token: tokA, slot: backSlot });
  check('删除未使用的槽位会退回配件（并解锁）', del1.status === 200 && del1.data.returned >= 1 && del1.data.wasActive === false,
    JSON.stringify({ returned: del1.data && del1.data.returned, wasActive: del1.data && del1.data.wasActive }));

  // —— 回归：卸下配件 = 把这根已保存的钓竿拆开，对应槽位随之取消 ——
  // 旧 bug：卸下时把改动后的装配同步回槽位快照 → 槽位被静默改写成残件，卸光后变成「空壳槽位」
  // （界面显示为空、却被 freeRodSlotOf 当成空位复用），新存的竿把原配置顶掉；rodActiveSlot 还会悬空指向它。
  section('钓竿槽位 · 卸下配件取消槽位');
  const meFree = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data;
  const freeSlot = (meFree.rodSlots || []).findIndex(function (x) { return !x; });
  check('存在空闲槽位可供回归用例', freeSlot >= 0, JSON.stringify((meFree.rodSlots || []).map(function (x) { return x && x.name; })));
  const regA = 'rod_bamboo#common#spd+12', regB = 'line_nylon#common#spd+10';
  for (const id of [regA, regB]) await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: id } });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: regA });
  await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'line', compId: regB });
  const regSave = await POST('http://localhost:' + P1 + '/api/rod/save', { token: tokA, slot: freeSlot, name: '回归·配置一' });
  check('回归前置：两件钓竿存进槽位', regSave.status === 200 && regSave.data.rodSlots[freeSlot]
    && regSave.data.rodSlots[freeSlot].count === 2 && regSave.data.rodSlots[freeSlot].name === '回归·配置一',
    JSON.stringify(regSave.data.rodSlots && regSave.data.rodSlots[freeSlot]));
  // 换装（装，不是卸）：槽位保留，快照同步
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokA, item: { kind: 'component', id: regA } });
  const regSwap = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'rod', compId: regA });
  check('换装仍保留槽位（装 ≠ 卸）', regSwap.data.releasedSlot === -1 && !!regSwap.data.rodSlots[freeSlot]
    && regSwap.data.rodSlots[freeSlot].count === 2, JSON.stringify({ r: regSwap.data.releasedSlot, s: regSwap.data.rodSlots[freeSlot] }));
  // 卸下任一配件 → 显式取消该槽位
  const invBeforeOff = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.inventory;
  const regOff = await POST('http://localhost:' + P1 + '/api/bd/set', { token: tokA, part: 'line', compId: null });
  check('卸下配件：槽位被显式取消', regOff.status === 200 && regOff.data.releasedSlot === freeSlot && regOff.data.rodSlots[freeSlot] === null,
    JSON.stringify({ r: regOff.data.releasedSlot, s: regOff.data.rodSlots[freeSlot] }));
  check('取消时回报槽位名（供前端提示）', regOff.data.releasedName === '回归·配置一', String(regOff.data.releasedName));
  check('取消后 rodActiveSlot 归 -1（不再悬空指向）', regOff.data.rodActiveSlot === -1, String(regOff.data.rodActiveSlot));
  const invAfterOff = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.inventory;
  check('卸下的配件退回背包', (invAfterOff[regB] || 0) === (invBeforeOff[regB] || 0) + 1,
    JSON.stringify({ before: invBeforeOff[regB] || 0, after: invAfterOff[regB] || 0 }));
  check('未卸下的配件仍在装戴（不是整根清空）', !!(regOff.data.bd.rod && regOff.data.bd.rod.compId), JSON.stringify(regOff.data.bd.rod));
  // 槽位清空后是「真空位」而非残件空壳：可被正常复用
  const meAfter = (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data;
  check('槽位显示为空（无残件空壳）', meAfter.rodSlots[freeSlot] === null, JSON.stringify(meAfter.rodSlots[freeSlot]));
  const regSave2 = await POST('http://localhost:' + P1 + '/api/rod/save', { token: tokA, slot: freeSlot, name: '回归·配置二' });
  check('槽位可正常重新占用（旧 bug 会在这里顶掉原配置）', regSave2.status === 200
    && regSave2.data.rodSlots[freeSlot] && regSave2.data.rodSlots[freeSlot].name === '回归·配置二',
    JSON.stringify(regSave2.data.rodSlots && regSave2.data.rodSlots[freeSlot]));

  section('榜单更新播报（任意榜单 / 所有鱼种）');
  // 重启过服务器：旧 SSE 连接已失效，这里新建一条订阅（用新 token）
  const sinkAnn = [];
  const cliAnn = sse(tokB, P1, sinkAnn);
  await sleep(400);
  check('播报订阅连接就绪（收到 init 快照）', sinkAnn.some(function (m) { return m.type === 'init'; }));
  // 用 dev 接口注入渔获，覆盖四级播报（普通鱼种「麦穗鱼」也照样通报）
  const annFish = 'minnow';
  const annPost = function (tok, size) {
    return POST('http://localhost:' + P1 + '/api/dev/catch', { token: tok, item: { kind: 'fish', id: annFish, rarity: 'common', name: '麦穗鱼', size: size }, ground: '静水湖', spot: '芦苇浅滩' });
  };
  const annTexts = function (from) { return sinkAnn.slice(from).filter(x => x.type === 'globalRecord').map(x => (x.record && x.record.text) || ''); };
  // 0) 先用超大个体把「全场最大」抬到 99999（避免后续鱼种纪录触发全场最大）
  let m = sinkAnn.length;
  await POST('http://localhost:' + P1 + '/api/dev/catch', { token: tokB, item: { kind: 'fish', id: 'tuna', rarity: 'big', name: '黄金枪鱼', size: 99999 }, ground: '落日海湾', spot: '礁石区' });
  await sleep(300);
  let texts0 = annTexts(m);
  check('全场最大被破为最高优先级播报', texts0.some(t => /全场最大纪录被破/.test(t)), JSON.stringify(texts0).slice(0, 160));
  // 1) 该鱼种最大纪录（5000 必然刷新历史，且低于 99999 不会触发全场最大）
  m = sinkAnn.length;
  await annPost(tokA, 5000);
  await sleep(300);
  let texts = annTexts(m);
  check('刷新该鱼种最大纪录即播报（普通鱼同样通报）', texts.some(t => /全服最大纪录刷新/.test(t)), JSON.stringify(texts).slice(0, 160));
  // 2) 该鱼种最小纪录（1cm 必然刷新）
  m = sinkAnn.length;
  await annPost(tokA, 1);
  await sleep(300);
  texts = annTexts(m);
  check('刷新该鱼种最小纪录即播报', texts.some(t => /全服最小纪录刷新/.test(t)), JSON.stringify(texts).slice(0, 160));
  // 3) 前十大：B 首次上榜（不破纪录）→ 播报名次
  m = sinkAnn.length;
  await annPost(tokB, 100);
  await sleep(300);
  texts = annTexts(m);
  check('进入前十大即播报（含名次）', texts.some(t => /前十大更新/.test(t) && /第 \d+ 名/.test(t)), JSON.stringify(texts).slice(0, 160));
  // 4) 前十小：B 的成绩变小（前十大不变、也不破最小纪录 1）→ 只播报前十小
  m = sinkAnn.length;
  await annPost(tokB, 50);
  await sleep(300);
  texts = annTexts(m);
  check('前十小有更新即播报', texts.some(t => /前十小更新/.test(t)), JSON.stringify(texts).slice(0, 160));
  check('播报文案随事件下发（不再只靠前端拼）', texts.length > 0 && texts.every(t => typeof t === 'string' && t.length > 4), JSON.stringify(texts).slice(0, 160));
  cliAnn.destroy();

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
    if (fs.existsSync(projData)) { projBackup = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-proj-')); copyDirSafe(projData, projBackup); }
    fs.rmSync(projData, { recursive: true, force: true });
    fs.mkdirSync(path.join(projData, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(projData, 'accounts', 'reloctest.json'),
      JSON.stringify({ username: 'reloctest', salt: 'aa', pwHash: 'x', name: '搬迁测试', coins: 777, inventory: {}, bd: {}, codex: {}, catchCount: 0, createdAt: 1 }));

    const env8 = Object.assign({}, process.env, { PORT: String(P1 + 80), FISHING_DEV: '1', HOME: HOME, USERPROFILE: HOME });
    delete env8.FISHING_DATA_DIR; // 走默认目录解析
    srv = spawn(NODE, ['backend/server.js'], { cwd: ROOT, env: env8 });
    await sleep(1400);
    check('数据目录默认解析到用户文档/web-fishing-game', fs.existsSync(EXPECT_DATA));
    check('旧项目内数据已搬迁到文档目录', fs.existsSync(path.join(EXPECT_DATA, 'accounts', 'reloctest.json')));
    const relocVer = await GET('http://localhost:' + (P1 + 80) + '/api/version');
    check('搬迁后服务器正常启动并响应', relocVer.status === 200 && !!relocVer.data.version);
    killTree(srv);
  } finally {
    // 复原：删掉测试造的旧目录，恢复原数据（即使上面抛错也保证执行）

    killTree(srv);
    try { fs.rmSync(projData, { recursive: true, force: true }); } catch (e) {}
    if (projBackup) { try { copyDirSafe(projBackup, projData); } catch (e) {} }
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
