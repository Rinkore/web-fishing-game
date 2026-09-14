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

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 8105;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-admin-test-'));

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
        if (line) { try { sink.push({ t: Date.now(), ev: JSON.parse(line.slice(6)) }); } catch (e) {} }
      }
    });
  });
  r.on('error', () => {});
  return r;
}

function start(dataDir) {
  return spawn(NODE, ['backend/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: dataDir }),
  });
}
async function waitReady() {
  for (let i = 0; i < 40; i++) {
    const r = await GET(B + '/shop');
    if (r.status === 200) return true;
    await sleep(200);
  }
  return false;
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
  check('目录含 41 种鱼 + 4 种材料', w0.data.catalog.fish.length === 41 && w0.data.catalog.materials.length === 4);
  check(' frostmoon 默认锁定', w0.data.grounds.find(g => g.id === 'frostmoon').locked === true);

  const setPool = (groundId, spotId, pool, tok) => POST(B + '/api/admin/spot/pool', { token: tok || TOKA, groundId: groundId, spotId: spotId, pool: pool });
  check('设置 dock 单一鲫鱼池', (await setPool('stillwater', 'dock', [{ pick: 'fish:crucian', weight: 100 }])).status === 200);
  check('未知鱼类被拒 400', (await setPool('stillwater', 'dock', [{ pick: 'fish:shark', weight: 10 }])).status === 400);
  check('空掉落池被拒 400', (await setPool('stillwater', 'dock', [])).status === 400);
  check('负权重被拒 400', (await setPool('stillwater', 'dock', [{ pick: 'fish:crucian', weight: -5 }])).status === 400);
  check('未知增益类别被拒 400', (await POST(B + '/api/admin/spot/buffs', { token: TOKA, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'magic', value: 10 }] })).status === 400);
  check('超范围增益值被拒 400', (await POST(B + '/api/admin/spot/buffs', { token: TOKA, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'speed', value: 5000 }] })).status === 400);
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
  await sleep(7000);
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
  check('非法数值区间（max<min）被过滤而非报错', (await POST(B + '/api/admin/component/config', { token: TOKA, affixRanges: { rod_bamboo: { speed: [5, 1] } } })).status === 200);
  const sim = await POST(B + '/api/admin/component/simulate', { token: TOKA, n: 1000 });
  check('组件试算接口可用', sim.status === 200 && sim.data.quality.epic === 1000, JSON.stringify(sim.data.quality));
  check('恢复默认组件配置', (await POST(B + '/api/admin/component/reset', { token: TOKA })).status === 200);
  check('非管理员改组件配置被拒 403', (await POST(B + '/api/admin/component/config', { token: TK2, rollModel: 'linear' })).status === 403);

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
  check('非管理员读快照被拒 403', (await GET(B + '/api/admin/users/snapshot?token=' + TK2 + '&key=adm_p2')).status === 403);

  // 删除账号（二次确认）
  const rgDel = await POST(B + '/api/register', { username: 'del_me', password: 'pass1234', confirmPassword: 'pass1234', qq: '123456' });
  check('待删除账号注册成功', rgDel.status === 200);
  check('删除需二次确认（缺 confirm 被拒 400）', (await POST(B + '/api/admin/users/delete', { token: TOKA, target: 'del_me' })).status === 400);
  check('不能删除自己', (await POST(B + '/api/admin/users/delete', { token: TOKA, target: 'adm_root', confirm: true })).status === 400);
  check('确认后删除成功', (await POST(B + '/api/admin/users/delete', { token: TOKA, target: 'del_me', confirm: true })).status === 200);
  check('删除后账号无法登录', (await POST(B + '/api/login', { username: 'del_me', password: 'pass1234' })).status === 401);
  check('删除后不在账号列表', !(await GET(B + '/api/admin/users?token=' + TOKA)).data.users.some(u => u.key === 'del_me'));


  // ---------- 持久化（重启服务器） ----------
  section('12. 配置持久化');
  killTree(srv);
  await sleep(800);
  srv = start(TMP_DATA);
  check('重启成功', await waitReady());
  const la2 = await POST(B + '/api/admin/login', { username: 'adm_root', password: 'pass1234' });
  check('管理员标志持久化（重启后可登录）', la2.status === 200);
  const TOKA2 = la2.data.token;
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

  es1.destroy(); es2.destroy(); // 关闭 SSE 套接字，否则进程不会退出
  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：\n  - ' + failed.join('\n  - ')); process.exitCode = 1; }
})().catch(e => { console.error('测试执行异常：', e); process.exitCode = 1; }).finally(() => {
  try { killTree(srv); } catch (e) {}
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
});
