'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { waitHttp, waitFor } = require('./_util');
const F = require('../frontend/js/features');
const ROOT = path.join(__dirname, '..'), PORT = 8297, base = 'http://localhost:' + PORT;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-features-'));
let server, browser, pass = 0;
function check(value, name) { assert.ok(value, name); pass++; }
async function request(route, body) {
 const r = await fetch(base + route, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
}
async function start() {
 server=spawn(process.execPath,['backend/server.js'],{cwd:ROOT,env:{...process.env,PORT:String(PORT),FISHING_DATA_DIR:data,FISHING_DEV:'1'},stdio:['pipe','ignore','pipe']});
 await waitHttp(base+'/api/version');
}
async function stop() { if(!server)return; const child=server;server=null; await new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('q\n');}); }
(async()=>{
 await start();
 const adminReg=await request('/api/register',{username:'featureadmin',password:'test1234',qq:'123456'});
 check(adminReg.status===200,'admin account');
 const admin=(await request('/api/admin/login',{username:'featureadmin',password:'test1234'})).data.token;
 const player=(await request('/api/register',{username:'featureplayer',password:'test1234',qq:'123456'})).data.token;
 const set=features=>request('/api/admin/features',{token:admin,features});
 check((await request('/api/admin/features',{token:player,features:{mall:false}})).status===403,'players cannot change switches');
 check((await set({unknown:false})).status===400,'unknown ids rejected');
 check((await set({mall:'false'})).status===400,'non boolean rejected');
 const initial=(await request('/api/admin/features?token='+admin)).data;
 check(initial.groups.length===11,'all main pages catalogued');
 check(!F.blocked(initial.features,'workshop.open'),'old installations default to enabled');
 await request('/api/dev/seed',{token:player,inventory:{crucian:5},coins:50000});
 await set({'mall.sell':false});
 check((await request('/api/sell',{token:player,id:'crucian',qty:1})).status===423,'direct sell API blocked');
 check((await request('/api/me?token='+player)).data.inventory.crucian===5,'blocked sell preserves inventory');
 await set({workshop:false,'workshop.open':true});
 for(const route of ['/api/chest/craft','/api/chest/open','/api/workshop/smelt','/api/workshop/recast'])check((await request(route,{token:player})).status===423,'parent blocks '+route);
 check((await request('/api/market/cancel',{token:player,lid:'none'})).status!==423,'withdrawal remains possible');
 await set({workshop:true,'workshop.open':false});
 check((await request('/api/chest/open',{token:player})).status===423,'child lock retained');
 check((await request('/api/chest/craft',{token:player})).status!==423,'sibling remains enabled');
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.evaluate(t=>localStorage.setItem('fishing_token',t),player);await page.reload();
 await page.waitForFunction(()=>Engine.state.me);
 await page.evaluate(()=>{UI.setView('inventory');UI.renderNav();UI.renderView();});
 check(await page.locator('[data-feature="mall.sell"][aria-disabled="true"]').count()>0,'sell controls show locked state');
 await set({inventory:false});await page.waitForSelector('.feature-closed');
 check((await page.locator('.feature-closed').innerText()).includes('背包'),'online open page locks via SSE');
 await set({inventory:true});await page.waitForSelector('.inv-page');
 check(await page.locator('.inv-page').count()===1,'online page unlocks');

 const spot=await page.evaluate(()=>({g:GameData.GROUNDS[0].id,s:GameData.GROUNDS[0].spots[0].id}));
 check((await request('/api/fishing/start',{token:player,groundId:spot.g,spotId:spot.s})).status===200,'start active fishing');
 await set({'fishing.cast':false});
 await page.waitForFunction(()=>Engine.state.features['fishing.cast']===false&&!Engine.state.fishing.active);
 check((await request('/api/fishing/start',{token:player,groundId:spot.g,spotId:spot.s})).status===423,'fishing restart blocked');
 check((await request('/api/fishing/stop',{token:player})).status===200,'stop still allowed');
 const adminPage=await browser.newPage();adminPage.on('pageerror',e=>errors.push(e.message));
 await adminPage.goto(base+'/admin.html');await adminPage.evaluate(t=>localStorage.setItem('fishing_admin_token',t),admin);await adminPage.reload();
 await adminPage.getByRole('button',{name:'🔒 功能开关',exact:true}).click();
 await adminPage.waitForSelector('[data-feature-key="mall.sell"]');
 await adminPage.locator('[data-feature-key="mall.sell"]').check();
 await adminPage.getByRole('button',{name:'保存功能开关',exact:true}).click();
 await page.waitForFunction(()=>Engine.state.features['mall.sell']===true);
 check((await request('/api/sell',{token:player,id:'crucian',qty:1})).status===200,'admin UI unlock takes effect');
 await set({'character.companion':false});
 await page.waitForFunction(()=>Engine.state.features['character.companion']===false);
 await page.evaluate(()=>{UI.setView('character');UI.renderNav();UI.renderView();});
 check(await page.locator('[data-feature="character.companion"][aria-disabled="true"]').count()>0,'local cosmetic option visibly locked');

 // Existing automatic-sale rules must stop executing, not just become uneditable.
 await set({'mall.sell':false,'mall.autosell':true});
 await request('/api/autosell',{token:player,id:'crucian',on:true,keep:0});
 await set({'mall.autosell':false,'mall.sell':true});
 await request('/api/dev/seed',{token:player,inventory:{crucian:100},coins:50000});
 await request('/api/dev/catch',{token:player,item:{id:'crucian',kind:'fish',rarity:'common'}});
 check((await request('/api/me?token='+player)).data.inventory.crucian===101,'existing auto-sale rule paused');
 check((await request('/api/autosell',{token:player,id:'crucian',on:true})).status===423,'auto-sale configuration locked');
 const peer=(await request('/api/register',{username:'featurepeer',password:'test1234',qq:'123456'})).data.token;
 const peerPage=await browser.newPage();await peerPage.goto(base);await peerPage.evaluate(t=>localStorage.setItem('fishing_token',t),peer);await peerPage.reload();await peerPage.waitForFunction(()=>Engine.state.me);
 const invitation=await request('/api/trade/invite',{token:player,target:'featurepeer'});
 check(invitation.status===200,'trade invitation created');
 await request('/api/trade/respond',{token:peer,tradeId:invitation.data.tradeId,accept:true});
 await set({'ground.trade':false});
 check((await request('/api/trade/confirm',{token:player,tradeId:invitation.data.tradeId})).status===423,'in-progress trade cannot settle after locking');
 await set({'ground.trade':true});
 check((await request('/api/trade/confirm',{token:player,tradeId:invitation.data.tradeId})).status===404,'locking cancels existing trade');
 // Main-page switches cascade to every mutation in each group.
 for(const [parent,route] of [['bd','/api/bd/set'],['mall','/api/market/list'],['ground','/api/trade/invite'],['feedback','/api/feedback/submit'],['inventory','/api/subscribe']]) {
   await set({[parent]:false}); check((await request(route,{token:player})).status===423,'parent guard '+parent); await set({[parent]:true});
 }
 check(errors.length===0,'no browser exceptions: '+errors.join(','));
 await browser.close();browser=null;
 await stop();await start();
 const saved=(await request('/api/features')).data.features;
 check(saved['workshop.open']===false&&saved['mall.sell']===true&&saved['fishing.cast']===false,'switches persist across restart');
 console.log('通过 '+pass+' 项，失败 0 项');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();await stop();});
