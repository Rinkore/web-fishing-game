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
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
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
  check('/wiki/ 同域托管 M1 验收页', wikiPage.status === 200 && /text\/html/.test(wikiPage.headers['content-type'] || '') && wikiPage.body.includes('wiki · 钓鱼网站') && wikiPage.body.includes('/wiki/js/core.js'), JSON.stringify({ status: wikiPage.status, type: wikiPage.headers['content-type'] }));
  check('/wiki/ 静态页使用 no-cache', String(wikiPage.headers['cache-control']).includes('no-cache'), String(wikiPage.headers['cache-control']));

  const corePages = [
    ['/wiki/items/index.html', 'data-page="items"'],
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

  const shop = await request('/shop');
  check('/shop 复用为实时价且 no-store', shop.status === 200 && shop.headers['cache-control'] === 'no-store', JSON.stringify({ status: shop.status, cache: shop.headers['cache-control'] }));

  const wikiContent = await request('/api/wiki/content');
  check('Wiki 攻略接口返回内置内容', wikiContent.status === 200 && wikiContent.data.revision >= 1 && Array.isArray(wikiContent.data.guides) && wikiContent.data.guides.length > 0 && Array.isArray(wikiContent.data.updates), JSON.stringify({ status: wikiContent.status, revision: wikiContent.data && wikiContent.data.revision, guides: wikiContent.data && wikiContent.data.guides && wikiContent.data.guides.length }));
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
  const invalidWikiSave = await post('/api/admin/wiki/content', { content: { guides: [], updates: [] } }, { Authorization: 'Bearer ' + adminLogin.data.token });
  check('管理员提交空攻略被拒绝', invalidWikiSave.status === 400 && !!invalidWikiSave.data.error, JSON.stringify(invalidWikiSave.data || {}));
  const hotContent = JSON.parse(JSON.stringify(wikiContent.data));
  hotContent.guides[0].title = '热更新验证：' + hotContent.guides[0].title;
  hotContent.updates.unshift({ date: '2026-09-18', title: '热更新验证', summary: '测试保存后立即生效。' });
  const hotSave = await post('/api/admin/wiki/content', { target: 'wiki-guides', content: { guides: hotContent.guides, updates: hotContent.updates } }, { Authorization: 'Bearer ' + adminLogin.data.token });
  check('管理员保存 Wiki 攻略成功', hotSave.status === 200 && hotSave.data.revision === wikiContent.data.revision + 1 && hotSave.data.guides[0].title === hotContent.guides[0].title, JSON.stringify(hotSave.data || { status: hotSave.status }));
  const hotRead = await request('/api/wiki/content');
  check('Wiki 攻略保存后公开接口立即可读', hotRead.status === 200 && hotRead.data.revision === hotSave.data.revision && hotRead.data.guides[0].title === hotContent.guides[0].title && hotRead.headers.etag !== wikiContent.headers.etag, JSON.stringify({ revision: hotRead.data && hotRead.data.revision }));
  const savedWiki = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'wiki.json'), 'utf8'));
  const savedConfigBeforeFeature = fs.existsSync(path.join(TMP_DATA, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'config.json'), 'utf8')) : {};
  check('Wiki 攻略独立落盘且不污染 config.json', savedWiki.wikiContentRevision === hotSave.data.revision && !Object.prototype.hasOwnProperty.call(savedConfigBeforeFeature, 'wikiContent'), JSON.stringify({ revision: savedWiki.wikiContentRevision, configKeys: Object.keys(savedConfigBeforeFeature) }));
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
