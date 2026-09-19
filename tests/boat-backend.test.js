/*
 * 船只 / 钓手目录与服务端权威加成回归（纯 HTTP + SSE）
 * 覆盖：共享目录（5 船含价格与水域 / 3 钓手含被动与解锁）、默认外观与存量迁移、
 *       船只购买（扣金币 / 重复购买 / 未拥有切船）、钓手付费解锁与天赋增益、
 *       适配钓点加成、自定义钓点不加成、钓鱼中换船即时重算，以及 noDouble 阻止追加渔获递归。
 * 运行：node tests/boat-backend.test.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { waitFor, waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8298;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-boat-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function killTree(p) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' });
    else p.kill('SIGTERM');
  } catch (e) {}
}
function killPortOccupant(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      '(Get-NetTCPConnection -State Listen -LocalPort ' + port + ' -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }'],
    { stdio: 'ignore' });
  } catch (e) {}
}
function req(method, p, body) {
  return new Promise(function (resolve) {
    const target = new URL(p, 'http://localhost');
    let token = target.searchParams.get('token') || '';
    if (token) target.searchParams.delete('token');
    let payload = body;
    if (body && body.token) {
      token = body.token;
      payload = Object.assign({}, body); delete payload.token;
    }
    const data = payload ? JSON.stringify(payload) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const requestPath = target.pathname + (target.searchParams.toString() ? '?' + target.searchParams.toString() : '');
    const r = http.request({ hostname: 'localhost', port: PORT, path: requestPath, method: method, headers: headers }, function (rs) {
      let raw = '';
      rs.on('data', function (c) { raw += c; });
      rs.on('end', function () {
        let parsed = null; try { parsed = JSON.parse(raw); } catch (e) {}
        resolve({ status: rs.statusCode, data: parsed, text: raw });
      });
    });
    r.on('error', function () { resolve({ status: 0, data: null }); });
    if (data) r.write(data);
    r.end();
  });
}
const GET = function (p) { return req('GET', p); };
const POST = function (p, body) { return req('POST', p, body); };
function sse(token, sink) {
  const r = http.get({ hostname: 'localhost', port: PORT, path: '/events', headers: { Authorization: 'Bearer ' + token } }, function (rs) {
    let buf = '';
    rs.on('data', function (c) {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(function (x) { return x.indexOf('data: ') === 0; });
        if (!line) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg && msg.type === 'batch' && Array.isArray(msg.list)) msg.list.forEach(function (x) { sink.push(x); });
          else sink.push(msg);
        } catch (e) {}
      }
    });
  });
  r.on('error', function () {});
  return r;
}

let server = null, streamA = null, streamB = null, streamL = null;
async function main() {
  section('共享船只 / 钓手 / 同伴目录');
  check('五艘船只均由 GameData 导出',
    Array.isArray(D.BOATS) && D.BOATS.map(function (b) { return b.id; }).join(',') === 'marsh_skiff,leaky_bucket,tide_cutter,snow_wolf,coast_rambler',
    JSON.stringify(D.BOATS.map(function (b) { return b.id; })));
  const marsh = D.boatOf('marsh_skiff'), tide = D.boatOf('tide_cutter');
  check('苇影平底舟目录值正确', !!marsh && marsh.name === '苇影平底舟' && marsh.price === 0 && marsh.water === '湖泊' &&
    marsh.fitSpots.join(',') === 'stillwater:dock,stillwater:reed,rapids:shoal,rapids:eddy,sunset:beach' &&
    JSON.stringify(marsh.buffs) === JSON.stringify([{ type: 'speed', value: 4 }, { type: 'material', value: 6 }]));
  check('潮脊稳舷艇目录值正确', !!tide && tide.name === '潮脊稳舷艇' && tide.price === 1000 && tide.water === '河流' &&
    tide.fitSpots.join(',') === 'stillwater:deep,rapids:fall,sunset:pier,sunset:reef' &&
    JSON.stringify(tide.buffs) === JSON.stringify([{ type: 'skill', value: 3 }, { type: 'size', value: 4 }]));
  check('新船价格梯度与水域类型', D.boatOf('leaky_bucket').price === 200 && D.boatOf('snow_wolf').price === 2000 &&
    D.boatOf('coast_rambler').price === 5000 && D.boatOf('coast_rambler').water === '海洋' &&
    JSON.stringify(D.boatOf('snow_wolf').buffs) === JSON.stringify([{ type: 'rare', value: 3 }, { type: 'speed', value: 2 }]));
  check('boatOf / boatFits 严格按目录 ID 匹配', D.boatOf('not-real') === null && D.boatOf('__proto__') === null &&
    D.boatFits('marsh_skiff', 'stillwater', 'dock') && !D.boatFits('marsh_skiff', 'stillwater', 'deep'));
  check('同伴目录 18 只 / 9 品种', D.COMPANIONS.length === 18 && D.companionBreeds().length === 9 &&
    D.companionOf('retriever_black').breed === 'retriever' && D.companionOf('saintbernard') !== null);
  check('钓手目录：澜速 / 墨巧免费，砾 3000 币解锁', D.freeAnglerIds().join() === 'lan,mo' &&
    D.anglerOf('lan').passive.type === 'speed' && D.anglerOf('mo').passive.type === 'skill' &&
    D.anglerOf('li').unlock.type === 'coins' && D.anglerOf('li').unlock.cost === 3000 &&
    D.anglerOf('lan').stats['耐心'] === 3 && D.anglerOf('mo').stats['耐心'] === 5);

  // 100% 基础双钓率用于确定性验证 noDouble；一次有效抛竿必须恰好结算 3 条。
  fs.writeFileSync(path.join(TMP_DATA, 'config.json'), JSON.stringify({
    doubleBase: 1,
    castCfg: { baseMs: 1000, minMs: 100, speedBonus: 0, speedCap: 80 },
    groundCfg: { spots: {}, grounds: {}, spotPos: {}, customSpots: { stillwater: [{
      id: 'boat_custom', name: '自定义测试点', pool: [{ pick: 'fish:crucian', weight: 1 }], buffs: [],
    }] } },
  }, null, 2));
  const accountsDir = path.join(TMP_DATA, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });
  const legacyPassword = 'Boatlegacy1234';
  const legacySalt = 'boat-legacy-salt';
  fs.writeFileSync(path.join(accountsDir, 'legacy_boat.json'), JSON.stringify({
    username: 'legacy_boat', name: '旧船手', qq: '55100', salt: legacySalt,
    pwHash: crypto.createHash('sha256').update(legacySalt + ':' + legacyPassword).digest('hex'),
    coins: 100000, inventory: {}, bd: {}, codex: {}, catchCount: 0,
  }, null, 2));
  killPortOccupant(PORT);
  server = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  check('服务器就绪', await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 }));

  const legacy = await POST('/api/login', { username: 'legacy_boat', password: legacyPassword });
  const tokL = legacy.data && legacy.data.token;
  const legacyApp = legacy.data && legacy.data.profile && legacy.data.profile.appearance;
  check('存量账号自动迁移：默认船 + 拥有两艘旧免费船 + 两名免费钓手', legacy.status === 200 &&
    legacyApp && legacyApp.boatId === 'marsh_skiff' && legacyApp.anglerId === 'lan' &&
    legacyApp.boats.join(',') === 'marsh_skiff,tide_cutter' && legacyApp.anglers.join(',') === 'lan,mo',
    JSON.stringify(legacyApp));

  const rA = await POST('/api/register', { username: 'boat_a', password: 'Boatpass1234', name: '船测甲', qq: '55101' });
  const rB = await POST('/api/register', { username: 'boat_b', password: 'Boatpass1234', name: '船测乙', qq: '55102' });
  const tokA = rA.data && rA.data.token, tokB = rB.data && rB.data.token;
  check('注册 profile 下发默认外观（仅拥有免费船与免费钓手）', rA.status === 200 && rB.status === 200 &&
    rA.data.profile.appearance.boatId === 'marsh_skiff' && rA.data.profile.appearance.anglerId === 'lan' &&
    rA.data.profile.appearance.boats.join() === 'marsh_skiff' && rA.data.profile.appearance.anglers.join() === 'lan,mo',
    JSON.stringify(rA.data && rA.data.profile && rA.data.profile.appearance));

  const sinkA = [], sinkB = [], sinkL = [];
  streamA = sse(tokA, sinkA); streamB = sse(tokB, sinkB); streamL = sse(tokL, sinkL);
  await waitFor(function () {
    return sinkA.some(function (m) { return m.type === 'init'; }) && sinkB.some(function (m) { return m.type === 'init'; }) &&
      sinkL.some(function (m) { return m.type === 'init'; });
  }, { timeout: 5000, interval: 40 });
  const initA = sinkA.find(function (m) { return m.type === 'init'; });
  check('SSE init 也下发外观', !!initA && initA.appearance && initA.appearance.boatId === 'marsh_skiff' &&
    Array.isArray(initA.appearance.boats) && Array.isArray(initA.appearance.anglers), JSON.stringify(initA && initA.appearance));

  section('白名单与所有权校验');
  const noAuth = await POST('/api/appearance/boat', { boatId: 'tide_cutter' });
  const badId = await POST('/api/appearance/boat', { token: tokA, boatId: 'copied_boat' });
  const badShape = await POST('/api/appearance/boat', { token: tokA, boatId: { id: 'tide_cutter' } });
  const notOwned = await POST('/api/appearance/boat', { token: tokA, boatId: 'tide_cutter' });
  check('换船接口需登录', noAuth.status === 401, String(noAuth.status));
  check('非目录 ID / 伪造对象均被拒绝', badId.status === 400 && badShape.status === 400,
    JSON.stringify({ id: badId.data, shape: badShape.data }));
  check('未拥有的船不能直接选用', notOwned.status === 400 && /尚未拥有/.test(notOwned.data && notOwned.data.error || ''),
    JSON.stringify(notOwned.data));
  check('拒绝后外观未被改写', (await GET('/api/me?token=' + tokA)).data.appearance.boatId === 'marsh_skiff');
  const badBuy = await POST('/api/appearance/boat/buy', { token: tokA, boatId: 'copied_boat' });
  const freeBuy = await POST('/api/appearance/boat/buy', { token: tokA, boatId: 'marsh_skiff' });
  check('购买接口拒绝未知船与已拥有船', badBuy.status === 400 && freeBuy.status === 400,
    JSON.stringify({ bad: badBuy.data, free: freeBuy.data }));

  section('购买流程（金币原子扣款）');
  const poorBuy = await POST('/api/appearance/boat/buy', { token: tokA, boatId: 'tide_cutter' });
  check('金币不足买潮脊舟被拒（500 < 1000）', poorBuy.status === 400 && /金币不足/.test(poorBuy.data && poorBuy.data.error || ''),
    JSON.stringify(poorBuy.data));
  const buyLeaky = await POST('/api/appearance/boat/buy', { token: tokA, boatId: 'leaky_bucket' });
  check('购入补漏旧木船成功并扣 200 金币', buyLeaky.status === 200 && buyLeaky.data.cost === 200 && buyLeaky.data.coins === 300 &&
    buyLeaky.data.appearance.boats.indexOf('leaky_bucket') >= 0, JSON.stringify(buyLeaky.data));
  const rebuy = await POST('/api/appearance/boat/buy', { token: tokA, boatId: 'leaky_bucket' });
  check('重复购买同一艘船被拒', rebuy.status === 400, JSON.stringify(rebuy.data));
  // 账号落盘有 1s 防抖（saveAccount），轮询等待写入完成。
  const leakyPersisted = await waitFor(function () {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'accounts', 'boat_a.json'), 'utf8'));
      return rec.appearance && rec.appearance.boats.indexOf('leaky_bucket') >= 0 && rec.coins === 300;
    } catch (e) { return false; }
  }, { timeout: 4000, interval: 100 });
  check('购买已持久化到账号档', leakyPersisted);
  const useLeaky = await POST('/api/appearance/boat', { token: tokA, boatId: 'leaky_bucket' });
  check('购入后即可选用', useLeaky.status === 200 && useLeaky.data.appearance.boatId === 'leaky_bucket', JSON.stringify(useLeaky.data));
  await POST('/api/appearance/boat', { token: tokA, boatId: 'marsh_skiff' });

  section('适配钓点加成（含钓手天赋乘算）');
  const dockA = await POST('/api/fishing/start', { token: tokA, groundId: 'stillwater', spotId: 'dock' });
  const dockB = await POST('/api/fishing/start', { token: tokB, groundId: 'stillwater', spotId: 'dock' });
  const ciDock = dockA.data && dockA.data.castInfo;
  // 1000 × 船 0.96 × 澜天赋 0.98 = 940.8 → 941
  check('苇影舟在码头命中适配且间隔 1000→941ms（含澜天赋）', dockA.status === 200 && dockA.data.interval === 941 &&
    ciDock.boatMatched === true && ciDock.boatSpeed === 4 && ciDock.boatMaterial === 6 && ciDock.boatMult === 0.96,
    JSON.stringify(dockA.data));
  check('castInfo 带钓手明细（澜 speed+2，anglerMult 0.98）', ciDock.anglerId === 'lan' && ciDock.anglerName === '澜' &&
    ciDock.anglerSpeed === 2 && ciDock.anglerMult === 0.98 &&
    JSON.stringify(ciDock.anglerBuffs) === JSON.stringify([{ type: 'speed', value: 2 }]), JSON.stringify(ciDock));
  check('原有钓竿 / 钓点明细语义不被船速污染', ciDock.affixSpeed === 0 && ciDock.buffSpeed === 0 && ciDock.spotMult === 1,
    JSON.stringify(ciDock));

  // 存量账号拥有潮脊舟：钓鱼中换船即时重算（澜天赋仍乘算：1000 × 0.98 = 980）
  const dockL = await POST('/api/fishing/start', { token: tokL, groundId: 'stillwater', spotId: 'dock' });
  check('旧船手开钓（默认苇影舟同样 941ms）', dockL.status === 200 && dockL.data.interval === 941, JSON.stringify(dockL.data));
  const switched = await POST('/api/appearance/boat', { token: tokL, boatId: 'tide_cutter' });
  check('钓鱼中换船立即重算本人 castInfo', switched.status === 200 && switched.data.appearance.boatId === 'tide_cutter' &&
    switched.data.castInfo && switched.data.castInfo.boatMatched === false && switched.data.castInfo.interval === 980,
    JSON.stringify(switched.data));
  const dockBAgain = await POST('/api/fishing/start', { token: tokB, groundId: 'stillwater', spotId: 'dock' });
  check('换船不影响他人：乙仍是默认船与 941ms', dockB.data.interval === 941 && dockBAgain.data.interval === 941 &&
    (await GET('/api/me?token=' + tokB)).data.appearance.boatId === 'marsh_skiff');
  await POST('/api/fishing/stop', { token: tokA });
  await POST('/api/fishing/stop', { token: tokB });

  const custom = await POST('/api/fishing/start', { token: tokL, groundId: 'stillwater', spotId: 'boat_custom' });
  check('自定义钓点不享受任何船只加成', custom.status === 200 && custom.data.castInfo.boatId === 'tide_cutter' &&
    custom.data.castInfo.boatMatched === false && custom.data.castInfo.boatBuffs.length === 0 &&
    custom.data.castInfo.boatSkill === 0 && custom.data.castInfo.boatSize === 0 && custom.data.castInfo.interval === 980,
    JSON.stringify(custom.data));
  await POST('/api/fishing/stop', { token: tokL });

  section('钓手付费解锁与天赋');
  const pickMo = await POST('/api/appearance/angler', { token: tokA, anglerId: 'mo' });
  check('免费钓手直接切换成功', pickMo.status === 200 && pickMo.data.cost === 0 &&
    pickMo.data.appearance.anglerId === 'mo', JSON.stringify(pickMo.data));
  const poorLi = await POST('/api/appearance/angler', { token: tokA, anglerId: 'li' });
  check('金币不足解锁「砾」被拒（300 < 3000）', poorLi.status === 400 && /金币不足/.test(poorLi.data && poorLi.data.error || ''),
    JSON.stringify(poorLi.data));
  check('解锁失败后钓手选择未变', (await GET('/api/me?token=' + tokA)).data.appearance.anglerId === 'mo');
  const badAngler = await POST('/api/appearance/angler', { token: tokA, anglerId: 'not_real' });
  check('未知钓手被拒', badAngler.status === 400, JSON.stringify(badAngler.data));
  // 墨的 skill+2 天赋进入上钩公式（90+2=92），且不改变抛竿间隔（980→960 仅船 0.96）
  const dockMo = await POST('/api/fishing/start', { token: tokA, groundId: 'stillwater', spotId: 'dock' });
  check('墨天赋：上钩率 92 且间隔仅吃船速（960ms）', dockMo.status === 200 && dockMo.data.castInfo.biteRate === 92 &&
    dockMo.data.interval === 960 && dockMo.data.castInfo.anglerId === 'mo' && dockMo.data.castInfo.anglerSpeed === 0,
    JSON.stringify(dockMo.data && { bite: dockMo.data.castInfo.biteRate, interval: dockMo.data.interval }));
  await POST('/api/fishing/stop', { token: tokA });

  const buyLi = await POST('/api/appearance/angler', { token: tokL, anglerId: 'li' });
  check('旧船手付费解锁「砾」（-3000 金币）', buyLi.status === 200 && buyLi.data.cost === 3000 && buyLi.data.coins === 97000 &&
    buyLi.data.appearance.anglerId === 'li' && buyLi.data.appearance.anglers.indexOf('li') >= 0, JSON.stringify(buyLi.data));
  const reLi = await POST('/api/appearance/angler', { token: tokL, anglerId: 'li' });
  check('已拥有钓手再次选择不再扣费', reLi.status === 200 && reLi.data.cost === 0 && reLi.data.coins === 97000, JSON.stringify(reLi.data));

  section('深水船效果与 noDouble 递归回归');
  const pier = await POST('/api/fishing/start', { token: tokL, groundId: 'sunset', spotId: 'pier' });
  const ciPier = pier.data && pier.data.castInfo;
  check('潮脊舟在防波堤提供技巧 +3 / 体型 +4', pier.status === 200 && ciPier.boatMatched === true &&
    ciPier.boatSkill === 3 && ciPier.boatSize === 4 && ciPier.boatSpeed === 0 && ciPier.boatMult === 1,
    JSON.stringify(ciPier));
  check('砾天赋 material+3 出现在明细中', ciPier.anglerId === 'li' &&
    JSON.stringify(ciPier.anglerBuffs) === JSON.stringify([{ type: 'material', value: 3 }]), JSON.stringify(ciPier.anglerBuffs));
  check('船只技巧已进入服务端上钩公式（90→93）', ciPier.biteRate === 93, JSON.stringify(ciPier));

  const before = (await GET('/api/me?token=' + tokL)).data.catchCount;
  const mark = sinkL.length;
  const gotTriple = await waitFor(function () {
    return sinkL.slice(mark).filter(function (m) { return m && m.type === 'catch'; }).length >= 3;
  }, { timeout: 8000, interval: 25 });
  await POST('/api/fishing/stop', { token: tokL });
  const after = (await GET('/api/me?token=' + tokL)).data.catchCount;
  check('100% 双钓的一次上钩仍恰好只有 3 条（追加渔获不再递归）', gotTriple && after - before === 3,
    JSON.stringify({ before: before, after: after, delta: after - before,
      catches: sinkL.slice(mark).filter(function (m) { return m && m.type === 'catch'; }).length }));
  check('双钓回归后服务进程仍健康', (await GET('/api/me?token=' + tokL)).status === 200);
  check('选船与钓手解锁已持久化到账号档', (function () {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'accounts', 'legacy_boat.json'), 'utf8'));
      return rec.appearance && rec.appearance.boatId === 'tide_cutter' && rec.appearance.anglerId === 'li' &&
        rec.appearance.anglers.indexOf('li') >= 0 && rec.coins === 97000;
    } catch (e) { return false; }
  })());
}

main().catch(function (e) {
  fail++; failed.push('未捕获异常'); console.error('TEST ERROR', e && e.stack || e);
}).finally(function () {
  try { if (streamA) streamA.destroy(); } catch (e) {}
  try { if (streamB) streamB.destroy(); } catch (e) {}
  try { if (streamL) streamL.destroy(); } catch (e) {}
  if (server) killTree(server);
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败：' + failed.join('、'));
  process.exitCode = fail ? 1 : 0;
});
