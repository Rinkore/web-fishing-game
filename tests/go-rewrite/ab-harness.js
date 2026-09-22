'use strict';

// Shared process/browser fixture for the Node/Go acceptance suites.
// The fixture owns every resource it creates: it never scans or kills a port
// occupant left by another test process.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_LOG_ROOT = path.join(ROOT, 'output', 'go-rewrite', 'ab');

function makeRun(label) {
  const safe = String(label || 'run').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 32) || 'run';
  const parent = path.resolve(process.env.FISHING_AB_LOG_ROOT || DEFAULT_LOG_ROOT);
  fs.mkdirSync(parent, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(parent, `${safe}-${Date.now()}-${process.pid}-`));
  const nodeData = path.join(runRoot, 'node-data');
  const profiles = path.join(runRoot, 'profiles');
  const logs = path.join(runRoot, 'logs');
  fs.mkdirSync(nodeData, { recursive: true });
  fs.mkdirSync(profiles, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  return {
    root: runRoot,
    nodeData,
    profiles,
    logs,
    profile(name) {
      const safeName = String(name || 'default').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 40) || 'default';
      const dir = path.join(profiles, safeName);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    log(name) {
      const safeName = String(name || 'process').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 40) || 'process';
      return path.join(logs, `${safeName}.log`);
    },
  };
}

function reservePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}

function httpProbe(url, options = {}) {
  const timeout = options.timeout || 1500;
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode || 0, body, json });
      });
    });
    req.once('error', error => resolve({ status: 0, body: '', json: null, error }));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve({ status: 0, body: '', json: null, error: new Error('probe timeout') });
    });
  });
}

async function waitForReady(baseUrl, pathname = '/healthz', options = {}) {
  const timeout = options.timeout || 20000;
  const interval = options.interval || 80;
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await httpProbe(new URL(pathname, baseUrl), options);
    const ok = options.test ? options.test(last) : last.status >= 200 && last.status < 300;
    if (ok) return last;
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(1, deadline - Date.now()))));
  }
  const error = new Error(`service did not become ready: ${baseUrl}${pathname}`);
  error.last = last;
  throw error;
}

function envFor(run, extra = {}) {
  return Object.assign({}, process.env, {
    TZ: 'Asia/Shanghai',
    PGTZ: 'Asia/Shanghai',
    FISHING_DATA_DIR: run.nodeData,
    FISHING_AB_RUN_ROOT: run.root,
  }, extra);
}

function pipeLog(child, file) {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  child.stdout && child.stdout.pipe(stream);
  child.stderr && child.stderr.pipe(stream);
  return stream;
}

async function terminate(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const timeout = options.timeout || 5000;
  const exited = once(child, 'exit').then(() => true);
  try { child.kill('SIGTERM'); } catch (_) {}
  let timer;
  const forced = new Promise(resolve => {
    timer = setTimeout(() => {
      // This PID is owned by this fixture. No port lookup or global process
      // scan is performed, so unrelated services cannot be terminated.
      if (process.platform === 'win32') {
        try {
          const { spawnSync } = require('node:child_process');
          spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        } catch (_) {}
      } else {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
      resolve(false);
    }, timeout);
  });
  await Promise.race([exited, forced]);
  clearTimeout(timer);
}

async function startNode(run, options = {}) {
  const port = options.port || await reservePort();
  const child = spawn(process.execPath, options.args || ['backend/server.js'], {
    cwd: options.cwd || ROOT,
    env: envFor(run, Object.assign({
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      FISHING_DEV: '1',
    }, options.env || {})),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = pipeLog(child, run.log(options.name || `node-${port}`));
  const service = { child, port, baseUrl: `http://127.0.0.1:${port}`, log, kind: 'node' };
  if (options.wait !== false) {
    try {
      await waitForReady(service.baseUrl, options.readyPath || '/shop', options.ready || {});
    } catch (error) {
      await terminate(child);
      log.end();
      throw error;
    }
  }
  return service;
}

async function startGo(run, options = {}) {
  const port = options.port || await reservePort();
  const command = options.command || path.join(ROOT, 'server-go', 'bin', 'game.exe');
  const child = spawn(command, options.args || [], {
    cwd: options.cwd || path.join(ROOT, 'server-go'),
    env: envFor(run, Object.assign({
      FISHING_GO_LISTEN: `127.0.0.1:${port}`,
      FISHING_GO_TIMEZONE: 'Asia/Shanghai',
    }, options.env || {})),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = pipeLog(child, run.log(options.name || `go-${port}`));
  const service = { child, port, baseUrl: `http://127.0.0.1:${port}`, log, kind: 'go' };
  if (options.wait !== false) {
    try {
      await waitForReady(service.baseUrl, options.readyPath || '/healthz', options.ready || {});
    } catch (error) {
      await terminate(child);
      log.end();
      throw error;
    }
  }
  return service;
}

async function launchBrowser(run, name, options = {}) {
  // Keep browser dependency loading lazy so HTTP-only contract suites can run
  // without Playwright or a locally installed Chrome.
  const { chromium } = require('playwright-core');
  const executablePath = options.executablePath || process.env.CHROME_PATH;
  const launchOptions = Object.assign({
    headless: true,
    timezoneId: 'Asia/Shanghai',
  }, options);
  delete launchOptions.executablePath;
  delete launchOptions.profileName;
  if (executablePath) launchOptions.executablePath = executablePath;
  return chromium.launchPersistentContext(run.profile(options.profileName || name), launchOptions);
}

async function closeBrowser(browser) {
  if (browser && typeof browser.close === 'function') await browser.close();
}

async function cleanup(run, services = [], browsers = []) {
  for (const browser of browsers.reverse()) await closeBrowser(browser);
  for (const service of services.reverse()) {
    try { await terminate(service.child); } finally { service.log && service.log.end(); }
  }
}

async function withRun(label, fn) {
  const run = makeRun(label);
  const services = [];
  const browsers = [];
  try {
    return await fn({ run, services, browsers });
  } finally {
    await cleanup(run, services, browsers);
  }
}

module.exports = {
  ROOT,
  makeRun,
  reservePort,
  httpProbe,
  waitForReady,
  envFor,
  startNode,
  startGo,
  launchBrowser,
  terminate,
  closeBrowser,
  cleanup,
  withRun,
};
