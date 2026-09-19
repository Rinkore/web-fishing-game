'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { waitFor } = require('./_util');
const S = require('../backend/security');
const T = require('../backend/transport-security');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-transport-'));
const base = 'http://127.0.0.1:19124';
const origin = 'https://game.example';
const cookieHeaders = { 'X-Session-Mode': 'cookie', 'X-Requested-With': 'FishGame', 'X-Forwarded-Proto': 'https', Origin: origin };
let child, output = '', errors = '', checks = 0;
function ok(v, message) { assert.ok(v, message); checks++; }
async function call(p, body, headers = {}) {
  const res = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch (_) {}
  return { status: res.status, headers: res.headers, data, text };
}
async function start(requireTls = false) {
  output = ''; errors = '';
  child = spawn(process.execPath, ['backend/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '19124', BIND_HOST: '127.0.0.1', FISHING_DATA_DIR: dir, ALLOWED_ORIGINS: origin, TRUSTED_PROXY_IPS: '127.0.0.1', REQUIRE_HTTPS: requireTls ? '1' : '0' }, windowsHide: true });
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => errors += d);
  ok(await waitFor(() => output.includes('API 服务器已启动'), { timeout: 5000 }), 'start: ' + errors);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(r => child.once('exit', r)); child.stdin.write('q\n'); await exited;
}
(async () => {
  try {
    fs.mkdirSync(path.join(dir, 'accounts'));
    const secret = crypto.randomBytes(20).toString('hex');
    const legacy = { username: 'legacy', name: 'Legacy', salt: 'test', pwHash: crypto.createHash('sha256').update('test:oldpass').digest('hex'), coins: 500, inventory: {}, bd: {}, admin: true, adminTotpSecret: secret };
    fs.writeFileSync(path.join(dir, 'accounts/legacy.json'), JSON.stringify(legacy));
    await start();
    const reg = await call('/api/register', { username: 'newplayer', password: 'River!28', qq: '12345' }, cookieHeaders);
    ok(reg.status === 200 && reg.data.token === 'cookie', 'browser never receives raw token');
    const set = reg.headers.get('set-cookie');
    ok(set.includes('__Host-fish_game=') && set.includes('HttpOnly') && set.includes('Secure') && set.includes('SameSite=Strict'), 'secure host-only cookie');
    ok(set.includes('Max-Age=86400'), '24 hour game cookie');
    const cookie = set.split(';')[0], headers = { ...cookieHeaders, Cookie: cookie };
    ok((await call('/api/me', undefined, headers)).status === 200, 'cookie auth');
    ok((await call('/api/admin/session', undefined, headers)).status === 403, 'game cookie isolated from admin');
    const state = await call('/api/me', undefined, headers);
    ok(!state.text.includes('pwHash') && !state.text.includes('adminTotpSecret'), 'no secrets in profile');
    ok(state.headers.get('cache-control') === 'no-store', 'authenticated no-store');
    ok(state.headers.get('strict-transport-security') === 'max-age=31536000', 'HSTS on trusted HTTPS');
    const page = await call('/admin.html', undefined, headers);
    ok(page.headers.get('x-frame-options') === 'DENY', 'admin anti-framing');
    ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"), 'enforced CSP frame restriction');
    ok(page.headers.get('content-security-policy-report-only').includes("script-src 'self'"), 'staged script CSP');
    ok(page.headers.get('x-content-type-options') === 'nosniff' && page.headers.get('referrer-policy') === 'no-referrer', 'security headers');
    ok(reg.headers.get('access-control-allow-origin') === origin && reg.headers.get('vary') === 'Origin', 'exact credentialed origin allowlist');
    for (const bad of ['https://evil.example', 'null', 'https://game.example.evil.example']) {
      const denied = await call('/api/me', undefined, { ...headers, Origin: bad });
      ok(denied.status === 403 && !denied.headers.get('access-control-allow-origin'), 'bad origin rejected ' + bad);
    }
    const missingCsrf = { ...headers }; delete missingCsrf['X-Requested-With'];
    ok((await call('/api/rod/name', { name: 'csrf' }, missingCsrf)).status === 403, 'cookie mutation requires CSRF header');
    ok((await call('/api/rod/name', { name: 'safe' }, headers)).status === 200, 'same-origin-style JSON mutation works');
    const preflight = await fetch(base + '/api/rod/name', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-requested-with,x-session-mode,content-type' } });
    ok(preflight.status === 204 && preflight.headers.get('access-control-allow-headers').includes('X-Requested-With'), 'allowed preflight');
    const sse = await fetch(base + '/events', { headers, signal: AbortSignal.timeout(3000) });
    const reader = sse.body.getReader(); const chunk = await reader.read(); await reader.cancel();
    ok(sse.status === 200 && Buffer.from(chunk.value).toString().includes('init'), 'SSE cookie works without URL token');
    const bearerLogin = await call('/api/login', { username: 'legacy', password: 'oldpass' });
    ok(bearerLogin.status === 200 && bearerLogin.data.token !== 'cookie', 'legacy password works with explicit API bearer mode');
    const token = bearerLogin.data.token;
    ok((await call('/api/me', undefined, { Authorization: 'Bearer ' + token })).status === 200, 'Bearer auth');
    ok((await call('/api/me?token=' + token)).status === 400, 'query credentials rejected');
    ok((await call('/api/rod/name', { token, name: 'bad' })).status === 400, 'body credentials rejected');
    ok((await call('/api/me', undefined, { 'X-Auth-Token': token })).status === 401, 'old custom token header rejected');
    const adm = await call('/api/admin/login', { username: 'legacy', password: 'oldpass', otp: S.totp(secret) }, cookieHeaders);
    ok(adm.status === 200 && adm.data.token === 'cookie', 'MFA cookie login');
    const adminSet = adm.headers.get('set-cookie');
    ok(adminSet.includes('__Host-fish_admin=') && adminSet.includes('Max-Age=1800'), 'separate short admin cookie');
    const adminHeaders = { ...cookieHeaders, Cookie: adminSet.split(';')[0] };
    ok((await call('/api/admin/session', undefined, adminHeaders)).status === 200, 'admin cookie authorizes admin APIs');
    ok((await call('/api/me', undefined, adminHeaders)).status === 401, 'admin cookie does not replace game cookie');
    ok((await call('/api/admin/logout', {}, adminHeaders)).headers.get('set-cookie').includes('Max-Age=0'), 'admin logout clears cookie');
    ok((await call('/api/admin/session', undefined, adminHeaders)).status === 403, 'admin logout revokes session');
    for (const password of ['River!2', 'password1234', 'aaaaaaaa', 'x'.repeat(257)]) ok((await call('/api/register', { username: 'weakuser', password, qq: '12345' })).status === 400, 'weak password rejected');
    ok((await call('/api/logout', {}, headers)).status === 200, 'game logout');
    ok((await call('/api/me', undefined, headers)).status === 401, 'game logout revokes cookie');
    ok((await call('/api/login', { username: 'newplayer', password: 'River!28' })).status === 200, '8-character registered password can log in');
    ok((await call('/api/version')).headers.get('strict-transport-security') === null, 'no HSTS on HTTP');
    await stop();
    const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'accounts/legacy.json')));
    const fresh = JSON.parse(fs.readFileSync(path.join(dir, 'accounts/newplayer.json')));
    ok(migrated.pwHash.startsWith('scrypt$v1$') && !migrated.salt, 'legacy hash migrates on successful login');
    ok(fresh.pwHash.startsWith('scrypt$v1$'), 'new account uses scrypt');
    ok(await T.verifyPassword(migrated, 'oldpass'), 'migrated hash verifies');
    ok(!await T.verifyPassword(migrated, 'incorrect'), 'wrong password rejected');
    const sessions = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json')));
    const entry = sessions.tokens[crypto.createHash('sha256').update(token).digest('hex')];
    ok(entry.e <= Date.now() + T.GAME_TTL, 'fixed bounded persisted expiry');
    entry.e = Date.now() - 1;
    const oldToken = 'legacy-session-test-token';
    sessions.tokens[crypto.createHash('sha256').update(oldToken).digest('hex')] = { k: 'legacy', e: Date.now() + 30 * 86400000, m: true };
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions));
    await start(true);
    ok((await call('/api/version')).status === 426, 'HTTPS mode refuses plaintext');
    ok((await call('/api/version', undefined, { 'X-Forwarded-Proto': 'https' })).status === 200, 'trusted HTTPS proxy accepted');
    ok((await call('/api/me', undefined, { Authorization: 'Bearer ' + token, 'X-Forwarded-Proto': 'https' })).status === 401, 'expired session not restored');
    ok((await call('/api/admin/session', undefined, { Authorization: 'Bearer ' + oldToken, 'X-Forwarded-Proto': 'https' })).status === 403, 'legacy long-lived admin session invalidated');
    ok(!errors.includes('uncaughtException'), 'no uncaught errors');
    console.log('PASS ' + checks + ' transport security assertions');
  } finally { await stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
