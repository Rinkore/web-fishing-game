'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const { spawn } = require('node:child_process');
const { waitFor } = require('./_util');
const { solve } = require('./_registration');
const D = require('../frontend/js/data');
const marketPage = require('../backend/market-page');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-abuse-market-'));
const base = 'http://127.0.0.1:19126';
let child, logs = '', errors = '', stream, checks = 0;
function ok(v, label) { assert.ok(v, label); checks++; }
async function call(p, body, token, ip) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, data: await r.json() };
}
const register = (username, ip, proof) => call('/api/register', { username, password: 'Safe-Register-Pass-77', qq: '12345', ...(proof ? { proof } : {}) }, null, ip);
(async () => {
  try {
    fs.mkdirSync(path.join(dir, 'accounts'));
    const sessions = { tokens: {} };
    for (const key of ['seller', 'buyer', 'admin']) {
      fs.writeFileSync(path.join(dir, 'accounts', key + '.json'), JSON.stringify({ username: key, name: key, coins: 1000000, inventory: { rope: 1000 }, bd: {}, listingCap: 0, admin: key === 'admin' }));
      sessions.tokens[crypto.createHash('sha256').update(key + '-test-token').digest('hex')] = { k: key, e: Date.now() + 3600000, m: key === 'admin', v: 2 };
    }
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions));
    const now = Date.now();
    const listings = Array.from({ length: 205 }, (_, i) => ({ lid: i + 1, seller: i < 65 ? 'buyer' : 'seller', sellerName: i < 65 ? 'buyer' : 'seller', id: i % 2 ? 'rope' : 'crucian', name: i === 80 ? 'UniqueNeedle' : 'item' + i, qty: 5, price: i + 1, t: now - i, expireAt: now + 86400000, hours: 24, src: 'private', internalSecret: 'do-not-publish' }));
    fs.writeFileSync(path.join(dir, 'market.json'), JSON.stringify({ listings, listingSeq: 206 }));
    // Component filtering and global sort before pagination.
    const component = D.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: 50 }]);
    const rows = listings.concat({ ...listings[0], lid: 999, id: component, price: 9999 });
    const aff = marketPage.page(rows, { affix: 'speed', min: '40', sort: 'affix', size: '1' }, null, 0);
    ok(aff.total === 1 && aff.listings[0].lid === 999, 'affix filter applies across full market');
    child = spawn(process.execPath, ['backend/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '19126', BIND_HOST: '127.0.0.1', FISHING_DATA_DIR: dir, TRUSTED_PROXY_IPS: '127.0.0.1', REQUIRE_HTTPS: '0', REGISTER_GLOBAL_HOURLY: '30' }, windowsHide: true });
    child.stdout.on('data', d => logs += d); child.stderr.on('data', d => errors += d);
    ok(await waitFor(() => logs.includes('API 服务器已启动')), 'server ready');
    const first = (await call('/api/market')).data;
    ok(first.listings.length === 30 && first.total === 205 && first.pages === 7, 'default bounded public page');
    ok(!JSON.stringify(first).includes('internalSecret') && !JSON.stringify(first).includes('private'), 'explicit public fields');
    const all = [];
    for (let page = 1; page <= first.pages; page++) all.push(...(await call('/api/market?page=' + page)).data.listings);
    ok(all.length === 205 && new Set(all.map(l => l.lid)).size === 205, 'all pages have no duplicates or omissions in unchanged market');
    for (const q of ['size=101', 'size=0', 'size=-1', 'page=1.5', 'page=1&page=2', 'q[]=x', 'min=NaN', 'max=Infinity', 'min=10&max=2']) ok((await call('/api/market?' + q)).status === 400, 'reject invalid query ' + q);
    ok((await call('/api/market?size=100')).data.listings.length === 100, 'maximum page size');
    ok((await call('/api/market?q=UniqueNeedle')).data.total === 1, 'search finds listing outside first page');
    ok((await call('/api/market?sort=price&dir=desc&size=1')).data.listings[0].price === 205, 'sort before slicing');
    const mine = (await call('/api/market?scope=mine&page=3', undefined, 'buyer-test-token')).data;
    ok(mine.total === 65 && mine.mineCount === 65 && mine.listings.length === 5, 'own listings paginated independently');
    const others = (await call('/api/market?scope=others', undefined, 'buyer-test-token')).data;
    ok(others.total === 140 && others.listings.every(l => l.seller === 'seller'), 'exclude my listings globally');
    ok((await call('/api/market?page=999')).data.page === 7, 'page beyond end clamps');
    const events = [];
    stream = http.get(base + '/events', { headers: { Authorization: 'Bearer buyer-test-token' } }, res => {
      let buf = '';
      res.on('data', d => { buf += d; let pos; while ((pos = buf.indexOf('\n\n')) >= 0) { const part = buf.slice(0, pos); buf = buf.slice(pos + 2); const line = part.split('\n').find(l => l.startsWith('data: ')); if (!line) continue; const ev = JSON.parse(line.slice(6)); events.push(...(ev.type === 'batch' ? ev.list : [ev])); } });
    });
    ok(await waitFor(() => events.some(e => e.type === 'init')), 'SSE init');
    ok(!('market' in events.find(e => e.type === 'init')), 'SSE init excludes full market');
    const created = await call('/api/market/list', { id: 'rope', qty: 3, price: 8 }, 'seller-test-token');
    ok(created.status === 200, 'listing creation');
    ok(await waitFor(() => events.some(e => e.type === 'marketDelta' && e.upsert && e.upsert.some(l => l.lid === created.data.listing.lid))), 'incremental upsert broadcast');
    const startRevision = events.filter(e => e.type === 'marketDelta').at(-1).revision;
    const purchase = await call('/api/market/buy', { lid: created.data.listing.lid, qty: 1 }, 'buyer-test-token');
    ok(purchase.status === 200, 'partial purchase');
    ok(await waitFor(() => events.some(e => e.type === 'marketDelta' && e.revision > startRevision && e.upsert && e.upsert.some(l => l.lid === created.data.listing.lid && l.qty === 2))), 'quantity delta');
    await call('/api/market/cancel', { lid: created.data.listing.lid }, 'seller-test-token');
    ok(await waitFor(() => events.some(e => e.type === 'marketDelta' && e.removed && e.removed.includes(created.data.listing.lid))), 'incremental deletion');
    ok(events.filter(e => e.type === 'marketDelta').every(e => JSON.stringify(e).length < 3000 && !e.listings), 'small mutations never send full market');
    const bulk = await call('/api/admin/market/bulk', { seller: 'seller', counts: { material: 150 } }, 'admin-test-token');
    ok(bulk.status === 200, 'admin bulk creation');
    ok(await waitFor(() => events.some(e => e.type === 'marketDelta' && e.reset === true)), 'large batch uses bounded resync notification');
    const rev = events.filter(e => e.type === 'marketDelta').at(-1).revision;
    ok((await call('/api/market')).data.revision === rev, 'page revision supports client resync');
    for (let i = 0; i < 3; i++) ok((await register('reg' + i, '198.51.100.1')).status === 200, 'low-risk registration');
    ok((await register('reg3', '198.51.100.1')).data.code === 'REGISTRATION_CHALLENGE', 'fourth attempt requires proof');
    const c = (await call('/api/register/challenge', undefined, null, '198.51.100.1')).data;
    const proof = solve(c);
    ok((await register('reg3', '198.51.100.1', proof)).status === 200, 'valid one-time proof');
    ok((await register('reg4', '198.51.100.1', proof)).data.code === 'REGISTRATION_CHALLENGE', 'proof replay rejected');
    const wrongSource = solve((await call('/api/register/challenge', undefined, null, '198.51.100.2')).data);
    ok((await register('reg5', '198.51.100.1', wrongSource)).data.code === 'REGISTRATION_CHALLENGE', 'proof bound to source');
    let limited;
    for (let i = 0; i < 4; i++) limited = await register('flood' + i, '198.51.100.1');
    ok(limited.status === 429, 'source hourly quota');
    for (let i = 2; i < 6; i++) {
      const dup = await register('reg0', '198.51.100.' + i);
      ok(dup.status === 409 && !dup.data.error.includes('已存在'), 'generic duplicate failure');
    }
    ok((await register('reg0', '198.51.100.8')).status === 429, 'username quota spans source addresses');
    let global;
    for (let i = 10; i < 31; i++) global = await register('global' + i, '198.51.100.' + i);
    ok(global.status === 429, 'global hourly quota across sources');
    ok((await call('/api/admin/registration/stats', undefined, 'buyer-test-token')).status === 403, 'monitoring requires MFA admin');
    const stats = (await call('/api/admin/registration/stats', undefined, 'admin-test-token')).data;
    ok(stats.attention && stats.counters.limited > 0 && stats.counters.duplicate === 4 && stats.counters.challenged >= 3, 'admin anomaly counters');
    ok(!JSON.stringify(stats).includes('198.51.100'), 'monitoring does not expose source details');
    ok(!errors.includes('uncaughtException'), 'no uncaught errors');
    console.log('PASS ' + checks + ' registration/market assertions');
  } finally {
    if (stream) stream.destroy();
    if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.stdin.write('q\n'); await exited; }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
