'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanSource, inventory } = require('../tools/go-rewrite/inventory');

test('inventory captures method, dev guard and review-only type literals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-inventory-'));
  try {
    const file = path.join(root, 'server.js');
    fs.writeFileSync(file, [
      "if (p === '/api/me' && req.method === 'GET') {}",
      "if (process.env.FISHING_DEV === '1' && p === '/api/dev/seed' && req.method === 'POST') {}",
      "if (p === '/api/new') {}",
      "if (p.startsWith('/api/dynamic/')) {}",
      "broadcast({ type: 'assets' });",
      "// if (p === '/api/comment' && req.method === 'GET') {}",
      "const MARKET_KEYS = ['listings', 'listingSeq'];",
    ].join('\n'));
    const result = await scanSource(file);
    assert.equal(result.routes.length, 3);
    assert.equal(result.routes[1].developmentOnly, true);
    assert.equal(result.routes[2].method, 'REVIEW');
    assert.equal(result.unresolved.length, 2);
    assert.deepEqual(result.persistedDomainKeys[0].fields, ['listings', 'listingSeq']);
    assert.equal(result.typeLiteralCandidates[0].type, 'assets');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('checked-in local source inventory remains reproducible', async () => {
  const root = path.join(__dirname, '..');
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'server-go/api/legacy-inventory.json'), 'utf8'));
  const actual = await inventory(root);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.unresolved, []);
  assert(actual.routes.some(r => r.path === '/api/wiki/guides/{id}'));
  assert(actual.routes.some(r => r.path === '/events' && r.method === 'GET'));
  assert(actual.clientEvents.some(e => e.type === 'assets'));
  assert(actual.clientEvents.some(e => e.type === 'batch'));
});

test('legacy rule oracle remains unchanged', () => {
  const D = require('../frontend/js/data');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../server-go/testdata/legacy-rules.json'), 'utf8'));
  assert.equal(D.VERSION, fixture.version);
  for (const c of fixture.cases) assert.deepEqual(D[c.fn](...c.args), c.expected, c.id);
});
