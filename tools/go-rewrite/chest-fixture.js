'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../../frontend/js/data');
const cases = [];
for (const chest of D.CHESTS) {
  const choices = chest.mode === 'random' ? [''] : chest.mode === 'part' ? [...new Set(D.COMPONENT_BASES.map(x => x.part))] : D.COMPONENT_BASES.map(x => x.id);
  for (const choice of choices) for (const seed of [0, 37, 99]) for (const forced of chest.extra ? [false, true] : [false]) {
    let draws = 0; const previous = Math.random;
    Math.random = () => ((draws++ * 37 + seed) % 101) / 101;
    let item;
    try {
      const bases = chest.mode === 'part' ? D.COMPONENT_BASES.filter(x => x.part === choice) : D.COMPONENT_BASES;
      const base = chest.mode === 'base' ? D.componentBase(choice) : bases[Math.floor(Math.random() * bases.length)];
      item = chest.extra ? D.genBreakthrough(base.id, { hitCount: chest.hitCount, missCount: chest.missCount, chance: forced ? 1 : chest.chance }) : D.genComponent(base.id, D.rollChestQuality(chest), { minAffixes: chest.minAffixes, forceMax: !!chest.forceMax });
    } finally { Math.random = previous; }
    cases.push({ id: `chest-${cases.length}`, fn: 'chest', args: [chest.id, chest.mode === 'part' ? choice : '', chest.mode === 'base' ? choice : '', forced, seed], expected: { id: item.id, draws } });
  }
}
const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/data.js'), 'utf8').replace(/\r\n/g, '\n');
const content = JSON.stringify({ format: 1, version: D.VERSION, sourceSHA256: crypto.createHash('sha256').update(source).digest('hex'), cases }, null, 2) + '\n';
const output = path.resolve(__dirname, '../../server-go/testdata/chest-rules.json');
if (process.argv[2] === '--write') fs.writeFileSync(output, content);
else if (process.argv[2] === '--check') { if (fs.readFileSync(output, 'utf8') !== content) throw new Error('Chest oracle changed; review before recording'); }
else throw new Error('Usage: node tools/go-rewrite/chest-fixture.js --write|--check');
console.log(`Chest oracle: ${cases.length} cases (${D.VERSION}).`);
