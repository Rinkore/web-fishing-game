'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { scenarios } = require('./ab-scenarios');
const { makeRun, startNode, startGo, launchBrowser, cleanup } = require('./ab-harness');

// This file is intentionally independent from tests/run-all.js. The browser
// suite owns dynamic ports, persistent profiles and its child processes.
let run;
const services = [];
const browsers = [];

function jsonRequest(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(pathname, baseUrl);
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode || 0, json, text }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function start(kind) {
  if (kind === 'node') {
    const service = await startNode(run, { name: 'browser-node' });
    services.push(service);
    return service;
  }
  if (!process.env.FISHING_GO_AB_COMMAND || !process.env.FISHING_GO_DATABASE_URL) return null;
  const service = await startGo(run, {
    name: 'browser-go',
    command: process.env.FISHING_GO_AB_COMMAND,
    env: { FISHING_GO_DATABASE_URL: process.env.FISHING_GO_DATABASE_URL },
  });
  services.push(service);
  return service;
}

async function playerToken(service, kind) {
  if (kind === 'go') {
    if (process.env.FISHING_GO_AB_TOKEN) return process.env.FISHING_GO_AB_TOKEN;
    if (!process.env.FISHING_GO_AB_USER || !process.env.FISHING_GO_AB_PASS) return null;
    const login = await jsonRequest(service.baseUrl, 'POST', '/api/login', { username: process.env.FISHING_GO_AB_USER, password: process.env.FISHING_GO_AB_PASS });
    return login.json && login.json.token;
  }
  const username = `abbrowser${Date.now()}${process.pid}`;
  const password = 'AB-Controlled-Pass42';
  const register = await jsonRequest(service.baseUrl, 'POST', '/api/register', { username, password, confirmPassword: password, name: 'AB Browser', qq: '100002' });
  if (register.status !== 200 || !register.json || !register.json.token) throw new Error(`browser fixture registration failed: ${register.status}`);
  return register.json.token;
}

async function runAuthBrowser(kind, service) {
  const token = await playerToken(service, kind);
  assert.ok(token, `${kind} browser token`);
  const browser = await launchBrowser(run, `${kind}-player`, { profileName: `${kind}-player` });
  browsers.push(browser);
  await browser.addCookies([{ name: 'fish_game', value: token, url: service.baseUrl, httpOnly: true }]);
  const page = await browser.newPage();
  await page.goto(service.baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Net && window.Net.getMe && window.Net.getMe(), null, { timeout: 20000 });
  const me = await page.evaluate(() => Net.getMe());
  assert.ok(me && (me.id || me.username));
}

test.before(() => { run = makeRun('browser'); });
test.after(async () => { await cleanup(run, services, browsers); });

for (const kind of ['node', 'go']) {
  for (const scenario of scenarios) {
    test(`${kind} browser A/B: ${scenario.name}`, async t => {
      if (process.env.FISHING_AB_BROWSER !== '1') {
        t.skip('set FISHING_AB_BROWSER=1 to run real Chrome A/B; static or partial browser checks are not acceptance');
        return;
      }
      if (kind === 'go' && (!process.env.FISHING_GO_AB_COMMAND || !process.env.FISHING_GO_DATABASE_URL)) {
        t.skip('Go browser fixture requires FISHING_GO_AB_COMMAND and isolated FISHING_GO_DATABASE_URL');
        return;
      }
      if (scenario.id !== 'auth' && !(process.env.FISHING_AB_SCENARIOS || '').split(',').includes(scenario.id)) {
        t.skip(`scenario adapter pending; opt in explicitly with FISHING_AB_SCENARIOS=${scenario.id}`);
        return;
      }
      const service = await start(kind);
      if (!service) { t.skip('backend fixture unavailable'); return; }
      if (scenario.id === 'auth') {
        await runAuthBrowser(kind, service);
        return;
      }
      // The registry is executable: every future flow must provide a concrete
      // action function here and assert both UI and authoritative rereads.
      throw new Error(`scenario adapter not implemented: ${scenario.id}; no pass is recorded`);
    });
  }
}
