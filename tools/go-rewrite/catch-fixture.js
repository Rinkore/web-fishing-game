'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');
const crypto = require('node:crypto');
const D = require('../../frontend/js/data');

// Extract only the pure catch functions, never boot the legacy server.
async function main() {
  const wanted = new Set(['resolveItemAt', 'rollSizeOf', 'boostPoolOf', 'weightedPickOf',
    'rareMultOf', 'rareK', 'pickIsCommon', 'componentCommonProb', 'sizeTierOf',
    'doServerCatch', 'doubleExtraOf', 'doubleProbOf']);
  const blocks = []; let lines;
  for await (const line of readline.createInterface({input: fs.createReadStream(path.resolve(__dirname, '../../backend/server.js')), crlfDelay: Infinity})) {
    if (!lines) { const m = /^function (\w+)\(/.exec(line); if (m && wanted.delete(m[1])) lines = []; }
    if (lines) { lines.push(line); if (/^}/.test(line) || /^function .*}\s*$/.test(line)) { blocks.push(lines.join('\n')); lines = null; } }
  }
  if (wanted.size || lines) throw new Error('Catch function extraction changed');
  const source = blocks.join('\n');
  const sandbox = {
    D, Math, world: {doubleBase: 0}, FISH_ID_SET: {},
    FISH_SIZE_MAX: Object.fromEntries(D.allItems().filter(x => x.kind === 'fish' && x.size).map(x => [x.id, x.size[1]])),
    dropCfg: () => ({global: 100, common: 100, big: 100, rare: 100, material: 100}),
    lootGroupById: () => null,
    isOceanGround: () => false, invAdd: () => {}, sizeTierOf: () => null,
    feedVisible: () => false, players: new Map(), saveAccount: () => {},
    itemName: id => id, boardAnnouncement: () => null, sendTo: () => {}, maybeSendSubAlert: () => {},
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const originalResolve = context.resolveItemAt;
  const resolve = [], walks = [];
  function random(seed) {
    let state = seed + 1, draws = 0;
    return {rng: () => { if (++draws > 100000) throw new Error('Oracle draw budget exceeded'); state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }, count: () => draws};
  }
  function controlled(seed, fn) {
    const stream = random(seed), saved = Math.random;
    Math.random = stream.rng;
    try { return {value: fn(), draws: stream.count()}; } finally { Math.random = saved; }
  }
  for (const ground of D.GROUNDS) for (const spot of ground.spots) for (const seed of Array.from({length: 24}, (_, i) => i)) for (const effects of [{}, {rare: 30, material: 70, size: 200}]) {
    const result = controlled(seed, () => {
      const it = originalResolve(spot, effects);
      if (!it) return null;
      const tier = context.sizeTierOf(it.id, it.size);
      return {id: it.id, kind: it.kind, codexId: it.kind === 'component' ? it.baseId : it.id,
        tier: tier === 'G' ? 'giant' : tier === 'L' ? 'large' : 'normal', size: it.size == null ? null : it.size};
    });
    resolve.push({ground: ground.id, spot: spot.id, seed, effects, expected: result});
  }
  // Execute the actual recursive function with inert persistence/notification
  // adapters. Missing loot exercises the early return before double rolls.
  for (const a of [0, 25, 80, 150]) for (const seed of Array.from({length: 25}, (_, i) => i)) for (const missing of [false, true]) {
    const trace = [];
    context.resolveItemAt = () => { const ok = Math.random() >= (missing ? .2 : 0); trace.push(ok ? 'enter' : 'missing'); return ok ? {id: 'bait_pack', kind: 'material', size: null} : null; };
    context.autoSellCheck = () => trace.push('leave');
    const result = controlled(seed, () => { context.doServerCatch({name: 'fixture'}, 'fixture', {id: 'map'}, {}, {double: a}, false); return trace; });
    walks.push({a, seed, missing, expected: result});
  }
  const content = JSON.stringify({format: 1, version: D.VERSION, sourceSHA256: crypto.createHash('sha256').update(source).digest('hex'), resolve, walks}, null, 2) + '\n';
  const output = path.resolve(__dirname, '../../server-go/testdata/catch-rules.json');
  if (process.argv[2] === '--write') fs.writeFileSync(output, content);
  else if (process.argv[2] === '--check') { if (fs.readFileSync(output, 'utf8') !== content) throw new Error('Catch oracle changed; review before recording'); }
  else throw new Error('Usage: catch-fixture.js --write|--check');
  console.log(`Catch oracle: ${resolve.length} loot/size and ${walks.length} recursive traces (${D.VERSION}).`);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
