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
const PORT = 8271;
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-wiki-test-'));
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function request(pathname, options) {
  options = options || {};
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = Object.assign({}, options.headers || {});
  if (body) headers['Content-Type'] = 'application/json';
  return new Promise(resolve => {
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method: options.method || 'GET', headers: headers }, res => {
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
async function post(pathname, body, headers) { return request(pathname, { method: 'POST', body: body, headers: headers }); }
async function registerAccount(username) {
  const payload = { username: username, password: 'wiki-test-1234', name: 'Wiki Test', qq: '827100' };
  let r = await post('/api/register', payload);
  if ((r.status === 200 || r.status === 403) && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }

let srv = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, SOURCE_COMMIT: SOURCE_COMMIT }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });

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
  check('Wiki 快照目录包含鱼类/材料/组件/宝匣/部位', snap && snap.catalog.fish.length === 40 && snap.catalog.materials.length === 7 && snap.catalog.components.length === 29 && snap.catalog.chests.length === 4 && snap.catalog.rodParts.length === 7, JSON.stringify(snap && { fish: snap.catalog.fish.length, materials: snap.catalog.materials.length, components: snap.catalog.components.length, chests: snap.catalog.chests.length, rodParts: snap.catalog.rodParts.length }));
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
  check('版本记录静态文件可访问并与主线同步', versions.status === 200 && versions.data.count === 77 && versions.data.versions.some(v => v.version === 'v0.19.0'), JSON.stringify({ status: versions.status, count: versions.data && versions.data.count }));

  const shop = await request('/shop');
  check('/shop 复用为实时价且 no-store', shop.status === 200 && shop.headers['cache-control'] === 'no-store', JSON.stringify({ status: shop.status, cache: shop.headers['cache-control'] }));

  const wikiContent = await request('/api/wiki/content');
  check('Wiki 攻略接口返回内置内容', wikiContent.status === 200 && typeof wikiContent.data.revision === 'string' && wikiContent.data.officialRevision >= 1 && wikiContent.data.userRevision >= 1 && Array.isArray(wikiContent.data.guides) && wikiContent.data.guides.length > 0 && Array.isArray(wikiContent.data.updates), JSON.stringify({ status: wikiContent.status, revision: wikiContent.data && wikiContent.data.revision, guides: wikiContent.data && wikiContent.data.guides && wikiContent.data.guides.length }));
  check('Wiki 官方攻略带官方身份', wikiContent.data.guides.every(g => g.kind !== 'user' || g.status === 'approved'), JSON.stringify(wikiContent.data.guides && wikiContent.data.guides.filter(g => g.kind === 'user').map(g => g.status)));
  check('Wiki 攻略包含热更新后的关键攻略', wikiContent.data.guides.some(g => g.id === 'seven-part-reference-build' && g.sections.some(s => s.h === '实测成本样本')), JSON.stringify(wikiContent.data.guides && wikiContent.data.guides.map(g => g.id)));
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

  // 用户投稿：注册两个用户，分别验证通过、拒绝和作者删除。
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
  check('登录用户提交攻略成功', submitted.status === 200 && submitted.data.status === 'pending' && /^ug_[a-f0-9]{12,24}$/.test(submitted.data.guideId), JSON.stringify(submitted.data || {}));
  const afterSubmitPublic = await request('/api/wiki/content');
  check('待审核攻略不会进入公开接口', !afterSubmitPublic.data.guides.some(g => g.id === submitted.data.guideId), submitted.data.guideId);
  const myGuides = await request('/api/wiki/guides/my', { headers: userAuth });
  check('我的攻略返回待审核投稿', myGuides.status === 200 && myGuides.data.guides.some(g => g.id === submitted.data.guideId && g.status === 'pending'), JSON.stringify(myGuides.data || {}));
  const immediateSecond = await post('/api/wiki/guides/submit', guidePayload, userAuth);
  check('投稿间隔限制生效', immediateSecond.status === 429 && !!immediateSecond.data.limits.nextAllowedAt, JSON.stringify(immediateSecond.data || {}));
  const pendingList = await request('/api/admin/wiki/guides?status=pending', { headers: adminAuth });
  check('管理员可查看待审核投稿', pendingList.status === 200 && pendingList.data.guides.some(g => g.id === submitted.data.guideId) && pendingList.data.guides.every(g => !g.authorKey), JSON.stringify(pendingList.data || {}));
  const wrongReview = await post('/api/admin/wiki/guides/review', { id: submitted.data.guideId, action: 'approve', expectedStatus: 'approved' }, adminAuth);
  check('状态不匹配的重复审核被拒绝', wrongReview.status === 409 && wrongReview.data.currentStatus === 'pending', JSON.stringify(wrongReview.data || {}));
  const approved = await post('/api/admin/wiki/guides/review', { id: submitted.data.guideId, action: 'approve', expectedStatus: 'pending', note: '' }, adminAuth);
  check('管理员通过投稿成功', approved.status === 200 && approved.data.guide.status === 'approved', JSON.stringify(approved.data || {}));
  const afterApprove = await request('/api/wiki/content');
  const publicGuide = afterApprove.data.guides.find(g => g.id === submitted.data.guideId);
  check('审核通过后公开可见且不泄露内部字段', !!publicGuide && publicGuide.status === 'approved' && publicGuide.authorName === 'Wiki Test' && !('authorKey' in publicGuide) && !('reviewNote' in publicGuide), JSON.stringify(publicGuide || null));
  const myAfterApprove = await request('/api/wiki/guides/my', { headers: userAuth });
  check('作者可见已通过状态', myAfterApprove.status === 200 && myAfterApprove.data.guides.some(g => g.id === submitted.data.guideId && g.status === 'approved'), JSON.stringify(myAfterApprove.data || {}));

  check('第二个投稿用户注册成功', (await registerAccount('wikiuser2')).status === 200);
  const user2Login = await post('/api/login', { username: 'wikiuser2', password: 'wiki-test-1234' });
  const user2Auth = { Authorization: 'Bearer ' + user2Login.data.token };
  const rejectedSubmit = await post('/api/wiki/guides/submit', Object.assign({}, guidePayload, { title: '将被拒绝的投稿' }), user2Auth);
  check('第二个用户提交攻略成功', rejectedSubmit.status === 200 && rejectedSubmit.data.status === 'pending', JSON.stringify(rejectedSubmit.data || {}));
  const rejected = await post('/api/admin/wiki/guides/review', { id: rejectedSubmit.data.guideId, action: 'reject', expectedStatus: 'pending', note: '内容需要补充验证。' }, adminAuth);
  check('管理员拒绝投稿必须带原因', rejected.status === 200 && rejected.data.guide.status === 'rejected' && rejected.data.guide.reviewNote === '内容需要补充验证。', JSON.stringify(rejected.data || {}));
  const afterReject = await request('/api/wiki/content');
  check('已拒绝攻略不进入公开接口', !afterReject.data.guides.some(g => g.id === rejectedSubmit.data.guideId), rejectedSubmit.data.guideId);
  const myRejected = await request('/api/wiki/guides/my', { headers: user2Auth });
  check('作者可见拒绝原因', myRejected.status === 200 && myRejected.data.guides.some(g => g.id === rejectedSubmit.data.guideId && g.status === 'rejected' && g.reviewNote === '内容需要补充验证。'), JSON.stringify(myRejected.data || {}));

  check('第三个投稿用户注册成功', (await registerAccount('wikiuser3')).status === 200);
  const user3Login = await post('/api/login', { username: 'wikiuser3', password: 'wiki-test-1234' });
  const user3Auth = { Authorization: 'Bearer ' + user3Login.data.token };
  const deletedSubmit = await post('/api/wiki/guides/submit', Object.assign({}, guidePayload, { title: '将被作者删除的投稿' }), user3Auth);
  check('第三个用户提交攻略成功', deletedSubmit.status === 200 && deletedSubmit.data.status === 'pending', JSON.stringify(deletedSubmit.data || {}));
  const wrongDelete = await post('/api/wiki/guides/delete', { id: deletedSubmit.data.guideId }, user2Auth);
  check('不能删除别人的投稿', wrongDelete.status === 404, JSON.stringify(wrongDelete.data || {}));
  const authorDelete = await post('/api/wiki/guides/delete', { id: deletedSubmit.data.guideId }, user3Auth);
  check('作者可删除待审核投稿', authorDelete.status === 200 && authorDelete.data.ok, JSON.stringify(authorDelete.data || {}));
  const afterDeleteList = await request('/api/admin/wiki/guides?status=all', { headers: adminAuth });
  check('已删除投稿不再出现在审核列表', !afterDeleteList.data.guides.some(g => g.id === deletedSubmit.data.guideId), deletedSubmit.data.guideId);
  const nonAdminReview = await post('/api/admin/wiki/guides/review', { id: submitted.data.guideId, action: 'reject', expectedStatus: 'approved', note: 'x' }, userAuth);
  check('非管理员不能审核攻略', nonAdminReview.status === 403, JSON.stringify(nonAdminReview.data || {}));

  // 官方内容保存不得覆盖用户投稿；恢复内置同样不得影响用户投稿。
  const officialAfterUser = await request('/api/admin/wiki/content', { headers: adminAuth });
  const officialSaveAfterUser = await post('/api/admin/wiki/content', { content: { guides: officialAfterUser.data.guides, updates: officialAfterUser.data.updates }, baseRevision: officialAfterUser.data.officialRevision }, adminAuth);
  check('管理员保存官方内容不影响用户投稿', officialSaveAfterUser.status === 200 && (await request('/api/wiki/guides/my', { headers: userAuth })).data.guides.some(g => g.id === submitted.data.guideId), JSON.stringify(officialSaveAfterUser.data || {}));
  const resetOfficial = await post('/api/admin/wiki/content', { reset: true, baseRevision: officialSaveAfterUser.data.officialRevision }, adminAuth);
  check('恢复官方内置内容不影响用户投稿', resetOfficial.status === 200 && (await request('/api/wiki/guides/my', { headers: userAuth })).data.guides.some(g => g.id === submitted.data.guideId), JSON.stringify(resetOfficial.data || {}));

  const savedWiki = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'wiki.json'), 'utf8'));
  const savedUserGuides = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'wiki-guides.json'), 'utf8'));
  const savedConfigBeforeFeature = fs.existsSync(path.join(TMP_DATA, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'config.json'), 'utf8')) : {};
  check('Wiki 官方与用户投稿独立落盘且不污染 config.json', savedWiki.wikiContentRevision === resetOfficial.data.officialRevision && savedUserGuides.wikiUserGuides.length >= 2 && !Object.prototype.hasOwnProperty.call(savedConfigBeforeFeature, 'wikiContent') && !Object.prototype.hasOwnProperty.call(savedConfigBeforeFeature, 'wikiUserGuides'), JSON.stringify({ official: savedWiki.wikiContentRevision, userGuides: savedUserGuides.wikiUserGuides.length, configKeys: Object.keys(savedConfigBeforeFeature) }));
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

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：' + failed.join('、')); process.exitCode = 1; }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => { if (srv) killTree(srv); });

