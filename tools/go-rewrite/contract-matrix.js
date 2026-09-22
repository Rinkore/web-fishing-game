'use strict';

// Build the executable legacy contract matrix from the fixed Node inventory.
// Route registration is deliberately not treated as contract acceptance: every
// row carries explicit auth, validation, response, error, side-effect and
// oracle fields consumed by the A/B harness.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const inventoryFile = path.join(ROOT, 'server-go/api/legacy-inventory.json');

const PUBLIC = new Set([
  'GET /api/register/challenge', 'POST /api/register', 'POST /api/login',
  'GET /api/features', 'GET /api/v1/features', 'GET /api/version',
  'GET /api/grounds', 'GET /api/banner', 'GET /api/records',
  'GET /api/records/top', 'GET /shop',
]);
const READ_ONLY = new Set([
  'GET /api/version', 'GET /api/features', 'GET /api/v1/features',
  'GET /api/grounds', 'GET /api/banner', 'GET /api/records',
  'GET /api/records/top', 'GET /shop', 'GET /api/shop/history',
  'GET /api/market', 'GET /api/market/history', 'GET /api/chest',
  'GET /api/workshop', 'GET /api/party', 'GET /api/sea',
  'GET /api/friends', 'GET /api/friends/relations', 'GET /api/players/page',
  'GET /api/feedback', 'GET /api/subscribe', 'GET /api/autosell',
  'GET /api/admin/session', 'GET /api/admin/overview', 'GET /api/admin/stats',
  'GET /api/admin/netstats', 'GET /api/admin/security',
  'GET /api/admin/registration/stats', 'GET /api/admin/world',
  'GET /api/admin/loot/groups', 'GET /api/admin/loot/spots',
  'GET /api/admin/features', 'GET /api/admin/users',
  'GET /api/admin/users/snapshot', 'GET /api/admin/users/snapshots',
  'GET /api/admin/feedback', 'GET /api/admin/banner', 'GET /api/admin/parties',
  'GET /api/admin/market/supply', 'GET /api/wiki/content',
  'GET /api/admin/wiki/content', 'GET /api/wiki/guides',
  'GET /api/wiki/guides/session', 'GET /api/wiki/guides/my',
  'GET /api/wiki/guides/{id}', 'GET /api/wiki/simulator/inventory',
  'GET /api/v1/me', 'GET /api/v1/assets', 'GET /api/v1/codex',
  'GET /api/v1/sea', 'GET /api/v1/events', 'GET /api/v1/trade',
  'GET /api/v1/market', 'GET /api/v1/market/history',
  'GET /api/v1/mall', 'GET /api/v1/friends', 'GET /api/v1/party',
  'GET /api/v1/party/events', 'GET /api/v1/shop',
  'GET /api/v1/autosell', 'GET /api/v1/operation',
]);
const ANONYMOUS_COMPAT_READS = new Set([
  'GET /api/market', 'GET /api/wiki/content', 'GET /api/wiki/guides',
  'GET /api/wiki/guides/session',
]);
const ANONYMOUS_COMPAT_WRITES = new Set([
  'POST /api/logout', 'POST /api/admin/logout',
]);

