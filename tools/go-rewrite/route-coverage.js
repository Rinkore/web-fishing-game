'use strict';

// Static method+path coverage only. No server is imported or started, and a
// registered route is never treated as a passed contract or browser scenario.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const inventoryPath = 'server-go/api/legacy-inventory.json';
const gatewayPath = 'server-go/internal/gateway/http.go';
const methods = new Map(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'Connect', 'Trace'].map(name => [name, name.toUpperCase()]));
const unsupported = new Set(['Method', 'MethodFunc', 'Handle', 'HandleFunc', 'Route', 'Mount', 'Group', 'With']);
const normalized = value => value.replace(/\r\n/g, '\n');
const sha256 = value => crypto.createHash('sha256').update(normalized(value)).digest('hex');
const key = route => `${route.method} ${route.path}`;
const retiredRoutes = new Set([
  'GET /api/workshop',
  'POST /api/workshop/smelt',
  'POST /api/workshop/forge',
  'POST /api/workshop/recast',
  'POST /api/admin/smelt/config',
]);

function tokens(source) {
  // Tokenize comments and Go strings first so commented registrations and
  // string contents cannot inflate coverage. Preserve offsets for line reports.
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|`[^`]*`|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g;
  const result = [];
  for (const match of source.matchAll(re)) {
    if (match[0].startsWith('//') || match[0].startsWith('/*')) continue;
    result.push({ value: match[0], offset: match.index });
  }
  return result;
}

function scanGoRoutes(source) {
  const parts = tokens(source), routes = [], unresolved = [];
  for (let i = 0; i < parts.length - 5; i++) {
    if (parts[i].value !== 'r' || parts[i + 1].value !== '.' || parts[i + 3].value !== '(') continue;
    const name = parts[i + 2].value;
    if (!methods.has(name) && !unsupported.has(name)) continue;
    const line = source.slice(0, parts[i].offset).split('\n').length;
    if (!methods.has(name)) {
      unresolved.push({ line, reason: `unsupported-router-call:${name}` });
      continue;
    }
    const literal = parts[i + 4].value;
    if (parts[i + 5].value !== ',' || (!literal.startsWith('"') && !literal.startsWith('`'))) {
      unresolved.push({ line, reason: 'nonliteral-route-path' });
      continue;
    }
    let routePath;
    try { routePath = literal.startsWith('`') ? literal.slice(1, -1) : JSON.parse(literal); }
    catch { unresolved.push({ line, reason: 'unsupported-go-string-escape' }); continue; }
    routes.push({ method: methods.get(name), path: routePath, line });
  }
  return { routes, unresolved };
}

function compareCoverage(inventory, registration, excludedRoutes = new Set()) {
  const duplicates = (routes, source) => {
    const seen = new Set(), found = [];
    for (const route of routes) {
      if (seen.has(key(route))) found.push({ source, method: route.method, path: route.path });
      seen.add(key(route));
    }
    return found;
  };
  const nondevelopment = inventory.routes.filter(route => !route.developmentOnly);
  const excludedRetired = nondevelopment.filter(route => excludedRoutes.has(key(route)));
  const candidates = nondevelopment.filter(route => !excludedRoutes.has(key(route)));
  const expected = new Map(candidates.map(route => [key(route), route]));
  const actual = new Map(registration.routes.map(route => [key(route), route]));
  const registered = [], missing = [];
  for (const [routeKey, route] of expected) {
    const item = { method: route.method, path: route.path, legacyLine: route.line };
    if (actual.has(routeKey)) registered.push({ ...item, goLine: actual.get(routeKey).line });
    else missing.push(item);
  }
  const sort = rows => rows.sort((a, b) => key(a).localeCompare(key(b), 'en'));
  return {
    denominator: expected.size,
    registeredCount: registered.length,
    missingCount: missing.length,
    excludedDevelopmentCount: inventory.routes.length - nondevelopment.length,
    excludedRetiredCount: excludedRetired.length,
    excludedRetired: sort(excludedRetired.map(route => ({ method: route.method, path: route.path, legacyLine: route.line }))),
    goRegistrationCount: actual.size,
    registered: sort(registered), missing: sort(missing),
    additionalGoRoutes: sort(registration.routes.filter(route => !expected.has(key(route)))),
    duplicates: [...duplicates(candidates, 'inventory'), ...duplicates(registration.routes, 'gateway')],
    unresolved: [...(inventory.unresolved || []).map(item => ({ source: 'inventory', ...item })),
      ...registration.unresolved.map(item => ({ source: 'gateway', ...item })),
      ...candidates.filter(route => !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|CONNECT|TRACE)$/.test(route.method))
        .map(route => ({ source: 'inventory', line: route.line, reason: 'unresolved-http-method' }))],
    contractAcceptance: 'not-evaluated',
    browserAcceptance: 'not-evaluated',
  };
}

function coverage(root, ref) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const revision = git(['rev-parse', '--verify', `${ref || 'HEAD'}^{commit}`]);
  const read = file => ref ? execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, file), 'utf8');
  const inventoryText = read(inventoryPath), gatewayText = read(gatewayPath);
  const inventory = JSON.parse(inventoryText);
  return {
    format: 1,
    scope: 'Static route existence by exact method+path; not contract or browser acceptance.',
    subject: { kind: ref ? 'commit' : 'worktree', revision,
      ...(ref ? {} : { worktreeDirty: git(['status', '--porcelain']).length > 0 }) },
    legacySourceCommit: inventory.sourceCommit,
    rulesVersion: inventory.version,
    sharedRulesSha256: inventory.sharedRulesSha256,
    inputs: { inventory: { path: inventoryPath, sha256: sha256(inventoryText) }, gateway: { path: gatewayPath, sha256: sha256(gatewayText) } },
    ...compareCoverage(inventory, scanGoRoutes(gatewayText), ref ? new Set() : retiredRoutes),
  };
}

function main() {
  let ref, json = false, check = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--check') check = true;
    else if (args[i] === '--ref' && args[i + 1]) ref = args[++i];
    else throw new Error('Usage: node tools/go-rewrite/route-coverage.js [--ref <commit>] [--json] [--check]');
  }
  const report = coverage(path.resolve(__dirname, '../..'), ref);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Subject: ${report.subject.kind} ${report.subject.revision}${report.subject.worktreeDirty ? ' (dirty)' : ''}`);
    console.log(`Legacy ${report.rulesVersion}: ${report.registeredCount}/${report.denominator} method+path registered; ${report.missingCount} missing; ${report.excludedDevelopmentCount} development routes excluded; ${report.excludedRetiredCount} retired routes excluded.`);
    console.log(`Go: ${report.goRegistrationCount} unique registrations; ${report.duplicates.length} duplicates; ${report.unresolved.length} unresolved expressions.`);
    for (const route of report.missing) console.log(`MISSING ${key(route)}`);
    for (const item of report.duplicates) console.log(`DUPLICATE ${item.source} ${key(item)}`);
    for (const item of report.unresolved) console.log(`UNRESOLVED ${item.source}:${item.line} ${item.reason}`);
    console.log('Contract acceptance: not evaluated. Browser acceptance: not evaluated.');
  }
  if (report.duplicates.length || report.unresolved.length || (check && report.missingCount)) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { scanGoRoutes, compareCoverage, coverage };
