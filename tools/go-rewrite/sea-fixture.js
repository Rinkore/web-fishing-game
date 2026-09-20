'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const D = require('../../frontend/js/data');
async function main() {
  const wanted = new Set(['seaMoodRoll', 'genVoyageZone', 'rollSeaQuests']);
  const blocks = []; let lines = null;
  for await (const line of readline.createInterface({ input: fs.createReadStream(path.resolve(__dirname, '../../backend/server.js')), crlfDelay: Infinity })) {
    if (!lines) { const m = /^function ([A-Za-z0-9_]+)\(/.exec(line); if (m && wanted.delete(m[1]) || /^const SEA_FISH_TEMPL =/.test(line)) lines = []; }
    if (lines) { lines.push(line); if (/^}/.test(line) || /^];/.test(line)) { blocks.push(lines.join('\n')); lines = null; } }
  }
  if (wanted.size || lines || blocks.length !== 4) throw new Error('Legacy sea function layout changed');
  const source = blocks.join('\n');
  const context = vm.createContext({ D, now: 1700000000000 });
  vm.runInContext(source, context, { timeout: 1000 });
  const cases = [];
  for (const seed of Array.from({ length: 101 }, (_, i) => i)) {
    context.seed = seed;
    const out = vm.runInContext(`(() => { let draws=0; Math.random=()=>((draws++*37+seed)%101)/101;Date.now=()=>now;return {zone:genVoyageZone(),draws}; })()`, context);
    cases.push({ id:`zone-${seed}`,fn:'voyageZone',args:[context.now,seed],expected:out });
    const quest = vm.runInContext(`(() => { let draws=0; Math.random=()=>((draws++*37+seed)%101)/101;return {ids:rollSeaQuests().map(x=>x.id),draws}; })()`,context);
    cases.push({ id:`quests-${seed}`,fn:'seaQuests',args:[seed],expected:quest });
  }
  const content=JSON.stringify({format:1,version:D.VERSION,sourceSHA256:crypto.createHash('sha256').update(source).digest('hex'),cases},null,2)+'\n';
  const output=path.resolve(__dirname,'../../server-go/testdata/sea-rules.json');
  if(process.argv[2]==='--write')fs.writeFileSync(output,content);else if(process.argv[2]==='--check'){if(fs.readFileSync(output,'utf8')!==content)throw new Error('Sea oracle changed; review before recording');}else throw new Error('Usage: sea-fixture.js --write|--check');
  console.log(`Sea oracle: ${cases.length} cases (${D.VERSION}).`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
