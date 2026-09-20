// 抛竿/上钩曲线与材料总权重回归；临时存档、独立端口。
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp, waitFor } = require('./_util.js');
const registrationProof = require('./_registration.js');
const { provisionAdmin } = require('./_admin.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8286;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-formula-test-'));
const DATA = require(path.join(ROOT, 'frontend', 'js', 'data.js'));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function request(pathname, options) {
  options = options || {};
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = Object.assign({}, options.headers || {});
  if (body) headers['Content-Type'] = 'application/json';
  return new Promise(resolve => {
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method: options.method || 'GET', headers: headers }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, data: data, body: out });
      });
    });
    r.on('error', () => resolve({ status: 0, data: null, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
const BEARER = t => ({ Authorization: 'Bearer ' + t });
const getT = (p, t) => request(p, { headers: BEARER(t) });
const postT = (p, body, t) => request(p, { method: 'POST', body: body, headers: BEARER(t) });
const post = (p, body) => request(p, { method: 'POST', body: body });
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
async function registerAccount(username) {
  const payload = { username: username, password: 'loot-test-1234', name: '战利品组测试', qq: '828300' };
  let r = await post('/api/register', payload);
  if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
    const challenge = await request('/api/register/challenge');
    r = await post('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge.data) }));
  }
  return r;
}


let srv = null;
async function boot() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, FISHING_DEV: '1' }) });
  await waitHttp('http://127.0.0.1:' + PORT + '/api/version', { timeout: 20000 });
}
async function main() {
  const D = DATA;
  const rod = speed => ({ reel: { compId: 'reel_electric#common#spd+' + speed } });
  check('新默认基础间隔为 10 秒', D.castIntervalOf({}, null) === 10000);
  check('独立基础间隔受玩家钓速影响', D.castIntervalOf(rod(60), { intervalMs: 16000 }) === 10000);
  check('钓点速率独立修正基础，钓竿与全服钓速相加', D.castIntervalOf(rod(20), { intervalMs: 14000, buffs: [{type:'speed',value:10}] }, { cast: {speedBonus:10} }) === 9692);
  check('钓速上限 0 可用', D.castIntervalOf(rod(60), null, {cast:{speedCap:0}}) === 10000);
  check('短间隔仍受最短值保护', D.castIntervalOf(rod(90), {intervalMs:100}) === 800);
  check('自定义公式可读取独立基础和技巧', D.castIntervalOf(rod(60), {intervalMs:16000,buffs:[{type:'skill',value:20}]}, {cast:{formula:'interval / 2 + skill'}}) === 8020);
  check('无穷/非法运行值回退默认计算', D.castIntervalOf(rod(60), null, {cast:{formula:'interval / 0'}}) === 6250);
  check('极大抛竿公式不会导致计时器溢出', D.castIntervalOf({},null,{cast:{formula:'999999999999'}})===3600000);
  const hour = (s,k) => {
    const interval = 10000 / (1+s/100);
    return D.biteProbabilityOf({speed:s,skill:k}, interval, null, D.BITE_FORMULA_DEFAULT) * 36000 / interval;
  };
  for (const kind of ['speed','skill']) {
    const h = x => kind === 'speed' ? hour(x,30) : hour(60,x);
    const gains = [0,10,20,50,60,70,80].map(x=>h(x+10)-h(x));
    check(kind+' 0–30 边际收益递增', gains[0]>0 && gains[1]>gains[0] && gains[2]>gains[1]);
    check(kind+' 50 以上边际收益递减', gains[3]>gains[4] && gains[4]>gains[5] && gains[5]>gains[6] && gains[6]>0);
  }
  let decreasing=true, bounded=true;
  for(let s=0;s<=100;s++) for(let k=0;k<=100;k+=10) {
    const p=x=>D.biteProbabilityOf({speed:x,skill:k},10000/(1+x/100),null,D.BITE_FORMULA_DEFAULT);
    if(s<100 && p(s+1)>p(s)+1e-9) decreasing=false;
    for(const ms of [100,800,1000,5263,10000,60000]) {
      const h=D.biteProbabilityOf({speed:s,skill:k},ms,null,D.BITE_FORMULA_DEFAULT)*36000/ms;
      if(h>600+1e-9) bounded=false;
    }
  }
  check('默认单竿上钩率随钓速下降', decreasing);
  check('默认公式各间隔每小时成功上钩不超过 600', bounded);
  check('60/30 与 90/60 差距小于 15%', hour(60,30)/hour(90,60)>.85 && hour(90,60)<600);
  // 覆盖旧默认、自定义配置，以及已经执行过 v0.21.4 首次迁移的存档。
  const configFile = path.join(TMP_DATA,'config.json');
  const legacyCases = [
    {name:'旧默认', biteFormula:'clamp(90 + skill, 0, 100)', castCfg:{baseMs:3000,speedCap:80}},
    {name:'旧自定义', biteFormula:'72 + skill / 2', castCfg:{baseMs:7000,minMs:600,speedBonus:25,speedCap:60,formula:'interval * (1 - speed / 100)'}},
    {name:'已迁移 revision 1', fishingFormulaRevision:1, biteFormula:'90', castCfg:{baseMs:6000,minMs:600,speedBonus:0,speedCap:80,formula:'interval / 3'}},
  ];
  for (const legacy of legacyCases) {
    if (srv) killTree(srv);
    const saved = {...legacy, rareK:7}; delete saved.name;
    fs.writeFileSync(configFile, JSON.stringify(saved));
    await boot();
    const migrated=JSON.parse(fs.readFileSync(configFile,'utf8'));
    check(legacy.name+' 强制更新公式、10s基础与钓速上限',
      migrated.fishingFormulaRevision===2 && migrated.biteFormula===D.BITE_FORMULA_DEFAULT &&
      migrated.castCfg.formula===D.CAST_FORMULA_DEFAULT && migrated.castCfg.baseMs===10000 && migrated.castCfg.speedCap===100);
    check(legacy.name+' 原配置备份并保留无关设置',
      migrated.fishingFormulaBackup?.biteFormula===legacy.biteFormula &&
      JSON.stringify(migrated.fishingFormulaBackup?.castCfg)===JSON.stringify(legacy.castCfg) && migrated.rareK===7 &&
      (legacy.castCfg.speedBonus==null || migrated.castCfg.speedBonus===legacy.castCfg.speedBonus) &&
      (legacy.castCfg.minMs==null || migrated.castCfg.minMs===legacy.castCfg.minMs));
  }
  const originalBackup=JSON.parse(fs.readFileSync(configFile,'utf8')).fishingFormulaBackup;
  const user='form'+String(Date.now()%100000);
  await registerAccount(user);
  const otp=await provisionAdmin(srv,TMP_DATA,user);
  const login=await post('/api/admin/login',{username:user,password:'loot-test-1234',otp});
  let at=login.data.token;
  const config=()=>getT('/api/admin/world',at);
  const settings=b=>postT('/api/admin/settings',b,at);
  const simulate=t=>postT('/api/admin/simulate',{spotKey:'map:dock',totals:t},at);
  const initial=(await config()).data;
  check('旧默认迁移到 10s、新公式和 100 钓速上限', initial.castBaseMs===10000 && initial.castSpeedCap===100 && initial.biteFormula===D.BITE_FORMULA_DEFAULT);
  const low=(await simulate({speed:60,skill:30})).data;
  const high=(await simulate({speed:90,skill:60})).data;
  check('后台模拟两档期望与实际默认公式一致', Math.abs(low.expect.fishPerHour-394.4)<.1 && Math.abs(high.expect.fishPerHour-445.4)<.1);
  check('非法变量/空抛竿公式保存被拒', (await settings({castFormula:'unknown + 1'})).status===400 && (await settings({castFormula:''})).status===400);
  await settings({castFormula:'interval / 2',validateOnly:true});
  check('仅校验不改实际公式', (await config()).data.castFormula===D.CAST_FORMULA_DEFAULT);
  await postT('/api/admin/spot/rate',{groundId:'map',spotId:'dock',intervalMs:16000},at);
  const simSpot=(await simulate({speed:60})).data;
  check('后台模拟独立间隔仍吃钓速', simSpot.cast.interval===10000);
  await settings({castFormula:'interval / 2'});
  check('编辑抛竿公式立即生效', (await simulate({speed:60})).data.cast.interval===8000);
  await registerAccount(user+'p');
  const player=await post('/api/login',{username:user+'p',password:'loot-test-1234'});
  const stream=http.get('http://127.0.0.1:'+PORT+'/events',{headers:BEARER(player.data.token)},res=>res.resume());
  stream.on('error',()=>{});
  await waitFor(async()=>(await getT('/api/players/page',player.data.token)).data?.players?.some(p=>p.id===user+'p'),{timeout:5000});
  const started=await postT('/api/fishing/start',{groundId:'map',spotId:'dock'},player.data.token);
  check('实际开钓采用已保存公式和钓点初始值', started.data.interval===8000,JSON.stringify(started.data));
  await postT('/api/fishing/stop',{},player.data.token);
  stream.destroy();
  const fish=D.FISH.common[0].id, mat=D.MATERIALS[0].id;
  await postT('/api/admin/loot/group',{group:{id:'matgroup',name:'材料测试组',weight:1,items:[{pick:'fish:'+fish,weight:3},{pick:'material:'+mat,weight:1}]}},at);
  await postT('/api/admin/spot/pool',{groundId:'map',spotId:'dock',pool:[{pick:'group:matgroup',weight:10},{pick:'material:'+mat,weight:2},{pick:'component:',weight:1}]},at);
  const material=(await simulate({material:100})).data.loot;
  const groupMat=material.find(r=>r.type==='material'&&r.group);
  const directMat=material.find(r=>r.type==='material'&&!r.group);
  const fishRow=material.find(r=>r.type==='fish');
  check('组内材料最终权重 ×2（2.5→5）', Math.abs(groupMat.afterPct-5/17.5*100)<1e-8);
  check('直接材料最终权重 ×2（2→4）', Math.abs(directMat.afterPct-4/17.5*100)<1e-8);
  check('非材料最终权重不变（鱼仍为7.5）', Math.abs(fishRow.afterPct-7.5/17.5*100)<1e-8);
  const negative=(await simulate({material:-100})).data.loot;
  check('材料概率 -100 不产生负权重', negative.filter(r=>r.type==='material').every(r=>r.afterPct===0));
  await settings({biteFormula:'clamp(90 + skill, 0, 100)'});
  await new Promise(resolve=>setTimeout(resolve,1200));
  killTree(srv); await boot();
  const persisted=JSON.parse(fs.readFileSync(path.join(TMP_DATA,'config.json'),'utf8'));
  check('自定义抛竿公式与迁移标记重启后保留', persisted.castCfg.formula==='interval / 2' && persisted.fishingFormulaRevision===2);
  check('备份重启后不被覆盖', JSON.stringify(persisted.fishingFormulaBackup)===JSON.stringify(originalBackup));
  check('首次迁移后主动保存的旧公式不再被覆盖', persisted.biteFormula==='clamp(90 + skill, 0, 100)');
  console.log('\n===== fishing-formulas 结果：通过 '+pass+' 项，失败 '+fail+' 项 =====');
}
main().catch(e=>{fail++;console.error('TEST ERROR:',e);}).finally(()=>{
  if(srv)killTree(srv);
  setTimeout(()=>process.exit(fail?1:0),300);
});
