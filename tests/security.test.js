'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const S = require('../backend/security');
const { waitFor } = require('./_util');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-security-'));
const base = 'http://127.0.0.1:9001';
let server, output = '', errors = '', checks = 0;
const streams = [];
function ok(value, message) { assert.ok(value, message); checks++; }
async function request(p, body, headers = {}) {
  const u = new URL(p, base);
  const bearer = body && body.token || u.searchParams.get('token');
  if (bearer) { headers = { ...headers, Authorization: 'Bearer ' + bearer }; u.searchParams.delete('token'); }
  if (body && Object.prototype.hasOwnProperty.call(body, 'token')) { body = { ...body }; delete body.token; }
  const r = await fetch(u, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2500) });
  return { status: r.status, data: await r.json() };
}
async function login(username, password = 'pass1234', extra = {}) { return request('/api/login', { username, password, ...extra }); }
async function adminLogin(username) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'accounts', username + '.json')));
  return request('/api/admin/login', { username, password: 'pass1234', otp: S.totp(rec.adminTotpSecret) });
}
async function command(cmd, username) {
  server.stdin.write(cmd + ' ' + username + '\n');
  ok(await waitFor(() => {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'accounts', username + '.json')));
    return !!rec.adminTotpSecret;
  }), 'local administrator setup');
}
async function online(token) {
  await new Promise((resolve, reject) => {
    const req = http.get(base + '/events', { headers: { Authorization: 'Bearer ' + token } }, res => { res.once('data', resolve); res.on('data', () => {}); });
    req.on('error', reject); streams.push(req);
  });
}
async function start() {
  output = ''; errors = '';
  server = spawn(process.execPath, ['backend/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '9001', BIND_HOST: '0.0.0.0', FISHING_DATA_DIR: dir, TRUSTED_PROXY_IPS: '' }, windowsHide: true });
  server.stdout.on('data', d => { output += d; }); server.stderr.on('data', d => { errors += d; });
  ok(await waitFor(() => output.includes('API 服务器已启动'), { timeout: 5000 }), 'server started: ' + errors);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.stdin.write('q\n'); await exited;
}
(async () => {
  try {
    // Refuse to reuse or terminate any existing listener.
    await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(9001, '127.0.0.1', () => s.close(resolve)); });
    fs.mkdirSync(path.join(dir, 'accounts'));
    for (const username of ['seller', 'buyer', 'guarduser']) fs.writeFileSync(path.join(dir, 'accounts', username + '.json'), JSON.stringify({ username, name: username, salt: 'test', pwHash: crypto.createHash('sha256').update('test:pass1234').digest('hex'), coins: 10000, inventory: { crucian: 100, rope: 100 }, bd: {}, codex: {} }));
    // RFC 6238 vector and proxy trust boundary.
    ok(S.totp(Buffer.from('12345678901234567890').toString('hex'), 1) === '287082', 'TOTP standard vector');
    const originalProxy = process.env.TRUSTED_PROXY_IPS;
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    ok(S.clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.4' } }) === '198.51.100.4', 'ignore forged leftmost proxy entry');
    ok(S.clientIp({ socket: { remoteAddress: '198.51.100.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } }) === '198.51.100.5', 'untrusted peer cannot supply address');
    if (originalProxy === undefined) delete process.env.TRUSTED_PROXY_IPS; else process.env.TRUSTED_PROXY_IPS = originalProxy;
    await start();
    for (const nic of Object.values(os.networkInterfaces()).flat().filter(x => x.family === 'IPv4' && !x.internal)) {
      let accessible = false;
      try { await fetch('http://' + nic.address + ':9001/api/version', { signal: AbortSignal.timeout(1000) }); accessible = true; } catch (_) {}
      ok(!accessible, '9001 inaccessible via external interface ' + nic.address);
    }
    const invalid = [0, -1, 1.5, '1', true, null, {}, [], 1e100];
    for (const p of ['/api/login', '/api/register', '/api/admin/login']) {
      for (const username of [{}, [], 12, null]) ok((await request(p, { username, password: 'pass1234' })).status === 400, p + ' rejects username');
      ok((await request(p, { username: 'seller', password: {} })).status === 400, p + ' rejects password');
    }
    ok((await request('/api/register', { username: 'newbie', password: 'pass1234', name: {}, qq: '12345' })).status === 400, 'invalid display name');
    ok((await request('/api/login', [])).status === 400, 'array body');
    const huge = await request('/api/login', { username: 'x'.repeat(1000001), password: 'x' });
    ok(huge.status === 413, 'body size limit');
    let seller = (await login('seller')).data.token, buyer = (await login('buyer')).data.token;
    ok((await request('/api/admin/login', { username: 'seller', password: 'pass1234' })).status === 403, 'no public administrator bootstrap');
    await command('admin-init', 'seller');
    ok((await request('/api/admin/login', { username: 'seller', password: 'pass1234', otp: 'invalid' })).status === 401, 'MFA required');
    const admin = await adminLogin('seller'); ok(admin.status === 200, 'MFA login');
    ok((await adminLogin('seller')).status === 401, 'MFA replay rejected');
    seller = (await login('seller')).data.token; // Login kicks old sessions, so refresh admin via next unused time step.
    ok((await request('/api/admin/session?token=' + seller)).status === 403, 'game login cannot bypass MFA');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'accounts/seller.json')));
    const nextAdmin = await request('/api/admin/login', { username: 'seller', password: 'pass1234', otp: S.totp(rec.adminTotpSecret, Math.floor(Date.now() / 30000) + 1) });
    ok(nextAdmin.status === 200, 'MFA accepts clock tolerance');
    const token = nextAdmin.data.token;
    ok((await request('/api/admin/users/setadmin', { token, target: 'seller', admin: false })).status === 400, 'last admin cannot be revoked');
    ok((await request('/api/admin/users/delete', { token, target: 'seller', confirm: true })).status === 400, 'last admin cannot be deleted');
    server.stdin.write('admin-init buyer\n');
    ok(await waitFor(() => output.includes('已有管理员')), 'repeat initialization rejected');
    const initialBuyer = (await request('/api/me?token=' + buyer)).data;
    const listing = await request('/api/market/list', { token: seller, id: 'rope', qty: 5, price: 2, hours: 6 });
    ok(listing.status === 200, 'valid listing');
    const baseline = (await request('/api/me?token=' + seller)).data;
    for (const v of invalid) {
      for (const [p, body] of [
        ['/api/sell', { token: seller, id: 'crucian', qty: v }],
        ['/api/market/list', { token: seller, id: 'rope', qty: v, price: 2 }],
        ['/api/market/list', { token: seller, id: 'rope', qty: 1, price: v }],
        ['/api/market/list', { token: seller, id: 'rope', qty: 1, price: 2, hours: v }],
        ['/api/market/buy', { token: buyer, lid: listing.data.listing.lid, qty: v }],
        ['/api/chest/craft', { token: seller, chestId: 'chest_wreck', qty: v }],
        ['/api/mall/buy', { token: seller, id: 'rope', qty: v }],
      ]) ok((await request(p, body)).status === 400, p + ' invalid ' + JSON.stringify(v));
    }
    for (const [tok, before] of [[seller, baseline], [buyer, initialBuyer]]) {
      const after = (await request('/api/me?token=' + tok)).data;
      assert.deepEqual(after.inventory, before.inventory); ok(after.coins === before.coins, 'invalid mutations leave assets unchanged');
    }
    ok((await request('/api/market/buy', { token: buyer, lid: listing.data.listing.lid, qty: 6 })).status === 400, 'overbuy rejected');
    const bought = await request('/api/market/buy', { token: buyer, lid: listing.data.listing.lid });
    ok(bought.status === 200 && bought.data.qty === 5, 'omitted quantity retains whole-order behavior');
    ok((await request('/api/sell', { token: seller, id: 'crucian', qty: 1 })).status === 200, 'valid sale');
    await online(seller); await online(buyer);
    const tradeId = (await request('/api/trade/invite', { token: seller, target: 'buyer' })).data.tradeId;
    ok(!!tradeId, 'trade created');
    await request('/api/trade/respond', { token: buyer, tradeId, accept: true });
    for (const v of invalid) ok((await request('/api/trade/set', { token: seller, tradeId, items: [{ id: 'rope', qty: v }] })).status === 400, 'invalid trade quantity');
    ok((await request('/api/trade/set', { token: seller, tradeId, items: [{ id: 'rope', qty: 90 }, { id: 'rope', qty: 90 }] })).status === 400, 'duplicate trade items rejected');
    ok((await request('/api/trade/set', { token: seller, tradeId, items: [{ id: 'rope', qty: 1 }] })).status === 200, 'valid trade offer');
    await request('/api/trade/confirm', { token: seller, tradeId });
    ok((await request('/api/trade/confirm', { token: buyer, tradeId })).data.done, 'valid trade settles');
    for (let i = 0; i < 5; i++) ok((await login('guarduser', 'wrong')).status === 401, 'initial failures');
    ok((await login('guarduser', 'wrong')).status === 429, 'lock active');
    ok((await request('/api/login', { username: 'guarduser', password: 'wrong' }, { 'X-Forwarded-For': '198.51.100.9' })).status === 429, 'forged forwarding header cannot bypass lock');
    const source = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
    const routes = [...source.matchAll(/p === '(\/api\/admin\/[^']+)' && req.method === '(GET|POST)'/g)].filter(m => !['/api/admin/login', '/api/admin/logout'].includes(m[1]));
    for (const [, p, method] of routes) {
      // Validation intentionally precedes authorization for malformed bodies; well-formed requests still require MFA.
      const r = await request(p + (method === 'GET' ? '?token=' + buyer : ''), method === 'POST' ? { token: buyer } : undefined);
      ok(r.status === 403, p + ' ordinary user denied');
    }
    for (const stream of streams) stream.destroy();
    ok(!errors.includes('uncaughtException'), 'no uncaught request errors');
    await stop(); await start();
    ok((await request('/api/admin/session?token=' + token)).status === 200, 'MFA session survives restart');
    ok((await request('/api/admin/session?token=' + seller)).status === 403, 'normal session remains non-MFA after restart');
    let lastRegistration;
    for (let i = 0; i < 21; i++) lastRegistration = await request('/api/register', { username: 'bad name', password: 'pass1234', qq: '12345' });
    ok(lastRegistration.status === 429, 'registration source limit');
    for (let i = 0; i < 31; i++) await request('/api/login', { username: 'rateaccount', password: 'wrong' });
    ok((await request('/api/login', { username: 'rateaccount', password: 'wrong' })).status === 429, 'account request limit');
    console.log('PASS ' + checks + ' security assertions; isolated data: ' + dir);
  } finally { for (const stream of streams) stream.destroy(); await stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
