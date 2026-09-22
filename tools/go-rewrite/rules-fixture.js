'use strict';
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../frontend/js/data');

// JSON-only inputs can be consumed unchanged by future Go differential tests.
// The legacy implementation generates the oracle only on explicit --write.
const cases = [
  { id: 'cast-default', fn: 'castInfoOf', args: [{}, null, {}] },
  { id: 'cast-fixed-100ms', fn: 'castInfoOf', args: [{}, { intervalMs: 100 }, { cast: { minMs: 100 } }] },
  { id: 'cast-spot-speed-clamp', fn: 'castInfoOf', args: [{}, { intervalMs: 10000, buffs: [{ type: 'speed', value: 200 }] }, { cast: { minMs: 100 } }] },
  { id: 'cast-negative-spot-speed', fn: 'castInfoOf', args: [{}, { buffs: [{ type: 'speed', value: -200 }] }, {}] },
  { id: 'cast-half-rounding', fn: 'castInfoOf', args: [{}, { intervalMs: 100.5 }, { cast: { minMs: 100 } }] },
  { id: 'cast-invalid-formula', fn: 'castInfoOf', args: [{}, null, { cast: { formula: 'invalid(' } }] },
  { id: 'cast-timer-cap', fn: 'castInfoOf', args: [{}, null, { cast: { formula: '999999999' } }] },
  { id: 'bite-override-zero', fn: 'castInfoOf', args: [{}, { biteRate: 0 }, {}] },
  { id: 'bite-override-clamp', fn: 'castInfoOf', args: [{}, { biteRate: 150 }, {}] },
  { id: 'double-default', fn: 'doubleProbOf', args: [0, 0] },
  { id: 'double-negative', fn: 'doubleProbOf', args: [-100, 0] },
  { id: 'double-combined', fn: 'doubleProbOf', args: [100, 0.2] },
  { id: 'double-base-clamp', fn: 'doubleProbOf', args: [100, 2] },
  { id: 'double-numeric-string', fn: 'doubleProbOf', args: ['100', '0.2'] },
];

if (require.main === module) {
  if (process.argv[2] !== '--write') throw new Error('Usage: node tools/go-rewrite/rules-fixture.js --write');
  const fixture = { format: 1, version: D.VERSION, floatingComparisonTolerance: 1e-12,
    cases: cases.map(c => ({ ...c, expected: D[c.fn](...c.args) })) };
  const output = path.resolve(__dirname, '../../server-go/testdata/legacy-rules.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`Recorded ${fixture.cases.length} legacy rule cases (${D.VERSION}).`);
}
