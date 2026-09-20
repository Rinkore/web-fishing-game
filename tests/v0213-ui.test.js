/*
 * v0.21.3 浏览器回归 —— 远洋页/编队面板不随上鱼重建 · 好友请求红点 · 婉拒按钮风格 ·
 *                       临时海域钓点不重叠 · 背包全量对账 · 后台分图钓点
 * 覆盖：
 *   · 远洋页：广播（assets/catch/players）只就地改文字，页面与按钮节点不被替换；
 *     纯数据变化（合成海图）就地更新；结构变化（出航多一片海域）才重建
 *   · 编队面板：上鱼广播不重建；成员变动才重建
 *   · 编队邀请的「婉拒」按钮与「离开编队/解散编队」同款（btn mini）
 *   · 好友请求红点：社交入口显示待处理数（推送 2.5 秒内），处理掉即消失
 *   · 临时海域：两片海域的钓点名牌在地图上互不重叠
 *   · 背包：本地被改脏（虚空物品）后 resyncAssets() 拉回服务器真实值
 *   · 后台「🎣 钓点管理」：近岸图 / 远洋图页签底图与节点各归各图
 * 注意：管理员用独立账号 —— 管理员登录会重置同账号的普通会话，拿玩家号当管理员会把已登录的页面踢下线。
 * 运行：node tests/v0213-ui.test.js（需要 FISHING_DEV=1，套件自行设置；CHROME_PATH 可选）
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { waitHttp, waitFor, sleep } = require('./_util');
const registration = require('./_registration');
const { provisionAdmin } = require('./_admin');
const D = require('../frontend/js/data');
const ROOT = path.resolve(__dirname, '..'), PORT = 8299, BASE = 'http://127.0.0.1:' + PORT;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-v0213-ui-'));

function detectBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cands = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return '';
}

let server, browser, count = 0;
function check(name, ok, extra) { assert.ok(ok, name + (extra ? '  -> ' + extra : '')); count++; console.log('PASS ' + name); }

(async () => {
  server = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FISHING_DATA_DIR: DIR, FISHING_DEV: '1' } });
  server.stdout.resume(); server.stderr.resume();
  await waitHttp(BASE + '/api/version', { timeout: 20000 });
  browser = await chromium.launch({ executablePath: detectBrowser(), headless: true });
  const opts = { viewport: { width: 1400, height: 1000 }, extraHTTPHeaders: { 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' } };
  const ctxA = await browser.newContext(opts), ctxB = await browser.newContext(opts), ctxD = await browser.newContext(opts), ctxAdmin = await browser.newContext(opts);
  const errors = [];
  async function post(context, url, data) {
    const r = await context.request.post(BASE + url, { data });
    return { status: r.status(), body: await r.json() };
  }
  async function registerOnly(context, username, name) {
    const data = { username, name, password: 'v0213ui-test-1', qq: '829900' };
    let r = await post(context, '/api/register', data);
    if (r.body && r.body.code === 'REGISTRATION_CHALLENGE') {
      const ch = await (await context.request.get(BASE + '/api/register/challenge')).json();
      r = await post(context, '/api/register', { ...data, proof: registration.solve(ch) });
    }
    assert.ok(r.body.profile, '注册失败：' + JSON.stringify(r.body));
    await post(context, '/api/login', { username, password: 'v0213ui-test-1' });
    return r.body.profile;
  }
  async function register(context, username, name) {
    await registerOnly(context, username, name);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(username + ': ' + e.message));
    await page.goto(BASE);
    await page.waitForFunction(() => Engine.state.me && document.querySelector('#auth').style.display === 'none');
    return page;
  }
  const uniq = String(Date.now() % 10000);
  const A = 'v213uia' + uniq, B = 'v213uib' + uniq, Dn = 'v213uid' + uniq, ADM = 'v213uiadm' + uniq;
  const pageA = await register(ctxA, A, '甲钓手' + uniq);
  const pageB = await register(ctxB, B, '乙钓手' + uniq);
  const pageD = await register(ctxD, Dn, '丁钓手' + uniq);
  await registerOnly(ctxAdmin, ADM, '界面管理员' + uniq);
  const friends = async (ctxSelf, other) => { await post(ctxSelf, '/api/friends', { target: other, action: 'request' }); };
  async function befriend(ctx1, u1, ctx2, u2) {
    await post(ctx1, '/api/friends', { target: u2, action: 'request' });
    await post(ctx2, '/api/friends', { target: u1, action: 'accept' });
  }
  await befriend(ctxA, A, ctxB, B);

  // ---- 1. 远洋页：广播只就地更新，不重建 ----
  // 种 2 张海图：本套件后面还要再出航一次（临时海域重叠用例），
  // 而 /api/dev/seed 的 sea 是**整体替换**，再种一次会把已有的海域清掉。
  await post(ctxA, '/api/dev/seed', { sea: { charts: 2 }, inventory: { chartfrag: 6 } });
  await pageA.evaluate(() => { UI.setView('sea'); UI.renderView(); });
  await pageA.locator('.sea-panel').waitFor({ timeout: 15000 });
  await pageA.locator('[data-sea="chart-craft"]').waitFor();
  await pageA.evaluate(() => {
    window.__seaPanel = document.querySelector('.sea-panel');
    window.__seaBtn = document.querySelector('[data-sea="chart-craft"]');
    window.__seaZoneCount = document.querySelector('[data-sea="zone-count"]');
  });
  for (const sc of ['assets', 'catch', 'players', 'feed', 'grounds']) {
    await pageA.evaluate(s => UI.refreshAll(s), sc);
  }
  await sleep(300);
  const sameNode = await pageA.evaluate(() => document.querySelector('.sea-panel') === window.__seaPanel);
  check('远洋页：上鱼/资产等广播不重建页面骨架（节点是同一个）', sameNode === true);
  const sameBtn = await pageA.evaluate(() => document.querySelector('[data-sea="chart-craft"]') === window.__seaBtn);
  check('远洋页：按钮节点在广播后原地保留（不再闪烁）', sameBtn === true);
  // 纯数据变化：合成海图 → 文字就地更新，页面不重建
  const chartsBefore = await pageA.evaluate(() => Number((document.querySelector('[data-sea="chart-hint"]').innerText.match(/未知海图\s*(\d+)/) || [])[1]));
  await pageA.click('[data-sea="chart-craft"]');
  const fragUpdated = await waitFor(async () => {
    const t = await pageA.locator('[data-sea="chart-hint"]').innerText();
    const n = Number((t.match(/未知海图\s*(\d+)/) || [])[1]);
    return n === chartsBefore + 1;
  }, { timeout: 8000, interval: 150 });
  check('远洋页：合成海图后「未知海图」文字就地更新（' + chartsBefore + ' → ' + (chartsBefore + 1) + '）', fragUpdated === true, await pageA.locator('[data-sea="chart-hint"]').innerText());
  const stillSame = await pageA.evaluate(() => document.querySelector('.sea-panel') === window.__seaPanel);
  check('远洋页：纯数据变化同样不重建骨架', stillSame === true);
  // 结构变化：出航 → 多一片临时海域 → 应当重建（并带上结构签名）
  await pageA.click('[data-sea="voyage"]');
  const zoneShown = await waitFor(async () => /我的临时海域（1\/3）/.test(await pageA.locator('[data-sea="zone-count"]').innerText()), { timeout: 10000, interval: 200 });
  check('远洋页：出航后海域面板出现（结构变化正常重建）', zoneShown === true, await pageA.locator('[data-sea="zone-count"]').innerText());
  const rebuilt = await pageA.evaluate(() => document.querySelector('.sea-panel') !== window.__seaPanel);
  check('远洋页：结构变化才替换骨架节点', rebuilt === true);

  // ---- 2. 编队面板：上鱼广播不重建 ----
  await post(ctxA, '/api/party', { action: 'create' });
  const pInv = await post(ctxA, '/api/party', { target: B, action: 'invite' });
  check('邀请 B 入队（界面用例前置）', pInv.status === 200, JSON.stringify(pInv.body));
  await pageB.evaluate(() => { UI.setView('ground'); UI.renderView(); });
  await pageB.getByRole('button', { name: '⚓ 编队', exact: true }).click();
  await pageB.locator('.party-panel').waitFor({ timeout: 15000 });
  // 邀请块里的「婉拒」按钮与「离开编队/解散编队」同款
  const declineCls = await pageB.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.party-panel button')).find(x => x.textContent.trim() === '婉拒');
    return b ? b.className : '';
  });
  check('编队邀请的「婉拒」按钮与队内按钮同款（btn mini）', /(^|\s)btn(\s|$)/.test(declineCls) && /(^|\s)mini(\s|$)/.test(declineCls), JSON.stringify(declineCls));
  await pageB.getByRole('button', { name: '接受邀请', exact: true }).click();
  await pageB.locator('[data-p="count"]').waitFor({ timeout: 15000 });
  await pageB.evaluate(() => {
    window.__partyPanel = document.querySelector('.party-panel');
    window.__partyBtn = Array.from(document.querySelectorAll('.party-panel button')).find(x => x.textContent.indexOf('邀请好友') >= 0);
  });
  for (const sc of ['players', 'feed', 'catch', 'assets', 'grounds']) {
    await pageB.evaluate(s => UI.refreshAll(s), sc);
  }
  await sleep(400);
  const partySame = await pageB.evaluate(() => document.querySelector('.party-panel') === window.__partyPanel);
  const partyBtnSame = await pageB.evaluate(() => Array.from(document.querySelectorAll('.party-panel button')).indexOf(window.__partyBtn) >= 0);
  check('编队面板：上鱼广播不重建骨架', partySame === true);
  check('编队面板：按钮节点在广播后原地保留（不再闪烁）', partyBtnSame === true);
  // 结构变化：队长踢人 → 面板重建、成员数变化
  await post(ctxA, '/api/party', { target: B, action: 'kick' });
  const backToEmpty = await waitFor(async () => /还没有加入编队/.test(await pageB.locator('.party-panel').innerText()), { timeout: 10000, interval: 200 });
  check('编队面板：被踢后界面回到「还没有加入编队」（结构变化重建）', backToEmpty === true, (await pageB.locator('.party-panel').innerText()).slice(0, 80));

  // ---- 3. 好友请求红点（社交入口） ----
  const dotText = () => pageD.evaluate(() => {
    const item = Array.from(document.querySelectorAll('.nav-item')).find(x => /社交/.test(x.textContent));
    if (!item) return null;
    const b = item.querySelector('.nav-badge');
    return b ? { text: b.textContent, cls: b.className } : null;
  });
  check('初始没有好友请求 → 社交入口没有红点', (await dotText()) === null, JSON.stringify(await dotText()));
  await friends(ctxB, Dn);                       // B 向 D 发申请
  const dotOn = await waitFor(async () => { const d = await dotText(); return !!d && d.text === '1'; }, { timeout: 4000, interval: 150 });
  check('收到好友请求 → 社交入口出现红点（推送 2.5 秒内）', dotOn === true, JSON.stringify(await dotText()));
  const dotCls = await dotText();
  check('红点用 alert 样式（与交易提醒同款）', !!dotCls && /alert/.test(dotCls.cls), JSON.stringify(dotCls));
  await pageD.evaluate(() => { UI.setView('ground'); UI.renderView(); });
  await pageD.getByRole('button', { name: '👥 好友', exact: true }).click();
  await pageD.locator('.friends-panel').waitFor({ timeout: 15000 });
  await pageD.getByRole('button', { name: '✓ 同意', exact: true }).first().click();
  const dotOff = await waitFor(async () => (await dotText()) === null, { timeout: 5000, interval: 150 });
  check('同意请求后红点消失', dotOff === true, JSON.stringify(await dotText()));

  // ---- 4. 临时海域钓点在地图上不重叠 ----
  const voy2 = await post(ctxA, '/api/sea/voyage', {});   // 第二片（第一片在步骤 1 出航得到）
  check('A 出航第二片海域', voy2.status === 200, JSON.stringify(voy2.body));
  await pageA.evaluate(() => { UI.setView('fishing'); UI.renderView(); });
  await pageA.locator('.px-map-tab', { hasText: '远洋' }).click();
  const readSeaNodes = () => pageA.$$eval('.px-node[data-g^="sea:"] .pn-name', els => els.map(e => {
    const r = e.getBoundingClientRect();
    return { t: e.textContent, x: r.left, y: r.top, w: r.width, h: r.height };
  }));
  const zonesNow = await pageA.evaluate(() => ({ grounds: window.GameData.GROUNDS.filter(g => g.zone).map(g => ({ id: g.id, n: (g.spots||[]).length })), nodes: document.querySelectorAll('.px-node[data-g^="sea:"]').length }));
  const ready = await waitFor(async () => (await readSeaNodes()).length >= 4, { timeout: 15000, interval: 300 });
  const seaNodes = await readSeaNodes();
  check('远洋图上出现两片海域的钓点（≥4 个节点）', ready === true && seaNodes.length >= 4, JSON.stringify(seaNodes.map(n => n.t)));
  const names = seaNodes.map(n => n.t);
  let clash = null;
  for (let i = 0; i < seaNodes.length && !clash; i++) {
    for (let j = i + 1; j < seaNodes.length; j++) {
      const a = seaNodes[i], b = seaNodes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { clash = [a.t, b.t]; break; }
    }
  }
  check('两片临时海域的钓点名牌互不重叠（' + seaNodes.length + ' 个节点）', !clash, JSON.stringify(clash || []) + ' ' + JSON.stringify(names));

  // ---- 4.5 解散编队 → 留在队友海域里的成员收到弹窗提醒 ----
  await post(ctxA, '/api/party', { action: 'disband' });   // 上一段用例留下的单人群
  await post(ctxA, '/api/party', { action: 'create' });
  await post(ctxA, '/api/party', { target: B, action: 'invite' });
  await post(ctxB, '/api/party', { action: 'accept' });
  await post(ctxA, '/api/dev/seed', { sea: { charts: 1 } });
  const vz = await post(ctxA, '/api/sea/voyage', {});
  check('A 出航（弹窗用例前置）', vz.status === 200 && !!vz.body.zone, JSON.stringify(vz.body));
  const stB = await post(ctxB, '/api/fishing/start', { groundId: vz.body.zone.groundId, spotId: vz.body.zone.spots[0].id });
  check('B 在 A 的海域下竿（弹窗用例前置）', stB.status === 200, JSON.stringify(stB.body));
  // 队友海域在地图上要能点到（v0.21.3：节点由 /api/sea 的 partyZones 注入，队伍散了会自己消失）
  const sharedSel = '.px-node[data-g="' + vz.body.zone.groundId + '"]';
  await pageB.evaluate(() => { UI.setView('fishing'); UI.renderView(); });
  await pageB.locator('.px-map-tab', { hasText: '远洋' }).click();
  const sharedUp = await waitFor(async () => (await pageB.locator(sharedSel).count()) >= 1, { timeout: 12000, interval: 300 });
  check('B 的远洋图上有队友共享海域节点', sharedUp === true);
  const sharedName = await pageB.locator(sharedSel + ' .pn-name').first().innerText();
  check('共享海域节点标出主人名（与自己的海域区分）', sharedName.indexOf('甲钓手' + uniq) >= 0, JSON.stringify(sharedName));
  await post(ctxA, '/api/party', { action: 'disband' });
  const modalUp = await waitFor(async () => /离开了临时海域/.test(await pageB.evaluate(() => document.body.innerText)), { timeout: 6000, interval: 150 });
  check('解散后 B 弹出「离开了临时海域」提醒（不只 toast）', modalUp === true, (await pageB.evaluate(() => document.body.innerText)).slice(0, 120));
  const cleared = await pageB.evaluate(() => {
    const okBtn = document.querySelector('.modal-overlay .cf-ok');
    if (okBtn) okBtn.click();
    return !Engine.state.fishing.active && !Engine.state.player.groundId && !Engine.state.selected.groundId;
  });
  check('弹窗同时清掉本地钓点（界面不再显示「在钓」）', cleared === true, JSON.stringify(await pageB.evaluate(() => ({ act: Engine.state.fishing.active, g: Engine.state.player.groundId }))));
  const sharedGone = await waitFor(async () => (await pageB.locator(sharedSel).count()) === 0, { timeout: 14000, interval: 400 });
  check('解散后地图上的共享海域节点随轮询消失（不再挂着点进去报错）', sharedGone === true);

  // ---- 5. 背包全量对账：虚空物品自愈 ----
  await post(ctxA, '/api/dev/seed', { inventory: { mullet: 3 } });
  await pageA.evaluate(() => { UI.setView('inventory'); UI.renderView(); });
  await pageA.locator('.inv-panel, .panel.wide').first().waitFor({ timeout: 15000 });
  // 把本地改脏（模拟漏包累积出的「显示有、实际没有」）
  const dirty = await pageA.evaluate(() => {
    Engine.state.inventory.mullet = 99;
    Engine.state.inventory.ghost_fish = 5;
    UI.refreshAll('assets');
    return { mullet: Engine.state.inventory.mullet, ghost: Engine.state.inventory.ghost_fish };
  });
  check('本地已改脏（mullet 99 / ghost 5）', dirty.mullet === 99 && dirty.ghost === 5, JSON.stringify(dirty));
  const rowShown = await waitFor(async () => /×99/.test(await pageA.evaluate(() => document.body.innerText)), { timeout: 5000, interval: 150 });
  check('界面显示被改脏的数量（×99）', rowShown === true);
  await pageA.evaluate(() => UI.resyncAssets());
  const healed = await waitFor(async () => pageA.evaluate(() => Engine.state.inventory.mullet === 3 && !Engine.state.inventory.ghost_fish), { timeout: 8000, interval: 150 });
  check('对账后本地库存回到服务器真实值（mullet 3，虚空物品消失）', healed === true, JSON.stringify(await pageA.evaluate(() => ({ mullet: Engine.state.inventory.mullet, ghost: Engine.state.inventory.ghost_fish }))));
  const uiHealed = await waitFor(async () => !/×99/.test(await pageA.evaluate(() => document.body.innerText)), { timeout: 5000, interval: 150 });
  check('界面上的虚空数量也一并消失（不再显示 ×99）', uiHealed === true);

  // ---- 6. 后台：近岸图 / 远洋图分页签（底图与节点各归各图） ----
  const otp = await provisionAdmin(server, DIR, ADM);
  const admPage = await ctxAdmin.newPage();
  admPage.on('pageerror', e => errors.push('admin: ' + e.message));
  await admPage.goto(BASE + '/admin.html', { waitUntil: 'load' });
  await admPage.fill('#login-user', ADM);
  await admPage.fill('#login-pass', 'v0213ui-test-1');
  await admPage.fill('#login-otp', otp);
  await admPage.evaluate(() => { const b = document.getElementById('login-btn'); if (b) b.click(); });
  await admPage.locator('.nav-item').first().waitFor({ timeout: 15000 });
  await admPage.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('钓点管理'));
    if (b) b.click();
  });
  await admPage.locator('#gd-map-canvas').waitFor({ timeout: 15000 });
  const allSpots = (D.GROUNDS.find(g => g.id === 'map').spots || []);
  const nearIds = allSpots.filter(s => s.map !== 'voyage').map(s => s.id);
  const voyIds = allSpots.filter(s => s.map === 'voyage').map(s => s.id);
  const nearNodes = await admPage.$$eval('#gd-map-canvas .gd-node', els => els.map(e => e.getAttribute('data-s')));
  check('后台近岸图：底图是世界地图 PNG', await admPage.locator('#gd-map-canvas img[src*="worldmap.png"]').count() === 1);
  check('后台近岸图：只画近岸钓点（' + nearIds.length + ' 个）', nearNodes.length === nearIds.length && nearNodes.every(id => nearIds.indexOf(id) >= 0), JSON.stringify(nearNodes));
  await admPage.click('[data-mtab="voyage"]');
  await admPage.locator('#gd-map-canvas .vm-art').waitFor({ timeout: 15000 });
  const voyNodes = await admPage.$$eval('#gd-map-canvas .gd-node', els => els.map(e => e.getAttribute('data-s')));
  check('切到远洋图：底图换成 CSS 像素海图（不再是世界地图 PNG）', await admPage.locator('#gd-map-canvas img[src*="worldmap.png"]').count() === 0);
  check('切到远洋图：只画远洋钓点（' + voyIds.length + ' 个）', voyNodes.length === voyIds.length && voyNodes.every(id => voyIds.indexOf(id) >= 0), JSON.stringify(voyNodes));
  await admPage.click('[data-mtab="nearshore"]');
  await admPage.locator('#gd-map-canvas img[src*="worldmap.png"]').waitFor({ timeout: 8000 });
  const backNodes = await admPage.$$eval('#gd-map-canvas .gd-node', els => els.map(e => e.getAttribute('data-s')));
  check('切回近岸图：底图与节点都还原', backNodes.length === nearIds.length, JSON.stringify(backNodes));

  check('浏览器无未捕获错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  console.log('通过 ' + count + ' 项，失败 0 项');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' }); } catch (_) {} }
});
