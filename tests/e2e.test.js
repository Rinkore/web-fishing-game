/*
 * 全量功能端到端测试
 * 覆盖：静态数据 / 引擎钓鱼逻辑 / 账号注册登录会话 / 资料持久化 / 真实多人联机 / 静态服务与安全
 * 运行： node tests/e2e.test.js
 */
'use strict';
const { spawn } = require('child_process');
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
  return r;
}

function start(port) {
  return spawn(NODE, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port) }) });
}

// 在桩化浏览器环境中加载客户端脚本，直接测试引擎逻辑
function loadEngine() {
  global.window = global;
  const store = {};
  global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } };
  global.setInterval = () => 0;
  global.clearInterval = () => {};
  global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  global.addEventListener = () => {};
  global.EventSource = function () { this.onmessage = null; this.onerror = null; };
  require(path.join(ROOT, 'js', 'data.js'));
  require(path.join(ROOT, 'js', 'engine.js'));
  return { D: global.GameData, E: global.Engine };
}

(async () => {
  console.log('钓鱼小游戏 · 全量功能测试');
  console.log('Node ' + process.version);

  // ---------- 1. 静态数据 ----------
  section('1. 静态数据完整性');
  const { D } = loadEngine();
  check('钓场总数 4（3 普通 + 1 活动）', D.GROUNDS.length === 4 && D.GROUNDS.filter(g => g.type === 'normal').length === 3 && D.GROUNDS.filter(g => g.type === 'event').length === 1);
  check('钓竿部位 7 且含饰品栏位', D.ROD_PARTS.length === 7 && D.ROD_PARTS.some(p => p.isCharm));
  check('每个普通钓场至少 1 个钓点', D.GROUNDS.filter(g => g.type === 'normal').every(g => g.spots.length >= 1));
  check('活动钓场为锁定状态', D.GROUNDS.filter(g => g.type === 'event').every(g => g.locked === true));
  check('鱼类含 普通/大鱼/稀有 三档', D.FISH.common.length > 0 && D.FISH.big.length > 0 && D.FISH.rare.length > 0);
  check('导航已实现入口 8 个（钓鱼/BD/渔场/商店/市集/交易/图鉴/大鱼榜）', D.NAV.filter(n => n.implemented).length === 8, 'got ' + D.NAV.filter(n => n.implemented).map(n => n.id).join(','));
  check('导航未实现占位入口 2 个（商城/收藏）', D.NAV.filter(n => !n.implemented).length === 2, 'got ' + D.NAV.filter(n => !n.implemented).map(n => n.id).join(','));

  // ---------- 2. 引擎钓鱼逻辑 ----------
  section('2. 引擎钓鱼逻辑');
  const { E } = loadEngine();
  E.init();
  check('初始 BD 7 部位且全部无词缀/无稀有', Object.keys(E.state.bd).length === 7 && D.ROD_PARTS.every(p => E.state.bd[p.key].affixes.length === 0 && E.state.bd[p.key].rare === null));
  check('未选点时开始钓鱼被拒', E.startFishing(null, null).ok === false);
  check('非法钓点被拒', E.startFishing('stillwater', 'not-exist').ok === false);
  check('合法钓点可开始钓鱼', E.startFishing('stillwater', 'dock').ok === true);
  check('开始后状态 = fishing', E.state.player.status === 'fishing' && E.state.fishing.active === true);

  const kinds = { fish: 0, material: 0, component: 0 };
  const rar = { common: 0, big: 0, rare: 0 };
  for (let i = 0; i < 800; i++) {
    const c = E.doCatch('stillwater', 'dock', E.state.player.name);
    if (c) { kinds[c.item.kind]++; rar[c.item.rarity]++; }
  }
  check('产出包含鱼类', kinds.fish > 0);
  check('产出包含材料', kinds.material > 0);
  check('产出包含组件', kinds.component > 0);
  check('产出覆盖 普通/大鱼/稀有 三档', rar.common > 0 && rar.big > 0 && rar.rare > 0);
  check('产出进入玩家库存', Object.keys(E.state.inventory).length > 0);
  check('渔获日志有记录且不超 60 条', E.state.log.length > 0 && E.state.log.length <= 60);
  check('钓点玩家查询可用', Array.isArray(E.playersAtGround('stillwater')));
  E.stopFishing();
  check('停止后状态 = idle', E.state.player.status === 'idle' && E.state.fishing.active === false);

  // ---------- 3. 账号系统 ----------
  section('3. 账号：注册 / 登录 / 会话');
  let srv = start(P1);
  await sleep(800);

  const r1 = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_a', password: 'pass1234', name: '测试甲' });
  check('注册成功返回 token', r1.status === 200 && !!r1.data.token);
  check('注册返回初始资料 coins=500', r1.data && r1.data.profile && r1.data.profile.coins === 500 && r1.data.profile.username === 'tester_a');
  const r2 = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_b', password: 'pass5678', name: '测试乙' });
  check('第二个账号注册成功', r2.status === 200 && !!r2.data.token);
  const dupRes = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_a', password: 'another123' });
  check('重复用户名被拒 409', dupRes.status === 409, 'status=' + dupRes.status + ' body=' + JSON.stringify(dupRes.data));
  const dupCase = await POST('http://localhost:' + P1 + '/api/register', { username: 'TESTER_A', password: 'another123' });
  check('用户名大小写不敏感（同账号视为重复）409', dupCase.status === 409, 'status=' + dupCase.status);
  const dupName = await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_d', password: 'abcd1234' });
  check('不同用户名可注册（不误判重复）', dupName.status === 200);
  check('非法用户名被拒 400', (await POST('http://localhost:' + P1 + '/api/register', { username: 'ab', password: 'abcd' })).status === 400);
  check('过短密码被拒 400', (await POST('http://localhost:' + P1 + '/api/register', { username: 'tester_c', password: '1' })).status === 400);
  check('错误密码登录失败 401', (await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_a', password: 'bad' })).status === 401);
  const lg = await POST('http://localhost:' + P1 + '/api/login', { username: 'tester_a', password: 'pass1234' });
  check('正确密码登录成功', lg.status === 200 && !!lg.data.token);
  check('无 token 取资料被拒 401', (await GET('http://localhost:' + P1 + '/api/me')).status === 401);
  check('伪造 token 取资料被拒 401', (await GET('http://localhost:' + P1 + '/api/me?token=fake123')).status === 401);
  const meOk = await GET('http://localhost:' + P1 + '/api/me?token=' + lg.data.token);
  check('有效 token 可取回自身资料', meOk.status === 200 && meOk.data.username === 'tester_a');

  const tokA = lg.data.token, tokB = r2.data.token;

  // ---------- 4. 真实多人联机 ----------
  section('4. 真实多人联机（SSE 广播）');
  const sinkA = [], sinkB = [];
  const cliA = sse(tokA, P1, sinkA);
  const cliB = sse(tokB, P1, sinkB);
  await sleep(400);
  check('A 连接后收到 init 快照', sinkA.some(m => m.type === 'init'));
  check('init.you 等于自身账号', sinkA.some(m => m.type === 'init' && m.you === 'tester_a'));

  await POST('http://localhost:' + P1 + '/presence', { token: tokA, status: 'fishing', groundId: 'stillwater', spotId: 'dock', recent: null });
  await sleep(300);
  check('B 收到 A 的在线状态与钓点', sinkB.some(m => m.type === 'players' && m.players.some(p => p.id === 'tester_a' && p.status === 'fishing' && p.groundId === 'stillwater')));

  await POST('http://localhost:' + P1 + '/catch', { token: tokA, item: { kind: 'fish', rarity: 'big', id: 'catfish', name: '巨型鲶鱼' }, ground: '静水湖', spot: '老旧码头' });
  await sleep(300);
  check('B 收到 A 的渔获广播（含账号显示名）', sinkB.some(m => m.type === 'feed' && m.entry.who === '测试甲' && m.entry.item.name === '巨型鲶鱼'));

  await POST('http://localhost:' + P1 + '/presence', { token: tokA, status: 'idle', groundId: 'stillwater', spotId: 'dock' });
  await sleep(300);
  check('状态切换 idle 同步到 B', sinkB.some(m => m.type === 'players' && m.players.some(p => p.id === 'tester_a' && p.status === 'idle')));

  check('未登录上报状态被拒 401', (await POST('http://localhost:' + P1 + '/presence', { token: 'bad', status: 'fishing' })).status === 401);
  check('未登录上报渔获被拒 401', (await POST('http://localhost:' + P1 + '/catch', { token: 'bad', item: {} })).status === 401);

  cliA.destroy();
  await sleep(400);
  check('A 断线后 B 在线列表移除 A', sinkB.some(m => m.type === 'players' && !m.players.some(p => p.id === 'tester_a')));

  // ---------- 5. 资料持久化 ----------
  section('5. 资料持久化（服务端落盘）');
  check('保存资料成功', (await POST('http://localhost:' + P1 + '/api/profile', { token: tokA, coins: 1234, inventory: { carp: 9, koi: 1 }, bd: { hook: { name: '标准钩', affixes: [], rare: null } }, name: '测试甲改' })).status === 200);
  check('保存后立即取回一致', (await GET('http://localhost:' + P1 + '/api/me?token=' + tokA)).data.coins === 1234);
  const uf = path.join(ROOT, 'data', 'users.json');
  check('users.json 已落盘且含账号', fs.existsSync(uf) && Object.keys(JSON.parse(fs.readFileSync(uf, 'utf8'))).includes('tester_a'));
  const raw = fs.readFileSync(uf, 'utf8');
  check('密码以 salt+hash 存储（不存明文）', raw.includes('pwHash') && raw.includes('salt') && !raw.includes('pass1234'));

  cliB.destroy();
  srv.kill();
  await sleep(500);

  srv = start(P2);
  await sleep(900);
  const lg2 = await POST('http://localhost:' + P2 + '/api/login', { username: 'tester_a', password: 'pass1234' });
  check('重启服务器后仍可登录', lg2.status === 200);
  const me2 = await GET('http://localhost:' + P2 + '/api/me?token=' + (lg2.data && lg2.data.token));
  check('重启后 coins 持久化 = 1234', me2.data && me2.data.coins === 1234);
  check('重启后 inventory 持久化', me2.data && me2.data.inventory && me2.data.inventory.carp === 9);
  check('重启后 bd 持久化', !!(me2.data && me2.data.bd && me2.data.bd.hook));
  check('重启后显示名持久化', me2.data && me2.data.name === '测试甲改');
  srv.kill();
  await sleep(300);

  // ---------- 6. 静态服务与安全 ----------
  section('6. 静态服务与前端资源');
  srv = start(P1);
  await sleep(800);
  const idx = await GET('http://localhost:' + P1 + '/');
  check('首页可访问 200', idx.status === 200 && idx.text.includes('网页钓鱼小游戏'));
  check('首页含登录/注册界面', idx.text.includes('auth-card') && idx.text.includes('auth-user'));
  for (const f of ['/css/style.css', '/js/data.js', '/js/net.js', '/js/engine.js', '/js/ui.js']) {
    const r = await GET('http://localhost:' + P1 + f);
    check('静态资源可访问 ' + f, r.status === 200 && r.text.length > 0);
  }
  check('CSS 含登录遮罩样式', (await GET('http://localhost:' + P1 + '/css/style.css')).text.includes('.auth-overlay'));
  check('前端引入顺序正确 data->engine->net->ui', (function () { const t = idx.text; return t.indexOf('js/data.js') < t.indexOf('js/engine.js') && t.indexOf('js/engine.js') < t.indexOf('js/net.js') && t.indexOf('js/net.js') < t.indexOf('js/ui.js'); })());

  section('7. 安全');
  check('/data 目录被拦截 403', (await GET('http://localhost:' + P1 + '/data/users.json')).status === 403);
  check('已知未知路径返回 404', (await GET('http://localhost:' + P1 + '/nope-xyz')).status === 404);
  srv.kill();

  try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch (e) {}

  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) console.log('失败项：\n  - ' + failed.join('\n  - '));
  console.log(fail === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');
  console.log('============================');
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200);
})();
