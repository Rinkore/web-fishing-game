'use strict';

// Source inventory only: never imports server.js or starts the legacy server.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function scanSource(file) {
  const routes = [], domains = [], typeCandidates = new Map(), unresolved = [];
  const input = fs.createReadStream(file);
  const hash = crypto.createHash('sha256');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  for await (const text of lines) {
    line++;
    hash.update(text + '\n'); // Normalize checkout CRLF/LF for cross-platform CI.
    if (text.trimStart().startsWith('//')) continue;
    if (/\bif\s*\(/.test(text)) {
      const paths = [...text.matchAll(/\bp\s*===\s*'([^']+)'/g)];
      const method = text.match(/req\.method\s*===\s*'(GET|POST|PUT|PATCH|DELETE|OPTIONS)'/);
      for (const match of paths) {
        if (!match[1].startsWith('/api/') && match[1] !== '/events' && match[1] !== '/shop') continue;
        const special = match[1] === '/api/wiki/simulator/inventory';
        routes.push({ method: method ? method[1] : special ? 'GET' : 'REVIEW', path: match[1], line,
          developmentOnly: text.includes("process.env.FISHING_DEV === '1'"), contract: 'unreviewed' });
        if (!method && !special) unresolved.push({ line, reason: 'method-not-extracted' });
      }
    }
    // Explicitly recognize the only current parameterized route, and fail the
    // check if additional path expressions require extending this extractor.
    if (/const wikiGuideDetail =/.test(text)) {
      routes.push({ method: 'GET', path: '/api/wiki/guides/{id}', line, developmentOnly: false, contract: 'unreviewed' });
    } else if (/\.(?:exec|test)\(p\)|\bp\.(?:match|startsWith)\(/.test(text) && !text.includes("p.startsWith('/data/')") && !text.includes("Transport.token(req, p.startsWith('/api/admin/'))")) {
      unresolved.push({ line, reason: 'path-expression-needs-review' });
    }
    const keys = text.match(/^const ([A-Z_]+)_KEYS = \[(.*?)\]/);
    if (keys) domains.push({ constant: keys[1] + '_KEYS', line, fields: [...keys[2].matchAll(/'([^']+)'/g)].map(m => m[1]) });
    // This deliberately includes non-SSE literals. It is a review queue, not
    // an inferred event schema or a claim about authentication/payloads.
    for (const match of text.matchAll(/\btype:\s*'([A-Za-z][A-Za-z0-9_-]*)'/g)) {
      if (!typeCandidates.has(match[1])) typeCandidates.set(match[1], []);
      typeCandidates.get(match[1]).push(line);
    }
  }
  return { sourceSha256: hash.digest('hex'), routes, persistedDomainKeys: domains,
    typeLiteralCandidates: [...typeCandidates].map(([type, lines]) => ({ type, lines })), unresolved };
}

async function inventory(root) {
  const result = await scanSource(path.join(root, 'backend', 'server.js'));
  const clientEvents = [];
  const clientInput = fs.createReadStream(path.join(root, 'frontend/js/net.js'));
  const clientHash = crypto.createHash('sha256');
  let line = 0;
  for await (const text of readline.createInterface({ input: clientInput, crlfDelay: Infinity })) {
    line++;
    clientHash.update(text + '\n');
    for (const match of text.matchAll(/\bm\.type\s*===\s*'([^']+)'/g)) clientEvents.push({ type: match[1], line });
  }
  const data = fs.readFileSync(path.join(root, 'frontend', 'js', 'data.js'), 'utf8').replace(/\r\n/g, '\n');
  const revision = execFileSync('git', ['log', '-1', '--format=%H', '--', 'backend/server.js', 'frontend/js/data.js', 'frontend/js/net.js'], { cwd: root, encoding: 'utf8' }).trim();
  return { format: 1, sourceCommit: revision, version: data.match(/const VERSION = '([^']+)'/)[1],
    sharedRulesSha256: crypto.createHash('sha256').update(data).digest('hex'), clientSha256: clientHash.digest('hex'), clientEvents,
    scope: 'Static candidates from local source; production version, payloads and authorization require review.', ...result };
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const target = path.join(root, 'server-go/api/legacy-inventory.json');
  const output = JSON.stringify(await inventory(root), null, 2) + '\n';
  if (process.argv[2] === '--write') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output);
  } else if (process.argv[2] === '--check') {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) throw new Error('Legacy inventory changed; review and regenerate with --write');
  } else throw new Error('Usage: node tools/go-rewrite/inventory.js --write|--check');
  const report = JSON.parse(output);
  console.log(`Legacy ${report.version}: ${report.routes.length} routes; ${report.typeLiteralCandidates.length} type candidates; ${report.unresolved.length} unresolved path expressions.`);
  if (report.unresolved.length) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { scanSource, inventory };
