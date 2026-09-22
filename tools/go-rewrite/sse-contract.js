'use strict';

// SSE contract is derived from the client's dispatch branches and then joined
// with both sender implementations. A sender's `type` literal alone is not a
// contract: only client-consumed types are in the required set.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const CLIENT = path.join(ROOT, 'frontend/js/net.js');
const INVENTORY = path.join(ROOT, 'server-go/api/legacy-inventory.json');
const GO_DIR = path.join(ROOT, 'server-go/internal/gateway');

function lines(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/); }
function clientTypes(file = CLIENT) {
  const out = new Map();
  lines(file).forEach((line, index) => {
    const re = /m\.type\s*===\s*['"]([^'"]+)['"]/g;
    for (const m of line.matchAll(re)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(index + 1);
    }
  });
  return out;
}

function senderTypes(file) {
  const out = new Map();
  lines(file).forEach((line, index) => {
    const re = /(?:["']type["']|type)\s*:\s*["']([^"']+)["']/g;
    for (const m of line.matchAll(re)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(index + 1);
    }
  });
  return out;
}

function goSenderTypes(root = ROOT) {
  const out = new Map();
  for (const name of fs.readdirSync(path.join(root, 'server-go/internal/gateway'))) {
    if (!name.endsWith('.go') || name.endsWith('_test.go')) continue;
    const file = path.join(root, 'server-go/internal/gateway', name);
    const types = senderTypes(file);
    for (const [type, locs] of types) {
      if (!out.has(type)) out.set(type, []);
      out.get(type).push(...locs.map(line => ({ file: `server-go/internal/gateway/${name}`, line })));
    }
  }
  return out;
}

const behavior = [
  { id: 'init', types: ['init'], assertion: 'first JSON frame has current features/market/catalog state and optional resumedFishing; reread authoritative state' },
  { id: 'pagination-tail', types: ['playersPage', 'recordsDirty'], assertion: 'last page and dirty-version invalidation do not fabricate a full list; fetch exact page/records' },
  { id: 'reconnect', types: ['init', 'ping', 'maintenance', 'kicked'], assertion: 'EventSource reconnect receives init; stale/expired session becomes kicked; maintenance exposes version' },
  { id: 'multi-tab-lease', types: ['init', 'kicked'], assertion: 'gateway stream lease opens, renews and closes; duplicate tabs do not lose the surviving lease' },
  { id: 'slow-connection', types: ['batch', 'feedBatch', 'ping'], assertion: 'bounded writes drain or fail without blocking unrelated streams; event order stays observable' },
  { id: 'read-failure', types: ['maintenance', 'kicked'], assertion: 'poll failure does not advance its cursor or emit a partial frame; recovery replays the complete page; maintenance/kicked are terminal stop or revocation only' },
  { id: 'duplicate-event', types: ['feed', 'feedBatch', 'banner', 'assets'], assertion: 'feed/banner/inventory revisions deduplicate and reject stale invRev' },
  { id: 'asset-revision', types: ['assets', 'tradeDone', 'codexAdd'], assertion: 'monotonic invRev and codex revision preserve authoritative assets under HTTP/SSE reordering' },
  { id: 'expired-state', types: ['seaEvict', 'trade', 'marketDelta', 'notice'], assertion: 'expired trade/market/sea state is visible and subsequent GET reflects terminal status' },
];

function buildSseContract(root = ROOT) {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'server-go/api/legacy-inventory.json'), 'utf8'));
  const client = clientTypes(path.join(root, 'frontend/js/net.js'));
  const node = senderTypes(path.join(root, 'backend/server.js'));
  const go = goSenderTypes(root);
  const required = [...client.keys()].sort();
  const row = type => ({
    type,
    client: { lines: client.get(type) || [] },
    node: { lines: node.get(type) || [], emitted: node.has(type) },
    go: { locations: go.get(type) || [], emitted: go.has(type) },
    acceptance: 'not-run',
  });
  return {
    format: 1,
    source: { commit: inventory.sourceCommit, version: inventory.version, client: 'frontend/js/net.js' },
    clientTypes: required.map(row),
    senderOnly: {
      node: [...node.keys()].filter(type => !client.has(type)).sort(),
      go: [...go.keys()].filter(type => !client.has(type)).sort(),
    },
    missing: {
      node: required.filter(type => !node.has(type)),
      go: required.filter(type => !go.has(type)),
    },
    lifecycle: behavior.map(item => ({ ...item, acceptance: 'not-run' })),
  };
}

function main() {
  const report = buildSseContract();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`SSE client contract: ${report.clientTypes.length} consumed types from ${report.source.commit}`);
    console.log(`Node sender missing: ${report.missing.node.length}; Go sender missing: ${report.missing.go.length}`);
    for (const row of report.clientTypes) console.log(`${row.type}: client=${row.client.lines.join(',')} node=${row.node.emitted ? 'yes' : 'no'} go=${row.go.emitted ? 'yes' : 'no'}`);
  }
  if (process.argv.includes('--write')) {
    const target = path.join(ROOT, 'output/go-rewrite/ab-sse-contract.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    console.log(`Wrote ${target}`);
  }
}

if (require.main === module) main();
module.exports = { buildSseContract, clientTypes, senderTypes, goSenderTypes };
