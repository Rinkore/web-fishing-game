'use strict';

// Build a deterministic, synthetic legacy snapshot for migration drills.
// This never reads the live game data directory and never emits credentials.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const VERSION = 'v0.21.4';
const FIXED_NOW = '2026-09-22T00:00:00.000Z';

function usage() {
  console.error('Usage: node migration-fixture.js --output DIR [--variant valid|blocked] [--force]');
}

function parseArgs(argv) {
  const out = { variant: 'valid', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') out.output = argv[++i];
    else if (arg === '--variant') out.variant = argv[++i];
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!out.output || !['valid', 'blocked'].includes(out.variant)) throw new Error('output and valid|blocked variant are required');
  return out;
}

function ensureFreshDir(dir, force) {
  if (fs.existsSync(dir)) {
    if (!force) throw new Error(`output exists (use --force only for a synthetic directory): ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function account(id, username, coins, inventory, equipment, social, sea) {
  return {
    schemaVersion: 3,
    id,
    username,
    name: username === 'alice' ? 'Synthetic Alice' : 'Synthetic Bob',
    qq: username === 'alice' ? '000001' : '000002',
    // Deliberately non-working placeholders. They are test vectors, not secrets.
    pwHash: `$scrypt$synthetic$${username}`,
    passwordAlgorithm: 'scrypt',
    mfa: { enabled: false, secret: null },
    coins,
    inventory,
    inventoryByCategory: {
      fish: { crucian: inventory.crucian || 0, salmon: inventory.salmon || 0 },
      bait: { worm: inventory.worm || 0 },
      materials: { shard: inventory.shard || 0 },
    },
    bigfish: { crucian: { L: username === 'alice' ? 2 : 1, G: 1 } },
    codex: { crucian: { caught: true, firstAt: FIXED_NOW }, salmon: { caught: username === 'alice' } },
    catchCount: username === 'alice' ? 27 : 11,
    bd: equipment,
    rodSlots: username === 'alice'
      ? [{ id: 'rod-old-100', name: 'Synthetic Rod', components: ['component-old-1'], locked: true }, null]
      : [{ id: 'rod-old-200', name: 'Backup Rod', components: [], locked: false }, null],
    rodActiveSlot: 0,
    rodName: username === 'alice' ? 'Synthetic Rod' : 'Backup Rod',
    autoSell: { enabled: false, fish: false, materials: true },
    subNotify: { catches: true, trades: true, friends: false },
    equipment,
    trades: username === 'alice'
      ? [{ id: 'trade-old-1', with: 'legacy-u-2002', state: 'offered', give: [{ item: 'shard', qty: 2 }], want: [{ item: 'worm', qty: 3 }] }]
      : [{ id: 'trade-old-1', with: 'legacy-u-1001', state: 'offered', give: [{ item: 'worm', qty: 3 }], want: [{ item: 'shard', qty: 2 }] }],
    social,
    sea,
    history: { assetOperations: username === 'alice' ? ['op-old-1', 'op-old-2'] : ['op-old-3'], revision: username === 'alice' ? 12 : 8 },
    sessions: { activeCount: username === 'alice' ? 1 : 0 },
  };
}

function buildWiki() {
  const guide = {
    id: 'synthetic-six-affix', kind: 'official', status: 'published', title: 'Synthetic six affix route', category: 'workshop',
    summary: 'Synthetic content for migration reconciliation.', tags: ['synthetic', 'migration'], aliases: ['six-affix'],
    authorKey: null, authorName: 'Synthetic Operator', submittedAt: null, reviewedAt: null, reviewedBy: null, reviewNote: '',
    deletedAt: null, deletedBy: null, deleteReason: null, revision: 4, updatedAt: FIXED_NOW,
    sections: [{ h: 'Route', type: 'p', text: 'Transfer, fill gaps, and verify every affix.' }],
  };
  const userGuide = {
    id: 'synthetic-player-note', kind: 'user', status: 'approved', title: 'Synthetic player note', category: 'catch',
    summary: 'A submitted synthetic guide.', tags: ['synthetic'], aliases: [], authorKey: 'legacy-u-1001', authorName: 'Synthetic Alice',
    submittedAt: '2026-09-20T00:00:00.000Z', reviewedAt: '2026-09-21T00:00:00.000Z', reviewedBy: 'legacy-admin-1', reviewNote: 'fixture',
    deletedAt: null, deletedBy: null, deleteReason: null, revision: 2, updatedAt: '2026-09-21T00:00:00.000Z',
    sections: [{ h: 'Tip', type: 'p', text: 'Keep the original component id in the import ledger.' }],
  };
  return {
    official: { guides: [guide], updates: [{ date: '2026-09-22', title: 'Synthetic update', summary: 'Fixture update.' }] },
    user: { wikiUserGuides: [userGuide], wikiUserGuidesRevision: 3 },
    officialRevision: 4,
  };
}

function createWikiDB(file, wiki) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE wiki_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE guides (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      category TEXT NOT NULL, summary TEXT NOT NULL, tags_json TEXT NOT NULL, aliases_json TEXT NOT NULL,
      author_key TEXT, author_name TEXT, submitted_at TEXT, reviewed_at TEXT, reviewed_by TEXT,
      review_note TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT, delete_reason TEXT,
      revision INTEGER NOT NULL, sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE guide_sections (
      guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE, ord INTEGER NOT NULL,
      heading TEXT NOT NULL, type TEXT NOT NULL, text TEXT, items_json TEXT,
      PRIMARY KEY (guide_id, ord)
    );
    CREATE TABLE updates (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, sort_order INTEGER NOT NULL);
    CREATE TABLE guide_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, guide_id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, actor_key TEXT, actor_name TEXT, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const meta = db.prepare('INSERT INTO wiki_meta(key,value) VALUES (?,?)');
  meta.run('schema_version', '1'); meta.run('official_revision', String(wiki.officialRevision)); meta.run('user_revision', String(wiki.user.wikiUserGuidesRevision)); meta.run('official_updated_at', FIXED_NOW);
  const insertGuide = db.prepare(`INSERT INTO guides(id,kind,status,title,category,summary,tags_json,aliases_json,author_key,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,deleted_by,delete_reason,revision,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertSection = db.prepare('INSERT INTO guide_sections(guide_id,ord,heading,type,text,items_json) VALUES (?,?,?,?,?,?)');
  const insertRevision = db.prepare('INSERT INTO guide_revisions(guide_id,revision,action,actor_key,actor_name,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?)');
  for (const [kind, guides] of [['official', wiki.official.guides], ['user', wiki.user.wikiUserGuides]]) {
    guides.forEach((g, index) => {
      const created = g.submittedAt || g.updatedAt;
      insertGuide.run(g.id, kind, g.status, g.title, g.category, g.summary, JSON.stringify(g.tags), JSON.stringify(g.aliases), g.authorKey, g.authorName, g.submittedAt, g.reviewedAt, g.reviewedBy, g.reviewNote, g.deletedAt, g.deletedBy, g.deleteReason, g.revision, index, created, g.updatedAt);
      g.sections.forEach((s, ord) => insertSection.run(g.id, ord, s.h, s.type, s.text || null, s.items ? JSON.stringify(s.items) : null));
      insertRevision.run(g.id, g.revision, kind === 'official' ? 'official_save' : 'approve', g.authorKey, g.authorName, JSON.stringify(g), g.updatedAt);
    });
  }
  const update = db.prepare('INSERT INTO updates(date,title,summary,sort_order) VALUES (?,?,?,?)');
  wiki.official.updates.forEach((u, i) => update.run(u.date, u.title, u.summary, i));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
}

function makeFixture(opts) {
  const root = path.resolve(opts.output);
  ensureFreshDir(root, opts.force);
  const alice = account('legacy-u-1001', 'alice', 125000, { crucian: 8, salmon: 2, worm: 20, shard: 7 }, {
    'component-old-1': { id: 'component-old-1', part: 'tip', quality: 'mythic', affixes: [{ id: 'power', value: 12 }, { id: 'luck', value: 4 }] },
  }, { friends: ['legacy-u-2002'], incoming: [], outgoing: [] }, { voyageId: 'voyage-old-1', status: 'sailing', sea: 'north', fuel: 4, crew: ['legacy-u-1001', 'legacy-u-2002'] });
  const bob = account('legacy-u-2002', 'bob', 88000, { crucian: 4, salmon: 1, worm: 14, shard: 3 }, {
    'component-old-2': { id: 'component-old-2', part: 'reel', quality: 'rare', affixes: [{ id: 'speed', value: 5 }] },
  }, { friends: ['legacy-u-1001'], incoming: [], outgoing: [] }, { voyageId: 'voyage-old-1', status: 'sailing', sea: 'north', fuel: 4, crew: ['legacy-u-1001', 'legacy-u-2002'] });
  const wiki = buildWiki();
  writeJSON(path.join(root, 'accounts/alice.json'), alice);
  writeJSON(path.join(root, 'accounts/bob.json'), bob);
  writeJSON(path.join(root, 'market.json'), {
    listingSeq: 8,
    listings: [{ lid: 7, id: 'shard', seller: 'alice', sellerAccountId: 'legacy-u-1001', qty: 2, remaining: 2, price: 300, state: 'escrowed', escrow: { owner: 'legacy-u-1001', qty: 2 }, createdAt: FIXED_NOW, expiresAt: '2026-09-23T00:00:00.000Z' }],
    marketSupply: { shard: 11, worm: 25 },
  });
  writeJSON(path.join(root, 'records.json'), { bigRecords: { crucian: { owner: 'legacy-u-1001', value: 42 } }, smallRecords: {}, topCatches: [{ accountId: 'legacy-u-1001', fish: 'crucian', value: 42 }], topSmall: [], globalMax: 42, rank: { 'legacy-u-1001': 1, 'legacy-u-2002': 2 }, lastRec: FIXED_NOW });
  writeJSON(path.join(root, 'economy.json'), { shopSales: [{ op: 'op-old-shop-1', accountId: 'legacy-u-1001', item: 'salmon', qty: 1, coins: 120 }], priceLog: [{ item: 'shard', price: 300, at: FIXED_NOW }], tradeLog: [{ id: 'trade-old-1', state: 'offered' }], marketLog: [{ lid: 7, event: 'listed', at: FIXED_NOW }], priceOv: {}, economyLog: [{ op: 'op-old-1', delta: -300, accountId: 'legacy-u-1001' }] });
  writeJSON(path.join(root, 'config.json'), { items: [
    { id: 'crucian', kind: 'fish' }, { id: 'salmon', kind: 'fish' },
    { id: 'worm', kind: 'material' }, { id: 'shard', kind: 'material' },
    { id: 'component-old-1', kind: 'equipment', part: 'tip' }, { id: 'component-old-2', kind: 'equipment', part: 'reel' },
  ], features: { workshop: true, voyage: true }, featureOrder: ['workshop', 'voyage'], groundCfg: {}, notifyLevel: 1, autoNotify: true, biteFormula: 'synthetic-v1', doubleBase: 1, componentCfg: {}, fishCfg: {}, bannerSeq: 3, banners: [], bannerCfg: {}, feedbackCfg: { cooldownMs: 86400000, skipCoins: 10000 }, castCfg: {}, priceCfg: { shard: 300 }, dropCfg: {}, lootCfg: {}, chestCfg: {}, seaCfg: { north: { fuel: 4 } }, mallCfg: {}, smeltCfg: {}, recordsCfg: {}, rareK: 1, autoSellCfg: {}, snapshotCfg: {}, fishingFormulaRevision: 9, wikiConfigRevision: 4 });
  writeJSON(path.join(root, 'feedback.json'), { feedback: [{ id: 'feedback-old-1', accountId: 'legacy-u-2002', status: 'pending', text: 'Synthetic feedback' }], feedbackMeta: { revision: 2 } });
  writeJSON(path.join(root, 'stats.json'), { statMin: [{ minute: '2026-09-22T00:00:00Z', online: 2 }], statHour: [{ hour: '2026-09-22T00:00:00Z', catches: 38 }], statPeak: { online: 2, at: FIXED_NOW } });
  writeJSON(path.join(root, 'admin.json'), { adminLog: [{ id: 'admin-op-1', actor: 'legacy-admin-1', action: 'review-guide', target: 'synthetic-player-note', at: FIXED_NOW }] });
  writeJSON(path.join(root, 'sessions.json'), { sessions: [{ id: 'session-old-1', accountId: 'legacy-u-1001', createdAt: FIXED_NOW, expiresAt: '2026-09-23T00:00:00Z', revoked: false }], sessionRevision: 1 });
  writeJSON(path.join(root, 'wiki.json'), { wikiContent: wiki.official, wikiContentRevision: wiki.officialRevision, wikiContentUpdatedAt: FIXED_NOW });
  writeJSON(path.join(root, 'wiki-guides.json'), wiki.user);
  writeJSON(path.join(root, 'snapshots/alice/2026-09-21T00-00-00.000Z.json'), { accountId: 'legacy-u-1001', capturedAt: '2026-09-21T00:00:00.000Z', coins: 120000, inventory: { crucian: 7, salmon: 2, worm: 20, shard: 7 }, revision: 11 });
  createWikiDB(path.join(root, 'wiki.db'), wiki);
  if (opts.variant === 'blocked') {
    writeJSON(path.join(root, 'users.json'), { legacyUsers: [{ id: 'legacy-u-1001', username: 'alice' }], note: 'monolith requires versioned review' });
    writeJSON(path.join(root, 'unclassified-future.json'), { domain: 'future', value: 1 });
  }
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ path: path.relative(root, full).replaceAll(path.sep, '/'), bytes: fs.statSync(full).size, sha256: sha256(full) });
    }
  }
  walk(root);
  const manifest = { format: 1, generatedBy: 'migration-fixture.js', sourceVersion: VERSION, variant: opts.variant, capturedAt: FIXED_NOW, files };
  const manifestPath = `${root}.manifest.json`;
  const oraclePath = `${root}.oracle.json`;
  writeJSON(manifestPath, manifest);
  writeJSON(oraclePath, {
    format: 1, sourceVersion: VERSION, fixture: path.basename(root),
    oldIds: { alice: 'legacy-u-1001', bob: 'legacy-u-2002', listing: '7', trade: 'trade-old-1', voyage: 'voyage-old-1', componentAlice: 'component-old-1', componentBob: 'component-old-2' },
    accounts: { 'legacy-u-1001': { coins: 125000, inventoryUnits: 37, equipment: 1, activeRod: 'rod-old-100' }, 'legacy-u-2002': { coins: 88000, inventoryUnits: 22, equipment: 1, activeRod: 'rod-old-200' } },
    market: { listings: 1, escrowUnits: 2, seller: 'legacy-u-1001' },
    social: { friendshipPairs: 1 }, sea: { voyages: 1, crew: 2 }, wiki: { officialGuides: 1, userGuides: 1, updates: 1, revisions: 2 },
    conservation: { coins: 213000, inventoryUnits: 59, escrowUnits: 2, componentIds: ['component-old-1', 'component-old-2'] },
    requiredChecks: ['old-id-map-preserved', 'coins-and-quantities-exact', 'escrow-owner-and-quantity', 'trade-state-preserved', 'wiki-json-sqlite-consistent', 'sessions-revoked-before-cutover', 'unknown-fields-abort-import'],
  });
  return { root, manifestPath, oraclePath, fileCount: files.length };
}

try {
  const result = makeFixture(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`migration fixture failed: ${error.message}`);
  process.exitCode = 2;
}
