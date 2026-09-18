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
  if (failed) process.exit(1);
  console.log('PASS Wiki 服务端契约验证：' + BASE);
}
main().catch(function (e) { console.error('FAIL ' + (e.stack || e)); process.exit(1); });
