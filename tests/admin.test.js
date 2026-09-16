/*
 * 管理后台功能端到端测试（纯 HTTP，可独立运行）
 * 覆盖：管理员引导与授权 / 掉落池编辑（权重校验）/ 钓点增益（钓速即时生效）/
 *       钓场锁定 / 市集退回挂单 / 上钩判断公式（校验+试算+实际掷骰）/ 通知等级过滤 / 配置持久化
 * 运行： node tests/admin.test.js
 * 说明：使用 FISHING_DATA_DIR 指向临时数据目录，不触碰真实 backend/data。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 轮询等待工具（测试内部不依赖固定 sleep）：就绪即继续，超时才失败
const { waitFor, waitHttp, waitPage } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 8105;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-admin-test-'));
// 双端共享目录：校验批量上架生成的组件实例（词条是否在池内、数值是否在自然区间）
const D_DATA = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
// 按 id 找渔场（11e 用）
function dockFind(grounds) { return (grounds || []).find(function (g) { return g.id === 'stillwater'; }); }
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
const B = 'http://localhost:' + PORT;

// SSE：把事件推入 sink（附带接收时间）
function sse(tok, sink) {
  const r = http.get(B + '/events?token=' + tok, res => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) {
          try {
            const m = JSON.parse(line.slice(6));
            // perf-5/8 批量协议：batch 解包逐条；feedBatch（钓场分区 feed）展开为 feed 事件
            if (m && m.type === 'batch' && Array.isArray(m.list)) {
              for (const it of m.list) {
                if (it && it.type === 'feedBatch' && Array.isArray(it.list)) { for (const e2 of it.list) sink.push({ t: Date.now(), ev: { type: 'feed', entry: e2 } }); }
                else sink.push({ t: Date.now(), ev: it });
              }
            }
            else if (m && m.type === 'feedBatch' && Array.isArray(m.list)) { for (const e2 of m.list) sink.push({ t: Date.now(), ev: { type: 'feed', entry: e2 } }); }
            else sink.push({ t: Date.now(), ev: m });
          } catch (e) {}
        }
      }
    });
  });
  r.on('error', () => {});
  return r;
}

// 启动前清理端口占用：Windows 下测试进程被强杀时 taskkill 可能失败，残留的旧服务器会占住端口，
// 导致下一次运行的所有请求打到「陈旧的服务器实例」上（表现为大面积 未登录/数据不符）。
function killPortOccupant(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + port + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
      { stdio: 'ignore' });
  } catch (e) {}
}
function start(dataDir) {
  killPortOccupant(PORT);
  return spawn(NODE, ['backend/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: dataDir }),
  });
}
function waitReady() {
  // 轮询就绪：服务器一响应就继续（通常 0.3-0.8s），不再固定等待
  return waitHttp(B + '/shop', { timeout: 20000 });
}

(async () => {
  console.log('管理后台功能测试（数据目录：' + TMP_DATA + '）');
  let srv = start(TMP_DATA);
  check('服务器启动成功', await waitReady());

  // ---------- 1. 引导与权限 ----------
  section('1. 管理员引导与授权');
  check('错误密码登录被拒 401', (await POST(B + '/api/admin/login', { username: 'nobody', password: 'x' })).status === 401);

  const rg1 = await POST(B + '/api/register', { username: 'adm_root', password: 'pass1234', name: ' Root', qq: '10004' });
  check('管理员候选账号注册成功', rg1.status === 200);
  const la = await POST(B + '/api/admin/login', { username: 'adm_root', password: 'pass1234' });
  check('服务器无管理员时首个登录自动成为管理员（引导）', la.status === 200 && la.data.admin === true);
  const TOKA = la.data.token;
  check('session 校验通过', (await GET(B + '/api/admin/session?token=' + TOKA)).status === 200);
  const meRoot = await GET(B + '/api/me?token=' + TOKA);
  check('资料接口带 admin 标志', meRoot.data.admin === true, JSON.stringify(meRoot.data));

  await POST(B + '/api/register', { username: 'adm_p1', password: 'pass1234', name: '玩家一号', qq: '10005' });
  await POST(B + '/api/register', { username: 'adm_p2', password: 'pass1234', name: '玩家二号', qq: '10006' });
  const lp1 = await POST(B + '/api/login', { username: 'adm_p1', password: 'pass1234' });
  const lp2 = await POST(B + '/api/login', { username: 'adm_p2', password: 'pass1234' });
  const TK1 = lp1.data.token, TK2 = lp2.data.token;

  const ldenied = await POST(B + '/api/admin/login', { username: 'adm_p1', password: 'pass1234' });
  check('已有管理员时普通账号登录后台被拒 403', ldenied.status === 403);
  check('普通账号 token 访问管理 API 被拒 403', (await GET(B + '/api/admin/overview?token=' + TK1)).status === 403);
  check('伪造 token 被拒 403', (await GET(B + '/api/admin/overview?token=fake')).status === 403);

  check('授予 adm_p1 管理员', (await POST(B + '/api/admin/users/setadmin', { token: TOKA, target: 'adm_p1', admin: true })).status === 200);
  check('被授权账号 session 通过', (await GET(B + '/api/admin/session?token=' + TK1)).status === 200);
  check('不能撤销自己的管理员', (await POST(B + '/api/admin/users/setadmin', { token: TK1, target: 'adm_p1', admin: false })).status === 400);
  check('撤销 adm_p2 之前无需授权 403', (await GET(B + '/api/admin/session?token=' + TK2)).status === 403);
  check('授予再撤销 adm_p2', (await POST(B + '/api/admin/users/setadmin', { token: TOKA, target: 'adm_p2', admin: true })).status === 200
    && (await POST(B + '/api/admin/users/setadmin', { token: TOKA, target: 'adm_p2', admin: false })).status === 200);
  check('撤销后 session 被拒', (await GET(B + '/api/admin/session?token=' + TK2)).status === 403);

  // 玩家二号建立实时连接（后续钓鱼/锁定/公式/通知场景都要在线）
  const sink2 = [];
  const es2 = sse(TK2, sink2);
  await sleep(400);

  // ---------- 2. 渔场配置：掉落池 + 增益 ----------
  section('2. 掉落池与增益编辑');
  const w0 = await GET(B + '/api/admin/world?token=' + TOKA);
  check('world 返回 4 钓场 + 9 钓点', w0.status === 200 && w0.data.grounds.length === 4 && w0.data.grounds.reduce((n, g) => n + g.spots.length, 0) === 9);
  // 40 种鱼（龙宫宝珠改为材料）+ 7 种材料（新增潮汐砂 / 龙鳞碎屑）
  check('目录含 40 种鱼 + 7 种材料', w0.data.catalog.fish.length === 40 && w0.data.catalog.materials.length === 7, JSON.stringify({ fish: w0.data.catalog.fish.length, mat: w0.data.catalog.materials.length }));
  check(' frostmoon 默认锁定', w0.data.grounds.find(g => g.id === 'frostmoon').locked === true);

  const setPool = (groundId, spotId, pool, tok) => POST(B + '/api/admin/spot/pool', { token: tok || TOKA, groundId: groundId, spotId: spotId, pool: pool });
  check('设置 dock 单一鲫鱼池', (await setPool('stillwater', 'dock', [{ pick: 'fish:crucian', weight: 100 }])).status === 200);
  check('未知鱼类被拒 400', (await setPool('stillwater', 'dock', [{ pick: 'fish:shark', weight: 10 }])).status === 400);
  check('空掉落池被拒 400', (await setPool('stillwater', 'dock', [])).status === 400);
  check('负权重被拒 400', (await setPool('stillwater', 'dock', [{ pick: 'fish:crucian', weight: -5 }])).status === 400);
  check('未知增益类别被拒 400', (await POST(B + '/api/admin/spot/buffs', { token: TOKA, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'magic', value: 10 }] })).status === 400);
  check('超范围增益值被拒 400', (await POST(B + '/api/admin/spot/buffs', { token: TOKA, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'speed', value: 5000 }] })).status === 400);
  // 上限 100：曾允许到 1000，实测该量级会把抛竿间隔压到异常小、拖垮服务器
  const overBuff = await POST(B + '/api/admin/spot/buffs', { token: TOKA, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'speed', value: 101 }] });
  check('增益值 101 被拒 400（上限 100）', overBuff.status === 400 && /-100 到 100/.test(overBuff.data.error || ''), JSON.stringify(overBuff.data));
  check('增益值上限 100 可保存', (await POST(B + '/api/admin/spot/buffs', { token: TOKA, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'speed', value: 100 }] })).status === 200);
  check('设置钓速增益 20%', (await POST(B + '/api/admin/spot/buffs', { token: TOKA, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'speed', value: 20 }] })).status === 200);

  const w1 = await GET(B + '/api/admin/world?token=' + TOKA);
  const dock = w1.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock');
  check('掉落池覆盖已生效（单一鲫鱼）', dock.pool.length === 1 && dock.pool[0].pick === 'fish:crucian');
  check('增益覆盖已生效（speed 20）', Array.isArray(dock.buffs) && dock.buffs[0].type === 'speed' && dock.buffs[0].value === 20);

  // 上钩公式先固定 100% 便于确定性断言
  check('公式固定为 100（必上钩）', (await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '100' })).status === 200);

  // 玩家一号连接 SSE 并钓鱼：验证增益影响间隔 + 掉落池生效
  const sink1 = [];
  const es1 = sse(TK1, sink1);
  await sleep(400);
  const fs1 = await POST(B + '/api/fishing/start', { token: TK1, groundId: 'stillwater', spotId: 'dock' });
  check('钓点增益改变抛竿间隔（3000×0.8=2400）', fs1.status === 200 && fs1.data.interval === 2400, JSON.stringify(fs1.data));
  await sleep(4000);
  const myCatch = sink1.filter(x => x.ev.type === 'catch' && x.ev.entry.who === '玩家一号');
  check('4 秒内收到至少一条渔获推送', myCatch.length >= 1);
  check('渔获全部来自新掉落池（鲫鱼）', myCatch.every(x => x.ev.entry.item.id === 'crucian'));
  check('全局 feed 正常广播（等级 all）', sink1.some(x => x.ev.type === 'feed' && x.ev.entry.who === '玩家一号'));
  await POST(B + '/api/fishing/stop', { token: TK1 });

  // ---------- 3. 钓场锁定 ----------
  section('3. 钓场锁定');
  check('锁定急流河', (await POST(B + '/api/admin/ground/lock', { token: TOKA, groundId: 'rapids', locked: true })).status === 200);
  const lockStart = await POST(B + '/api/fishing/start', { token: TK2, groundId: 'rapids', spotId: 'shoal' });
  check('锁定后开始钓鱼被拒', lockStart.status === 400 && /尚未开放/.test(lockStart.data.error || ''), JSON.stringify(lockStart.data));
  check('解锁急流河', (await POST(B + '/api/admin/ground/lock', { token: TOKA, groundId: 'rapids', locked: false })).status === 200);
  check('解锁后可正常开始', (await POST(B + '/api/fishing/start', { token: TK2, groundId: 'rapids', spotId: 'shoal' })).status === 200);
  await POST(B + '/api/fishing/stop', { token: TK2 });
  check('解锁霜月冰湖（无钓点）', (await POST(B + '/api/admin/ground/lock', { token: TOKA, groundId: 'frostmoon', locked: false })).status === 200);
  check('无钓点钓场开始被拒（钓点不存在）', (await POST(B + '/api/fishing/start', { token: TK2, groundId: 'frostmoon', spotId: 'x' })).status === 400);
  check('重新锁定霜月冰湖', (await POST(B + '/api/admin/ground/lock', { token: TOKA, groundId: 'frostmoon', locked: true })).status === 200);

  // ---------- 4. 市集退回 ----------
  section('4. 市集退回挂单');
  await POST(B + '/api/dev/seed', { token: TK2, inventory: { crucian: 5 } });
  const li = await POST(B + '/api/market/list', { token: TK2, id: 'crucian', qty: 5, price: 1, hours: 6 });
  check('玩家二号上架 5 条鲫鱼', li.status === 200 && !!li.data.listing);
  const LID = li.data.listing.lid;
  check('普通玩家无法调用退回 403', (await POST(B + '/api/admin/market/return', { token: TK2, lid: LID })).status === 403);
  check('管理员退回挂单', (await POST(B + '/api/admin/market/return', { token: TOKA, lid: LID })).status === 200);
  const mkAfter = await GET(B + '/api/market');
  check('挂单已从市集移除', !mkAfter.data.listings.some(l => l.lid === LID));
  const meP2 = await GET(B + '/api/me?token=' + TK2);
  check('物品已退回卖家背包（5 条鲫鱼）', meP2.data.inventory.crucian === 5, JSON.stringify(meP2.data.inventory));
  check('退回不存在的挂单 404', (await POST(B + '/api/admin/market/return', { token: TOKA, lid: 99999 })).status === 404);

  // ---------- 4b. 后台批量上架（活跃市场） ----------
  section('4b. 后台批量上架');
  check('普通玩家无权批量上架 403', (await POST(B + '/api/admin/market/bulk', { token: TK2, seller: 'adm_p2', counts: { component: 1 } })).status === 403);
  check('卖家账号不存在被拒 400', (await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'nobody_zzz', counts: { component: 1 } })).status === 400);
  check('一类条数都没给被拒 400', (await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'adm_p2', counts: {} })).status === 400);
  check('超过单次上限（500）被拒 400', (await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'adm_p2', counts: { component: 501 } })).status === 400);
  check('部件筛选后没有可用底材被拒 400',
    (await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'adm_p2', counts: { component: 1 }, part: 'rod', picks: { component: ['line_nylon'] } })).status === 400);
  check('品质权重全 0 被拒 400',
    (await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'adm_p2', counts: { component: 1 }, quality: { common: 0, rare: 0, epic: 0, mythic: 0 } })).status === 400);

  const mkPre = (await GET(B + '/api/market')).data.listings.length;
  const dry = await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'adm_p2', counts: { component: 30 }, dryRun: true });
  check('预览返回条数与样例（8 条）', dry.status === 200 && dry.data.count === 30 && dry.data.samples.length === 8, JSON.stringify(dry.data).slice(0, 150));
  check('预览不写入任何挂单', (await GET(B + '/api/market')).data.listings.length === mkPre, String(mkPre));
  check('预览样例是组件且带词条', dry.data.samples.every(s => s.kind === 'component' && s.affixN >= 1), JSON.stringify(dry.data.samples[0]));

  const bulk = await POST(B + '/api/admin/market/bulk', {
    token: TOKA, seller: 'adm_p2', hours: 12, counts: { component: 20, fish: 4, material: 3, chest: 2 }, mulMin: 0.9, mulMax: 1.1,
  });
  check('批量上架成功（20+4+3+2=29 条）', bulk.status === 200 && bulk.data.created === 29, JSON.stringify(bulk.data).slice(0, 150));
  const mkBulk = (await GET(B + '/api/market')).data.listings.filter(l => l.seller === 'adm_p2');
  check('市集出现这 29 条（挂在该账号名头下）', mkBulk.length === 29 && mkBulk.every(l => l.sellerName === '玩家二号'), JSON.stringify({ n: mkBulk.length, name: mkBulk[0] && mkBulk[0].sellerName }));
  check('挂单带后台标记 src=admin', mkBulk.every(l => l.src === 'admin'));
  const kindOf = l => D_DATA.itemOf(l.id).kind;
  check('四类物品都按条数挂出', ['component', 'fish', 'material', 'chest'].every(k => mkBulk.filter(l => kindOf(l) === k).length === ({ component: 20, fish: 4, material: 3, chest: 2 })[k]),
    JSON.stringify({ component: mkBulk.filter(l => kindOf(l) === 'component').length, fish: mkBulk.filter(l => kindOf(l) === 'fish').length, material: mkBulk.filter(l => kindOf(l) === 'material').length, chest: mkBulk.filter(l => kindOf(l) === 'chest').length }));
  check('组件每单固定 1 件（实例不可合并）', mkBulk.filter(l => kindOf(l) === 'component').every(l => l.qty === 1));
  check('非组件每单数量落在配置区间内（默认 1~1）', mkBulk.filter(l => kindOf(l) !== 'component').every(l => l.qty === 1));
  check('时长写入挂单（12 小时）', mkBulk.every(l => l.hours === 12 && l.expireAt > l.t));
  check('价格 = 现价 × 倍率区间（0.9~1.1）', mkBulk.every(l => {
    const base = D_DATA.itemOf(l.id).price || 0;   // 组件按品质固定价，鱼/材料按基准价
    return l.price >= Math.max(1, Math.floor(base * 0.9)) && l.price <= Math.ceil(base * 1.1) + 1;
  }), JSON.stringify(mkBulk.slice(0, 3).map(l => [l.name, l.price])));

  const comps = mkBulk.filter(l => kindOf(l) === 'component');
  check('组件都是合法实例', comps.every(l => !!D_DATA.instanceOf(l.id)));
  check('组件词条在底材池内、数值在自然区间（正常配件，不出池外/越界）', comps.every(l => {
    const inst = D_DATA.instanceOf(l.id);
    const base = D_DATA.componentBase(inst.baseId);
    return inst.affixes.length >= 1 && inst.affixes.every(a => {
      const slot = base.pool.filter(p => p.type === a.type)[0];
      return !!slot && a.value >= slot.min && a.value <= slot.max;
    });
  }), JSON.stringify(comps.filter(l => {
    const inst = D_DATA.instanceOf(l.id); const base = D_DATA.componentBase(inst.baseId);
    return !inst.affixes.every(a => { const slot = base.pool.filter(p => p.type === a.type)[0]; return !!slot && a.value >= slot.min && a.value <= slot.max; });
  }).slice(0, 2)));

  // 部位限定 + 品质限定：生成结果必须都落在限定内
  const limited = await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'adm_p2', counts: { component: 12 }, part: 'reel', quality: { common: 0, rare: 0, epic: 1, mythic: 0 }, affixMin: 3, affixMax: 3, dryRun: true });
  check('部位限定生效（只出卷线器底材）', limited.status === 200 && limited.data.samples.every(s => D_DATA.componentBase(D_DATA.instanceOf(s.id).baseId).part === 'reel'), JSON.stringify(limited.data.samples.map(s => s.id)).slice(0, 140));
  check('品质权重限定生效（只出史诗）', limited.data.samples.every(s => D_DATA.instanceOf(s.id).quality === 'epic'));
  // 词条条数受「底材池长」与「品质上限」夹取（池里没有的词缀不会凭空出现，仍是正常配件）
  check('词条条数限定生效（期望 min(3, 池长) 条）', limited.data.samples.every(s => {
    const inst = D_DATA.instanceOf(s.id);
    return s.affixN === Math.min(3, D_DATA.componentBase(inst.baseId).pool.length);
  }), JSON.stringify(limited.data.samples.map(s => s.affixN)));

  // 过期/退回：后台虚拟挂单的物品是现造的，不能退回卖家背包（否则等于凭空生成道具）
  const invB2 = JSON.stringify((await GET(B + '/api/me?token=' + TK2)).data.inventory);
  // 注意退回的是**组件**单：下面还要拿一条**鱼**单验证购买（别把同一条单退了又买）
  const backTarget = mkBulk.find(l => kindOf(l) === 'component');
  const backOne = await POST(B + '/api/admin/market/return', { token: TOKA, lid: backTarget.lid });
  check('退回后台挂单成功', backOne.status === 200);
  check('退回虚拟挂单不把物品塞进卖家背包', JSON.stringify((await GET(B + '/api/me?token=' + TK2)).data.inventory) === invB2, invB2);
  check('退回后该挂单从市集消失', !(await GET(B + '/api/market')).data.listings.some(l => l.lid === backTarget.lid));

  // 玩家照常能买后台挂出的物品（钱进卖家账号）
  await POST(B + '/api/admin/users/update', { token: TOKA, target: 'adm_p1', coins: 100000 });
  const buyBulk = await POST(B + '/api/market/buy', { token: TK1, lid: mkBulk.find(l => kindOf(l) === 'fish').lid, qty: 1 });
  check('玩家可以买走后台挂出的物品', buyBulk.status === 200, JSON.stringify(buyBulk.data).slice(0, 120));
  const p2Coins = (await GET(B + '/api/me?token=' + TK2)).data.coins;
  check('成交款进卖家账号（扣 10% 税后 > 0）', p2Coins > 0, String(p2Coins));

  // ---------- 4c. 名头带大写字母：挂单与成交必须完全走该账号名下 ----------
  // 回归：批量上架曾把 seller 写成账号的原始大小写用户名（如 Wj1752），而成交/下架/退单/删号
  // 全按账号 key（小写）查 —— 结果是挂单看得见、卖出去却不进账、也不出现在它的历史订单里。
  section('4c. 后台批量上架 · 名头含大写字母');
  const rgCase = await POST(B + '/api/register', { username: 'CaseHead9', password: 'pass1234', name: '大小写名头', qq: '10084' });
  check('新建含大写字母的账号（CaseHead9）', rgCase.status === 200, JSON.stringify(rgCase.data).slice(0, 100));
  const TKC = rgCase.data.token;
  const KEYC = 'casehead9';
  const dryCase = await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'CaseHead9', counts: { fish: 4, material: 2 }, dryRun: true });
  check('预览回带账号 key（小写）而非原始大小写', dryCase.status === 200 && dryCase.data.seller.key === KEYC && dryCase.data.seller.name === '大小写名头', JSON.stringify(dryCase.data.seller));
  const bulkCase = await POST(B + '/api/admin/market/bulk', { token: TOKA, seller: 'CaseHead9', hours: 6, counts: { fish: 4, material: 2 } });
  check('大小写名头批量上架成功（6 条）', bulkCase.status === 200 && bulkCase.data.created === 6, JSON.stringify(bulkCase.data).slice(0, 120));
  const mkAllCase = (await GET(B + '/api/market')).data.listings;
  const mkCase = mkAllCase.filter(l => l.seller === KEYC);
  check('挂单 seller 存的是账号 key（小写）', mkCase.length === 6 && !mkAllCase.some(l => String(l.seller) === 'CaseHead9'), JSON.stringify(mkAllCase.map(l => l.seller).slice(0, 5)));
  check('挂单展示名仍是账号显示名', mkCase.every(l => l.sellerName === '大小写名头'));
  const caseBuy = mkCase[0] || { lid: -1, price: 0 };   // 空市集兜底：下面的断言照常失败，但别让用例抛异常中断
  const coinsBefore = (await GET(B + '/api/me?token=' + TKC)).data.coins;
  const buyCase = await POST(B + '/api/market/buy', { token: TK1, lid: caseBuy.lid, qty: 1 });
  const coinsAfter = (await GET(B + '/api/me?token=' + TKC)).data.coins;
  const caseGain = caseBuy.price * 1 - Math.ceil(caseBuy.price * 1 * 0.10);
  check('玩家买走该名头挂出的物品', buyCase.status === 200, JSON.stringify(buyCase.data).slice(0, 120));
  check('成交款按 key 进该账号（扣 10% 税）', buyCase.status === 200 && coinsAfter === coinsBefore + caseGain, JSON.stringify({ before: coinsBefore, after: coinsAfter, gain: caseGain }));
  const histCase = await GET(B + '/api/market/history?token=' + TKC);
  check('售出出现在该账号的历史订单里（自己=卖家）', (histCase.data.trades || []).some(t => t.seller === KEYC && t.buyer === 'adm_p1'), JSON.stringify((histCase.data.trades || []).slice(0, 2)));
  const histBuyerCase = await GET(B + '/api/market/history?token=' + TK1);
  check('买家侧历史订单显示卖家名', (histBuyerCase.data.trades || []).some(t => t.seller === KEYC && t.sellerName === '大小写名头'), JSON.stringify((histBuyerCase.data.trades || []).slice(0, 2)));

  // ---------- 4d. 每账号挂单上限（默认 40，可单独覆盖，0 = 不限） ----------
  section('4d. 每账号挂单上限');
  check('普通玩家看不到账号列表 403', (await GET(B + '/api/admin/users?token=' + TKC)).status === 403);
  const usersCap0 = (await GET(B + '/api/admin/users?token=' + TOKA)).data.users;
  const uCase0 = usersCap0.find(u => u.key === KEYC);
  const uPlain0 = usersCap0.find(u => u.key === 'adm_p2');
  check('账号列表回带挂单上限 + 在用数（未设置 = 默认 40）', !!uCase0 && uCase0.listingCap === 40 && uCase0.capSet === false && uPlain0.listingCap === 40, JSON.stringify(uCase0));
  check('在用数按账号统计（含后台批量上架的名头）', uCase0.listings >= 5, JSON.stringify({ listings: uCase0.listings }));
  const capLow = Math.max(1, uCase0.listings - 1);
  check('设置该账号挂单上限成功', (await POST(B + '/api/admin/users/update', { token: TOKA, target: KEYC, listingCap: capLow })).status === 200);
  const meLow = (await GET(B + '/api/me?token=' + TKC)).data;
  check('账号资料回带上限（玩家端据此提示）', meLow.listingCap === capLow && meLow.listingCapSet === true, JSON.stringify({ cap: meLow.listingCap, set: meLow.listingCapSet }));
  await POST(B + '/api/dev/seed', { token: TKC, inventory: { crucian: 5 } });
  const blockLow = await POST(B + '/api/market/list', { token: TKC, id: 'crucian', qty: 1, price: 1 });
  check('达到该账号上限后上架被拒 400（错误里带该上限数）', blockLow.status === 400 && String(blockLow.data.error).indexOf(String(capLow)) >= 0, JSON.stringify(blockLow.data));
  check('放宽上限成功', (await POST(B + '/api/admin/users/update', { token: TOKA, target: KEYC, listingCap: uCase0.listings + 5 })).status === 200);
  check('放宽后立刻可以上架', (await POST(B + '/api/market/list', { token: TKC, id: 'crucian', qty: 1, price: 1 })).status === 200);
  check('上限设 0 = 不限', (await POST(B + '/api/admin/users/update', { token: TOKA, target: KEYC, listingCap: 0 })).status === 200);
  check('不限时继续上架成功', (await POST(B + '/api/market/list', { token: TKC, id: 'crucian', qty: 1, price: 1 })).status === 200);
  check('上限非法值（负数）被拒 400', (await POST(B + '/api/admin/users/update', { token: TOKA, target: KEYC, listingCap: -3 })).status === 400);
  check('未设置的账号仍按默认 40 卡', (await GET(B + '/api/admin/users?token=' + TOKA)).data.users.find(u => u.key === 'adm_p2').listingCap === 40);

  // ---------- 5. 上钩公式 ----------
  section('5. 上钩判断公式');
  check('非法公式被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '1 +', validateOnly: true })).status === 400);
  check('未知变量被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: 'hackspeed + 1', validateOnly: true })).status === 400);
  check('未知函数被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: 'eval(1)', validateOnly: true })).status === 400);
  const evl = await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: 'min(99, 80 + speed * 0.3)', validateOnly: true, evalVars: { speed: 60 } });
  check('校验+试算：min(99, 80+60×0.3)=98', evl.status === 200 && evl.data.prob === 98, JSON.stringify(evl.data));

  // 公式 0%：永远不上钩
  check('保存公式 0', (await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '0' })).status === 200);
  const marker0 = Date.now();
  await POST(B + '/api/fishing/start', { token: TK2, groundId: 'stillwater', spotId: 'dock' });
  await waitFor(() => false, { timeout: 7000 }); // 观察窗口：7 秒内不应有任何渔获
  check('公式 0 时 7 秒内零渔获', !sink2.some(x => x.ev.type === 'catch' && x.t > marker0));
  // 公式 100%：竿竿上钩
  await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '100' });
  await sleep(4200);
  await POST(B + '/api/fishing/stop', { token: TK2 });
  check('公式 100 后恢复渔获', sink2.some(x => x.ev.type === 'catch' && x.t > marker0));

  // ---------- 6. 通知等级 ----------
  section('6. 全服动态通知等级');
  const marker = Date.now();
  check('设为 uncommon（仅非普通）', (await POST(B + '/api/admin/settings', { token: TOKA, notifyLevel: 'uncommon' })).status === 200);
  await POST(B + '/api/fishing/start', { token: TK2, groundId: 'stillwater', spotId: 'dock' });
  await sleep(3800);
  await POST(B + '/api/fishing/stop', { token: TK2 });
  // 池子只有普通鲫鱼：uncommon 下不广播 feed，但钓者自己的 catch 一定到
  const catchesSince = sink2.filter(x => x.ev.type === 'catch' && x.t > marker);
  check('uncommon 下钓者自己仍收到渔获推送', catchesSince.length >= 1);
  check('uncommon 下普通鱼不进全服动态', !sink2.some(x => x.ev.type === 'feed' && x.ev.entry.who === '玩家二号' && x.t > marker));
  check('未知通知等级被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, notifyLevel: 'loud' })).status === 400);

  check('设为 all 后恢复广播', (await POST(B + '/api/admin/settings', { token: TOKA, notifyLevel: 'all' })).status === 200);
  const marker2 = Date.now();
  await POST(B + '/api/fishing/start', { token: TK2, groundId: 'stillwater', spotId: 'dock' });
  await sleep(3800);
  await POST(B + '/api/fishing/stop', { token: TK2 });
  check('all 下普通鱼重新进入动态', sink2.some(x => x.ev.type === 'feed' && x.ev.entry.who === '玩家二号' && x.t > marker2));

  check('设为 none（关闭动态）', (await POST(B + '/api/admin/settings', { token: TOKA, notifyLevel: 'none' })).status === 200);
  const marker3 = Date.now();
  await POST(B + '/api/fishing/start', { token: TK2, groundId: 'stillwater', spotId: 'dock' });
  await sleep(3800);
  await POST(B + '/api/fishing/stop', { token: TK2 });
  check('none 下钓者自己仍收到推送', sink2.some(x => x.ev.type === 'catch' && x.t > marker3));
  check('none 下无任何 feed 广播', !sink2.some(x => x.ev.type === 'feed' && x.t > marker3));

  // ---------- 7. 反馈意见管理 ----------
  section('7. 反馈意见');
  check('玩家提交反馈成功', (await POST(B + '/api/feedback/submit', { token: TK2, text: '管理员可见的测试反馈', kind: 'idea' })).status === 200);
  const fbList = await GET(B + '/api/admin/feedback?token=' + TOKA);
  check('管理员可读取反馈列表', fbList.status === 200 && Array.isArray(fbList.data.feedback));
  check('反馈列表含玩家提交内容', fbList.data.feedback.some(f => f.text === '管理员可见的测试反馈' && f.kind === 'idea' && f.name === '玩家二号'));
  check('非管理员读取反馈被拒 403', (await GET(B + '/api/admin/feedback?token=' + TK2)).status === 403);
  const ovFb = await GET(B + '/api/admin/overview?token=' + TOKA);
  check('概览统计含反馈数', typeof ovFb.data.feedbackCount === 'number' && ovFb.data.feedbackCount >= 1, String(ovFb.data.feedbackCount));

  // ---------- 8. 服务器热力图（概览面板的数据源） ----------
  section('8. 服务器热力图数据');
  check('非管理员读取热力图被拒 403', (await GET(B + '/api/admin/stats?range=24h&token=' + TK2)).status === 403);
  check('伪造 token 读取热力图被拒 403', (await GET(B + '/api/admin/stats?range=24h&token=fake')).status === 403);
  const heat = await GET(B + '/api/admin/stats?range=24h&token=' + TOKA);
  check('热力图接口返回 200', heat.status === 200 && heat.data.ok === true, JSON.stringify(heat.data).slice(0, 140));
  check('曲线至少含「当前」一个采样桶', Array.isArray(heat.data.points) && heat.data.points.length >= 1, JSON.stringify(heat.data.points));
  check('每个点含 t/online/onlineMax/fishing/listings/trades/users',
    !!(heat.data.points[0] && heat.data.points[0].t && 'online' in heat.data.points[0] && 'onlineMax' in heat.data.points[0]
      && 'fishing' in heat.data.points[0] && 'listings' in heat.data.points[0] && 'trades' in heat.data.points[0] && 'users' in heat.data.points[0]),
    JSON.stringify(heat.data.points[0]));
  check('24h 桶步长 10 分钟 / 跨度 24 小时', heat.data.range === '24h' && heat.data.step === 600000 && heat.data.span === 86400000,
    heat.data.range + '/' + heat.data.step + '/' + heat.data.span);
  check('热力格为 7×24', Array.isArray(heat.data.heat) && heat.data.heat.length === 7 && heat.data.heat.every(r => r.length === 24),
    JSON.stringify(heat.data.heat && heat.data.heat.length));
  check('热力格含本次启动的样本（存在非空格）', heat.data.heat.some(r => r.some(v => v != null)));
  check('返回 live 在线数与概览一致', heat.data.live.online === ovFb.data.online, heat.data.live.online + ' vs ' + ovFb.data.online);
  check('返回历史峰值在线（含时间戳）', typeof heat.data.peak.online === 'number' && typeof heat.data.peak.t === 'number', JSON.stringify(heat.data.peak));
  const heat30 = await GET(B + '/api/admin/stats?range=30d&token=' + TOKA);
  check('30 天区间改用小时样本（步长 6 小时）', heat30.data.range === '30d' && heat30.data.step === 6 * 3600000, String(heat30.data.step));
  check('非法区间回落到 24h', (await GET(B + '/api/admin/stats?range=whatever&token=' + TOKA)).data.range === '24h');

  // ---------- 9. 基础双钓率配置 ----------
  section('9. 基础双钓率');
  const wdD = await GET(B + '/api/admin/world?token=' + TOKA);
  check('world 返回基础双钓率字段', typeof wdD.data.doubleBase === 'number' && wdD.data.doubleBase === 0, String(wdD.data.doubleBase));
  check('负数基础双钓率被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, doubleBase: -0.1 })).status === 400);
  check('超过 1 的基础双钓率被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, doubleBase: 1.5 })).status === 400);
  check('设置基础双钓率 0.5 成功', (await POST(B + '/api/admin/settings', { token: TOKA, doubleBase: 0.5 })).status === 200);
  check('基础双钓率已生效（0.5）', (await GET(B + '/api/admin/world?token=' + TOKA)).data.doubleBase === 0.5);

  // ---------- 9b. 组件生成配置 ----------
  section('9b. 组件生成配置');
  const wc = await GET(B + '/api/admin/world?token=' + TOKA);
  check('world 返回组件生成配置与默认值', !!wc.data.componentCfg && !!wc.data.componentDefaults);
  check('未知 roll 模型被拒 400', (await POST(B + '/api/admin/component/config', { token: TOKA, rollModel: 'magic' })).status === 400);
  const ccSet = await POST(B + '/api/admin/component/config', {
    token: TOKA, qualityWeights: { common: 0, rare: 0, epic: 1 }, countWeights: { epic: [0, 0, 1] },
    rollModel: 'skew', affixRanges: { rod_bamboo: { speed: [88, 88] } },
    adjectiveRules: [{ name: '测试极品', full: true }, { name: '普通款' }],
  });
  check('保存组件生成配置成功', ccSet.status === 200);
  check('品质概率已生效', JSON.stringify(ccSet.data.componentCfg.qualityWeights) === JSON.stringify({ common: 0, rare: 0, epic: 1 }));
  check('数值区间已生效', JSON.stringify(ccSet.data.componentCfg.affixRanges.rod_bamboo.speed) === '[88,88]');
  check('修饰词规则已生效', ccSet.data.componentCfg.adjectiveRules[0].name === '测试极品');
  // v0.13.5：修饰词规则可带词条数区间，试算要回报每条规则的命中分布（含示例件）
  const ccSet2 = await POST(B + '/api/admin/component/config', {
    token: TOKA, adjectiveRules: [{ name: '恰好三条', minAffixes: 3, maxAffixes: 3 }, { name: '兜底款' }],
  });
  check('规则可带词条数区间并回读', ccSet2.status === 200 &&
    ccSet2.data.componentCfg.adjectiveRules[0].minAffixes === 3 && ccSet2.data.componentCfg.adjectiveRules[0].maxAffixes === 3,
    JSON.stringify(ccSet2.data.componentCfg.adjectiveRules));
  const sim2 = await POST(B + '/api/admin/component/simulate', { token: TOKA, n: 2000 });
  const simNames = Object.keys(sim2.data.rules || {});
  check('试算回报修饰词命中分布', sim2.status === 200 && simNames.indexOf('恰好三条') >= 0, JSON.stringify(simNames));
  check('命中分布带示例组件名与条数', /词条$/.test(((sim2.data.rules['恰好三条'] || {}).samples || [''])[0]),
    JSON.stringify(sim2.data.rules && sim2.data.rules['恰好三条']));
  check('每件组件都被某条规则命名（分布合计 = 样本数）',
    simNames.reduce(function (s, k) { return s + sim2.data.rules[k].count; }, 0) === 2000, JSON.stringify(sim2.data.rules));
  check('试算回报满词条（池内全满）占比', sim2.data.fullCount > 0 && sim2.data.fullCount <= 2000, String(sim2.data.fullCount));
  check('非法数值区间（max<min）被过滤而非报错', (await POST(B + '/api/admin/component/config', { token: TOKA, affixRanges: { rod_bamboo: { speed: [5, 1] } } })).status === 200);
  const sim = await POST(B + '/api/admin/component/simulate', { token: TOKA, n: 1000 });
  check('组件试算接口可用', sim.status === 200 && sim.data.quality.epic === 1000, JSON.stringify(sim.data.quality));
  check('试算无 0 值词条（roll=0 已被拒绝）', sim.data.zeroAffixes === 0, String(sim.data.zeroAffixes));
  check('恢复默认组件配置', (await POST(B + '/api/admin/component/reset', { token: TOKA })).status === 200);
  check('非管理员改组件配置被拒 403', (await POST(B + '/api/admin/component/config', { token: TK2, rollModel: 'linear' })).status === 403);
  // roll 模型三档都要能保存（回归：单选框缺 value 时前端会传 "on" 被拒）
  for (const rm of ['linear', 'normal', 'skew']) {
    check('可保存 roll 模型 ' + rm, (await POST(B + '/api/admin/component/config', { token: TOKA, rollModel: rm })).status === 200);
    check('服务器已应用 roll 模型 ' + rm, (await GET(B + '/api/admin/world?token=' + TOKA)).data.componentCfg.rollModel === rm);
  }
  // 钓场目录兜底接口：后进入/刷新的玩家可拿到含增益的最新目录
  const gPub = await GET(B + '/api/grounds');
  check('GET /api/grounds 返回钓场目录', gPub.status === 200 && Array.isArray(gPub.data.grounds) && gPub.data.grounds.length === 4);
  const gDock = gPub.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock');
  check('/api/grounds 含钓点增益（⚡ 标记数据源）', Array.isArray(gDock.buffs) && gDock.buffs.length > 0, JSON.stringify(gDock.buffs));

  // ---------- 9c. 横幅队列 ----------
  section('9c. 横幅队列');
  const bn1 = await POST(B + '/api/admin/banner/add', { token: TOKA, content: '公告一', duration: 5 });
  const bn2 = await POST(B + '/api/admin/banner/add', { token: TOKA, content: '公告二', duration: 6 });
  check('发布横幅成功', bn1.status === 200 && bn2.status === 200);
  check('空内容被拒 400', (await POST(B + '/api/admin/banner/add', { token: TOKA, content: '   ', duration: 5 })).status === 400);
  check('非法时长被拒 400', (await POST(B + '/api/admin/banner/add', { token: TOKA, content: 'x', duration: 0 })).status === 400);
  const bnPub = await GET(B + '/api/banner');
  check('公开横幅接口返回队列（2 条）', bnPub.status === 200 && bnPub.data.banners.length >= 2);
  check('队列按 seq 排序（公告一在前）', bnPub.data.banners[0].content === '公告一');
  check('下移公告一调整顺序', (await POST(B + '/api/admin/banner/move', { token: TOKA, id: bn1.data.banner.id, dir: 'down' })).status === 200);
  check('移动后公告二在前', (await GET(B + '/api/banner')).data.banners[0].content === '公告二');
  check('设置图标闪烁', (await POST(B + '/api/admin/banner/cfg', { token: TOKA, blink: true, blinkTitle: '📢 新公告' })).status === 200);
  check('公开接口返回闪烁配置', (await GET(B + '/api/banner')).data.cfg.blink === true);
  check('删除横幅', (await POST(B + '/api/admin/banner/remove', { token: TOKA, id: bn1.data.banner.id })).status === 200);
  check('删除后队列减少', (await GET(B + '/api/banner')).data.banners.every(b => b.id !== bn1.data.banner.id));
  check('非管理员发布横幅被拒 403', (await POST(B + '/api/admin/banner/add', { token: TK2, content: 'x', duration: 5 })).status === 403);

  // ---------- 9d. 反馈状态 ----------
  section('9d. 反馈状态');
  const rgFb = await POST(B + '/api/register', { username: 'fb_stater', password: 'pass1234', confirmPassword: 'pass1234', qq: '123456' });
  const fbSubmit = await POST(B + '/api/feedback/submit', { token: rgFb.data.token, text: '状态测试反馈' });
  check('新反馈状态为已提交（submitted）', fbSubmit.data.entry.status === 'submitted');
  const fbAdminList = await GET(B + '/api/admin/feedback?token=' + TOKA);
  const fbItem = fbAdminList.data.feedback.find(f => f.text === '状态测试反馈');
  check('管理员列表含反馈且带状态', !!fbItem && fbItem.status === 'submitted');
  check('未知状态被拒 400', (await POST(B + '/api/admin/feedback/status', { token: TOKA, id: fbItem.id, status: 'nope' })).status === 400);
  check('标记为已受理', (await POST(B + '/api/admin/feedback/status', { token: TOKA, id: fbItem.id, status: 'accepted' })).status === 200);
  check('标记为已完成', (await POST(B + '/api/admin/feedback/status', { token: TOKA, id: fbItem.id, status: 'done' })).status === 200);
  const fbPlayer = await GET(B + '/api/feedback?token=' + rgFb.data.token);
  check('玩家看到状态为已完成', fbPlayer.data.mine.find(f => f.id === fbItem.id).status === 'done');
  check('非管理员改状态被拒 403', (await POST(B + '/api/admin/feedback/status', { token: TK2, id: fbItem.id, status: 'accepted' })).status === 403);

  // ---------- 9e. 反馈规则（CD 时长 / 清空费用） ----------
  section('9e. 反馈规则配置');
  const fbCfg0 = await GET(B + '/api/admin/feedback?token=' + TOKA);
  check('反馈列表返回默认规则（24h / 10000）', fbCfg0.data.cfg && fbCfg0.data.cfg.cdHours === 24 && fbCfg0.data.cfg.skipCost === 10000, JSON.stringify(fbCfg0.data.cfg));
  check('负数 CD 被拒 400', (await POST(B + '/api/admin/feedback/cfg', { token: TOKA, cdHours: -1 })).status === 400);
  check('负数费用被拒 400', (await POST(B + '/api/admin/feedback/cfg', { token: TOKA, skipCost: -5 })).status === 400);
  check('非管理员改规则被拒 403', (await POST(B + '/api/admin/feedback/cfg', { token: TK2, cdHours: 1 })).status === 403);
  check('设置 CD=2h / 费用=500', (await POST(B + '/api/admin/feedback/cfg', { token: TOKA, cdHours: 2, skipCost: 500 })).status === 200);
  // 玩家端状态应反映新规则
  const rgFb2 = await POST(B + '/api/register', { username: 'fb_ruler', password: 'pass1234', confirmPassword: 'pass1234', qq: '123456' });
  const stNew = (await GET(B + '/api/feedback?token=' + rgFb2.data.token)).data.status;
  check('玩家端 status 返回新规则', stNew.skipCost === 500 && stNew.cdHours === 2, JSON.stringify(stNew));
  // 提交后 CD 约 2 小时
  await POST(B + '/api/feedback/submit', { token: rgFb2.data.token, text: '规则测试' });
  const stAfter = (await GET(B + '/api/feedback?token=' + rgFb2.data.token)).data.status;
  check('提交后 CD 约 2 小时', Math.abs(stAfter.remainingMs / 3600000 - 2) < 0.05, String(stAfter.remainingMs / 3600000));
  // 清空 CD 按新费用扣费
  await POST(B + '/api/dev/seed', { token: rgFb2.data.token, coins: 1000 });
  const skipNew = await POST(B + '/api/feedback/skip', { token: rgFb2.data.token });
  check('按新费用（500）清空 CD', skipNew.status === 200 && skipNew.data.coins === 500, JSON.stringify({ s: skipNew.status, coins: skipNew.data.coins }));
  // 恢复默认，避免影响后续用例
  await POST(B + '/api/admin/feedback/cfg', { token: TOKA, cdHours: 24, skipCost: 10000 });

  // ---------- 9f. 抛竿间隔（基础值 / 最短值） ----------
  section('9f. 抛竿间隔配置');
  const wdCast = await GET(B + '/api/admin/world?token=' + TOKA);
  check('world 返回抛竿间隔默认值（3000 / 800）', wdCast.data.castBaseMs === 3000 && wdCast.data.castMinMs === 800, JSON.stringify({ b: wdCast.data.castBaseMs, m: wdCast.data.castMinMs }));
  check('基础间隔过小被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, castBaseMs: 50 })).status === 400);
  check('最短间隔大于基础被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, castBaseMs: 3000, castMinMs: 5000 })).status === 400);
  check('非管理员改间隔被拒 403', (await POST(B + '/api/admin/settings', { token: TK2, castBaseMs: 4000 })).status === 403);
  check('validateOnly 只校验不落库', (await POST(B + '/api/admin/settings', { token: TOKA, castBaseMs: 1234, validateOnly: true })).status === 200
    && (await GET(B + '/api/admin/world?token=' + TOKA)).data.castBaseMs === 3000);
  // 玩家二号在线开钓：基础 3000 → 4000ms 验证实际生效
  await POST(B + '/api/fishing/start', { token: TK2, groundId: 'stillwater', spotId: 'dock' });
  const castSinkMark = sink2.length;
  check('设置基础 4000 / 最短 600 成功', (await POST(B + '/api/admin/settings', { token: TOKA, castBaseMs: 4000, castMinMs: 600 })).status === 200);
  check('配置回读生效（4000 / 600）', (await GET(B + '/api/admin/world?token=' + TOKA)).data.castBaseMs === 4000);
  await sleep(400);
  check('间隔变更广播 castcfg 给游戏端', sink2.slice(castSinkMark).some(x => x.ev.type === 'castcfg' && x.ev.baseMs === 4000 && x.ev.minMs === 600),
    sink2.slice(castSinkMark).map(x => x.ev.type).join(','));
  const reStart = await POST(B + '/api/fishing/start', { token: TK2, groundId: 'stillwater', spotId: 'dock' });
  check('按新基础间隔开钓（4000 × 0.8 钓点增益 = 3200ms）', reStart.data.interval === 3200, JSON.stringify(reStart.data));
  // 最短间隔限制：钓点 +20% 增益 + 组件 +25% = 45%，1000 × (1-0.45) = 550 → 应被 900ms 下限兜住
  const spdInst = 'reel_electric#common#spd+25';
  await POST(B + '/api/dev/catch', { token: TK2, item: { kind: 'component', id: spdInst } });
  await POST(B + '/api/bd/set', { token: TK2, part: 'reel', compId: spdInst });
  await POST(B + '/api/admin/settings', { token: TOKA, castBaseMs: 1000, castMinMs: 900 });
  const reStart2 = await POST(B + '/api/fishing/start', { token: TK2, groundId: 'stillwater', spotId: 'dock' });
  check('最短间隔兜住词缀+增益（1000 × 0.55 = 550 → 900ms）', reStart2.data.interval === 900, JSON.stringify(reStart2.data));
  // 恢复：卸下组件 + 默认间隔
  await POST(B + '/api/bd/set', { token: TK2, part: 'reel', compId: null });
  await POST(B + '/api/fishing/stop', { token: TK2 });
  check('恢复默认间隔', (await POST(B + '/api/admin/settings', { token: TOKA, castBaseMs: 3000, castMinMs: 800 })).status === 200);

  // ---------- 9g. 鱼类体型 roll 模型（默认正态） ----------
  section('9g. 鱼类体型 roll 模型');
  const setSize = m => POST(B + '/api/admin/fish/config', { token: TOKA, sizeModel: m });
  const simSize = b => POST(B + '/api/admin/fish/simulate', Object.assign({ token: TOKA }, b));
  // 分析一组掷骰结果：均值与 25~75 分位跨度（区分三种模型的形状）
  function spread(rolls) {
    const s = rolls.slice().sort((a, b) => a - b);
    const at = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { mean: s.reduce((a, b) => a + b, 0) / s.length, span: at(0.75) - at(0.25) };
  }
  const wdFish = await GET(B + '/api/admin/world?token=' + TOKA);
  check('world 返回体型配置（默认 normal）', wdFish.data.fishCfg && wdFish.data.fishCfg.sizeModel === 'normal', JSON.stringify(wdFish.data.fishCfg));
  check('world 返回体型默认值 normal', wdFish.data.fishDefaults && wdFish.data.fishDefaults.sizeModel === 'normal');
  check('/api/version 下发体型配置（前端可见）', (await GET(B + '/api/version')).data.fishCfg.sizeModel === 'normal');
  check('未知模型被拒 400', (await setSize('bogus')).status === 400);
  check('缺少 sizeModel 被拒 400', (await POST(B + '/api/admin/fish/config', { token: TOKA })).status === 400);
  check('非管理员改体型模型被拒 403', (await POST(B + '/api/admin/fish/config', { token: TK2, sizeModel: 'linear' })).status === 403);
  check('非管理员调用试算被拒 403', (await POST(B + '/api/admin/fish/simulate', { token: TK2 })).status === 403);
  check('保存 linear 成功', (await setSize('linear')).status === 200);
  check('配置回读生效（linear）', (await GET(B + '/api/admin/world?token=' + TOKA)).data.fishCfg.sizeModel === 'linear');
  // 鲫鱼基准 10~35cm（中值 22.5）：三种模型的形状应有明显区别
  const simLin = await simSize({ n: 20000, model: 'linear', fishId: 'crucian' });
  const simNor = await simSize({ n: 20000, model: 'normal', fishId: 'crucian' });
  const simSkw = await simSize({ n: 20000, model: 'skew', fishId: 'crucian' });
  check('试算返回直方图 20 桶', simLin.data.buckets && simLin.data.buckets.length === 20);
  check('试算 linear 均匀（25~75 分位跨度大）', simLin.data.stats.p75 - simLin.data.stats.p25 > 10, JSON.stringify(simLin.data.stats));
  check('试算 normal 集中在中值（跨度小、中位数≈22.5）', (simNor.data.stats.p75 - simNor.data.stats.p25) < 8 && Math.abs(simNor.data.stats.p50 - 22.5) < 1.5, JSON.stringify(simNor.data.stats));
  check('试算 skew 偏向小值（均值明显低于中值）', simSkw.data.stats.mean < 20, JSON.stringify(simSkw.data.stats));
  check('normal 比 linear 更集中（跨度对比）', (simNor.data.stats.p75 - simNor.data.stats.p25) < (simLin.data.stats.p75 - simLin.data.stats.p25));
  check('试算 model 参数可预览未保存的模型', simSkw.data.model === 'skew' && simSkw.data.currentModel === 'linear', JSON.stringify({ m: simSkw.data.model, c: simSkw.data.currentModel }));
  check('未指定 model 时按当前配置（linear）', (await simSize({ n: 1000, fishId: 'crucian' })).data.model === 'linear');
  const simBonus = await simSize({ n: 20000, model: 'normal', fishId: 'crucian', sizeBonus: 50 });
  check('体型加成 50% 抬高体型（中位数≈22.5×1.5）', Math.abs(simBonus.data.stats.p50 - 33.75) < 2.5, JSON.stringify(simBonus.data.stats));
  check('试算未知鱼被拒 400', (await simSize({ fishId: 'shark' })).status === 400);
  check('试算未知模型被拒 400', (await simSize({ model: 'bogus' })).status === 400);
  // 真实上鱼路径：dev/rollsize 调用线上同一个 rollSizeOf
  await setSize('skew');
  const liveSkew = spread((await POST(B + '/api/dev/rollsize', { token: TK2, range: [10, 35], n: 1000 })).data.rolls);
  await setSize('normal');
  const liveNor = spread((await POST(B + '/api/dev/rollsize', { token: TK2, range: [10, 35], n: 1000 })).data.rolls);
  check('线上掷骰走配置模型：skew 均值偏小', liveSkew.mean < 20.5, String(liveSkew.mean));
  check('线上掷骰走配置模型：normal 均值居中', Math.abs(liveNor.mean - 22.5) < 1.2, String(liveNor.mean));
  check('线上掷骰 normal 比 skew 更集中', liveNor.span < liveSkew.span, JSON.stringify({ n: liveNor.span, s: liveSkew.span }));
  check('掷骰结果始终落在基准区间内', (await POST(B + '/api/dev/rollsize', { token: TK2, range: [10, 35], n: 500 })).data.rolls.every(v => v >= 10 && v <= 35));
  check('恢复默认（正态）', (await POST(B + '/api/admin/fish/reset', { token: TOKA })).status === 200
    && (await GET(B + '/api/admin/world?token=' + TOKA)).data.fishCfg.sizeModel === 'normal');
  check('非管理员恢复默认被拒 403', (await POST(B + '/api/admin/fish/reset', { token: TK2 })).status === 403);


  // ---------- 10. 账号管理（改密码 / 改显示名 / 调整金币） ----------
  section('10. 账号管理');
  check('非管理员调用账号管理被拒 403', (await POST(B + '/api/admin/users/update', { token: TK2, target: 'adm_p2', name: 'x' })).status === 403);
  check('不存在的账号被拒 404', (await POST(B + '/api/admin/users/update', { token: TOKA, target: 'nobody_here', name: 'x' })).status === 404);
  check('空修改被拒 400', (await POST(B + '/api/admin/users/update', { token: TOKA, target: 'adm_p2' })).status === 400);
  check('过短密码被拒 400', (await POST(B + '/api/admin/users/update', { token: TOKA, target: 'adm_p2', password: '1' })).status === 400);
  const upName = await POST(B + '/api/admin/users/update', { token: TOKA, target: 'adm_p2', name: '改名后的二号' });
  check('修改显示名成功', upName.status === 200 && upName.data.changed.indexOf('显示名') >= 0);
  const upCoins = await POST(B + '/api/admin/users/update', { token: TOKA, target: 'adm_p2', coins: 8888 });
  check('调整金币成功', upCoins.status === 200 && upCoins.data.coins === 8888);
  check('负金币被拒 400', (await POST(B + '/api/admin/users/update', { token: TOKA, target: 'adm_p2', coins: -5 })).status === 400);
  // 改密码：旧密码失效、新密码可登录、旧会话被顶
  const upPw = await POST(B + '/api/admin/users/update', { token: TOKA, target: 'adm_p2', password: 'newpass99' });
  check('修改密码成功', upPw.status === 200 && upPw.data.changed.indexOf('密码') >= 0);
  check('旧密码登录失败 401', (await POST(B + '/api/login', { username: 'adm_p2', password: 'pass5678' })).status === 401);
  const reLogin = await POST(B + '/api/login', { username: 'adm_p2', password: 'newpass99' });
  check('新密码可登录', reLogin.status === 200 && !!reLogin.data.token);
  check('改密后显示名已持久应用', reLogin.data.profile.name === '改名后的二号');
  check('改密后金币已应用', reLogin.data.profile.coins === 8888);

  // 快照：查看并编辑背包/金币
  const snap = await GET(B + '/api/admin/users/snapshot?token=' + TOKA + '&key=adm_p2');
  check('读取账号快照成功', snap.status === 200 && snap.data.coins === 8888 && typeof snap.data.inventory === 'object');
  check('快照编辑背包与金币', (await POST(B + '/api/admin/users/snapshot', { token: TOKA, target: 'adm_p2', coins: 555, inventory: { crucian: 4 } })).status === 200);
  const snap2 = await GET(B + '/api/admin/users/snapshot?token=' + TOKA + '&key=adm_p2');
  check('快照已更新（金币 555 / 鲫鱼 4）', snap2.data.coins === 555 && snap2.data.inventory.crucian === 4);
  check('快照非法物品被拒 400', (await POST(B + '/api/admin/users/snapshot', { token: TOKA, target: 'adm_p2', inventory: { not_a_real_item: 1 } })).status === 400);
  // 定制配件：管理员按「底材 × 品质 × 任意词条数值」生成组件实例直接入包（后台定制给予）。
  // 实例编码与前端共用 data.js 的 instanceId；服务端按实例规则校验，词缀类型不合法会被拒。
  const DData = require(path.join(ROOT, 'frontend', 'js', 'data.js'));
  const cusId = DData.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: 50 }, { type: 'skill', value: 30 }]);
  check('定制配件实例可编码（base#品质#词条）', /^rod_bamboo#epic#spd\+50,skl\+30$/.test(cusId), cusId);
  const cusGive = await POST(B + '/api/admin/users/snapshot', { token: TOKA, target: 'adm_p2', inventory: { crucian: 4, [cusId]: 2 } });
  check('定制配件可写入玩家背包', cusGive.status === 200, JSON.stringify(cusGive.data).slice(0, 100));
  const cusSnap = await GET(B + '/api/admin/users/snapshot?token=' + TOKA + '&key=adm_p2');
  // v0.12.2：skill 不在竹制短竿池内 → 启动/写入规范化会把范围来源（@bt）补进签名
  const cusIdNorm = DData.normalizeItemId(cusId);
  check('定制配件已入包（数量 2，键为带范围来源的规范化签名）', cusSnap.data.inventory[cusIdNorm] === 2, JSON.stringify(cusSnap.data.inventory));
  const meta = DData.instanceMeta(cusId);
  check('定制配件可被前端解析出名称与词条', !!meta && meta.name.indexOf('竹制短竿') >= 0 && meta.affixes.length === 2,
    JSON.stringify(meta && { name: meta.name, n: meta.affixes.length }));
  check('词缀类型不合法的实例被拒 400', (await POST(B + '/api/admin/users/snapshot', { token: TOKA, target: 'adm_p2', inventory: { 'rod_bamboo#common#hacker+99': 1 } })).status === 400);
  check('无词条实例（第三段为空）也合法', (await POST(B + '/api/admin/users/snapshot', { token: TOKA, target: 'adm_p2', inventory: { crucian: 4, 'hook_barb#common#': 1 } })).status === 200);
  // v0.11.8：定制件刻意**不受底材词缀池与自然区间限制**——6 类词条全上（rod_bamboo 池里只有钓速/体型，
  // 其余 4 类都是池外）、数值远超自然区间也不截断（管理员定制，服务端只按实例编码规则校验）。
  const cusFreeId = DData.instanceId('rod_bamboo', 'mythic', [
    { type: 'speed', value: 999 }, { type: 'skill', value: 120 }, { type: 'rare', value: 120 },
    { type: 'material', value: 120 }, { type: 'size', value: 400 }, { type: 'double', value: 150 },
  ]);
  const cusFreeGive = await POST(B + '/api/admin/users/snapshot', { token: TOKA, target: 'adm_p2', inventory: { crucian: 4, [cusFreeId]: 1 } });
  check('定制件 6 类词条 + 越界数值可写入背包', cusFreeGive.status === 200, JSON.stringify(cusFreeGive.data).slice(0, 120));
  const cusFreeSnap = await GET(B + '/api/admin/users/snapshot?token=' + TOKA + '&key=adm_p2');
  const cusFreeMeta = DData.instanceMeta(cusFreeId);
  check('定制件解析出 6 条词条且数值未被截断', cusFreeMeta.affixes.length === 6 &&
    cusFreeMeta.affixes.some(a => a.type === 'speed' && a.value === 999) &&
    cusFreeMeta.affixes.some(a => a.type === 'size' && a.value === 400),
    JSON.stringify(cusFreeMeta.affixes));
  check('池外词条标 extra（与宝匣突破件同一套标记）', cusFreeMeta.affixes.filter(a => a.extra).length === 4,
    JSON.stringify(cusFreeMeta.affixes.map(a => a.type + (a.extra ? '*' : ''))));
  check('超品质条数上限的定制件按「突破」呈现',
    cusFreeMeta.breakthrough === true && cusFreeMeta.affixes.length > DData.QUALITY.mythic.cap,
    JSON.stringify({ n: cusFreeMeta.affixes.length, cap: DData.QUALITY.mythic.cap, bt: cusFreeMeta.breakthrough }));
  check('定制件已入包且键为规范化实例签名', cusFreeSnap.data.inventory[DData.normalizeItemId(cusFreeId)] === 1, JSON.stringify(Object.keys(cusFreeSnap.data.inventory)));
  check('非管理员读快照被拒 403', (await GET(B + '/api/admin/users/snapshot?token=' + TK2 + '&key=adm_p2')).status === 403);

  // 删除账号（二次确认）
  const rgDel = await POST(B + '/api/register', { username: 'del_me', password: 'pass1234', confirmPassword: 'pass1234', qq: '123456' });
  check('待删除账号注册成功', rgDel.status === 200);
  check('删除需二次确认（缺 confirm 被拒 400）', (await POST(B + '/api/admin/users/delete', { token: TOKA, target: 'del_me' })).status === 400);
  check('不能删除自己', (await POST(B + '/api/admin/users/delete', { token: TOKA, target: 'adm_root', confirm: true })).status === 400);
  check('确认后删除成功', (await POST(B + '/api/admin/users/delete', { token: TOKA, target: 'del_me', confirm: true })).status === 200);
  check('删除后账号无法登录', (await POST(B + '/api/login', { username: 'del_me', password: 'pass1234' })).status === 401);
  check('删除后不在账号列表', !(await GET(B + '/api/admin/users?token=' + TOKA)).data.users.some(u => u.key === 'del_me'));


  // ---------- 11a. 全服钓速（钓速只影响抛竿间隔） ----------
  section('11a. 全服钓速与默认上钩率');
  // 第 10 节改过 adm_p2 密码，旧 token 已失效：重新登录并建立实时连接（后续断言依赖）
  const lp2b = await POST(B + '/api/login', { username: 'adm_p2', password: 'newpass99' });
  const TK2B = lp2b.data.token;
  const sink2b = [];
  const es2b = sse(TK2B, sink2b);
  await sleep(400);
  check('玩家重新登录成功（新会话可用）', lp2b.status === 200 && !!TK2B);
  // 默认公式 = 平值 90：把公式恢复成默认值后，上钩率不随钓速变化（试算 speed 0 / 50 结果一致）
  const fx0 = await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '90' });
  const fxEval0 = await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '90', validateOnly: true, evalVars: { speed: 0 } });
  const fxEval50 = await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '90', validateOnly: true, evalVars: { speed: 50 } });
  check('默认上钩公式为平值 90（钓速不再影响上钩率）', fx0.status === 200 && fxEval0.data.prob === 90 && fxEval50.data.prob === 90,
    JSON.stringify({ a: fxEval0.data.prob, b: fxEval50.data.prob }));
  // 复原第 2 节设的公式 100（第 12 节持久化用例依赖该值）
  await POST(B + '/api/admin/settings', { token: TOKA, biteFormula: '100' });
  const w11 = await GET(B + '/api/admin/world?token=' + TOKA);
  check('world 返回全服钓速加成/上限默认值（0 / 80）', w11.data.castSpeedBonus === 0 && w11.data.castSpeedCap === 80, JSON.stringify({ b: w11.data.castSpeedBonus, c: w11.data.castSpeedCap }));
  check('非管理员改全服钓速被拒 403', (await POST(B + '/api/admin/settings', { token: TK2B, castSpeedBonus: 50 })).status === 403);
  check('全服钓速加成超范围被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, castSpeedBonus: 900 })).status === 400);
  check('钓速上限超范围被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, castSpeedCap: 150 })).status === 400);
  // dock 钓点在本文件第 2 节被加了 +20% 钓速增益；全服 +50% → 有效 70% → 3000 × 0.3 = 900ms
  check('设置全服钓速 +50% 成功', (await POST(B + '/api/admin/settings', { token: TOKA, castSpeedBonus: 50 })).status === 200);
  const spd1 = await POST(B + '/api/fishing/start', { token: TK2B, groundId: 'stillwater', spotId: 'dock' });
  // 钓点钓速为最终乘算：3000 × (1-0.50) × (1-0.20) = 1200ms（旧的加算写法会得 900ms）
  check('全服钓速生效且钓点钓速乘算（3000×0.5×0.8=1200ms）', spd1.data.interval === 1200, JSON.stringify(spd1.data));
  // 上限截断：+200% 但上限 80% → 3000 × 0.2 = 600 → 最短间隔 800 兜底
  check('设置 +200% / 上限 80%', (await POST(B + '/api/admin/settings', { token: TOKA, castSpeedBonus: 200, castSpeedCap: 80 })).status === 200);
  const spd2 = await POST(B + '/api/fishing/start', { token: TK2B, groundId: 'stillwater', spotId: 'dock' });
  check('钓速上限截断 + 最短间隔兜底（800ms）', spd2.data.interval === 800, JSON.stringify(spd2.data));
  await POST(B + '/api/fishing/stop', { token: TK2B });
  check('恢复默认钓速（0 / 80）', (await POST(B + '/api/admin/settings', { token: TOKA, castSpeedBonus: 0, castSpeedCap: 80 })).status === 200);

  // ---------- 11b. 渔场与钓点增删（实时生效） ----------
  section('11b. 渔场与钓点增删 · 限时渔场 · 一键填充');
  check('非法渔场 ID 被拒 400', (await POST(B + '/api/admin/ground/add', { token: TOKA, id: 'Bad-ID!', name: 'x' })).status === 400);
  check('与内置渔场冲撞的 ID 被拒 400', (await POST(B + '/api/admin/ground/add', { token: TOKA, id: 'stillwater', name: 'x' })).status === 400);
  check('空名称被拒 400', (await POST(B + '/api/admin/ground/add', { token: TOKA, id: 'qa_bay', name: '' })).status === 400);
  const gAdd = await POST(B + '/api/admin/ground/add', { token: TOKA, id: 'qa_bay', name: 'QA 湾', type: 'event', desc: '测试渔场', spotName: '浅滩', preset: 'big', fill: true });
  check('新建渔场成功且按「大物塘」预设填充（14 条）', gAdd.status === 200 && gAdd.data.ground.spots.length === 1 && gAdd.data.ground.spots[0].pool.length === 14, JSON.stringify(gAdd.data.ground && gAdd.data.ground.spots[0].pool.length));
  const grPub = await GET(B + '/api/grounds');
  check('新渔场实时进入公开目录（玩家可钓）', (grPub.data.grounds || []).some(g => g.id === 'qa_bay' && g.spots.length === 1));
  check('重复渔场 ID 被拒 409', (await POST(B + '/api/admin/ground/add', { token: TOKA, id: 'qa_bay', name: 'x' })).status === 409);
  // 限时窗口
  check('限时时间格式非法被拒 400', (await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_bay', openFrom: 'not-a-date' })).status === 400);
  check('开始晚于结束被拒 400', (await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_bay', openFrom: Date.now() + 10000, openTo: Date.now() })).status === 400);
  const winPast = await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_bay', openFrom: Date.now() - 7200000, openTo: Date.now() - 3600000 });
  check('限时窗口已过期 → 自动锁定', winPast.status === 200 && winPast.data.ground.locked === true, JSON.stringify(winPast.data.ground && winPast.data.ground.locked));
  const winFuture = await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_bay', openFrom: Date.now() + 3600000, openTo: Date.now() + 7200000 });
  check('未到开窗时间 → 保持锁定', winFuture.data.ground.locked === true);
  const winOpen = await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_bay', openFrom: Date.now() - 1000, openTo: Date.now() + 3600000 });
  check('窗口内 → 自动开放', winOpen.data.ground.locked === false);
  const lockedStart = await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_bay', openFrom: Date.now() - 100000, openTo: Date.now() - 1000 });
  void lockedStart;
  const lockStart2 = await POST(B + '/api/fishing/start', { token: TK2B, groundId: 'qa_bay', spotId: 'main' });
  check('限时关闭期间开钓被拒（尚未开放）', lockStart2.status === 400 && /尚未开放/.test(lockStart2.data.error || ''), JSON.stringify(lockStart2.data));
  check('清除限时窗口（恢复常驻）', (await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_bay', clearWindow: true })).status === 200);
  const openStart = await POST(B + '/api/fishing/start', { token: TK2B, groundId: 'qa_bay', spotId: 'main' });
  check('清除限时后可正常开钓（新渔场新钓点亮了）', openStart.status === 200 && openStart.data.interval > 0, JSON.stringify(openStart.data));
  await POST(B + '/api/fishing/stop', { token: TK2B });
  // 钓点增删
  check('内置渔场新增钓点（一键填充材料工坊 11 条）', (await POST(B + '/api/admin/spot/add', { token: TOKA, groundId: 'stillwater', id: 'qa_spot', name: 'QA 钓点', preset: 'material', fill: true })).status === 200);
  const grPub2 = await GET(B + '/api/grounds');
  const stW = (grPub2.data.grounds || []).find(g => g.id === 'stillwater');
  check('新钓点进入目录且池按预设填充', !!stW && stW.spots.some(s => s.id === 'qa_spot' && s.pool.length === 11));
  check('同名钓点被拒 409', (await POST(B + '/api/admin/spot/add', { token: TOKA, groundId: 'stillwater', id: 'qa_spot', name: 'dup' })).status === 409);
  check('钓点 ID 非法被拒 400', (await POST(B + '/api/admin/spot/add', { token: TOKA, groundId: 'stillwater', id: '9bad', name: 'x' })).status === 400);
  check('删除自定义钓点', (await POST(B + '/api/admin/spot/remove', { token: TOKA, groundId: 'stillwater', spotId: 'qa_spot' })).status === 200);
  const grPub3 = await GET(B + '/api/grounds');
  check('删除后目录中不再有该钓点', !((grPub3.data.grounds || []).find(g => g.id === 'stillwater') || { spots: [] }).spots.some(s => s.id === 'qa_spot'));
  // 内置钓点删除 → 可恢复
  const stSpots = ((grPub3.data.grounds || []).find(g => g.id === 'stillwater') || { spots: [] }).spots;
  const victimSpot = stSpots[stSpots.length - 1].id;
  check('删除内置钓点（标记可恢复）', (await POST(B + '/api/admin/spot/remove', { token: TOKA, groundId: 'stillwater', spotId: victimSpot })).status === 200);
  check('恢复内置钓点', (await POST(B + '/api/admin/ground/restore', { token: TOKA, groundId: 'stillwater', spotId: victimSpot })).status === 200);
  const grPub4 = await GET(B + '/api/grounds');
  check('恢复后钓点回到目录', ((grPub4.data.grounds || []).find(g => g.id === 'stillwater') || { spots: [] }).spots.some(s => s.id === victimSpot));
  check('恢复不存在的钓点被拒 404', (await POST(B + '/api/admin/ground/restore', { token: TOKA, groundId: 'stillwater', spotId: 'nope' })).status === 404);
  // 渔场删除：自定义直接移除、内置可恢复
  check('删除自定义渔场', (await POST(B + '/api/admin/ground/remove', { token: TOKA, groundId: 'qa_bay' })).status === 200);
  check('删除内置渔场（标记可恢复）', (await POST(B + '/api/admin/ground/remove', { token: TOKA, groundId: 'rapids' })).status === 200);
  const grPub5 = await GET(B + '/api/grounds');
  check('删除后两个渔场都不在目录', !(grPub5.data.grounds || []).some(g => g.id === 'qa_bay' || g.id === 'rapids'), String((grPub5.data.grounds || []).length));
  check('恢复内置渔场', (await POST(B + '/api/admin/ground/restore', { token: TOKA, groundId: 'rapids' })).status === 200);
  const grPub6 = await GET(B + '/api/grounds');
  check('恢复后内置渔场回到目录', (grPub6.data.grounds || []).some(g => g.id === 'rapids'));
  // 一键填充预设接口
  const pr = await POST(B + '/api/admin/pool/preset', { token: TOKA, preset: 'rare' });
  check('一键填充预设接口返回条目与说明', pr.status === 200 && pr.data.pool.length === 13 && !!pr.data.presets.rare);
  check('未知预设被拒 400', (await POST(B + '/api/admin/pool/preset', { token: TOKA, preset: 'nope' })).status === 400);
  check('非管理员读取预设被拒 403', (await POST(B + '/api/admin/pool/preset', { token: TK2B, preset: 'rare' })).status === 403);

  // ---------- 11e. 钓点独立上鱼率 / 速率（留空 = 全服默认） ----------
  section('11e. 钓点独立上鱼率 / 速率');
  check('非法上鱼率被拒 400', (await POST(B + '/api/admin/spot/rate', { token: TOKA, groundId: 'stillwater', spotId: 'dock', biteRate: 120 })).status === 400);
  check('非法间隔被拒 400', (await POST(B + '/api/admin/spot/rate', { token: TOKA, groundId: 'stillwater', spotId: 'dock', intervalMs: 10 })).status === 400);
  check('非管理员被拒 403', (await POST(B + '/api/admin/spot/rate', { token: TK2B, groundId: 'stillwater', spotId: 'dock', biteRate: 50 })).status === 403);
  check('不存在的钓点被拒 404', (await POST(B + '/api/admin/spot/rate', { token: TOKA, groundId: 'stillwater', spotId: 'nope', biteRate: 50 })).status === 404);
  const sr1 = await POST(B + '/api/admin/spot/rate', { token: TOKA, groundId: 'stillwater', spotId: 'dock', biteRate: 100, intervalMs: 1500 });
  check('设置钓点独立上鱼率与间隔', sr1.status === 200 && sr1.data.biteRate === 100 && sr1.data.intervalMs === 1500, JSON.stringify(sr1.data));
  const srPub = await GET(B + '/api/grounds');
  const dockNow = (dockFind(srPub.data.grounds) || {}).spots.find(s => s.id === 'dock');
  check('钓点独立配置随目录下发（前端可见）', !!dockNow && dockNow.biteRate === 100 && dockNow.intervalMs === 1500, JSON.stringify(dockNow && { b: dockNow.biteRate, m: dockNow.intervalMs }));
  const srStart = await POST(B + '/api/fishing/start', { token: TK2B, groundId: 'stillwater', spotId: 'dock' });
  check('钓点独立间隔生效（1500ms）', srStart.data.interval === 1500, JSON.stringify(srStart.data));
  check('castInfo 返回钓点独立上鱼率（100%）', !!(srStart.data.castInfo && srStart.data.castInfo.biteRate === 100 && srStart.data.castInfo.biteOverride === true), JSON.stringify(srStart.data.castInfo));
  const srMark = sink2b.length;
  await waitFor(() => sink2b.slice(srMark).filter(x => x.ev.type === 'catch').length >= 2, { timeout: 9000, interval: 150 });
  check('上鱼率 100% 时每竿必上钩（9s 内 ≥2 条）', sink2b.slice(srMark).filter(x => x.ev.type === 'catch').length >= 2,
    String(sink2b.slice(srMark).filter(x => x.ev.type === 'catch').length));
  await POST(B + '/api/fishing/stop', { token: TK2B });
  const srClear = await POST(B + '/api/admin/spot/rate', { token: TOKA, groundId: 'stillwater', spotId: 'dock', biteRate: '', intervalMs: '' });
  check('清除后恢复全服默认（返回 null）', srClear.status === 200 && srClear.data.biteRate == null && srClear.data.intervalMs == null, JSON.stringify(srClear.data));
  // 乘算证明：钓竿 +25% 与钓点 +20% → 3000×0.75×0.8 = 1800（加算会是 1650）
  const multInst = 'reel_electric#common#spd+25';
  await POST(B + '/api/dev/catch', { token: TK2B, item: { kind: 'component', id: multInst } });
  await POST(B + '/api/bd/set', { token: TK2B, part: 'reel', compId: multInst });
  const multStart = await POST(B + '/api/fishing/start', { token: TK2B, groundId: 'stillwater', spotId: 'dock' });
  check('钓点钓速为最终乘算（3000×0.75×0.8=1800，非加算 1650）', multStart.data.interval === 1800, JSON.stringify(multStart.data));
  check('乘算明细随 castInfo 下发（spotMult 0.8）', !!(multStart.data.castInfo && multStart.data.castInfo.spotMult === 0.8 && multStart.data.castInfo.buffSpeed === 20), JSON.stringify(multStart.data.castInfo));
  await POST(B + '/api/bd/set', { token: TK2B, part: 'reel', compId: null });
  await POST(B + '/api/fishing/stop', { token: TK2B });
  const srBack = await POST(B + '/api/fishing/start', { token: TK2B, groundId: 'stillwater', spotId: 'dock' });
  check('清除独立间隔后回到按钓速计算（2400ms）', srBack.data.interval === 2400, JSON.stringify(srBack.data));
  await POST(B + '/api/fishing/stop', { token: TK2B });

  // ---------- 11c. 横幅滚播状态与停止 ----------
  section('11c. 横幅滚播状态与停止');
  const bnAdd = await POST(B + '/api/admin/banner/add', { token: TOKA, content: 'QA 滚播横幅', duration: 30 });
  check('发布横幅成功', bnAdd.status === 200 && !!bnAdd.data.banner.id);
  const bnId = bnAdd.data.banner.id;
  check('未登录上报滚播被拒 401', (await POST(B + '/api/banner/playing', { id: bnId })).status === 401);
  check('玩家上报滚播状态成功', (await POST(B + '/api/banner/playing', { token: TK2B, id: bnId })).status === 200);
  const bnList = await GET(B + '/api/admin/banner?token=' + TOKA);
  const playingRow = (bnList.data.playing || []).find(p => p.id === bnId);
  check('后台可见滚播人数（1 人）与在线数', !!playingRow && playingRow.count === 1 && typeof bnList.data.online === 'number', JSON.stringify(bnList.data.playing));
  check('非管理员停止滚播被拒 403', (await POST(B + '/api/admin/banner/stop', { token: TK2B, id: bnId })).status === 403);
  check('停止滚播成功', (await POST(B + '/api/admin/banner/stop', { token: TOKA, id: bnId })).status === 200);
  await sleep(350);
  check('在线玩家收到 bannerStop 事件', sink2b.some(x => x.ev.type === 'bannerStop' && x.ev.id === bnId), sink2b.slice(-5).map(x => x.ev.type).join(','));
  check('停止后滚播列表不再显示该横幅', !((await GET(B + '/api/admin/banner?token=' + TOKA)).data.playing || []).some(p => p.id === bnId));
  // 公告颜色：每条可自定义 + 默认色可配
  check('非法颜色被拒 400', (await POST(B + '/api/admin/banner/add', { token: TOKA, content: 'x', color: 'not-a-color' })).status === 400);
  const bnColor = await POST(B + '/api/admin/banner/add', { token: TOKA, content: '彩色公告', duration: 10, color: '#EF4444' });
  check('发布带颜色的公告成功（归一化小写）', bnColor.status === 200 && bnColor.data.banner.color === '#ef4444', JSON.stringify(bnColor.data.banner));
  check('公开横幅接口带上颜色', ((await GET(B + '/api/banner')).data.banners || []).some(b => b.color === '#ef4444'));
  const bnUpd = await POST(B + '/api/admin/banner/update', { token: TOKA, id: bnColor.data.banner.id, color: '#22c55e' });
  check('修改公告颜色成功', bnUpd.status === 200 && bnUpd.data.banner.color === '#22c55e', JSON.stringify(bnUpd.data.banner));
  check('非法颜色修改被拒 400', (await POST(B + '/api/admin/banner/update', { token: TOKA, id: bnColor.data.banner.id, color: 'red' })).status === 400);
  check('非管理员修改公告颜色被拒 403', (await POST(B + '/api/admin/banner/update', { token: TK2B, id: bnColor.data.banner.id, color: '#000000' })).status === 403);
  const ncCfg = await POST(B + '/api/admin/banner/cfg', { token: TOKA, blink: false, noticeColor: '#38BDF8' });
  check('公告默认颜色可配置', ncCfg.status === 200 && ncCfg.data.cfg.noticeColor === '#38bdf8', JSON.stringify(ncCfg.data.cfg));
  check('非法默认颜色被拒 400', (await POST(B + '/api/admin/banner/cfg', { token: TOKA, noticeColor: '#zz' })).status === 400);
  check('清空横幅队列', (await POST(B + '/api/admin/banner/clear', { token: TOKA })).status === 200);
  check('清空后队列为空', ((await GET(B + '/api/banner')).data.banners || []).length === 0);

  // ---------- 11d. 反馈奖励 ----------
  section('11d. 反馈奖励');
  // 用全新账号（adm_p2 在第 7 节已提交过反馈，24h CD 会挡住第二次）
  const rgRw = await POST(B + '/api/register', { username: 'qa_reward', password: 'pass1234', confirmPassword: 'pass1234', qq: '123456' });
  const TKR = rgRw.data.token;
  const fbSub11 = await POST(B + '/api/feedback/submit', { token: TKR, text: 'QA 奖励反馈' });
  check('玩家提交反馈（奖励前置）', fbSub11.status === 200 && !!fbSub11.data.entry.id);
  const fbId11 = fbSub11.data.entry.id;
  check('奖励金额非法被拒 400', (await POST(B + '/api/admin/feedback/reward', { token: TOKA, id: fbId11, coins: -5 })).status === 400);
  check('奖励不存在的反馈被拒 404', (await POST(B + '/api/admin/feedback/reward', { token: TOKA, id: 'nope', coins: 10 })).status === 404);
  check('非管理员奖励被拒 403', (await POST(B + '/api/admin/feedback/reward', { token: TKR, id: fbId11, coins: 10 })).status === 403);
  const coinsBeforeFb = (await GET(B + '/api/me?token=' + TKR)).data.coins;
  const rw11 = await POST(B + '/api/admin/feedback/reward', { token: TOKA, id: fbId11, coins: 888, note: 'QA 奖励' });
  check('奖励反馈成功且金币到账', rw11.status === 200 && rw11.data.playerCoins === coinsBeforeFb + 888, JSON.stringify(rw11.data));
  const fbRow11 = ((await GET(B + '/api/admin/feedback?token=' + TOKA)).data.feedback || []).find(f => f.id === fbId11);
  check('反馈记录带奖励信息（金额/备注/操作人）', !!(fbRow11 && fbRow11.reward && fbRow11.reward.coins === 888 && fbRow11.reward.note === 'QA 奖励' && fbRow11.reward.by), JSON.stringify(fbRow11 && fbRow11.reward));
  check('玩家侧反馈列表带奖励信息', !!(await GET(B + '/api/feedback?token=' + TKR)).data.mine.find(f => f.id === fbId11).reward);

  // ---------- 11f. 经济参数（价格模型全程可调） ----------
  section('11f. 经济参数（价格模型全程可调）');
  // 独立账号做抛售测试（背包用后台快照直接设定，确定性好）
  const rgEco = await POST(B + '/api/register', { username: 'qa_econ', password: 'pass1234', confirmPassword: 'pass1234', qq: '123456' });
  const TKE = rgEco.data.token;
  const we0 = await GET(B + '/api/admin/world?token=' + TOKA);
  check('经济参数默认值（地板40 / 天花板200 / 回升60分 / 下压0.0075）',
    we0.data.priceCfg.floorPct === 40 && we0.data.priceCfg.ceilPct === 200 && we0.data.priceCfg.riseTauMin === 60
    && Math.abs(we0.data.priceCfg.saleDivisor - 0.0075) < 1e-9, JSON.stringify(we0.data.priceCfg));
  check('经济参数默认值下发到 world.priceDefaults', we0.data.priceDefaults && we0.data.priceDefaults.floorPct === 40);
  check('产出倍率默认全 100', we0.data.dropCfg.global === 100 && we0.data.dropCfg.material === 100, JSON.stringify(we0.data.dropCfg));
  check('经济目录覆盖全部经济物品（40 鱼 + 7 材料 = 47）', (we0.data.economyCatalog || []).length === 47, String((we0.data.economyCatalog || []).length));
  check('/api/version 下发 priceCfg（前端商店文案用）', (await GET(B + '/api/version')).data.priceCfg.floorPct === 40);
  // 范围校验（越界一律 400）
  check('地板价越界被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { floorPct: 5 } })).status === 400);
  check('天花板越界被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { ceilPct: 50 } })).status === 400);
  check('地板==天花板被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { floorPct: 100, ceilPct: 100 } })).status === 400);
  check('每件下压越界被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { saleDivisor: 0.5 } })).status === 400);
  check('回升时间常数越界被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { riseTauMin: 1 } })).status === 400);
  check('采样间隔越界被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { sampleSec: 2 } })).status === 400);
  check('回升目标越界被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { riseTargetPct: 500 } })).status === 400);
  check('产出倍率越界被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, dropCfg: { global: 9999 } })).status === 400);
  check('非管理员改经济参数 403', (await POST(B + '/api/admin/settings', { token: TKE, priceCfg: { riseTauMin: 15 } })).status === 403);
  check('validateOnly 只校验不落库', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { riseTauMin: 12 }, validateOnly: true })).status === 200
    && (await GET(B + '/api/admin/world?token=' + TOKA)).data.priceCfg.riseTauMin === 60);
  // 保存生效：地板 50% + 回升 15 分钟 → 大额抛售压到 0.5 倍基准价
  const saveEco = await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { floorPct: 50, riseTauMin: 15 } });
  check('保存地板50% / 回升15分钟 200', saveEco.status === 200 && saveEco.data.priceCfg.floorPct === 50 && saveEco.data.priceCfg.riseTauMin === 15, JSON.stringify(saveEco.data.priceCfg));
  check('world 回读生效（50 / 15）', (await GET(B + '/api/admin/world?token=' + TOKA)).data.priceCfg.riseTauMin === 15);
  await POST(B + '/api/admin/users/snapshot', { token: TOKA, target: 'qa_econ', inventory: { crucian: 300 } });
  check('测试账号已备好 300 条鲫鱼', (await GET(B + '/api/me?token=' + TKE)).data.inventory.crucian === 300);
  check('抛售 300 条成功', (await POST(B + '/api/sell', { token: TKE, id: 'crucian', qty: 300 })).status === 200);
  check('地板价生效：鲫鱼 8 × 50% = 4', (await GET(B + '/shop')).data.crucian.price === 4, JSON.stringify((await GET(B + '/shop')).data.crucian));
  // 单品干预：锁价 → 无视供需；覆盖基准价 × 锁价；清除后回落到行情
  check('锁价干预（×3 → 24）', (await POST(B + '/api/admin/settings', { token: TOKA, priceOv: { id: 'crucian', m: 3 } })).status === 200
    && (await GET(B + '/shop')).data.crucian.price === 24, JSON.stringify((await GET(B + '/shop')).data.crucian));
  check('覆盖基准价 + 锁价（20×3 = 60）', (await POST(B + '/api/admin/settings', { token: TOKA, priceOv: { id: 'crucian', base: 20, m: 3 } })).status === 200
    && (await GET(B + '/shop')).data.crucian.price === 60, JSON.stringify((await GET(B + '/shop')).data.crucian));
  check('干预出现在经济目录', !!(await GET(B + '/api/admin/world?token=' + TOKA)).data.economyCatalog.find(i => i.id === 'crucian' && i.ov && i.ov.m === 3));
  check('清除干预（恢复行情地板价 4）', (await POST(B + '/api/admin/settings', { token: TOKA, priceOv: { id: 'crucian', clear: true } })).status === 200
    && (await GET(B + '/shop')).data.crucian.price === 4);
  check('未知物品干预被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceOv: { id: 'no_such_item', m: 2 } })).status === 400);
  // 品质层覆盖：大鱼 每件下压 3% / 回升 30 分
  const tierSave = await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { tiers: { big: { saleDivisor: 0.03, riseTauMin: 30 } } } });
  check('品质层覆盖保存并回传', tierSave.status === 200 && tierSave.data.priceCfg.tiers && tierSave.data.priceCfg.tiers.big.saleDivisor === 0.03,
    JSON.stringify(tierSave.data.priceCfg.tiers));
  check('品质层覆盖无效值被拒 400', (await POST(B + '/api/admin/settings', { token: TOKA, priceCfg: { tiers: { big: { saleDivisor: 0.5 } } } })).status === 400);
  // 产出倍率：大鱼 ×0 → 下发有效权重为 0（用未被其它用例改过池的 rapids:fall 断言）
  check('保存产出倍率（大鱼 0%）200', (await POST(B + '/api/admin/settings', { token: TOKA, dropCfg: { big: 0 } })).status === 200);
  const gEco = await GET(B + '/api/grounds');
  const fallEco = gEco.data.grounds.find(g => g.id === 'rapids').spots.find(s => s.id === 'fall');
  const wFish = id => (fallEco.pool.find(e => e.pick === 'fish:' + id) || {}).weight;
  check('大鱼权重归零（fall 的 bass）', wFish('bass') === 0, JSON.stringify(fallEco.pool));
  check('稀有鱼权重不受影响（fall 的 ghostray = 1）', wFish('ghostray') === 1, String(wFish('ghostray')));
  check('材料权重不受影响（fall 的 lure = 10）', (fallEco.pool.find(e => e.pick === 'material:lure') || {}).weight === 10);
  check('产出倍率改动不污染服务端原始权重', (await GET(B + '/api/admin/world?token=' + TOKA)).data.grounds.find(g => g.id === 'rapids').spots.find(s => s.id === 'fall')
    .pool.find(e => e.pick === 'fish:bass').weight === 8);
  check('审计日志记录了经济改动', ((await GET(B + '/api/admin/world?token=' + TOKA)).data.economyLog || []).some(l => /价格参数|产出倍率|单品干预/.test(l.text)));

  // ---------- 持久化（重启服务器） ----------
  section('12. 配置持久化');
  // 留一个非默认抛竿间隔，验证 config.json 落盘（9f 结束时已恢复默认）
  await POST(B + '/api/admin/settings', { token: TOKA, castBaseMs: 2500, castMinMs: 700 });
  // 留一个自定义渔场 + 限时窗口，验证 groundCfg 落盘并重算锁定状态
  await POST(B + '/api/admin/ground/add', { token: TOKA, id: 'qa_keep', name: 'QA 常驻湾', spotName: '浅滩', preset: 'economy', fill: true });
  await POST(B + '/api/admin/ground/update', { token: TOKA, groundId: 'qa_keep', openFrom: Date.now() - 60000, openTo: Date.now() + 86400000 });
  // 留一个非默认体型模型，验证 fishCfg 落盘
  await setSize('skew');
  // 历史遗留：旧上限时代的 config.json 里可能存着超限增益（如 1000）→ 载入时应收敛到 100
  // （换个不被其它断言覆盖的钓点写，避免影响 stillwater:dock 的既有校验）
  const cfgPath = path.join(TMP_DATA, 'config.json');
  const cfgJson = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfgJson.groundCfg = cfgJson.groundCfg || {};
  cfgJson.groundCfg.spots = cfgJson.groundCfg.spots || {};
  cfgJson.groundCfg.spots['stillwater:deep'] = Object.assign({}, cfgJson.groundCfg.spots['stillwater:deep'],
    { buffs: [{ type: 'speed', value: 1000 }, { type: 'size', value: -400 }] });
  fs.writeFileSync(cfgPath, JSON.stringify(cfgJson));
  killTree(srv);
  srv = start(TMP_DATA);
  check('重启成功', await waitReady());
  const la2 = await POST(B + '/api/admin/login', { username: 'adm_root', password: 'pass1234' });
  check('管理员标志持久化（重启后可登录）', la2.status === 200);
  const TOKA2 = la2.data.token;
  // 会话落盘：重启后旧 token 依然有效 → 客户端带着本地 token 自动登录、SSE 自动重连，
  // 不用让玩家重新输密码（配合前端版本强刷 = 无感热更新）。
  const oldTok = await GET(B + '/api/admin/session?token=' + TOKA);
  check('重启后旧 token 仍有效（自动登录）', oldTok.status === 200, JSON.stringify(oldTok.data));
  const oldMe = await GET(B + '/api/me?token=' + TOKA);
  check('重启后旧 token 可读资料（游戏侧同样免登录）', oldMe.status === 200 && !!oldMe.data.username, JSON.stringify(oldMe.data).slice(0, 80));
  // 落盘只存哈希：文件泄露不等于拿到可用凭据
  const sessRaw = fs.readFileSync(path.join(TMP_DATA, 'sessions.json'), 'utf8');
  check('会话文件不落原始 token（只存 SHA-256）', !!sessRaw && !sessRaw.includes(TOKA) && !sessRaw.includes(TOKA2), 'len=' + sessRaw.length);
  check('会话文件含账号与过期时间', /"k"\s*:\s*"adm_root"/.test(sessRaw) && /"e"\s*:\s*\d{10,}/.test(sessRaw), sessRaw.slice(0, 120));
  // 注意：adm_p2 的密码在「8. 账号管理」中已被改为 newpass99
  check('普通账号仍无权限（adm_p2 已被撤销）', (await POST(B + '/api/admin/login', { username: 'adm_p2', password: 'newpass99' })).status === 403);
  const w2 = await GET(B + '/api/admin/world?token=' + TOKA2);
  const dock2 = w2.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'dock');
  check('掉落池覆盖重启后仍在', dock2.pool.length === 1 && dock2.pool[0].pick === 'fish:crucian');
  check('增益重启后仍在', dock2.buffs && dock2.buffs[0].value === 20);
  check('上钩公式重启后仍在（100）', w2.data.biteFormula === '100');
  check('通知等级重启后仍在（none）', w2.data.notifyLevel === 'none');
  check('钓场锁定重启后仍在（frostmoon 锁定）', w2.data.grounds.find(g => g.id === 'frostmoon').locked === true);
  check('基础双钓率重启后仍在（0.5）', w2.data.doubleBase === 0.5, String(w2.data.doubleBase));
  check('抛竿间隔重启后仍在（2500 / 700）', w2.data.castBaseMs === 2500 && w2.data.castMinMs === 700, JSON.stringify({ b: w2.data.castBaseMs, m: w2.data.castMinMs }));
  check('鱼类体型模型重启后仍在（skew）', w2.data.fishCfg && w2.data.fishCfg.sizeModel === 'skew', JSON.stringify(w2.data.fishCfg));
  check('经济参数重启后仍在（地板50 / 回升15分）', w2.data.priceCfg.floorPct === 50 && w2.data.priceCfg.riseTauMin === 15, JSON.stringify(w2.data.priceCfg));
  check('品质层覆盖重启后仍在（大鱼 3% / 30 分）', !!(w2.data.priceCfg.tiers && w2.data.priceCfg.tiers.big && w2.data.priceCfg.tiers.big.saleDivisor === 0.03));
  check('产出倍率重启后仍在（大鱼 0%）', w2.data.dropCfg.big === 0, JSON.stringify(w2.data.dropCfg));
  check('产出倍率重启后仍下发有效权重（fall 大鱼为 0）', (await GET(B + '/api/grounds')).data.grounds.find(g => g.id === 'rapids').spots.find(s => s.id === 'fall')
    .pool.find(e => e.pick === 'fish:bass').weight === 0);
  const deepLegacy = w2.data.grounds.find(g => g.id === 'stillwater').spots.find(s => s.id === 'deep');
  check('旧配置里超限的增益值被收敛到上限 100', deepLegacy.buffs.length === 2 && deepLegacy.buffs[0].value === 100 && deepLegacy.buffs[1].value === -100,
    JSON.stringify(deepLegacy.buffs));
  const keepG = (w2.data.grounds || []).find(g => g.id === 'qa_keep');
  check('自定义渔场与限时窗口重启后仍在（窗口内开放）', !!keepG && !!keepG.openTo && keepG.locked === false, JSON.stringify(keepG && { locked: keepG.locked, openTo: keepG.openTo }));
  check('自定义渔场的钓点与掉落池重启后仍在', !!keepG && keepG.spots.length === 1 && keepG.spots[0].pool.length === 13, keepG ? String(keepG.spots[0].pool.length) : 'none');

  es1.destroy(); es2.destroy(); es2b.destroy(); // 关闭 SSE 套接字，否则进程不会退出
  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：\n  - ' + failed.join('\n  - ')); process.exitCode = 1; }
})().catch(e => { console.error('测试执行异常：', e); process.exitCode = 1; }).finally(() => {
  try { killTree(srv); } catch (e) {}
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  // 显式退出：SSE 套接字 / 子进程句柄可能让事件循环继续存活，
  // 会让 run-all 一直等不到进程退出（表现为「套件卡住、无汇总」）
  setTimeout(function () { process.exit(process.exitCode || 0); }, 200);
});
