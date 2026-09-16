/*
 * v0.13.8 自动售出重做（打包阈值 / 逐物品规则 / 最少保留量）端到端测试（纯 HTTP，可独立运行）
 * 覆盖：打包阈值默认值与 /api/version 下发 / 后台可调（校验 + 改动后对在线玩家就地补跑）/
 *       攒够一包才成交（省收发包的核心）/ 一次打包结算多物品 / 逐物品启用与就地开关（不动阈值）/
 *       最少保留数量（只卖超出部分）/ 材料参与（不看价格、留够用的）/
 *       旧存档 {all, fish} → {items} 迁移（重启后落盘）/ 出入参与校验
 * 运行： node tests/v0138.test.js
 * 说明：使用 FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 *       本套件故意不设 AUTOSELL_BATCH（用后台可调路径覆盖阈值），另见 e2e 的 AUTOSELL_BATCH=1 段。
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
const PORT = 8199;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0138-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));
const FISH_IDS = D.allItems().filter(function (it) { return it.kind === 'fish'; }).map(function (it) { return it.id; });

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

// 最小 SSE 监听（抓横幅播报：globalRecord 一类全服广播）
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
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

let TOK = null;
const authed = (pathName, body) => Object.assign({ token: TOK }, body || {});
const me = async () => (await GET(B + '/api/me?token=' + TOK)).data || {};
const inv = async () => (await me()).inventory || {};
const have = async (id) => (await inv())[id] || 0; // 数量为 0 时条目会被删掉，统一按 0 处理
const asGet = async () => (await GET(B + '/api/autosell?token=' + TOK)).data || {};
const asPost = (body) => POST(B + '/api/autosell', authed('/api/autosell', body));
// 开发接口注入物品（与线上同一上鱼链路：入包后同样触发自动售出判定）
function grant(id, n) {
  const kind = D.itemOf(id).kind;
  const list = [];
  for (let i = 0; i < (n || 1); i++) list.push(POST(B + '/api/dev/catch', authed('/api/dev/catch', { item: { id: id, kind: kind, rarity: 'common' } })));
  return Promise.all(list);
}

async function main() {
  srv = startServer();
  const ready = await waitHttp(B + '/api/version', { timeout: 20000 });
  if (!ready) { console.log('服务器启动失败'); process.exit(1); }

  const reg = await POST(B + '/api/register', { username: 'as_player', password: 'as123456', name: '自动售出测试', qq: '38001' });
  check('注册账号', reg.status === 200 && !!(reg.data && reg.data.token), JSON.stringify(reg.data));
  TOK = reg.data && reg.data.token;

  // ---------------- 打包阈值：默认值 ----------------
  section('打包阈值：默认 100，没攒够一包不成交');
  const ver = await GET(B + '/api/version');
  check('公开配置下发打包阈值（默认 100）',
    !!(ver.data && ver.data.autoSellCfg) && ver.data.autoSellCfg.batch === 100,
    JSON.stringify(ver.data && ver.data.autoSellCfg));
  await grant('crucian', 3);
  const asSet = await asPost({ id: 'crucian', minPrice: 1 });
  check('单物品规则保存成功（价格线必达标）',
    asSet.status === 200 && !!(asSet.data.items && asSet.data.items.crucian && asSet.data.items.crucian.on),
    JSON.stringify(asSet.data.items));
  check('3 条 < 阈值 100 → 一条都不卖', await have('crucian') === 3, JSON.stringify(await inv()));
  await grant('crucian', 30);
  check('攒到 33 条仍不成交（继续攒包）', await have('crucian') === 33, JSON.stringify(await inv()));
  const asg = await asGet();
  check('GET 同时返回逐物品规则与全服阈值', !!(asg.items && asg.items.crucian) && asg.batch === 100,
    JSON.stringify({ batch: asg.batch, keys: Object.keys(asg.items || {}) }));

  // ---------------- 后台可调 ----------------
  section('后台改打包阈值：校验 + 立即生效 + 对在线玩家就地补跑');
  const admReg = await POST(B + '/api/register', { username: 'as_admin', password: 'as123456', name: '后台测试', qq: '38002' });
  check('注册管理员候选账号', admReg.status === 200, JSON.stringify(admReg.data));
  const adm = await POST(B + '/api/admin/login', { username: 'as_admin', password: 'as123456' });
  check('服务器无管理员时首个登录账号被引导为管理员', adm.status === 200 && adm.data.admin === true, JSON.stringify(adm.data));
  const ADA = adm.data && adm.data.token;
  const bad0 = await POST(B + '/api/admin/settings', { token: ADA, autoSellCfg: { batch: 0 } });
  check('阈值 0 被拒 400', bad0.status === 400, JSON.stringify(bad0.data));
  const badMax = await POST(B + '/api/admin/settings', { token: ADA, autoSellCfg: { batch: 10001 } });
  check('阈值 10001 被拒 400', badMax.status === 400, JSON.stringify(badMax.data));
  const coins0 = (await me()).coins;
  const okSet = await POST(B + '/api/admin/settings', { token: ADA, autoSellCfg: { batch: 3 } });
  check('阈值保存成功并回显', okSet.status === 200 && okSet.data.autoSellCfg.batch === 3, JSON.stringify(okSet.data.autoSellCfg));
  check('调小阈值后在线玩家就地补跑（33 条一次性成包售出）', await have('crucian') === 0, JSON.stringify(await inv()));
  check('售出金额入账', (await me()).coins > coins0, String((await me()).coins) + ' vs ' + coins0);
  const ver2 = await GET(B + '/api/version');
  check('/api/version 同步新阈值', ver2.data.autoSellCfg.batch === 3, JSON.stringify(ver2.data.autoSellCfg));

  // ---------------- 攒够一包才成交 ----------------
  section('攒够一包才成交');
  await grant('crucian', 2);
  check('2 条 < 3 → 不成交', await have('crucian') === 2, JSON.stringify(await inv()));
  await grant('crucian', 1);
  check('第 3 条到位 → 整包成交（一次卖 3 条）', await have('crucian') === 0, JSON.stringify(await inv()));

  // ---------------- 保留数量 ----------------
  section('最少保留数量：只卖超出的部分');
  const kSet = await asPost({ id: 'crucian', minPrice: 1, keep: 2 });
  check('保留数量随规则保存', kSet.status === 200 && kSet.data.items.crucian.keep === 2, JSON.stringify(kSet.data.items.crucian));
  await grant('crucian', 4);
  check('持有 4、保留 2 → 可卖 2 条，不足一包不成交', await have('crucian') === 4, JSON.stringify(await inv()));
  await grant('crucian', 1);
  check('持有 5 → 可卖 3 条成包，全部卖出后剩 2 条（保留量原封不动）',
    await have('crucian') === 2, JSON.stringify(await inv()));

  // ---------------- 材料参与 ----------------
  section('材料参与：留够用的，多余的全卖（不看价格）');
  const mSet = await asPost({ id: 'bait_pack', minPct: '', minPrice: '', keep: 2 });
  check('材料规则可保存（价格线留空 = 不看价格）',
    mSet.status === 200 && mSet.data.items.bait_pack && mSet.data.items.bait_pack.minPct == null && mSet.data.items.bait_pack.keep === 2,
    JSON.stringify(mSet.data.items.bait_pack));
  await grant('bait_pack', 4);
  check('诱饵包 4 个、保留 2 → 可卖 2 个不足一包，不成交', await have('bait_pack') === 4, JSON.stringify(await inv()));
  await grant('bait_pack', 1);
  check('第 5 个到位 → 可卖 3 个成包，只卖超出的 3 个（留 2）', await have('bait_pack') === 2, JSON.stringify(await inv()));

  // ---------------- 一次结算多物品 ----------------
  section('一次打包结算多物品（省收发包）');
  await asPost({ bulk: 'all', remove: true });
  await grant('carp', 3);
  await grant('minnow', 3);
  const multi = await asPost({ bulk: 'fish', minPrice: 1 });
  check('批量应用到全部鱼', multi.status === 200, JSON.stringify(multi.data && multi.data.error));
  // v0.13.9：打包阈值改为对「已启用物品合计」判定 —— 上一节剩下的 2 条鲫鱼（保留量被批量应用重置为 0）
  // 也会计入合计一起成交，所以这里是 3 项而不是 2 项（逐件口径下它 2 < 3 会被跳过）。
  check('一次响应结算多物品（carp + minnow；含上一节剩余的鲫鱼，同一次扫描）',
    !!(multi.data.sold && multi.data.sold.length >= 2) &&
    multi.data.sold.some(x => x.id === 'carp') && multi.data.sold.some(x => x.id === 'minnow'),
    JSON.stringify(multi.data.sold));
  const invAfter = await inv();
  check('两项都整包清空', !invAfter.carp && !invAfter.minnow, JSON.stringify(invAfter));

  // ---------------- 就地开关 ----------------
  section('就地开关：停用不卖、启用即恢复，阈值保留');
  const off = await asPost({ id: 'minnow', on: false });
  check('只传 on 即就地停用，阈值不受影响',
    off.status === 200 && off.data.items.minnow.on === false && off.data.items.minnow.minPrice === 1,
    JSON.stringify(off.data.items.minnow));
  await grant('minnow', 3);
  check('停用后新钓的留在背包', await have('minnow') === 3, JSON.stringify(await inv()));
  const on = await asPost({ id: 'minnow', on: true });
  check('重新启用后立即成包售出', on.status === 200 && await have('minnow') === 0, JSON.stringify(await inv()));

  // ---------------- 校验 ----------------
  section('出入参与校验');
  check('未知物品被拒 400', (await asPost({ id: 'not_a_thing', minPct: 1 })).status === 400);
  check('组件不可自动售出 400', (await asPost({ id: 'comp_generic', minPct: 1 })).status === 400);
  check('宝匣不可自动售出 400', (await asPost({ id: 'chest_wreck', minPct: 1 })).status === 400);
  check('未知批量范围被拒 400', (await asPost({ bulk: 'chest', minPct: 1 })).status === 400);
  check('缺少物品 id 被拒 400', (await asPost({ minPct: 1 })).status === 400);
  check('负保留数量被拒 400', (await asPost({ id: 'carp', keep: -1 })).status === 400);
  check('负浮动被拒 400', (await asPost({ id: 'carp', minPrice: 10, slackPrice: -1 })).status === 400);
  check('超范围阈值被拒 400', (await asPost({ id: 'carp', minPct: 1000001 })).status === 400);
  check('未登录访问 GET 被拒 401', (await GET(B + '/api/autosell')).status === 401);

  // ---------------- 每日前十滚动播报 ----------------
  section('每日前十滚动播报：填满当日前十后才开始播报');
  const ann = [];
  const watcher = await POST(B + '/api/register', { username: 'v138_watch', password: 'as123456', name: '旁观者', qq: '38110' });
  const watchTok = watcher.data && watcher.data.token;
  const sse = sseListen(watchTok, ann);
  await new Promise(r => setTimeout(r, 800));
  check('旁观者 SSE 连接就绪（收到 init）', ann.some(m => m.type === 'init'),
    'ann=' + ann.length + ' tok=' + String(watchTok).slice(0, 8) + ' types=' + JSON.stringify(ann.map(m => m.type).slice(0, 5)));
  // 10 个账号各钓一条鲫鱼把「当日榜」填满（尺寸递减，最后一条刚好挤满前十）
  for (let i = 0; i < 10; i++) {
    const rr = await POST(B + '/api/register', { username: 'v138_fill' + i, password: 'as123456', name: '填榜' + i, qq: '3812' + i });
    await POST(B + '/api/dev/catch', { token: rr.data.token, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 200 - i } });
  }
  await new Promise(r => setTimeout(r, 1600));   // 广播有 1 秒批量窗口，等它 flush
  const bigBanner = ann.filter(m => m.type === 'globalRecord');
  check('横幅通道可用（纪录刷新照常播报）',
    bigBanner.some(m => /纪录刷新|全场最大纪录被破/.test((m.record || {}).text || '')), JSON.stringify(bigBanner.slice(0, 2).map(m => (m.record || {}).text)));
  check('当日榜没满之前不播「今日前十大」',
    !bigBanner.some(m => /今日前十大|今日前十小/.test((m.record || {}).text || '')),
    JSON.stringify(bigBanner.map(m => (m.record || {}).text)));
  // 第 11 条：尺寸挤进第 2 名 → 当日前十「已满 → 被改动」才播报
  const newcomer = await POST(B + '/api/register', { username: 'v138_new', password: 'as123456', name: '新面孔', qq: '38130' });
  check('第 11 位玩家注册成功', !!(newcomer.data && newcomer.data.token), JSON.stringify(newcomer.data));
  await POST(B + '/api/dev/catch', { token: newcomer.data.token, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 199.5 } });
  await new Promise(r => setTimeout(r, 1600));
  const daily = ann.filter(m => m.type === 'globalRecord' && /今日前十大/.test((m.record || {}).text || ''));
  check('挤进当日榜前十即播报（文案带「今日」与名次）',
    daily.length === 1 && /第 2 名/.test(daily[0].record.text), JSON.stringify(daily.map(m => m.record.text)));
  const dayTop = await GET(B + '/api/records/top?id=crucian&range=day');
  check('当日榜恰好 10 条（每人一条最好成绩）', (dayTop.data.top || []).length === 10, String((dayTop.data.top || []).length));
  check('新纪录排在当日榜第 2（榜首仍是 200cm）',
    (dayTop.data.top || [])[0].size === 200 && (dayTop.data.top || [])[1].size === 199.5,
    JSON.stringify((dayTop.data.top || []).slice(0, 3)));
  const allTop = await GET(B + '/api/records/top?id=crucian&range=all');
  check('总榜与日榜口径分开（总榜仍是历史前十）', (allTop.data.top || []).length === 10 && allTop.data.range === 'all', String((allTop.data.top || []).length));
  try { sse.destroy(); } catch (e) {}

  // ---------------- 旧存档迁移 ----------------
  section('旧存档迁移（{all, fish} → {items}，重启后落盘）');
  await flushWait();
  killTree(srv);
  await new Promise(r => setTimeout(r, 600));
  // 旧结构：单鱼规则（crucian 价格线）优先，「全部鱼」通配（minPct 150）需要展开到其余鱼种
  const legacy = {
    username: 'as_legacy', name: '老玩家', coins: 500,
    inventory: { crucian: 4 }, codex: {},
    autoSell: { all: { minPct: 150, minPrice: null, slackPct: 5, slackPrice: 0 }, fish: { crucian: { minPrice: 100 } } },
  };
  fs.writeFileSync(path.join(TMP_DATA, 'accounts', 'as_legacy.json'), JSON.stringify(legacy, null, 2));
  // 顺手塞一份「含非渔获残留」的纪录文件：龙宫宝珠 v0.11 起是材料，旧档里它还留着渔获纪录
  fs.writeFileSync(path.join(TMP_DATA, 'records.json'), JSON.stringify({
    bigRecords: { carp: { id: 'carp', name: '鲤鱼', size: 63.3, who: '甲', t: 1 }, dragonpearl: { id: 'dragonpearl', name: '龙宫宝珠', size: 28.5, who: '乙', t: 2 } },
    smallRecords: { carp: { id: 'carp', name: '鲤鱼', size: 12.1, who: '甲', t: 3 }, dragonpearl: { id: 'dragonpearl', name: '龙宫宝珠', size: 6, who: '丙', t: 4 } },
    topCatches: { carp: [{ size: 63.3, who: '甲', t: 1 }], dragonpearl: [{ size: 28.5, who: '乙', t: 2 }] },
    topSmall: { dragonpearl: [{ size: 6, who: '丙', t: 4 }] },
    globalMax: { id: 'dragonpearl', name: '龙宫宝珠', size: 28.5, who: '乙', t: 2 },
    rank: { day: {}, week: {} },
  }, null, 2));
  srv = startServer();
  const ready2 = await waitHttp(B + '/api/version', { timeout: 20000 });
  check('服务器重启就绪', ready2);
  await flushWait(); // 迁移在载入时完成，落盘是 1s 防抖
  const migPath = path.join(TMP_DATA, 'accounts', 'as_legacy.json');
  let mig = null;
  try { mig = JSON.parse(fs.readFileSync(migPath, 'utf8')); } catch (e) {}
  const items = (mig && mig.autoSell && mig.autoSell.items) || null;
  check('旧存档已升级为逐物品结构', !!items && !mig.autoSell.all && !mig.autoSell.fish, JSON.stringify(mig && mig.autoSell));
  check('旧「全部鱼」通配规则展开到各鱼种（阈值原样继承、保留量 0）',
    !!items && items.carp && items.carp.minPct === 150 && items.carp.on === true && items.carp.keep === 0,
    JSON.stringify(items && items.carp));
  check('旧的单鱼规则优先于通配（crucian 用价格线 100）',
    !!items && items.crucian && items.crucian.minPrice === 100 && items.crucian.minPct === null,
    JSON.stringify(items && items.crucian));
  check('展开条数 = 鱼种总数', !!items && Object.keys(items).length === FISH_IDS.length,
    String(items && Object.keys(items).length) + ' vs ' + FISH_IDS.length);
  check('材料不被旧规则波及（旧规则的适用范围只有渔获）', !!items && !items.bait_pack);
  // 落盘内容就是服务端内存态（saveAccount 写的就是 rec），磁盘断言即服务端断言
  const ver3 = await GET(B + '/api/version');
  check('重启后服务正常（阈值配置仍随公开接口下发）', !!(ver3.data && ver3.data.autoSellCfg) && ver3.data.autoSellCfg.batch === 3,
    JSON.stringify(ver3.data && ver3.data.autoSellCfg));

  // ---------------- 渔获纪录：清除已非鱼类分类的残留 ----------------
  section('渔获记录：非渔获物品的残留纪录被清掉（载入时报废）');
  let recFile = null;
  try { recFile = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'records.json'), 'utf8')); } catch (e) {}
  check('记录文件可读', !!recFile);
  check('龙宫宝珠（材料）的最大/最小纪录已删除',
    !(recFile.bigRecords || {}).dragonpearl && !(recFile.smallRecords || {}).dragonpearl,
    JSON.stringify({ big: Object.keys((recFile && recFile.bigRecords) || {}), small: Object.keys((recFile && recFile.smallRecords) || {}) }));
  check('龙的榜单条目也一并清除', !(recFile.topCatches || {}).dragonpearl && !(recFile.topSmall || {}).dragonpearl,
    JSON.stringify({ top: Object.keys((recFile && recFile.topCatches) || {}), topS: Object.keys((recFile && recFile.topSmall) || {}) }));
  check('全场最大改判给仍在榜的渔获（鲤鱼）',
    !!recFile.globalMax && recFile.globalMax.id === 'carp', JSON.stringify(recFile && recFile.globalMax));
  check('真正的渔获纪录原封不动（鲤鱼保留）',
    !!(recFile.bigRecords || {}).carp && recFile.bigRecords.carp.size === 63.3, JSON.stringify((recFile.bigRecords || {}).carp));
  const recApi = await GET(B + '/api/records');
  check('公开接口同样只返回渔获纪录',
    !recApi.data.records.dragonpearl && !!recApi.data.records.carp, JSON.stringify(Object.keys(recApi.data.records)));
  const pearlTop = await GET(B + '/api/records/top?id=dragonpearl');
  check('材料没有排行榜（未知鱼类 404）', pearlTop.status === 404, String(pearlTop.status));
}

main().then(function () {
  if (srv) killTree(srv);
  console.log('\n============================');
  console.log('v0.13.8 自动售出小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败项：\n  - ' + failed.join('\n  - '));
  console.log('============================');
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.log('测试异常：' + (e && e.stack || e));
  if (srv) killTree(srv);
  process.exit(1);
});
