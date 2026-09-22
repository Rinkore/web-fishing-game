'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { buildMatrix } = require('../../tools/go-rewrite/contract-matrix');
const { buildSseContract } = require('../../tools/go-rewrite/sse-contract');
const { makeRun, startNode, startGo, cleanup } = require('./ab-harness');

const ROOT = path.resolve(__dirname, '../..');
const matrix = buildMatrix(ROOT);
const sse = buildSseContract(ROOT);
let run;
const services = [];

function jsonRequest(baseUrl, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(pathname, baseUrl);
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function readSse(baseUrl, pathname, token, options = {}) {
  const timeout = options.timeout || 7000;
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
      let text = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, timeout);
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        const match = text.match(/data:\s*(\{[^\n]+\})\s*\n\s*\n/);
        if (!match) return;
        clearTimeout(timer);
        try { resolve({ status: res.statusCode || 0, frame: JSON.parse(match[1]), text }); } catch (error) { reject(error); }
        req.destroy();
      });
      res.on('error', error => { clearTimeout(timer); reject(error); });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}

async function startAdapter(kind) {
  if (kind === 'node') {
    const service = await startNode(run, { name: 'node-ab' });
    services.push(service);
    return { kind, service, token: null };
  }
  const command = process.env.FISHING_GO_AB_COMMAND;
  const database = process.env.FISHING_GO_DATABASE_URL;
  if (!command || !database) return null;
  const service = await startGo(run, { name: 'go-ab', command, env: { FISHING_GO_DATABASE_URL: database } });
  services.push(service);
  return { kind, service, token: process.env.FISHING_GO_AB_TOKEN || null };
}

async function ensurePlayer(adapter) {
  if (adapter.token) return adapter;
  if (adapter.kind === 'go') {
    const username = process.env.FISHING_GO_AB_USER;
    const password = process.env.FISHING_GO_AB_PASS;
    if (!username || !password) return null;
    const login = await jsonRequest(adapter.service.baseUrl, 'POST', '/api/login', { username, password });
    if (login.status !== 200 || !login.json || !login.json.token) return null;
    adapter.token = login.json.token;
    return adapter;
  }
  const suffix = `${Date.now()}_${process.pid}`;
  const username = `ab${suffix.replace(/[^a-z0-9]/gi, '')}`;
  const password = 'AB-Controlled-Pass42';
  const registered = await jsonRequest(adapter.service.baseUrl, 'POST', '/api/register', { username, password, confirmPassword: password, name: 'AB Player', qq: '100001' });
  if (![200, 201].includes(registered.status) || !registered.json || !registered.json.token) throw new Error(`Node registration failed: ${registered.status} ${registered.text}`);
  adapter.token = registered.json.token;
  adapter.username = username;
  return adapter;
}

async function identityAssertions(adapter) {
  const player = await ensurePlayer(adapter);
  if (!player) return { skipped: 'Go fixture requires FISHING_GO_AB_USER/FISHING_GO_AB_PASS or FISHING_GO_AB_TOKEN' };
  const unauth = await jsonRequest(player.service.baseUrl, 'GET', '/api/me');
  assert.ok([401, 403].includes(unauth.status), `${player.kind} /api/me must reject unauthenticated access`);
  const me = await jsonRequest(player.service.baseUrl, 'GET', '/api/me', undefined, player.token);
  assert.equal(me.status, 200, `${player.kind} /api/me status`);
  assert.ok(me.json && (me.json.id || me.json.username), `${player.kind} /api/me response`);
  const stream = await readSse(player.service.baseUrl, '/events', player.token);
  assert.equal(stream.status, 200, `${player.kind} /events status`);
  assert.equal(stream.frame.type, 'init', `${player.kind} first legacy SSE frame`);
  assert.ok(Object.prototype.hasOwnProperty.call(stream.frame, 'version'), `${player.kind} init version`);
  return { skipped: null, me: me.json, init: stream.frame };
}

test.before(async () => { run = makeRun('api'); });
test.after(async () => { await cleanup(run, services); });

test('contract matrix is complete and explicit for all non-development legacy routes', () => {
  assert.equal(matrix.source.commit, '13694a7038438ac0b3dd7df07db8c05ea239141f');
  assert.equal(matrix.denominator, 152);
  assert.equal(matrix.routes.length, 152);
  for (const row of matrix.routes) {
    assert.match(row.auth, /^(public|player_session|session_cookie_or_bearer|admin_session_mfa)$/);
    assert.ok(row.input && row.success && row.businessErrors.length > 0 && row.sideEffect && row.oracle);
    assert.notEqual(row.sideEffect.mode, undefined);
  }
});

test('SSE matrix records consumer, both sender paths and lifecycle assertions', () => {
  assert.equal(sse.source.commit, '13694a7038438ac0b3dd7df07db8c05ea239141f');
  assert.equal(sse.clientTypes.length, 40);
  assert.equal(sse.lifecycle.length, 9);
  assert.ok(sse.clientTypes.every(row => row.client.lines.length > 0));
  assert.ok(sse.missing.go.includes('batch'), 'Go gap is visible instead of being hidden by type-literal counts');
});

for (const kind of ['node', 'go']) {
  test(`${kind} legacy auth and init SSE smoke`, async t => {
    if (kind === 'go' && (!process.env.FISHING_GO_AB_COMMAND || !process.env.FISHING_GO_DATABASE_URL)) {
      t.skip('Go A/B requires FISHING_GO_AB_COMMAND and isolated FISHING_GO_DATABASE_URL');
      return;
    }
    const adapter = await startAdapter(kind);
    if (!adapter) { t.skip('backend fixture unavailable'); return; }
    const result = await identityAssertions(adapter);
    if (result.skipped) { t.skip(result.skipped); return; }
    assert.ok(result.me && result.init);
  });
}

for (const kind of ['node', 'go']) {
  test(`${kind} unauthenticated gate covers every legacy route`, async t => {
    if (kind === 'go' && (!process.env.FISHING_GO_AB_COMMAND || !process.env.FISHING_GO_DATABASE_URL)) {
      t.skip('Go A/B requires FISHING_GO_AB_COMMAND and isolated FISHING_GO_DATABASE_URL');
      return;
    }
    const adapter = await startAdapter(kind);
    if (!adapter) { t.skip('backend fixture unavailable'); return; }
    const failures = [];
    for (const row of matrix.routes) {
      const pathname = row.path.replace('{id}', '1');
      let result;
      try {
        result = row.method === 'GET' ? await jsonRequest(adapter.service.baseUrl, 'GET', pathname) : await jsonRequest(adapter.service.baseUrl, 'POST', pathname, {});
      } catch (error) {
        failures.push(`${row.method} ${row.path}: ${error.message}`);
        continue;
      }
      if (!row.unauthenticated.statuses.includes(result.status)) failures.push(`${row.method} ${row.path}: unauth status ${result.status}, expected ${row.unauthenticated.statuses.join('/')}`);
    }
    assert.deepEqual(failures, [], `${kind} unauthenticated route failures`);
  });
}

test('AB output directory is isolated and does not reuse the repository data directory', () => {
  assert.ok(run.root.startsWith(path.join(ROOT, 'output', 'go-rewrite', 'ab')));
  assert.notEqual(path.resolve(run.nodeData), path.resolve(path.join(ROOT, 'data')));
  assert.ok(fs.existsSync(run.profiles));
});

module.exports = { jsonRequest, readSse, identityAssertions };
