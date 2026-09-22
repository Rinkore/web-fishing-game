'use strict';
const fs=require('node:fs');const path=require('node:path');const D=require('../../frontend/js/data');
const cases=[];
const mains=D.COMPONENT_BASES.filter(b=>b.pool.length>=2);
for(const main of mains){const sub=D.COMPONENT_BASES.find(b=>b.part===main.part&&b.pool.some(a=>a.type!==main.pool[0].type));if(!sub)continue;
 const mainAffixes=main.pool.map(a=>({type:a.type,value:a.max}));
 const extra=D.AFFIX_TYPES.find(k=>!main.pool.some(a=>a.type===k));if(extra)mainAffixes.push({type:extra,value:3,src:'bt'});
 const mainId=D.instanceId(main.id,'mythic',mainAffixes);const subAffix=sub.pool.find(a=>a.type!==main.pool[0].type);
 const subId=D.instanceId(sub.id,'epic',[{type:subAffix.type,value:subAffix.max}]);
 const material=Object.keys(D.SMELT_MATERIAL_AFFIX).find(id=>![main.pool[0].type,subAffix.type].includes(D.SMELT_MATERIAL_AFFIX[id]));
 for(const pearl of [false,true])for(const relics of [0,extra?10:0])for(const seed of [0,5,90]){
  const input={mainId,subId,mainAffix:main.pool[0].type,subAffix:subAffix.type,materials:[{id:material,qty:3}],pearl,relics};const plan=D.smeltPlanOf(input);if(!plan.ok)throw new Error(plan.error);
  let n=0;const rng=()=>((n++*37+seed)%101)/101;const out=D.simulateSmeltPlan(plan,rng);
  const expected={success:out.success,extraOk:out.extraOk,retainOk:out.retainOk,retained:out.retained,protectAffix:out.protectAffix,removedAffix:out.removedAffix,resultId:out.resultId,mainAfterId:out.mainAfterId};
  cases.push({id:`smelt-${cases.length}`,fn:'smelt',args:[input,seed],expected:{outcome:expected,draws:n,gold:plan.gold,rate:plan.rates.rate,extraRate:plan.rates.extraRate,retainChance:plan.retainChance}});
 }
 for(const target of [-1,0,mainAffixes.length-1]){let n=0;const old=Math.random;Math.random=()=>((n++*37+13)%101)/101;try{const meta=D.componentOf(mainId);const aa=D.recastAffixes(main.id,meta.affixes,target<0?undefined:target);const pearls=D.recastPearlNeed(target,D.getSmeltCfg().recastPearl);cases.push({id:`recast-${cases.length}`,fn:'recast',args:[mainId,target],expected:{id:D.instanceId(main.id,'mythic',aa),draws:n,pearls,gold:D.recastGoldFor(pearls)}});}finally{Math.random=old;}}
}
const output=path.resolve(__dirname,'../../server-go/testdata/workshop-rules.json');const content=JSON.stringify({format:1,version:D.VERSION,cases},null,2)+'\n';
if(process.argv[2]==='--write')fs.writeFileSync(output,content);else if(process.argv[2]==='--check'){if(fs.readFileSync(output,'utf8')!==content)throw new Error('Workshop oracle changed; review before recording');}else throw new Error('Usage: node tools/go-rewrite/workshop-fixture.js --write|--check');
console.log(`Workshop oracle: ${cases.length} cases (${D.VERSION}).`);
