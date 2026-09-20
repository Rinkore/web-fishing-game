'use strict';
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../frontend/js/data');
const cases = [];
function record(fn, args, run = () => D[fn](...args)) { cases.push({ id: `${fn}-${cases.length}`, fn, args, expected: run() }); }
const vars = { speed: 35, skill: -2, interval: 999.5, size: 0, rare: 5, material: 0, double: 100, big: 0 };
for (const formula of ['1+2*3', '(1+2)*3', '-3%2', '-(-2)+ +3', 'round(-1.5)', 'round(-0.5)', 'round(2.5)', '.5 + 01', '1.', '1e2', 'unknown(2)', 'Math.max(2,3)', 'speed + skill * 2', D.CAST_FORMULA_DEFAULT, D.BITE_FORMULA_DEFAULT, 'interval/(speed-35)', '1/(speed-1)', 'min()', 'max()', 'floor()', 'clamp(3,4,2)', 'min(4,-1,9)', 'ceil(-1.9,5)', 'round(1,2)', 'abs(-1.5)', '1/0', 'max(1,)', 'true', '', 'size % skill']) {
  record('expression', [formula, vars], () => { const c = D.compileExpr(formula, D.SIM_VAR_NAMES); return c.ok ? { ok: true, value: c.fn(vars) } : { ok: false }; });
}
for (const speed of [-200, -1.55, 0, 55, 150]) for (const bonus of [-100, 0, 17.5]) {
  const bd = { rod: { compId: D.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: Math.round(speed) }, { type: 'skill', value: 55 }]) } };
  record('castInfoOf', [bd, { buffs: [{ type: 'speed', value: speed }, { type: 'rare', value: 12 }] }, { cast: { speedBonus: bonus } }]);
}
for (const intervalMs of [null, '', '0x100', '100.5', 'bad', 99, 100, 3600001]) record('castInfoOf', [{}, { intervalMs }, { cast: { minMs: 100 } }]);
for (const biteFormula of ['', 'invalid(', 'interval/(speed-0)', '100/(skill-1)', '-1', '200', '0/(skill-0)']) record('castInfoOf', [{}, { buffs: [{ type: 'skill', value: 1 }] }, { biteFormula }]);
for (const value of [null, true, false, '', '1e2', '0xff', [], [12], [null], [1, 2], {}, 'Inf', '-Infinity', 'NaN', '0x1p2']) record('number', [value], () => Number(value));
for (const model of ['linear', 'normal', 'skew', 'custom']) for (const draws of [[0,0,0,0], [.5,.5,.5,.5], [.999,.25,.75,.1], [.1,.9,.2,.8]]) {
  for (const fn of ['fishRatio','affix','boundary']) {
    draws.push(...draws); const args = [model, draws];
    record(fn, args, () => { let n = 0; const rng = () => { if (n >= draws.length) throw new Error('draw budget'); return draws[n++]; }; const value = fn === 'fishRatio' ? D.rollFishRatio({ sizeModel: model, sizeWeights: [0,10,0,10,0,10,0,10,0,10] }, rng) : (fn === 'boundary' ? D.rollAffixValueBoundaryWithRng : D.rollAffixValueWithRng)(-1, 1, model, rng); return { value, draws: n }; });
  }
}
for (const rare of [-1, 0, 1, 100, 1e12]) for (const k of [0, 2, 15]) record('rareCommonMult', [rare, k]);
for (const b of D.COMPONENT_BASES) for (const quality of Object.keys(D.QUALITY_ORDER)) for (const forceMax of [false, true]) {
  for (const fn of ['generate', 'breakthrough']) {
    const args = [b.id, quality, { forceMax }];
    record(fn, args, () => {
      let n = 0; const original = Math.random;
      Math.random = () => ((n++ * 37 + 13) % 101) / 101;
      try { const item = fn === 'generate' ? D.genComponent(...args) : D.genBreakthrough(args[0]); return { id: item.id, draws: n }; }
      finally { Math.random = original; }
    });
  }
}
const output = path.resolve(__dirname, '../../server-go/testdata/native-rules.json');
const content = JSON.stringify({ format: 1, version: D.VERSION, cases }, null, 2) + '\n';
if (process.argv[2] === '--write') fs.writeFileSync(output, content);
else if (process.argv[2] === '--check') { if (fs.readFileSync(output, 'utf8') !== content) throw new Error('Rule oracle changed; review differences before recording'); }
else throw new Error('Usage: node tools/go-rewrite/native-rules-fixture.js --write|--check');
console.log(`Native rule oracle: ${cases.length} cases (${D.VERSION}); original legacy-rules.json unchanged.`);


