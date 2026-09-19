/*
 * v0.21.2 浏览器回归 —— 好友身份显示 + 在线卡片「加好友」按钮 + 后台分图钓点 + 悬赏编辑器
 * 覆盖：
 *   · 好友面板：搜索行/申请行都显示 @账号名（同名玩家可分辨）
 *   · 好友关系推送：对面发起/撤回后，本侧面板 2.5 秒内自动反映（不等 5 秒轮询）
 *   · 在线动态卡片：交易 / 查看 / 加好友 三个按钮；加好友 → 撤回申请 → 加好友；自己那张卡没有加好友按钮
 *   · 后台「🎣 钓点管理」：近岸图 / 远洋图分页签，底图与节点各归各图（远洋用 CSS 海图）
 *   · 后台悬赏编辑器：切「上交指定物品」出现上交物品下拉；加奖励行并保存后玩家端读到新配置
 * 注意：管理员用独立账号 —— 管理员登录会重置同账号的普通会话，拿玩家号当管理员会把已登录的页面踢下线。
 * 运行：node tests/v0212-ui.test.js（需要 FISHING_DEV=1，套件自行设置；CHROME_PATH 可选）
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
const ROOT = path.resolve(__dirname, '..'), PORT = 8295, BASE = 'http://127.0.0.1:' + PORT;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-v0212-ui-'));

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
  const ctxA = await browser.newContext(opts), ctxB = await browser.newContext(opts), ctxAdmin = await browser.newContext(opts);
  const errors = [];
  async function post(context, url, data) {
    const r = await context.request.post(BASE + url, { data });
    return { status: r.status(), body: await r.json() };
  }
  async function registerOnly(context, username, name) {
    const data = { username, name, password: 'v0212ui-test-1', qq: '829500' };
    let r = await post(context, '/api/register', data);
    if (r.body.code === 'REGISTRATION_CHALLENGE') {
      const ch = await (await context.request.get(BASE + '/api/register/challenge')).json();
      r = await post(context, '/api/register', { ...data, proof: registration.solve(ch) });
    }
    assert.ok(r.body.profile, '注册失败：' + JSON.stringify(r.body));
    await post(context, '/api/login', { username, password: 'v0212ui-test-1' });
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
  const A = 'v212uia' + uniq, B = 'v212uib' + uniq, ADM = 'v212uiadm' + uniq;
  const pageA = await register(ctxA, A, '甲钓手' + uniq);
  const pageB = await register(ctxB, B, '乙钓手' + uniq);
  await registerOnly(ctxAdmin, ADM, '界面管理员' + uniq);

  async function openFriends(page, tab) {
    await page.evaluate(() => { UI.setView('ground'); UI.renderView(); });
    await page.getByRole('button', { name: tab || '👥 好友', exact: true }).click();
    await page.locator('.friends-panel').waitFor();
    await sleep(400);
  }
  const reqBlockText = page => page.locator('.friends-panel .friend-reqs').innerText();

  // ---- 1. 好友面板：@账号名 ----
  await openFriends(pageA);
  await pageA.fill('.friend-search-input', '乙钓手' + uniq);
  await pageA.getByRole('button', { name: '搜索', exact: true }).click();
  const searchRow = pageA.locator('.friends-panel .peep').filter({ hasText: '乙钓手' + uniq }).first();
  await searchRow.waitFor({ timeout: 15000 });
  const searchText = await searchRow.innerText();
  check('搜索结果行显示 @账号名', searchText.indexOf('@' + B) >= 0, JSON.stringify(searchText));
  await pageA.getByRole('button', { name: '添加好友', exact: true }).click();
  await pageA.getByRole('button', { name: '撤回', exact: true }).first().waitFor();
  const outText = await reqBlockText(pageA);
  check('「已发出」行也显示 @账号名（同名玩家能分辨）', outText.indexOf('@' + B) >= 0, JSON.stringify(outText));

  // ---- 2. 关系推送：对面不用等 5 秒轮询 ----
  await openFriends(pageB);
  const gotPush = await waitFor(async () => /待处理/.test(await reqBlockText(pageB)), { timeout: 2500, interval: 150 });
  check('B 侧 2.5 秒内自动出现「有 1 条待处理」（friends 推送生效）', gotPush === true, JSON.stringify(await reqBlockText(pageB)));
  const inText = await reqBlockText(pageB);
  check('B 侧收到的申请带 @账号名', inText.indexOf('@' + A) >= 0, JSON.stringify(inText));
  await pageA.getByRole('button', { name: '撤回', exact: true }).first().click();
  const gonePush = await waitFor(async () => /暂无收到/.test(await reqBlockText(pageB)), { timeout: 2500, interval: 150 });
  check('A 撤回后 B 侧 2.5 秒内自动清空', gonePush === true, JSON.stringify(await reqBlockText(pageB)));

  // ---- 3. 在线动态卡片上的「加好友」 ----
  const mapG = D.GROUNDS.find(g => g.id === 'map');
  const spot = mapG.spots.find(s => !s.locked && !s.minShip);
  await post(ctxB, '/api/fishing/start', { groundId: mapG.id, spotId: spot.id });
  await pageA.evaluate(() => { UI.setView('ground'); UI.renderView(); window.Net.setPlayersView({ page: 1, size: 30 }); });
  await pageA.getByRole('button', { name: '🌊 在线动态', exact: true }).click();
  const aCard = pageA.locator('.peep', { hasText: '乙钓手' + uniq }).first();
  await aCard.waitFor({ timeout: 15000 });
  const acts = await aCard.locator('.peep-acts button').allInnerTexts();
  check('卡片三个按钮：交易 / 查看 / 加好友',
    acts.length === 3 && /交易/.test(acts[0]) && /查看/.test(acts[1]) && /加好友/.test(acts[2]), JSON.stringify(acts));
  await aCard.getByRole('button', { name: /加好友/ }).click();
  const afterAdd = await waitFor(async () => /撤回申请/.test(await aCard.innerText()), { timeout: 4000, interval: 150 });
  check('卡片加好友后按钮变「撤回申请」', afterAdd === true, JSON.stringify(await aCard.innerText()));
  const relA = await (await ctxA.request.get(BASE + '/api/friends/relations')).json();
  check('关系速查里 B 进入 out 组', (relA.out || []).indexOf(B) >= 0, JSON.stringify(relA));
  await aCard.getByRole('button', { name: /撤回申请/ }).click();
  const afterCancel = await waitFor(async () => /加好友/.test(await aCard.innerText()), { timeout: 4000, interval: 150 });
  check('卡片撤回后按钮变回「加好友」', afterCancel === true, JSON.stringify(await aCard.innerText()));
  const selfCard = pageA.locator('.peep', { hasText: '（你）' }).first();
  const selfActs = (await selfCard.count()) ? await selfCard.locator('.peep-acts button').count() : 0;
  check('自己的卡片没有交易/加好友按钮', selfActs === 0, String(selfActs));

  // ---- 4. 后台：分图钓点 ----
  const otp = await provisionAdmin(server, DIR, ADM);
  const admPage = await ctxAdmin.newPage();
  admPage.on('pageerror', e => errors.push('admin: ' + e.message));
  await admPage.goto(BASE + '/admin.html', { waitUntil: 'load' });
  await admPage.fill('#login-user', ADM);
  await admPage.fill('#login-pass', 'v0212ui-test-1');
  await admPage.fill('#login-otp', otp);
  // 登录成功后浮层会立刻隐藏，Playwright 的可点击性检查会一直等 → 直接派发点击
  await admPage.evaluate(() => { const b = document.getElementById('login-btn'); if (b) b.click(); });
  await admPage.locator('.nav-item').first().waitFor({ timeout: 15000 });
  await admPage.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('钓点管理'));
    if (b) b.click();
  });
  await admPage.locator('#gd-map-canvas').waitFor({ timeout: 15000 });
  const allSpots = (D.GROUNDS.find(g => g.id === 'map').spots || []);
  const nearCount = allSpots.filter(s => s.map !== 'voyage').length;
  const voyCount = allSpots.filter(s => s.map === 'voyage').length;
  const voyIds = allSpots.filter(s => s.map === 'voyage').map(s => s.id);
  const nearNodes = await admPage.$$eval('#gd-map-canvas .gd-node', els => els.map(e => e.getAttribute('data-s')));
  check('近岸页签只画近岸钓点（' + nearCount + ' 个）', nearNodes.length === nearCount, JSON.stringify(nearNodes));
  check('近岸页签底图是世界地图 PNG', await admPage.locator('#gd-map-canvas img[src*="worldmap.png"]').count() === 1);
  await admPage.click('[data-mtab="voyage"]');
  await admPage.locator('#gd-map-canvas .vm-art').waitFor({ timeout: 15000 });
  const voyNodes = await admPage.$$eval('#gd-map-canvas .gd-node', els => els.map(e => e.getAttribute('data-s')));
  check('远洋页签只画远洋钓点（' + voyCount + ' 个）', voyNodes.length === voyCount, JSON.stringify(voyNodes));
  check('远洋页签的节点就是那批远洋钓点，与近岸不混',
    voyNodes.every(id => voyIds.indexOf(id) >= 0) && voyNodes.every(id => nearNodes.indexOf(id) < 0), JSON.stringify(voyNodes));
  check('远洋页签底图是 CSS 像素海图（与玩家端同一份）', await admPage.locator('#gd-map-canvas .vm-ink').count() > 0);
  await admPage.click('[data-mtab="nearshore"]');
  await admPage.locator('#gd-map-canvas img[src*="worldmap.png"]').waitFor({ timeout: 8000 });
  check('切回近岸页签底图与节点都还原', (await admPage.$$eval('#gd-map-canvas .gd-node', els => els.length)) === nearCount);

  // ---- 5. 后台悬赏编辑器：上交物品可配 + 奖励物品可加 ----
  await admPage.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('远洋配置'));
    if (b) b.click();
  });
  await admPage.locator('#sea-quests .q-card').first().waitFor({ timeout: 15000 });
  const qCount = await admPage.locator('#sea-quests .q-card').count();
  check('悬赏编辑器按条渲染全部模板', qCount === (D.SEA.quests || []).length, String(qCount));
  const submitIdx = (D.SEA.quests || []).findIndex(t => t.id === 'q_submit_scale');
  check('上交类悬赏默认已经显示「上交物品」下拉', await admPage.locator('#sea-q-subitem-' + submitIdx).count() === 1);
  check('上交类的需求次数锁为 1', await admPage.locator('#sea-q-need-' + submitIdx).isDisabled());
  await admPage.selectOption('#sea-q-kind-0', 'submit');
  await admPage.locator('#sea-q-subitem-0').waitFor({ timeout: 5000 });
  check('切换需求类型后出现上交物品选择', await admPage.locator('#sea-q-subitem-0').count() === 1);
  check('非上交类默认不显示上交物品框', await admPage.locator('#sea-q-subitem-1').count() === 0);
  await admPage.selectOption('#sea-q-subitem-0', 'relic');
  await admPage.fill('#sea-q-subcount-0', '3');
  await admPage.fill('#sea-q-title-0', '上贡遗物（界面回归）');
  const qCard0 = admPage.locator('#sea-quests .q-card').first();
  const rowsBefore = await qCard0.locator('.q-item-row').count();
  await admPage.click('[data-qadd="0"]');
  await qCard0.locator('.q-item-row').nth(rowsBefore).waitFor();
  await admPage.selectOption('#sea-q-item-0-' + rowsBefore, 'chest_king');
  await admPage.fill('#sea-q-qty-0-' + rowsBefore, '2');
  check('「＋ 加奖励物品」能加出一行并可选物品', await qCard0.locator('.q-item-row').count() === rowsBefore + 1);
  await admPage.click('#sea-save');
  const saved = await waitFor(async () => /已保存/.test(await admPage.textContent('#sea-state')), { timeout: 10000, interval: 200 });
  check('后台悬赏配置保存成功', saved === true, await admPage.textContent('#sea-state'));
  const firstId = (D.SEA.quests || [])[0].id;
  // 先确认已经落到服务端配置（后台读到的就是刚编辑的那份）
  const worldNow = await (await ctxAdmin.request.get(BASE + '/api/admin/world')).json();
  const saved0 = ((((worldNow.seaCfg || {}).sea || {}).quests) || []).find(q => q.id === firstId) || {};
  check('后台已落库新的悬赏配置（标题 / 上交物品 / 奖励行）',
    saved0.title === '上贡遗物（界面回归）' && !!saved0.submit && saved0.submit.id === 'relic' && saved0.submit.count === 3 &&
    !!saved0.reward && !!saved0.reward.items && saved0.reward.items.chest_king === 2,
    JSON.stringify(saved0));
  // 玩家端读到新配置（把这条悬赏种进今日列表再看）
  await post(ctxA, '/api/dev/seed', { inventory: { relic: 3 }, sea: { quests: { day: new Date().toDateString(), list: [{ id: firstId, kind: 'submit', progress: 0, claimed: false }] } } });
  const sea = await (await ctxA.request.get(BASE + '/api/sea')).json();
  const q0 = (sea.quests || [])[0] || {};
  check('玩家端读到「上交指定物品」配置',
    q0.title === '上贡遗物（界面回归）' && !!q0.submit && q0.submit.id === 'relic' && q0.submit.count === 3 && q0.submit.have === 3,
    JSON.stringify(q0));
  check('玩家端读到新增的奖励物品行',
    !!q0.reward && !!q0.reward.items && q0.reward.items.chest_king === 2, JSON.stringify(q0.reward || {}));
  check('持有量达标 → 该条悬赏进度自动算满（上交类固定 1 次）', q0.progress === 1 && q0.need === 1, JSON.stringify(q0));

  check('浏览器无未捕获错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  console.log('通过 ' + count + ' 项，失败 0 项');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' }); } catch (_) {} }
});
