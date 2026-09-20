'use strict';
// Extract only the named pure-rule functions. Never load/start server.js,
// inspect player saves, or make its filesystem/network capabilities available.
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const D = require('../../frontend/js/data');
async function main() {
  const wanted = new Set(['rareK','rareMultOf','pickIsCommon','componentCommonProb','boostPoolOf','weightedPickOf','currentMultiplier','autoSellKeepOf','autoSellHit','autoSellTierOn','autoSellExcess','autoSellPlan']);
  const blocks = []; let lines = null;
  for await (const line of readline.createInterface({ input: fs.createReadStream(path.resolve(__dirname, '../../backend/server.js')), crlfDelay: Infinity })) {
    if (!lines) { const match = /^function ([A-Za-z0-9_]+)\(/.exec(line); if (match && wanted.delete(match[1])) lines = []; }
    if (lines) { lines.push(line); if (/^}/.test(line) || (lines.length === 1 && /}\s*$/.test(line))) { blocks.push(lines.join('\n')); lines = null; } }
  }
  if (wanted.size || lines) throw new Error('Legacy function layout changed; review extractor');
  const source = blocks.join('\n');
  const context = vm.createContext({ D, world: { rareK: 2 }, dyn: {}, dynOf: () => context.dyn, priceCfg: () => ({}),
    lootGroupById: id => context.groups[id], dropCfg: () => context.drop,
    basePrice: id => context.inputs.find(x => x.id === id).base, currentPrice: id => context.inputs.find(x => x.id === id).price,
    autoSellItems: rec => rec.autoSell.items, autoSellRuleOf: (rec,id) => rec.autoSell.items[id],
    autoSellEligibleId: id => ['fish','material'].includes(D.itemOf(id).kind), autoSellBatchOf: () => context.batch,
    invCountOf: (rec,id) => rec.inventory[id], invAvailOf: (rec,id) => rec.available[id] });
  vm.runInContext(source, context, { timeout: 1000 });
  const cases = [];
  const record = (fn, args, expected) => cases.push({ id: `${fn}-${cases.length}`, fn, args, expected });
  for (const m of [.1,.4,1,2,3,null]) for (const elapsed of [-1000,0,60000,3600000,86400000]) {
    const s = { m, lastTs: 1700000000000 }; const dyn = { saleDivisor: .0075, riseTauMin: 60, floor: .4, ceil: 2, target: 2 };
    context.dyn = dyn; record('multiplier', [s, s.lastTs + elapsed, dyn], context.currentMultiplier(s, s.lastTs + elapsed, 'carp'));
  }
  for (const tier of [false,true]) for (const batch of [1,100,500]) for (const minPrice of [null,10,9999]) {
    const ids = [D.FISH.common[0].id, D.MATERIALS[0].id];
    const inputs = ids.map((id,i) => ({ id, rule: { on:true, keep: i ? '10.5' : 20, minPrice }, normal: 70, large: 25, giant: 25, base: 10, price: 20 }));
    const rec = { autoSell: { tier, items: Object.fromEntries(inputs.map(x => [x.id,x.rule])) }, inventory: Object.fromEntries(inputs.map(x => [x.id,x.normal+x.large+x.giant])), available: Object.fromEntries(inputs.map(x => [x.id,x.normal])) };
    context.inputs=inputs; context.batch=batch;
    const plan=context.autoSellPlan(rec);
    record('autosell', [inputs,tier,batch], { pool:plan.pool, blocked:plan.blocked, batch:plan.batch, quantities: plan.pool >= batch ? plan.list.map(x => ({ id:x.id, quantity:x.excess })) : [] });
  }
  const pool = [{ pick: 'fish:'+D.FISH.common[0].id, weight:20 }, { pick:'fish:'+D.FISH.big[0].id,weight:10 }, { pick:'fish:'+D.FISH.rare[0].id,weight:5 }, { pick:'component:',weight:10 }, { pick:'group:materials',weight:8 }];
  const groups={ materials: { id:'materials',name:'materials',items:D.MATERIALS.slice(0,3).map((x,i)=>({pick:'material:'+x.id,weight:10+i})) } };
  for (const rare of [0,20,100]) for (const material of [-100,0,100]) {
    const eff={rare,material}; context.groups=groups;context.drop={global:100,common:100,big:200,rare:150,material:80};
    const boosted=context.boostPoolOf(pool,eff);
    const clean=rows=>rows.map(x=>({pick:x.pick,weight:x.weight,...(x.items?{items:clean(x.items)}:{})}));
    record('boost',[pool,Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.items])),eff,context.drop],clean(boosted));
    for (const draws of [[0,0],[.3,.6],[.99,.99]]) { context.pool=boosted;context.draws=draws;const result=vm.runInContext('(()=>{let n=0;const prev=Math.random;Math.random=()=>draws[n++];try{return {pick:weightedPickOf(pool),draws:n}}finally{Math.random=prev}})()',context);record('pick',[clean(boosted),draws],result); }
  }
  const output=path.resolve(__dirname,'../../server-go/testdata/economy-rules.json');
  const content=JSON.stringify({format:1,version:D.VERSION,sourceSHA256:crypto.createHash('sha256').update(source).digest('hex'),cases},null,2)+'\n';
  if(process.argv[2]==='--write')fs.writeFileSync(output,content);else if(process.argv[2]==='--check'){if(fs.readFileSync(output,'utf8')!==content)throw new Error('Economy oracle changed; review before recording');}else throw new Error('Usage: node tools/go-rewrite/economy-fixture.js --write|--check');
  console.log(`Economy oracle: ${cases.length} cases (${D.VERSION}).`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