const groups = [
  [/register|login|logout|profile|me|session/, 'identity', ['identity', 'auth_sessions']],
  [/fishing|rod|bd\//, 'fishing', ['fishing_sessions', 'rod_loadouts', 'player_state', 'asset_operations']],
  [/market|shop|sell|autosell|mall/, 'economy', ['market_orders', 'market_fills', 'wallets', 'asset_operations']],
  [/trade/, 'trade', ['trades', 'asset_operations', 'player_events']],
  [/workshop|chest/, 'workshop', ['equipment_instances', 'inventory_stacks', 'asset_operations', 'random_intents']],
  [/sea|party/, 'sea_party', ['sea_players', 'sea_zones', 'parties', 'party_events']],
  [/friends|players/, 'social', ['friend_relations', 'gateway_streams', 'player_events']],
  [/wiki/, 'wiki', ['wiki_guides', 'wiki_revisions', 'wiki_updates']],
  [/feedback|subscribe/, 'feedback', ['feedback_entries', 'subscription_settings']],
  [/banner|features|settings|config|world|loot|records|admin/, 'admin', ['operator_settings', 'admin_audit', 'catalog_releases', 'feature_releases']],
];

function key(route) { return `${route.method} ${route.path}`; }
function groupFor(route) {
  const hit = groups.find(([re]) => re.test(route.path));
  return hit ? { name: hit[1], tables: hit[2] } : { name: 'core', tables: ['player_state'] };
}

function authFor(route) {
  const k = key(route);
  if (k === 'GET /events' || k === 'GET /api/v1/events') return 'session_cookie_or_bearer';
  if (PUBLIC.has(k)) return 'public';
  if (route.path.startsWith('/api/admin/')) return 'admin_session_mfa';
  return 'player_session';
}

function validationFor(route) {
  const k = key(route);
  if (k === 'GET /events' || k === 'GET /api/v1/events') return { transport: 'text/event-stream', body: 'none', query: 'optional stream cursor/lease controls' };
  if (route.method === 'GET') return { transport: 'query', body: 'none', unknown: 'ignored by URL parser' };
  return { transport: 'application/json', body: 'strict JSON object', unknown: 'rejected', maxBytes: 16384 };
}

function unauthenticatedFor(route) {
  const k = key(route);
  if (k === 'GET /events') return { statuses: [200, 401, 403], note: 'Node keeps legacy stream compatibility; Go may require a session' };
  if (k === 'POST /api/admin/login') return { statuses: [400, 401], note: 'credential validation precedes session creation' };
  if (ANONYMOUS_COMPAT_READS.has(k)) return { statuses: [200], note: 'legacy public read' };
  if (ANONYMOUS_COMPAT_WRITES.has(k)) return { statuses: [200, 401, 403], note: 'legacy logout is idempotent' };
  if (route.method === 'GET' && PUBLIC.has(k)) return { statuses: [200, 400, 404], note: 'public read, invalid query, or empty legacy projection' };
  if (route.method === 'POST' && /market\/(list|buy)|trade\/set/.test(route.path)) return { statuses: [400, 401, 403], note: 'body validation can precede authorization' };
  return { statuses: [400, 401, 403, 404], note: 'authentication/validation gate' };
}

function errorCodes(route) {
  const common = ['invalid_input', 'unauthorized', 'forbidden', 'unavailable'];
  if (route.method === 'GET' && PUBLIC.has(key(route))) return ['invalid_input', 'unavailable'];
  const p = route.path;
  const extra = [];
  if (/login|register/.test(p)) extra.push('invalid_credentials', 'username_exists', 'rate_limited');
  if (/market|trade|sell|mall|shop|workshop|chest|rod|sea|fishing/.test(p)) extra.push('insufficient_assets', 'conflict', 'not_found', 'expired');
  if (/wiki/.test(p)) extra.push('quota_exceeded', 'review_required', 'not_found');
  if (route.path.startsWith('/api/admin/')) extra.push('MFA_SETUP_REQUIRED', 'admin_required');
  return [...new Set(common.concat(extra))];
}

function responseFor(route) {
  const k = key(route);
  if (k === 'GET /events' || k === 'GET /api/v1/events') return { status: [200], contentType: 'text/event-stream', framing: 'data: JSON\\n\\n' };
  return { status: [200], contentType: 'application/json', shape: 'legacy response envelope; assert fields per scenario' };
}

function persistenceFor(route, group) {
  const k = key(route);
  if (k === 'GET /events' || k === 'GET /api/v1/events') return { mode: 'lease', tables: ['gateway_streams'], transaction: 'open/renew/close; no gameplay mutation' };
  if (READ_ONLY.has(k)) return { mode: 'read', tables: group.tables, transaction: 'none unless stream/view lease is documented' };
  return { mode: 'write', tables: group.tables, transaction: 'atomic command; idempotency asserted where requestKey exists' };
}

function oracleFor(route, group) {
  return {
    visible: route.path.startsWith('/api/admin/') ? 'admin response and rendered console state' : 'response and rendered player state',
    authoritative: persistenceFor(route, group).mode === 'read' ? 'same response plus subsequent reread' : 'database row counts/assets/outbox plus subsequent reread',
    randomTime: /fishing|chest|workshop|sea|market/.test(route.path) ? 'controlled fixture seed/clock; never compare uncontrolled random output' : 'deterministic',
  };
}

function buildMatrix(root = ROOT) {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'server-go/api/legacy-inventory.json'), 'utf8'));
  const routes = inventory.routes.filter(r => !r.developmentOnly).map((route, index) => {
    const group = groupFor(route);
    return {
      id: `legacy-${String(index + 1).padStart(3, '0')}`,
      method: route.method,
      path: route.path,
      source: { commit: inventory.sourceCommit, line: route.line },
      auth: authFor(route),
      permissionMfa: route.path.startsWith('/api/admin/') ? 'admin permission plus MFA/setup policy' : 'none beyond authentication policy',
      input: validationFor(route),
      unauthenticated: unauthenticatedFor(route),
      success: responseFor(route),
      businessErrors: errorCodes(route),
      sideEffect: persistenceFor(route, group),
      domain: group.name,
      oracle: oracleFor(route, group),
    };
  });
  return {
    format: 1,
    source: { commit: inventory.sourceCommit, version: inventory.version, inventory: 'server-go/api/legacy-inventory.json' },
    denominator: routes.length,
    routes,
  };
}

function main() {
  const args = process.argv.slice(2);
  const matrix = buildMatrix();
  if (args.includes('--json')) process.stdout.write(JSON.stringify(matrix, null, 2) + '\n');
  else {
    const domains = {};
    for (const row of matrix.routes) domains[row.domain] = (domains[row.domain] || 0) + 1;
    console.log(`Legacy contract matrix: ${matrix.denominator} routes from ${matrix.source.commit}`);
    console.log(Object.entries(domains).map(([name, count]) => `${name}=${count}`).join(' '));
  }
  if (args.includes('--write')) {
    const target = path.join(ROOT, 'output/go-rewrite/ab-contract-matrix.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(matrix, null, 2) + '\n');
    console.log(`Wrote ${target}`);
  }
}

if (require.main === module) main();
module.exports = { buildMatrix, key, PUBLIC, READ_ONLY, ANONYMOUS_COMPAT_READS, ANONYMOUS_COMPAT_WRITES };
