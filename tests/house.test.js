'use strict';
// 渔屋（v0.24.0）玩家端：四个页签可切换、钓竿页行为不变、广播时渔屋页不重建、幂等 requestKey 复用。
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'../frontend');
let count=0;
const check=(name,value)=>{assert.ok(value,name);count++;console.log('PASS '+name);};
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
   // 服务端权威视图（字段口径见 IMPLEMENTATION-CONTRACT §3/§4）
   window.house={ownerId:'1',level:5,endless:0,prestige:0,rate:68,capacityHours:8,hours:6.5,pending:442,
     pets:{golden:2,corgi:0},stationed:['golden'],roles:{cook:1,brine:0,trader:0},
     nextCost:{coins:8000,items:{lure:16,storm_relic:1}},
     steal:{picksLeft:2,picksMax:2,coinCap:200,coinUsed:0,heat:3}};
   // 首屏先走「还没有权威视图」的空态：page 只请求一次，数据到了再重绘
   window.houseReady=false;
   window.fetchHouseCalls=0;
   Net.fetchHouse=async()=>{window.fetchHouseCalls++;return {ok:true,data:{house:window.houseReady?window.house:null}};};
   Net.fetchFriends=async()=>({ok:true,data:{friends:[{id:'2',name:'老王',username:'laowang',online:true}],players:[],requests:{in:[],out:[]},page:1,pages:1,total:1}});
   Net.houseAction=async(action,body)=>{
    calls.push({action,body});
    if(window.failNetwork)return {ok:false,status:0,data:{}};
    if(action==='steal')return {ok:false,status:409,data:{error:'house_steal_pair_limit'}};
    const next=Object.assign({},window.house);
    if(action==='collect'){next.pending=0;next.hours=0;}
    if(action==='upgrade'){next.level=6;next.rate=74;next.nextCost={coins:11000,items:{lure:20,storm_relic:1}};}
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
  await host.locator('[data-house-pending]').waitFor();
  check('Sidebar character entry is now the fish house',await page.locator('#nav .nav-item').filter({hasText:'渔屋'}).count()===1);
  check('Four tabs render on the fish house page',await host.locator('.section-tabs button').count()===4
    && await host.locator('[data-sectiontab="rod"]').count()===1 && await host.locator('[data-sectiontab="yard"]').count()===1);
  check('Yard tab lands first and shows the offline pool',await host.locator('.section-tabs button.on').innerText().then(t=>t.includes('晒场'))
    && await host.locator('[data-house-pending]').innerText().then(t=>t.includes('442')));
  check('Collect has no daily cap (time is the only limit)',await host.locator('.hut-panel').innerText().then(t=>t.includes('领取次数不限')&&t.includes('单次最多结算 8 小时')));
  check('Upgrade cost shows the material whitelist and current holdings',await host.locator('.hut-panel').innerText().then(t=>t.includes('风暴遗物')&&t.includes('持有')));
  await host.locator('[data-house-action="collect"]').click();
  await page.waitForFunction(()=>calls.length===1);
  check('Collect sends a persisted request key',await page.evaluate(()=>calls[0].action==='collect'&&calls[0].body.requestKey.startsWith('house-')&&calls[0].body.requestKey.length>=8));
  check('Collect redraws from the authoritative response',await host.locator('[data-house-action="collect"]').isDisabled()
    && await host.locator('[data-house-pending]').innerText().then(t=>t.includes('0')));
  // 幂等：网络层失败（无状态码）时同一操作必须复用同一个 key，重试不会重复发奖
  await page.evaluate(()=>{window.failNetwork=true;});
  await host.locator('[data-house-action="upgrade"]').click();
  await page.waitForFunction(()=>calls.length===2);
  await host.locator('[data-house-action="upgrade"]').click();
  await page.waitForFunction(()=>calls.length===3);
  check('Retry after a transport failure reuses the same request key',await page.evaluate(()=>calls[1].body.requestKey===calls[2].body.requestKey&&calls[1].action==='upgrade'));
  await page.evaluate(()=>{window.failNetwork=false;});
  // 每竿一次的 assets 广播：结构没变 → 就地更新，不重建 DOM
  await page.evaluate(()=>{window.house=Object.assign({},window.house,{pending:510,hours:7.5});Engine.state.house=window.house;window.sameNode=document.querySelector('.hut-panel');UI.refreshAll('assets');});
  check('Assets broadcast updates the yard in place without rebuilding',await page.evaluate(()=>sameNode===document.querySelector('.hut-panel'))
    && await host.locator('[data-house-pending]').innerText().then(t=>t.includes('510')));
  // 好友偷取：拒绝码翻中文（面板自带 errors{} 表）
  await host.locator('[data-house-action="steal"]').waitFor();
  check('Steal lists friends as targets',await page.locator('[data-house-action="steal"]').count()===1);
  await host.locator('[data-house-action="steal"]').click();
  check('Steal rejection is translated to Chinese',await host.locator('[data-house-message]').innerText().then(t=>t.includes('今天已经偷过这位好友')));
  // 宠物页签
  await host.locator('[data-sectiontab="pet"]').click();
  await host.locator('[data-pet-card="golden"]').waitFor();
  check('Pet tab lists all eight pets with affinity and station controls',await host.locator('[data-pet-card]').count()===8
    && await host.locator('[data-pet-card="golden"]').innerText().then(t=>t.includes('亲和 2 / 10')&&t.includes('驻守中'))
    && await host.locator('[data-pet-card="corgi"] [data-pet-op="station"]').count()===1);
  await host.locator('[data-pet-card="corgi"] [data-pet-op="station"]').click();
  await page.waitForFunction(()=>calls.length===5);
  check('Stationing a pet sends the server pet id and action',await page.evaluate(()=>calls[4].action==='pet'&&calls[4].body.petId==='corgi'&&calls[4].body.petAction==='station'));
  // 角色页签
  await host.locator('[data-sectiontab="role"]').click();
  await host.locator('[data-track="cook"]').waitFor();
  check('Role tab exposes the three training tracks',await host.locator('[data-track]').count()===3
    && await host.locator('[data-track="cook"]').isDisabled()===false);
  check('Role tab keeps the 48-set appearance gallery as a local decoration layer',await host.locator('.char-look img').count()===1
    && await host.locator('.char-look .cb-chip').count()===11);
  // 钓竿页签：行为与改造前一致（bd 的渲染与 pageIdOf 折算都没动）
  await host.locator('[data-sectiontab="rod"]').click();
  await host.locator('.rod-slots').waitFor();
  check('Rod stays the first-class tab it was before the rebuild',await host.locator('.rod-slots').count()===1
    && await host.locator('.hut-panel').count()===0);
  check('No browser script errors',errors.length===0);
 }finally{await browser.close();}
 console.log('通过 '+count+' 项，失败 0 项');
})().catch(e=>{console.error(e);console.log('通过 '+count+' 项，失败 1 项');process.exitCode=1;});
