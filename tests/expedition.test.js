'use strict';
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
  await context.route('http://expedition.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   const file=path.join(root,p==='/'?'index.html':p);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   if(file.endsWith('index.html'))return route.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8').replace('window.Engine.init();','').replace('window.UI.init();','')});
   return route.fulfill({path:file});
  });
  const page=await context.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://expedition.test/');
  await page.evaluate(()=>{
   document.querySelector('#auth').remove();const D=GameData;
   // 本套件覆盖的是「远洋页 + 历史远征面板」的契约：只有关闭装备成长系统时，
   // ExpeditionUI 才会走 legacy 渲染（enabled 时由远航中心接管，见 tests/expedition-growth.test.js）。
   D.GEAR_SYSTEM.enabled=false;
   window.fixture={ship:{lv:1,name:'木划艇',xp:0,xpNeed:40,xpOk:false,upCoins:20000,upScale:5},coins:1000,deepscale:0,chartfrag:0,charts:0,chartCost:3,zones:[],quests:[],partyZones:[],
    expedition:{now:Date.now(),captain:{marks:0,voyages:0,successes:0,starter:0,clears:{},heat:0,clues:0,samples:0,tracking:0},config:D.EXPEDITION,sets:D.GEAR_SETS,gear:{level:1,set:'',effects:{stability:0,resonance:0,settle:0}},active:null,last:null}};
   window.calls=[];Engine.state.player.coins=1000;
   Net.seaGet=async()=>({ok:true,data:fixture});
   Net.seaExpedition=async(type,body)=>{
    calls.push({type,body});
    if(type==='start')fixture.expedition.active={id:'100',route:body.route,hours:body.hours,ready:false,startedAt:Date.now(),endsAt:Date.now()+body.hours*3600000,snapshot:{level:1,set:'',effects:{},success:100}};
    if(type==='claim'){fixture.expedition.last={...fixture.expedition.active,claimed:true};fixture.expedition.active=null;fixture.expedition.captain.starter=1;fixture.expedition.captain.marks=5;}
    if(type==='redeem')fixture.expedition.captain.starter=2;
    if(type==='target'){fixture.expedition.captain.target=body.target;fixture.expedition.captain.tracking=0;}
    return {ok:true,data:{sea:fixture}};
   };
   UI.setView('sea');UI.renderView();
  });
  const host=page.locator('.expedition-panel');await host.getByText('远航派遣',{exact:false}).first().waitFor();
  check('New expedition appears inside existing sea page',await host.count()===1 && await page.locator('#sea-chart-craft').count()===1);
  check('Sea page keeps functional pages only (intro help removed)',await page.locator('.sea-help').count()===0 && await page.locator('.sea-overview').count()===0);
  check('Sea title shares one row with the three function tabs',await page.locator('.sea-topbar .sea-nav>button').count()===3);
  check('Sea dock page leads with the four-step visual guide',await page.locator('[data-sea="step"]').count()===4 && await page.locator('.sea-legend .gear-mile').count()>0);
  check('Five routes follow the ship progression',await host.locator('[data-exp-start]').count()===5);
  check('Lv1 can start coastal route and sees higher routes locked',await host.locator('[data-exp-start="trade"]').isEnabled() && await host.locator('[data-exp-start="gather"]').isDisabled());
  check('Starter ticket exemption is visible',await host.innerText().then(t=>t.includes('前 3 次沿岸贸易免门票')));
  await host.locator('[data-exp-hours]').selectOption('12');
  await page.evaluate(()=>{window.sameHost=document.querySelector('.expedition-panel');UI.renderView();});
  check('Routine updates preserve duration and panel DOM',await host.locator('[data-exp-hours]').inputValue()==='12' && await page.evaluate(()=>sameHost===document.querySelector('.expedition-panel')));
  await host.locator('[data-exp-start="trade"]').click();
  check('Departure opens confirmation without sending a request',await page.locator('.confirm-modal').count()===1 && await page.evaluate(()=>calls.length===0));
  check('Confirmation shows chosen duration and ticket cost',(await page.locator('.confirm-modal').innerText()).includes('12 小时'));
  await page.locator('.cf-cancel').click();
  check('Cancel leaves the expedition undispatched',await page.evaluate(()=>calls.length===0));
  await host.locator('[data-exp-start="trade"]').click();await page.locator('.cf-ok').click();await host.locator('.exp-active').waitFor();
  check('Dispatch sends chosen duration with a stable request key',await page.evaluate(()=>calls[0].body.hours===12&&calls[0].body.requestKey.startsWith('exp-')));
  check('Active voyage prevents a second dispatch',await host.locator('[data-exp-start]:enabled').count()===0);
  check('Reward button is absent while sailing',await host.locator('[data-exp-claim]').count()===0);
  await page.evaluate(()=>{fixture.expedition.active.ready=true;fixture.expedition.active.reward={event:'平安返航',coins:72000,xp:24,marks:8,items:{tide_sand:6,curesalt:6}};ExpeditionUI.update(document.querySelector('.expedition-panel'),fixture,document.querySelector('.expedition-panel')._onChange);});
  await host.locator('[data-exp-claim]').click();await host.locator('[data-exp-choice="tide"]').waitFor();
  check('First success unlocks whole-set choice',await host.locator('[data-exp-choice="tide"]').isEnabled());
  check('Undesigned merchant set is a preview, not a redeemable fake feature',await host.locator('[data-exp-redeem="market"]').count()===0);
  await host.locator('[data-exp-choice="tide"]').click();await page.locator('.cf-cancel').click();
  check('Canceling the choice does not consume the unique entitlement',await page.evaluate(()=>calls.filter(x=>x.type==='redeem').length===0));
  await host.locator('[data-exp-choice="tide"]').click();await page.locator('.cf-ok').click();
  check('Confirming redeems two-piece starter and removes choice buttons',await page.evaluate(()=>calls.at(-1).body.starter===true)&&await host.locator('[data-exp-choice]').count()===0);
  await page.evaluate(()=>{fixture.expedition.gear.set='apex';fixture.expedition.captain.tracking=2;ExpeditionUI.update(document.querySelector('.expedition-panel'),fixture,document.querySelector('.expedition-panel')._onChange);});
  await host.locator('[data-exp-target]').selectOption('carp');await host.locator('[data-exp-target-save]').click();
  check('Hunter target choice is sent and resets tracking in returned state',await page.evaluate(()=>calls.at(-1).type==='target'&&calls.at(-1).body.target==='carp')&&(await host.innerText()).includes('追踪 0/3'));
  await page.setViewportSize({width:390,height:844});
  check('Mobile route cards do not overflow horizontally',await host.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await page.evaluate(()=>{fixture.expedition.config={};ExpeditionUI.update(document.querySelector('.expedition-panel'),fixture,document.querySelector('.expedition-panel')._onChange);});
  check('Older published catalogs show a pending configuration state', (await host.innerText()).includes('尚未启用远航'));
  check('Auto build never mixes different set identities',await page.evaluate(()=>{
    const p=GameData.autoBuildPlan({parts:['rod','charm'],candidates:{rod:['set_tide_rod#epic#mat+8','set_apex_rod#epic#skl+8'],charm:['set_apex_charm#epic#size+6','set_tide_charm#epic#stl+6']},order:['material','size']});
    return GameData.componentOf(p.picks.rod).setId===GameData.componentOf(p.picks.charm).setId;
  }));
  check('Auto build respects two ordinary resonance pieces',await page.evaluate(()=>{
    const p=GameData.autoBuildPlan({parts:['line','bait','accessory'],candidates:{line:['line_nylon#epic#res+10','gear_line_1#epic#spd+3'],bait:['gear_bait_3#epic#res+5'],accessory:['gear_accessory_2#epic#res+5']},order:['resonance']});
    return p.picks.line==='gear_line_1#epic#spd+3'&&p.vec.resonance===10;
  }));
  check('Owned complete sets lock cores and preserve chosen grown accessories',await page.evaluate(()=>{
    const D=GameData, rod='set_harvest_rod#epic#mat+8', charm='set_harvest_charm#epic#stl+6';
    const line=D.gearSignature('gear_line_1',8,'speed','main',0);
    const state={bd:{rod:{compId:rod}},inventory:{[charm]:1,[line]:1,'set_apex_rod#epic#skl+8':1}};
    const options=D.autoBuildOptions(state,{set:'harvest',fixed:{line}});
    const plan=D.autoBuildPlan({candidates:options.candidates});
    return !options.error&&options.sets.length===1&&plan.picks.rod===rod&&plan.picks.charm===charm&&plan.picks.line===line&&plan.vec.skill>=D.autoBuildVec(D.componentOf(line)).skill;
  }));
  check('Missing selected cores or fixed accessories invalidate stale plans',await page.evaluate(()=>{
    return !!GameData.autoBuildOptions({inventory:{},bd:{}},{set:'tide'}).error&&!!GameData.autoBuildOptions({inventory:{},bd:{}},{fixed:{line:'gone'}}).error;
  }));
  check('Fixed empty slots remain empty while other owned accessories optimize',await page.evaluate(()=>{
    const D=GameData,line=D.gearSignature('gear_line_1',4,'speed','none',0);
    const options=D.autoBuildOptions({inventory:{[line]:1},bd:{}},{fixed:{line:null}});
    return D.autoBuildPlan({candidates:options.candidates}).picks.line===null;
  }));
  check('No browser script errors',errors.length===0);
 }finally{await browser.close();}
 console.log('通过 '+count+' 项，失败 0 项');
})().catch(e=>{console.error(e);console.log('通过 '+count+' 项，失败 1 项');process.exitCode=1;});
