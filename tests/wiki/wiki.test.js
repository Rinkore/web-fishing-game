/*
 * Wiki M1 回归（纯 HTTP + 共享规则函数）
 * 覆盖：
 *   · /api/version 默认响应保持兼容，profile=wiki 返回独立 snapshot
 *   · 快照元数据、目录、有效掉落权重、缓存与 ETag 契约
 *   · /shop 保持 no-store，供 Wiki 实时收购价复用
 *   · data.js 配装试算与熔炼固定样例
 * 运行：node tests/wiki/wiki.test.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('../_util.js');
const { provisionAdmin } = require('../_admin.js');
const registrationProof = require('../_registration.js');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.WIKI_HTTP_TEST_PORT) || 8271;
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-wiki-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));
const WikiStore = require(path.join(ROOT, 'backend', 'wiki-store.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const contentContext = { window: {} };
require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'frontend/wiki/js/content.js'), 'utf8'), contentContext);
const mergeUpdates = contentContext.window.WikiContentTools.mergeUpdates;
const mixedUpdates = mergeUpdates([
  { date: '2026-09-01', title: '旧 Wiki' },
  { date: '2027-01-01', title: '新 Wiki' },
  { date: '2027-01-01', title: '同日第二条' }
], [{ date: '2026-12-31', version: 'v1' }, { date: '2027-01-01', version: 'v2' }]);
check('更新按完整日期跨年排序且同日优先 Wiki、保留来源顺序', mixedUpdates.map(x => x.title).join('|') === '新 Wiki|同日第二条|v2 版本更新|v1 版本更新|旧 Wiki');
check('最新游戏版本可以成为唯一最新记录，历史不丢失', mergeUpdates([{ date: '2026-09-19', title: 'Wiki' }], [{ date: '2026-09-20', version: 'vNext' }])[0].title === 'vNext 版本更新' && mixedUpdates.length === 5);
check('更新兼容空来源与无效日期', mergeUpdates([], []).length === 0 && mergeUpdates([{ date: 'bad', title: '无日期' }], [{ date: '2026-09-20', version: 'vNext' }])[1].title === '无日期');
function request(pathname, options) {
  options = options || {};
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = Object.assign({}, options.headers || {});
  if (body) headers['Content-Type'] = 'application/json';
  return new Promise(resolve => {
    const r = http.request({ hostname: '127.0.0.1', port: options.port || PORT, path: pathname, method: options.method || 'GET', headers: headers }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, data: data, body: out });
      });
    });
    r.on('error', () => resolve({ status: 0, headers: {}, data: null, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
async function post(pathname, body, headers, port) { return request(pathname, { method: 'POST', body: body, headers: headers, port: port }); }
async function registerAccount(username, port) {
  const payload = { username: username, password: 'wiki-test-1234', name: 'Wiki Test', qq: '827100' };
  let r = await post('/api/register', payload, undefined, port);
  if ((r.status === 200 || r.status === 403) && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }), undefined, port);
  }
  return r;
}
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }

let srv = null;
async function main() {
  const fixture = require('./simulator-fixture')(TMP_DATA);
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, SOURCE_COMMIT: SOURCE_COMMIT }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

  const simPath = '/api/wiki/simulator/inventory';
  const simAuth = { Authorization: 'Bearer ' + fixture.token };
  const diskBefore = fs.readFileSync(fixture.file, 'utf8');
  check('模拟背包读取需要登录', (await request(simPath)).status === 401);
  check('封禁账号不能读取模拟背包', (await request(simPath, { headers: { Authorization: 'Bearer ' + fixture.bannedToken } })).status === 403);
  check('模拟背包接口拒绝写入', (await post(simPath, { inventory: {}, coins: 0 }, simAuth)).status === 405);
  const inventory = await request(simPath, { headers: simAuth });
  check('模拟背包只读接口返回组件、当前装备、已存钓竿和资源', inventory.status === 200 && inventory.data.readOnly && inventory.data.inventory[fixture.mainId] === 1 && inventory.data.bd.rod.compId === fixture.rodId && inventory.data.rodSlots[0].parts.line === fixture.mainId && inventory.data.coins === 987654);
  check('模拟背包响应禁止缓存且不暴露账号认证资料', inventory.headers['cache-control'] === 'private, no-store' && !('pwHash' in inventory.data) && !('qq' in inventory.data) && !('token' in inventory.data));
  const repeatInventory = await request(simPath + '?username=simulatorbanned', { headers: simAuth });
  check('模拟背包只能读取当前会话，读取不触发自动出售', repeatInventory.data.inventory.crucian === 1000000 && repeatInventory.data.coins === 987654 && repeatInventory.data.name === inventory.data.name);
  await new Promise(r => setTimeout(r, 1300));
  check('读取副本和拒绝写入后账号文件逐字节不变', fs.readFileSync(fixture.file, 'utf8') === diskBefore);

  const def = await request('/api/version');
  check('默认版本接口保持 200 且无 snapshot 字段', def.status === 200 && def.data && def.data.version && def.data.snapshot === undefined, JSON.stringify(def.data || {}).slice(0, 200));
  check('默认版本接口不携带 ETag', !def.headers.etag, String(def.headers.etag));
  check('未知 profile 被拒绝', (await request('/api/version?profile=unknown')).status === 400);

  const wiki = await request('/api/version?profile=wiki');
  const snap = wiki.data && wiki.data.snapshot;
  check('Wiki profile 返回 {profile,version,snapshot}', wiki.status === 200 && wiki.data.profile === 'wiki' && !!snap && Object.keys(wiki.data).join(',') === 'profile,version,snapshot', JSON.stringify(wiki.data && Object.keys(wiki.data)));
  check('Wiki 快照声明服务端来源', snap && snap.sourceKind === 'server', snap && snap.sourceKind);
  check('Wiki 快照包含版本与规则版本', snap && snap.gameVersion === D.VERSION && snap.rulesVersion === 1, JSON.stringify(snap && { gameVersion: snap.gameVersion, rulesVersion: snap.rulesVersion }));
  check('Wiki 快照包含发布注入的完整提交 SHA', snap && snap.sourceCommit === SOURCE_COMMIT, snap && snap.sourceCommit);
  check('Wiki 快照包含 64 位配置哈希与配置代数', snap && /^[0-9a-f]{64}$/.test(snap.configHash) && snap.configRevision >= 1, snap && snap.configHash);
  check('Wiki 快照目录包含鱼类/材料/组件/宝匣/部位', snap && snap.catalog.fish.length === 51 && snap.catalog.materials.length === 9 && snap.catalog.components.length === 29 && snap.catalog.chests.length === 4 && snap.catalog.rodParts.length === 7, JSON.stringify(snap && { fish: snap.catalog.fish.length, materials: snap.catalog.materials.length, components: snap.catalog.components.length, chests: snap.catalog.chests.length, rodParts: snap.catalog.rodParts.length }));
  check('Wiki 快照使用 groundsWithDrop 有效权重', snap && snap.grounds.length > 0 && snap.grounds.some(g => (g.spots || []).some(s => (s.pool || []).length > 0)), JSON.stringify(snap && snap.grounds.length));
  check('Wiki 快照包含公式与计算配置', snap && snap.rulesConfig.castCfg && typeof snap.rulesConfig.biteFormula === 'string' && typeof snap.rulesConfig.doubleBase === 'number' && snap.rulesConfig.rareK > 0, JSON.stringify(snap && snap.rulesConfig));
  check('Wiki profile 使用 no-cache 与 ETag', String(wiki.headers['cache-control']).includes('no-cache') && !!wiki.headers.etag, JSON.stringify(wiki.headers));
  check('Wiki 快照与 /api/grounds 使用同一有效权重', snap && JSON.stringify(snap.grounds) === JSON.stringify((await request('/api/grounds')).data.grounds));

  const again = await request('/api/version?profile=wiki');
  check('同一配置下哈希与 ETag 稳定', again.data.snapshot.configHash === snap.configHash && again.data.snapshot.snapshotId === snap.snapshotId && again.headers.etag === wiki.headers.etag, JSON.stringify({ before: snap.snapshotId, after: again.data.snapshot && again.data.snapshot.snapshotId }));
  check('生成时间不参与配置哈希', new Date(again.data.snapshot.generatedAt).getTime() >= new Date(snap.generatedAt).getTime(), JSON.stringify({ before: snap.generatedAt, after: again.data.snapshot.generatedAt }));

  const cached = await request('/api/version?profile=wiki', { headers: { 'If-None-Match': wiki.headers.etag } });
  check('ETag 命中返回 304', cached.status === 304 && cached.headers.etag === wiki.headers.etag, JSON.stringify({ status: cached.status, etag: cached.headers.etag }));

  const wikiRedirect = await request('/wiki');
  check('/wiki 自动补齐尾斜杠', wikiRedirect.status === 301 && wikiRedirect.headers.location === '/wiki/', JSON.stringify({ status: wikiRedirect.status, location: wikiRedirect.headers.location }));

  const wikiPage = await request('/wiki/');
  check('/wiki/ 同域托管 M1 验收页', wikiPage.status === 200 && /text\/html/.test(wikiPage.headers['content-type'] || '') && wikiPage.body.includes('首页 · WIKI') && wikiPage.body.includes('/wiki/js/core.js'), JSON.stringify({ status: wikiPage.status, type: wikiPage.headers['content-type'] }));
  check('/wiki/ 静态页使用 no-cache', String(wikiPage.headers['cache-control']).includes('no-cache'), String(wikiPage.headers['cache-control']));

  const corePages = [
    ['/wiki/grounds/index.html', 'data-page="grounds"'],
    ['/wiki/search/index.html', 'data-page="search"'],
    ['/wiki/guides/index.html', 'data-page="guides"'],
    ['/wiki/updates/index.html', 'data-page="updates"'],
    ['/wiki/tools/build.html', 'id="current-result"'],
    ['/wiki/tools/smelt.html', 'id="preview"'],
  ];
  const coreResults = await Promise.all(corePages.map(async function (row) {
    const r = await request(row[0]);
    return r.status === 200 && r.body.includes(row[1]) && r.body.includes('/wiki/js/core.js');
  }));
  check('资料站与两个模拟器页面均可同域访问', coreResults.every(Boolean), JSON.stringify(corePages.map(function (x, i) { return x[0] + ':' + coreResults[i]; })));

  const versions = await request('/wiki/content/versions.json');
  check('版本记录静态文件可访问并与主线同步', versions.status === 200 && versions.data.count === 79 && versions.data.versions.some(v => v.version === 'v0.20.0'), JSON.stringify({ status: versions.status, count: versions.data && versions.data.count }));

  const shop = await request('/shop');
  check('/shop 复用为实时价且 no-store', shop.status === 200 && shop.headers['cache-control'] === 'no-store', JSON.stringify({ status: shop.status, cache: shop.headers['cache-control'] }));

  const wikiContent = await request('/api/wiki/content');
  check('Wiki 攻略接口返回内置内容', wikiContent.status === 200 && typeof wikiContent.data.revision === 'string' && wikiContent.data.officialRevision >= 1 && wikiContent.data.userRevision >= 1 && Array.isArray(wikiContent.data.guides) && wikiContent.data.guides.length > 0 && Array.isArray(wikiContent.data.updates), JSON.stringify({ status: wikiContent.status, revision: wikiContent.data && wikiContent.data.revision, guides: wikiContent.data && wikiContent.data.guides && wikiContent.data.guides.length }));
  check('Wiki 官方攻略带官方身份', wikiContent.data.guides.every(g => g.kind !== 'user' || g.status === 'approved'), JSON.stringify(wikiContent.data.guides && wikiContent.data.guides.filter(g => g.kind === 'user').map(g => g.status)));
  check('Wiki 公开攻略只下发元数据', wikiContent.data.guides.every(g => g.sections === undefined && typeof g.title === 'string' && typeof g.summary === 'string'), JSON.stringify(wikiContent.data.guides[0] || null));
  const keyGuideDetail = await request('/api/wiki/guides/seven-part-reference-build');
  check('Wiki 攻略详情按需返回正文段落', keyGuideDetail.status === 200 && keyGuideDetail.data.guide && keyGuideDetail.data.guide.sections.some(s => s.h === '实测成本样本'), JSON.stringify(keyGuideDetail.data && keyGuideDetail.data.guide && keyGuideDetail.data.guide.id));
  const publicGuideList = await request('/api/wiki/guides?page=1&pageSize=5&q=' + encodeURIComponent('六词条'));
  check('Wiki 攻略列表分页与搜索可用', publicGuideList.status === 200 && publicGuideList.data.total >= 2 && publicGuideList.data.guides.length <= 5 && publicGuideList.data.guides.every(g => g.sections === undefined), JSON.stringify({ total: publicGuideList.data && publicGuideList.data.total }));
  check('Wiki 攻略详情 404 不泄露未公开内容', (await request('/api/wiki/guides/no-such-guide-xyz')).status === 404);
  check('Wiki 攻略接口使用 no-cache 与 ETag', String(wikiContent.headers['cache-control']).includes('no-cache') && !!wikiContent.headers.etag, JSON.stringify(wikiContent.headers));
  const cachedWikiContent = await request('/api/wiki/content', { headers: { 'If-None-Match': wikiContent.headers.etag } });
  check('Wiki 攻略 ETag 命中返回 304', cachedWikiContent.status === 304 && cachedWikiContent.headers.etag === wikiContent.headers.etag, JSON.stringify({ status: cachedWikiContent.status, etag: cachedWikiContent.headers.etag }));
  check('未登录不能保存 Wiki 攻略', (await post('/api/admin/wiki/content', { content: wikiContent.data })).status === 403);

  // 管理端保存配置必须推进配置代数，并让规则哈希与 ETag 变化。
  check('测试管理员注册成功', (await registerAccount('wikiadmin')).status === 200);
  const otp = await provisionAdmin(srv, TMP_DATA, 'wikiadmin');
  const adminLogin = await post('/api/admin/login', { username: 'wikiadmin', password: 'wiki-test-1234', otp: otp });
  check('测试管理员登录成功', adminLogin.status === 200 && adminLogin.data.token, JSON.stringify(adminLogin.data || {}));
  const adminAuth = { Authorization: 'Bearer ' + adminLogin.data.token };
  const officialBefore = await request('/api/admin/wiki/content', { headers: adminAuth });
  check('管理员可读取官方 Wiki 内容', officialBefore.status === 200 && officialBefore.data.officialRevision === wikiContent.data.officialRevision && officialBefore.data.guides.every(g => g.kind !== 'user'), JSON.stringify({ status: officialBefore.status, revision: officialBefore.data && officialBefore.data.officialRevision }));
  const invalidWikiSave = await post('/api/admin/wiki/content', { content: { guides: [], updates: [] } }, adminAuth);
  check('缺少基线版本的官方攻略保存被拒绝', invalidWikiSave.status === 409 && invalidWikiSave.data.currentRevision === officialBefore.data.officialRevision, JSON.stringify(invalidWikiSave.data || {}));
  const hotContent = JSON.parse(JSON.stringify(officialBefore.data));
  hotContent.guides[0].title = '热更新验证：' + hotContent.guides[0].title;
  hotContent.updates.unshift({ date: '2026-09-18', title: '热更新验证', summary: '测试保存后立即生效。' });
  const staleWikiSave = await post('/api/admin/wiki/content', { content: { guides: hotContent.guides, updates: hotContent.updates }, baseRevision: officialBefore.data.officialRevision + 100 }, adminAuth);
  check('过期基线版本保存被拒绝', staleWikiSave.status === 409, JSON.stringify(staleWikiSave.data || {}));
  const hotSave = await post('/api/admin/wiki/content', { target: 'official-content', content: { guides: hotContent.guides, updates: hotContent.updates }, baseRevision: officialBefore.data.officialRevision }, adminAuth);
  check('管理员保存官方攻略成功', hotSave.status === 200 && hotSave.data.officialRevision === officialBefore.data.officialRevision + 1 && hotSave.data.guides[0].title === hotContent.guides[0].title, JSON.stringify(hotSave.data || { status: hotSave.status }));
  const hotRead = await request('/api/wiki/content');
  check('官方攻略保存后公开接口立即可读', hotRead.status === 200 && hotRead.data.officialRevision === hotSave.data.officialRevision && hotRead.data.guides[0].title === hotContent.guides[0].title && hotRead.headers.etag !== wikiContent.headers.etag, JSON.stringify({ revision: hotRead.data && hotRead.data.revision }));

  // 用户投稿：默认自动审核（提交后立即公开）；作者可删除自己的自动通过投稿。
  check('投稿用户注册成功', (await registerAccount('wikiuser')).status === 200);
  const userLogin = await post('/api/login', { username: 'wikiuser', password: 'wiki-test-1234' });
  check('投稿用户登录成功', userLogin.status === 200 && userLogin.data.token, JSON.stringify(userLogin.data || {}));
  const userAuth = { Authorization: 'Bearer ' + userLogin.data.token };
  check('未登录不能读取我的攻略', (await request('/api/wiki/guides/my')).status === 401);
  const guidePayload = { title: '玩家投稿验证', category: '心得分享', summary: '一篇用于验证审核链路的投稿。', tags: ['验证'], sections: [{ h: '思路', type: 'p', text: '先用模拟器确认收益，再投入材料。' }] };
  const forgedSubmit = await post('/api/wiki/guides/submit', Object.assign({}, guidePayload, { status: 'approved', authorName: '伪造作者' }), userAuth);
  check('客户端伪造系统字段被拒绝', forgedSubmit.status === 400 && !!forgedSubmit.data.error, JSON.stringify(forgedSubmit.data || {}));
  const invalidSubmit = await post('/api/wiki/guides/submit', { title: '', category: '心得分享', summary: 'x', sections: [] }, userAuth);
  check('非法投稿结构被拒绝', invalidSubmit.status === 400 && !!invalidSubmit.data.error, JSON.stringify(invalidSubmit.data || {}));
  const submitted = await post('/api/wiki/guides/submit', guidePayload, userAuth);
  check('登录用户提交攻略后自动通过', submitted.status === 200 && submitted.data.status === 'approved' && submitted.data.autoApproved === true && /^ug_[a-f0-9]{12,24}$/.test(submitted.data.guideId), JSON.stringify(submitted.data || {}));
  const afterSubmitPublic = await request('/api/wiki/content');
  const publicAfterSubmit = afterSubmitPublic.data.guides.find(g => g.id === submitted.data.guideId);
  check('自动通过攻略立即进入公开接口且不泄露内部字段', !!publicAfterSubmit && publicAfterSubmit.status === 'approved' && publicAfterSubmit.authorName === 'Wiki Test' && publicAfterSubmit.sections === undefined && !('authorKey' in publicAfterSubmit) && !('reviewNote' in publicAfterSubmit), JSON.stringify(publicAfterSubmit || null));
  const submittedDetail = await request('/api/wiki/guides/' + submitted.data.guideId);
  check('玩家投稿详情按需返回正文且不泄露内部字段', submittedDetail.status === 200 && submittedDetail.data.guide.sections.length === 1 && submittedDetail.data.guide.sections[0].h === '思路' && !('authorKey' in submittedDetail.data.guide) && !('reviewNote' in submittedDetail.data.guide), JSON.stringify(submittedDetail.data && submittedDetail.data.guide && submittedDetail.data.guide.id));
  const myGuides = await request('/api/wiki/guides/my', { headers: userAuth });
  const myAfterSubmit = myGuides.data.guides.find(g => g.id === submitted.data.guideId);
  check('我的攻略返回自动通过状态、正文与说明', myGuides.status === 200 && !!myAfterSubmit && myAfterSubmit.status === 'approved' && myAfterSubmit.autoApproved === true && Array.isArray(myAfterSubmit.sections) && myAfterSubmit.sections.length === 1 && /自动通过/.test(myAfterSubmit.reviewNote || ''), JSON.stringify(myGuides.data || {}));
  check('投稿频率限制返回自动审核标记', myGuides.data.limits && myGuides.data.limits.autoApprove === true, JSON.stringify(myGuides.data.limits || {}));
  const immediateSecond = await post('/api/wiki/guides/submit', guidePayload, userAuth);
  check('投稿间隔限制生效', immediateSecond.status === 429 && !!immediateSecond.data.limits.nextAllowedAt, JSON.stringify(immediateSecond.data || {}));
  const approvedList = await request('/api/admin/wiki/guides?status=approved', { headers: adminAuth });
  check('管理员在已通过列表看到自动通过投稿', approvedList.status === 200 && approvedList.data.autoApprove === true && approvedList.data.guides.some(g => g.id === submitted.data.guideId && g.autoApproved === true && !g.authorKey), JSON.stringify(approvedList.data || {}));
  const nonAdminReview = await post('/api/admin/wiki/guides/review', { id: submitted.data.guideId, action: 'reject', expectedStatus: 'approved', note: 'x' }, userAuth);
  check('非管理员不能审核攻略', nonAdminReview.status === 403, JSON.stringify(nonAdminReview.data || {}));

  // 第二个用户：验证作者可以删除自己的自动通过投稿。
  check('第二个投稿用户注册成功', (await registerAccount('wikiuser2')).status === 200);
  const user2Login = await post('/api/login', { username: 'wikiuser2', password: 'wiki-test-1234' });
  const user2Auth = { Authorization: 'Bearer ' + user2Login.data.token };
  const deletedSubmit = await post('/api/wiki/guides/submit', Object.assign({}, guidePayload, { title: '将被作者删除的投稿' }), user2Auth);
  check('第二个用户提交攻略自动通过', deletedSubmit.status === 200 && deletedSubmit.data.status === 'approved', JSON.stringify(deletedSubmit.data || {}));
  const wrongDelete = await post('/api/wiki/guides/delete', { id: deletedSubmit.data.guideId }, userAuth);
  check('不能删除别人的投稿', wrongDelete.status === 404, JSON.stringify(wrongDelete.data || {}));
  const authorDelete = await post('/api/wiki/guides/delete', { id: deletedSubmit.data.guideId }, user2Auth);
  check('作者可删除自动通过的投稿', authorDelete.status === 200 && authorDelete.data.ok, JSON.stringify(authorDelete.data || {}));
  const afterDeletePublic = await request('/api/wiki/content');
  check('作者删除后不再公开', !afterDeletePublic.data.guides.some(g => g.id === deletedSubmit.data.guideId), deletedSubmit.data.guideId);
  const afterDeleteList = await request('/api/admin/wiki/guides?status=all', { headers: adminAuth });
  check('已删除投稿不再出现在审核列表', !afterDeleteList.data.guides.some(g => g.id === deletedSubmit.data.guideId), deletedSubmit.data.guideId);

  // 官方内容保存不得覆盖用户投稿；恢复内置同样不得影响用户投稿。
  const officialAfterUser = await request('/api/admin/wiki/content', { headers: adminAuth });
  const officialSaveAfterUser = await post('/api/admin/wiki/content', { content: { guides: officialAfterUser.data.guides, updates: officialAfterUser.data.updates }, baseRevision: officialAfterUser.data.officialRevision }, adminAuth);
  check('管理员保存官方内容不影响用户投稿', officialSaveAfterUser.status === 200 && (await request('/api/wiki/guides/my', { headers: userAuth })).data.guides.some(g => g.id === submitted.data.guideId), JSON.stringify(officialSaveAfterUser.data || {}));
  const resetOfficial = await post('/api/admin/wiki/content', { reset: true, baseRevision: officialSaveAfterUser.data.officialRevision }, adminAuth);
  check('恢复官方内置内容不影响用户投稿', resetOfficial.status === 200 && (await request('/api/wiki/guides/my', { headers: userAuth })).data.guides.some(g => g.id === submitted.data.guideId), JSON.stringify(resetOfficial.data || {}));

  // 人工审核模式：WIKI_GUIDE_AUTO_APPROVE=0 时恢复「提交 → 待审核 → 管理员审核」。
  const MANUAL_PORT = PORT + 4;
  const MANUAL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-wiki-manual-'));
  // 同时验证 HTTP 层首次启动迁移：旧 JSON 存在时应导入 SQLite 并保留状态。
  fs.writeFileSync(path.join(MANUAL_DATA, 'wiki.json'), JSON.stringify({
    wikiContent: { guides: [{ id: 'legacy-official-http', kind: 'official', status: 'published', title: '旧版官方 HTTP', category: '机制说明', aliases: [], tags: ['迁移'], updatedAt: '2026-09-01', summary: '旧版摘要', sections: [{ h: '旧段落', type: 'p', text: '旧正文' }] }], updates: [{ date: '2026-09-01', title: '旧更新 HTTP', summary: '旧更新摘要' }] },
    wikiContentRevision: 5, wikiContentUpdatedAt: '2026-09-01T00:00:00.000Z'
  }), 'utf8');
  fs.writeFileSync(path.join(MANUAL_DATA, 'wiki-guides.json'), JSON.stringify({
    wikiUserGuides: [{ id: 'ug_abcdef123456', kind: 'user', status: 'pending', title: '旧版待审投稿', category: '心得分享', summary: '旧版待审摘要', tags: [], aliases: [], authorKey: 'legacyuser', authorName: '旧玩家', submittedAt: '2026-09-02T00:00:00.000Z', reviewedAt: null, reviewedBy: null, reviewNote: '', sections: [{ h: '旧投稿段落', type: 'p', text: '旧投稿正文' }] }],
    wikiUserGuidesRevision: 4
  }), 'utf8');
  let manualSrv = null;
  try {
    manualSrv = spawn(process.execPath, ['backend/server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(MANUAL_PORT), FISHING_DATA_DIR: MANUAL_DATA, SOURCE_COMMIT: SOURCE_COMMIT, WIKI_GUIDE_AUTO_APPROVE: '0' })
    });
    await waitHttp('http://127.0.0.1:' + MANUAL_PORT + '/api/version', { timeout: 20000 });
    check('人工审核模式用户注册成功', (await registerAccount('manualuser', MANUAL_PORT)).status === 200);
    const manualLogin = await post('/api/login', { username: 'manualuser', password: 'wiki-test-1234' }, undefined, MANUAL_PORT);
    const manualAuth = { Authorization: 'Bearer ' + manualLogin.data.token };
    const manualSubmit = await post('/api/wiki/guides/submit', Object.assign({}, guidePayload, { title: '人工审核验证' }), manualAuth, MANUAL_PORT);
    check('人工审核模式下投稿进入待审核', manualSubmit.status === 200 && manualSubmit.data.status === 'pending' && manualSubmit.data.autoApproved === false, JSON.stringify(manualSubmit.data || {}));
    const manualPublic = await request('/api/wiki/content', { port: MANUAL_PORT });
    check('HTTP 首次启动迁移旧 JSON 到 SQLite', fs.existsSync(path.join(MANUAL_DATA, 'wiki.db')) && manualPublic.data.officialRevision === 5 && manualPublic.data.guides.some(g => g.id === 'legacy-official-http') && manualPublic.data.updates.some(u => u.title === '旧更新 HTTP'), JSON.stringify({ revision: manualPublic.data.officialRevision }));
    check('迁移后的旧版待审投稿仍不公开', !manualPublic.data.guides.some(g => g.id === 'ug_abcdef123456'), 'ug_abcdef123456');
    check('人工审核模式下待审核投稿不公开', !manualPublic.data.guides.some(g => g.id === manualSubmit.data.guideId), manualSubmit.data.guideId);
    check('人工审核模式管理员注册成功', (await registerAccount('manualadmin', MANUAL_PORT)).status === 200);
    const manualOtp = await provisionAdmin(manualSrv, MANUAL_DATA, 'manualadmin');
    const manualAdminLogin = await post('/api/admin/login', { username: 'manualadmin', password: 'wiki-test-1234', otp: manualOtp }, undefined, MANUAL_PORT);
    const manualAdminAuth = { Authorization: 'Bearer ' + manualAdminLogin.data.token };
    const manualPending = await request('/api/admin/wiki/guides?status=pending', { headers: manualAdminAuth, port: MANUAL_PORT });
    check('人工审核模式管理员可查看待审核投稿', manualPending.status === 200 && manualPending.data.autoApprove === false && manualPending.data.guides.some(g => g.id === manualSubmit.data.guideId), JSON.stringify(manualPending.data || {}));
    const manualApprove = await post('/api/admin/wiki/guides/review', { id: manualSubmit.data.guideId, action: 'approve', expectedStatus: 'pending', note: '' }, manualAdminAuth, MANUAL_PORT);
    check('人工审核通过投稿成功', manualApprove.status === 200 && manualApprove.data.guide.status === 'approved' && manualApprove.data.guide.autoApproved === false, JSON.stringify(manualApprove.data || {}));
    const manualAfter = await request('/api/wiki/content', { port: MANUAL_PORT });
    check('人工审核通过后公开可见', manualAfter.data.guides.some(g => g.id === manualSubmit.data.guideId && g.status === 'approved'), manualSubmit.data.guideId);
  } finally {
    if (manualSrv) killTree(manualSrv);
  }

  const savedConfigBeforeFeature = fs.existsSync(path.join(TMP_DATA, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'config.json'), 'utf8')) : {};
  const wikiDbFile = path.join(TMP_DATA, 'wiki.db');
  const dbStore = new WikiStore(wikiDbFile);
  const dbOfficial = dbStore.getOfficialContent();
  const dbSubmitted = dbStore.getGuide(submitted.data.guideId);
  const dbDeleted = dbStore.getGuide(deletedSubmit.data.guideId, { includeDeleted: true });
  dbStore.close();
  check('Wiki 内容落盘 SQLite 且不污染 config.json', fs.existsSync(wikiDbFile) && fs.statSync(wikiDbFile).size > 0 && dbOfficial.guides.length >= 10 && dbOfficial.updates.length >= 1 && !!dbSubmitted && dbSubmitted.status === 'approved' && !!dbDeleted && !!dbDeleted.deletedAt && !Object.prototype.hasOwnProperty.call(savedConfigBeforeFeature, 'wikiContent') && !Object.prototype.hasOwnProperty.call(savedConfigBeforeFeature, 'wikiUserGuides'), JSON.stringify({ db: fs.existsSync(wikiDbFile), official: dbOfficial.guides.length, configKeys: Object.keys(savedConfigBeforeFeature) }));
  check('Wiki 不再写旧版 JSON 文件', !fs.existsSync(path.join(TMP_DATA, 'wiki.json')) && !fs.existsSync(path.join(TMP_DATA, 'wiki-guides.json')), 'wiki.json/wiki-guides.json');
  const featureSave = await post('/api/admin/features', { features: { mall: false } }, { Authorization: 'Bearer ' + adminLogin.data.token });
  check('管理端保存功能开关成功', featureSave.status === 200, JSON.stringify(featureSave.data || {}));
  const changed = await request('/api/version?profile=wiki');
  check('配置保存推进配置代数', changed.data.snapshot.configRevision > snap.configRevision, JSON.stringify({ before: snap.configRevision, after: changed.data.snapshot.configRevision }));
  check('配置保存改变规则哈希与 ETag', changed.data.snapshot.configHash !== snap.configHash && changed.headers.etag !== wiki.headers.etag, JSON.stringify({ before: snap.configHash, after: changed.data.snapshot.configHash }));
  const savedConfig = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'config.json'), 'utf8'));
  check('配置代数随 config.json 持久化', savedConfig.wikiConfigRevision === changed.data.snapshot.configRevision, JSON.stringify({ file: savedConfig.wikiConfigRevision, api: changed.data.snapshot.configRevision }));

  // 配装：同一份 data.js 函数接收服务端 profile 的规则。
  if (snap) {
    D.setComponentCfg(snap.rulesConfig.componentCfg);
    const base = D.COMPONENT_BASES.find(b => b.pool.some(a => a.type === 'speed'));
    const compId = D.instanceId(base.id, 'common', [{ type: 'speed', value: 50 }]);
    const bd = {}; bd[base.part] = { compId: compId };
    const spot = snap.grounds[0].spots[0];
    const rules = { cast: snap.rulesConfig.castCfg, biteFormula: snap.rulesConfig.biteFormula, doubleBase: snap.rulesConfig.doubleBase };
    const sim = D.simulateRodPlan(bd, spot, rules);
    check('配装共享计算汇总词缀与抛竿间隔', sim.eff.speed === 50 && sim.info.affixSpeed === 50 && sim.info.interval === 1500, JSON.stringify({ eff: sim.eff, info: sim.info }));
    check('配装共享计算上鱼率使用服务端公式', sim.bite === 90, JSON.stringify(sim));
    check('双钓公式 A=100、B=0 时追加概率 50%', Math.abs(D.doubleProbOf(100, 0) - 0.5) < 1e-12, String(D.doubleProbOf(100, 0)));
  }

  // 熔炼：文档中的本地固定样例，只验证共享公式，不代表线上配置。
  D.setSmeltCfg(D.defaultSmeltCfg());
  const empty = D.smeltRatesOf(D.smeltLoadOf([]), false);
  check('熔炼空投料固定样例：50% / 5000 金币', empty.rate === 50 && D.smeltGoldOf(D.smeltLoadOf([]), false) === 5000, JSON.stringify(empty));
  const mat = D.smeltMaterialIds()[0];
  const load20 = D.smeltLoadOf([{ id: mat, qty: 20 }]);
  const rates20 = D.smeltRatesOf(load20, false);
  const probs20 = D.smeltSuccessProbs(rates20, true);
  check('熔炼 20 份固定样例：10% / 95% / 9.5% / 23000 金币', rates20.rate === 10 && rates20.extraRate === 95 && probs20.full === 9.5 && D.smeltGoldOf(load20, false) === 23000, JSON.stringify({ rates: rates20, probs: probs20, gold: D.smeltGoldOf(load20, false) }));
  check('熔炼宝珠只改变费用与边界取值', D.smeltGoldOf(load20, true) === 43000 && D.smeltRatesOf(load20, true).rate === 10, JSON.stringify({ gold: D.smeltGoldOf(load20, true), rates: D.smeltRatesOf(load20, true) }));

  // SQLite 存储层：旧 JSON 迁移 + 重启持久化 + 正文搜索。
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-wiki-store-'));
  const legacyWiki = { wikiContent: { guides: [{ id: 'legacy-guide', kind: 'official', status: 'published', title: '旧版官方', category: '机制说明', aliases: ['旧'], tags: ['迁移'], updatedAt: '2026-09-01', summary: '旧版摘要', sections: [{ h: '旧段落', type: 'p', text: '旧正文' }] }], updates: [{ date: '2026-09-01', title: '旧更新', summary: '旧更新摘要' }] }, wikiContentRevision: 7, wikiContentUpdatedAt: '2026-09-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(storeDir, 'wiki.json'), JSON.stringify(legacyWiki), 'utf8');
  fs.writeFileSync(path.join(storeDir, 'wiki-guides.json'), JSON.stringify({ wikiUserGuides: [{ id: 'ug_abcdefabcdef', kind: 'user', status: 'pending', title: '旧投稿', category: '心得分享', summary: '旧投稿摘要', tags: ['迁移'], aliases: [], authorKey: 'olduser', authorName: '旧玩家', submittedAt: '2026-09-02T00:00:00.000Z', reviewedAt: null, reviewedBy: null, reviewNote: '', sections: [{ h: '投稿段落', type: 'p', text: '投稿正文' }] }], wikiUserGuidesRevision: 3 }), 'utf8');
  const storeA = new WikiStore(path.join(storeDir, 'wiki.db'));
  const imported = storeA.importLegacy({ officialSeed: { guides: [], updates: [] }, wikiJsonFile: path.join(storeDir, 'wiki.json'), wikiGuidesFile: path.join(storeDir, 'wiki-guides.json') });
  check('SQLite 首次启动迁移旧 JSON', imported.imported === true && imported.official === 1 && imported.user === 1 && storeA.getOfficialRevision() === 7 && storeA.getUserRevision() === 3 && storeA.getGuide('legacy-guide').sections.length === 1 && storeA.getGuide('ug_abcdefabcdef').status === 'pending', JSON.stringify(imported));
  storeA.close();
  const storeB = new WikiStore(path.join(storeDir, 'wiki.db'));
  const importedAgain = storeB.importLegacy({ officialSeed: { guides: [], updates: [] } });
  check('SQLite 重开不重复迁移且内容持久', importedAgain.imported === false && storeB.getOfficialContent().guides.length === 1 && storeB.getGuide('ug_abcdefabcdef').title === '旧投稿' && storeB.getUserRevision() === 3, JSON.stringify(importedAgain));
  const insResult = storeB.insertUserGuide({ id: 'ug_1234567890ab', kind: 'user', status: 'approved', title: '新投稿', category: '心得分享', summary: '新摘要', tags: [], aliases: [], authorKey: 'newuser', authorName: '新玩家', submittedAt: new Date().toISOString(), reviewedAt: new Date().toISOString(), reviewedBy: 'auto', reviewNote: '自动通过', sections: [{ h: '新段落', type: 'p', text: '新的正文关键词' }] });
  check('SQLite 玩家投稿写入推进 revision', insResult.revision === 4 && !!storeB.getPublicGuide('ug_1234567890ab'), JSON.stringify(insResult));
  const storeSearch = storeB.listPublicGuides({ q: '新的正文关键词' });
  const storePage = storeB.listPublicGuides({ limit: 1, offset: 0 });
  check('SQLite 搜索覆盖正文且列表可分页', storeSearch.items.length === 1 && storeSearch.items[0].id === 'ug_1234567890ab' && storePage.items.length === 1 && storePage.total >= 2, JSON.stringify({ search: storeSearch.total, page: storePage.total }));
  storeB.close();

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：' + failed.join('、')); process.exitCode = 1; }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => { if (srv) killTree(srv); });
