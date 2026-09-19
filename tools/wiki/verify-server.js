'use strict';
/*
 * 连接指定服务端验证 Wiki 规则契约。
 * 用法：WIKI_SERVER_BASE=http://localhost:9000 npm run wiki:verify:server
 */
const BASE = (process.env.WIKI_SERVER_BASE || 'http://localhost:9000').replace(/\/$/, '');
const COMMIT = String(process.env.SOURCE_COMMIT || '').toLowerCase();
let failed = false;
function ok(name, value, detail) {
  if (value) console.log('PASS ' + name);
  else { console.error('FAIL ' + name + (detail ? ' -> ' + detail : '')); failed = true; }
}
async function main() {
  const res = await fetch(BASE + '/api/version?profile=wiki', { cache: 'no-store' });
  const data = await res.json().catch(() => null);
  const snap = data && data.snapshot;
  ok('/api/version?profile=wiki 返回 200', res.status === 200, 'HTTP ' + res.status);
  ok('响应外形为 {profile,version,snapshot}', data && data.profile === 'wiki' && !!snap && Object.keys(data).join(',') === 'profile,version,snapshot');
  ok('快照结构有效', !!(snap && snap.schemaVersion === 1 && snap.gameVersion && snap.rulesVersion &&
    /^[0-9a-f]{40}$/.test(snap.sourceCommit || '') && /^[0-9a-f]{64}$/.test(snap.configHash || '') &&
    snap.snapshotId && snap.catalog && Array.isArray(snap.grounds) && snap.rulesConfig));
  ok('profile 使用 no-cache', /no-cache/i.test(res.headers.get('cache-control') || ''), res.headers.get('cache-control'));
  ok('profile 返回 ETag', !!res.headers.get('etag'), res.headers.get('etag'));
  if (COMMIT) ok('来源提交匹配发布注入', snap && snap.sourceCommit === COMMIT, snap && snap.sourceCommit);

  const etag = res.headers.get('etag');
  if (etag) {
    const cached = await fetch(BASE + '/api/version?profile=wiki', { headers: { 'If-None-Match': etag }, cache: 'no-store' });
    ok('ETag 命中返回 304', cached.status === 304, 'HTTP ' + cached.status);
  }

  const grounds = await fetch(BASE + '/api/grounds', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
  ok('快照钓点与 /api/grounds 一致', !!(grounds && snap && JSON.stringify(grounds.grounds) === JSON.stringify(snap.grounds)));

  const shopRes = await fetch(BASE + '/shop', { cache: 'no-store' });
  ok('/shop 返回 200 且 no-store', shopRes.status === 200 && /no-store/i.test(shopRes.headers.get('cache-control') || ''), shopRes.status + ' ' + shopRes.headers.get('cache-control'));
  const shop = await shopRes.json().catch(() => null);
  ok('/shop 返回实时价格目录', !!(shop && Object.keys(shop).length));

  const contentRes = await fetch(BASE + '/api/wiki/content', { cache: 'no-store' });
  const content = await contentRes.json().catch(() => null);
  ok('/api/wiki/content 返回攻略内容', contentRes.status === 200 && !!(content && typeof content.revision === 'string' && content.officialRevision >= 1 && content.userRevision >= 1 && Array.isArray(content.guides) && content.guides.length && Array.isArray(content.updates)), contentRes.status + ' ' + (content && content.revision) + ' / ' + (content && content.guides && content.guides.length));
  ok('攻略内容使用 no-cache 与 ETag', /no-cache/i.test(contentRes.headers.get('cache-control') || '') && !!contentRes.headers.get('etag'), contentRes.headers.get('cache-control') + ' ' + contentRes.headers.get('etag'));
  ok('公开攻略只下发元数据', !!(content && Array.isArray(content.guides) && content.guides.every(g => g.sections === undefined)), JSON.stringify(content && content.guides && content.guides[0]));
  const listRes = await fetch(BASE + '/api/wiki/guides?page=1&pageSize=5', { cache: 'no-store' });
  const list = await listRes.json().catch(() => null);
  ok('攻略列表分页接口可用', listRes.status === 200 && !!(list && list.ok && list.page === 1 && list.pageSize === 5 && Array.isArray(list.guides) && list.guides.length <= 5 && list.total >= list.guides.length), JSON.stringify(list && { total: list.total, page: list.page, size: list.pageSize }));
  const firstGuideId = content && content.guides && content.guides[0] && content.guides[0].id;
  if (firstGuideId) {
    const detailRes = await fetch(BASE + '/api/wiki/guides/' + encodeURIComponent(firstGuideId), { cache: 'no-store' });
    const detail = await detailRes.json().catch(() => null);
    ok('攻略详情按需返回正文', detailRes.status === 200 && !!(detail && detail.ok && detail.guide && detail.guide.id === firstGuideId && Array.isArray(detail.guide.sections) && detail.guide.sections.length), detailRes.status + ' ' + firstGuideId);
  }
  if (failed) process.exit(1);
  console.log('PASS Wiki 服务端契约验证：' + BASE);
}
main().catch(function (e) { console.error('FAIL ' + (e.stack || e)); process.exit(1); });
