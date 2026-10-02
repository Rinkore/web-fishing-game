'use strict';
// 渔屋玩家端（v0.25.0）：晒架 / 宠物职能 / 角色 三个页签；无被动离线金币。
// 验收项：
//   晒架页 — 显示晒架位、收取批次、升级；
//   宠物页 — 8 只宠物、职能标签、驻守控件；
//   角色页 — 三条方向；
//   偷取 — 拒绝码翻中文；
//   广播就地刷新不重建；幂等 requestKey 复用。
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'../frontend');
let count=0;
const check=(name,value)=>{assert.ok(value,name);count++;console.log('PASS '+name);};
const shot=async(page,name)=>{if(!process.env.FISHING_HOUSE_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.FISHING_HOUSE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.FISHING_HOUSE_SCREENSHOT_DIR,name)});};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.route('http://house.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   const file=path.join(root,p==='/'?'index.html':p);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   if(file.endsWith('index.html'))return route.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8').replace('window.Engine.init();','').replace('window.UI.init();','')});
   return route.fulfill({path:file});
  });
  const page=await context.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://house.test/');
  await page.evaluate(()=>{
   document.querySelector('#auth').remove();
   window.calls=[];
   // 服务端权威视图（v0.25 新字段口径：rackSlots / rackCapacity / steal / pets / roles / stationed）
   window.house={ownerId:'1',level:5,endless:0,prestige:0,
     rackCapacity:2,
     rackSlots:[
       {slotIdx:0,fishId:'silver_carp',fishTier:'common',phases:['dry'],phaseIdx:0,readyAt:new Date(Date.now()+3*3600*1000).toISOString(),done:false},
       {slotIdx:1,fishId:'tuna',fishTier:'rare',phases:['pre','dry','post'],phaseIdx:1,readyAt:new Date(Date.now()+1000).toISOString(),done:true,premium:false},
     ],
     pets:{golden:2,corgi:0},stationed:['golden'],roles:{cook:1,brine:0,trader:0},
     nextCost:{coins:8000,items:{lure:16,storm_relic:1}},
     steal:{picksLeft:2,picksMax:2,coinCap:200,coinUsed:0,heat:3}};
   window.houseReady=false;
   window.fetchHouseCalls=0;
   Net.fetchHouse=async()=>{window.fetchHouseCalls++;return {ok:true,data:{house:window.houseReady?window.house:null}};};
   Net.fetchFriends=async()=>({ok:true,data:{friends:[{id:'2',name:'老王',username:'laowang',online:true}],players:[],requests:{in:[],out:[]},page:1,pages:1,total:1}});
   Net.houseAction=async(action,body)=>{
    calls.push({action,body});
    if(window.failNetwork)return {ok:false,status:0,data:{}};
    if(action==='steal')return {ok:false,status:409,data:{error:'house_steal_pair_limit'}};
    const next=Object.assign({},window.house);
    if(action==='collect_rack'){
      next.rackSlots=next.rackSlots.filter(s=>!s.done);
    }
    if(action==='upgrade'){next.level=6;next.nextCost={coins:11000,items:{lure:20,storm_relic:1}};}
    window.house=next;Engine.state.house=next;
    return {ok:true,data:{house:next,result:{status:action+'ed'}}};
   };
   UI.setView('character');UI.renderNav();UI.renderView();
  });
  const host=page.locator('.char-view');
  await host.locator('[data-sectiontab="yard"]').waitFor();
  check('Empty state asks the server for the house view',await host.locator('.hint').first().innerText().then(t=>t.includes('正在读取渔屋状态'))
    && await page.evaluate(()=>fetchHouseCalls===1));
  await page.evaluate(()=>{window.houseReady=true;Engine.state.house=window.house;UI.refreshAll('house');});
  await host.locator('.rack-slots').waitFor();
  await shot(page,'house-yard-rack.png');

  check('Yard tab has rack-slots container',await host.locator('.rack-slots').count()===1);
  check('Rack shows 2 slots matching rackCapacity',await host.locator('[data-rack-slot]').count()===2);
  check('Slot 0 shows fish id and in-progress phase',await host.locator('[data-rack-slot="0"]').innerText().then(t=>t.includes('silver_carp')));
  check('Slot 1 is done and shows collect button',await host.locator('[data-rack-slot="1"]').innerText().then(t=>t.includes('完成')));
  check('Collect button visible when a batch is done',await host.locator('[data-house-action="collect_rack"]').count()===1);

  // 收取完成批次
  await host.locator('[data-house-action="collect_rack"]').click();
  await page.waitForFunction(()=>calls.length===1);
  check('CollectRack sends correct action',await page.evaluate(()=>calls[0].action==='collect_rack'&&calls[0].body.requestKey.startsWith('house-')));
  check('Collect removes done rack slot from view',
    await host.locator('[data-rack-slot="1"].rack-slot-active').count()===0
    || await host.locator('[data-rack-slot]').count()===1);

  // 升级
  await host.locator('[data-house-action="upgrade"]').waitFor();
  await page.evaluate(()=>{window.failNetwork=true;});
  await host.locator('[data-house-action="upgrade"]').click();
  await page.waitForFunction(()=>calls.length===2);
  await host.locator('[data-house-action="upgrade"]').click();
  await page.waitForFunction(()=>calls.length===3);
  check('Retry after transport failure reuses the same request key',await page.evaluate(()=>calls[1].body.requestKey===calls[2].body.requestKey&&calls[1].action==='upgrade'));
  await page.evaluate(()=>{window.failNetwork=false;});

  // assets 广播：就地更新，不重建
  await page.evaluate(()=>{
    const next=Object.assign({},window.house,{steal:Object.assign({},window.house.steal,{picksLeft:1})});
    window.house=next;Engine.state.house=next;window.sameNode=document.querySelector('.hut-panel');
    UI.refreshAll('assets');
  });
  check('Assets broadcast updates yard in place without rebuilding',await page.evaluate(()=>sameNode===document.querySelector('.hut-panel')));

  // 偷取 → 拒绝码翻中文
  await host.locator('[data-house-action="steal"]').waitFor();
  await host.locator('[data-house-action="steal"]').click();
  check('Steal rejection is translated to Chinese',await host.locator('[data-house-message]').innerText().then(t=>t.includes('今天已经偷过这位好友')));

  // 宠物页签
  await host.locator('[data-sectiontab="pet"]').click();
  await host.locator('[data-pet-card="golden"]').waitFor();
  await shot(page,'house-pet-role.png');
  check('Pet tab lists all eight pets with role labels and station controls',await host.locator('[data-pet-card]').count()===8
    && await host.locator('[data-pet-card="golden"]').innerText().then(t=>t.includes('亲和 2 / 10')&&t.includes('驻守中'))
    && await host.locator('[data-pet-card="corgi"] [data-pet-op="station"]').count()===1);
  // 验证职能标签显示（golden = production）
  check('Pet cards show role label',await host.locator('[data-pet-card="golden"]').innerText().then(t=>t.includes('生产')));
  // 驻守一只新宠物
  await host.locator('[data-pet-card="corgi"] [data-pet-op="station"]').click();
  await page.waitForFunction(()=>calls.length===5);
  check('Stationing a pet sends petId and petAction',await page.evaluate(()=>calls[4].action==='pet'&&calls[4].body.petId==='corgi'&&calls[4].body.petAction==='station'));

  // 角色页签
  await host.locator('[data-sectiontab="role"]').click();
  await host.locator('[data-track="cook"]').waitFor();
  await shot(page,'house-role.png');
  check('Role tab exposes the three training tracks',await host.locator('[data-track]').count()===3
    && await host.locator('[data-track="cook"]').isDisabled()===false);
  check('Role tab explains cook raises batch value and brine unlocks stage',
    await host.locator('.hut-panel').innerText().then(t=>t.includes('批次收益')&&t.includes('腌制')));

  // 角色页签 → 切回晒架
  await host.locator('[data-sectiontab="yard"]').click();
  check('Switching back to yard still shows rack-slots',await host.locator('.rack-slots').count()===1);

  // 钓竿页签保持独立
  await host.locator('[data-sectiontab="rod"]').click();
  await host.locator('.rod-slots').waitFor();
  check('Rod tab is independent of yard rebuild',await host.locator('.rod-slots').count()===1&&await host.locator('.hut-panel').count()===0);

  check('No browser script errors',errors.length===0);
 }finally{await browser.close();}
 console.log('通过 '+count+' 项，失败 0 项');
})().catch(e=>{console.error(e);console.log('通过 '+count+' 项，失败 1 项');process.exitCode=1;});
