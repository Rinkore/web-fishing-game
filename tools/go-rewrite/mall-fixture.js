'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../../frontend/js/data');
const cases = [];
const previous = process.env.TZ;
try {
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    process.env.TZ = zone;
    for (const refresh of ['04:00', '0:0', ' 23 : 59 ', 'invalid', '24:00', '02:30', '01:30']) {
      for (const at of ['2026-01-01T00:00:00Z', '2026-09-20T19:59:59.999Z', '2026-09-20T20:00:00Z', '2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z']) {
        const now = Date.parse(at);
        cases.push({ id: `mall-${cases.length}`, fn: 'mallCycle', args: [refresh, now, zone], expected: D.mallCycleOf(refresh, now) });
      }
    }
  }
} finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
// Normalize CRLF so the digest is identical on Windows and Linux checkouts:
// Function.prototype.toString preserves the file's line endings, which differ by
// checkout (core.autocrlf), so hash the LF form on every platform.
const source = (D.mallCycleOf.toString() + D.parseRefreshTime.toString()).replace(/\r\n/g, '\n');
const content = JSON.stringify({ format: 1, version: D.VERSION, sourceSHA256: crypto.createHash('sha256').update(source).digest('hex'), cases }, null, 2) + '\n';
const output = path.resolve(__dirname, '../../server-go/testdata/mall-rules.json');
if (process.argv[2] === '--write') fs.writeFileSync(output, content);
else if (process.argv[2] === '--check') { if (fs.readFileSync(output, 'utf8') !== content) throw new Error('Mall oracle changed; review before recording'); }
else throw new Error('Usage: node tools/go-rewrite/mall-fixture.js --write|--check');
console.log(`Mall oracle: ${cases.length} cases (${D.VERSION}).`);
