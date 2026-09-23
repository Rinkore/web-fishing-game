'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'../frontend');
(async()=>{
 fs.mkdirSync(path.resolve(__dirname,'../output/mail-validation'),{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
  await context.route('http://ops.test/**',async route=>{const p=new URL(route.request().url()).pathname;const file=path.join(root,p==='/'?'index.html':p);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});if(file.endsWith('index.html'))return route.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8').replace('window.Engine.init();','').replace('window.UI.init();','')});return route.fulfill({path:file});});
  await page.goto('http://ops.test/');
  await page.evaluate(()=>{
   document.querySelector('#auth').remove();Engine.state.me={id:'testmail',username:'testmail'};
   window.mailFixture={messages:[{id:'1',sender:'管理员',subject:'测试来信 <b>纯文本</b>',body:'第一行\n第二行<script>bad</script>',createdAt:Date.now(),read:false,claimed:false,attachments:[{itemId:'custom_badge',name:'航海纪念章',description:'测试自定义材料',quantity:3,tier:'normal'}]}],unread:1,pending:1,total:1,page:1};window.mailCalls=[];
   Net.mailGet=async()=>({ok:true,data:JSON.parse(JSON.stringify(mailFixture))});Net.mailChange=async(type,body)=>{mailCalls.push({type,body});mailFixture.messages[0].read=true;mailFixture.unread=0;if(type==='claim'){mailFixture.pending=0;mailFixture.messages[0].claimed=true;}return {ok:true,data:{}};};UI.resyncAssets=async()=>null;
   UI.setView('mail');UI.renderNav();UI.renderView();return MailUI.refresh(false);
  });
  assert.equal(await page.locator('[data-feature="mail"] .unread').count(),1);
  assert.equal(await page.locator('.mail-card summary b b').count(),0,'subject is escaped');
  await page.locator('.mail-card summary').click();await page.waitForFunction(()=>mailCalls.some(c=>c.type==='read'));
  await page.locator('[data-mail-claim]:enabled').waitFor();await page.locator('[data-mail-claim]').click();await page.waitForFunction(()=>document.querySelector('[data-mail-claim]').textContent==='已领取附件');
  assert.equal(await page.locator('[data-feature="mail"] .unread').count(),0);
  assert.equal(await page.evaluate(()=>mailCalls.filter(c=>c.type==='claim').length),1);
  await page.setViewportSize({width:390,height:844});assert(await page.locator('.mail-panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  await page.screenshot({path:path.resolve(__dirname,'../output/mail-validation/mail-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1280,height:900});await page.addScriptTag({url:'http://ops.test/js/admin-operations.js'});
  await page.evaluate(()=>{
   window.adminCalls=[];window.allowConfirm=false;window.opsData={config:structuredClone(GameData.EXPEDITION),sets:structuredClone(GameData.GEAR_SETS),revision:1,player:{captain:{marks:10,voyages:1,successes:0,starter:0,clears:{},heat:0,clues:0,samples:0,tracking:0,target:''},active:{id:'100',route:'trade',hours:8,endsAt:Date.now()+3600000}}};
   window.opsApi=async(method,url,body)=>{adminCalls.push({method,url,body});if(url.startsWith('/api/admin/expedition'))return {ok:true,data:method==='GET'?opsData:{result:{details:{coins:123}}}};if(url==='/api/admin/mail')return {ok:true,data:{items:[{id:'relic',name:'沉船残片',kind:'material',rarity:'rare',price:1},{id:'rod_bamboo',name:'竹竿',kind:'component',part:'rod',rarity:'common'}]}};return {ok:true,data:{}};};
   return AdminOperations.expedition(document.querySelector('#main'),opsApi,async()=>allowConfirm);
  });
  await page.locator('[data-ticket]').fill('2');await page.locator('[data-exp-config] button[type=submit]').click();await page.waitForFunction(()=>adminCalls.some(c=>c.url.endsWith('/config')));
  assert.equal(await page.evaluate(()=>adminCalls.find(c=>c.url.endsWith('/config')).body.config.ticket),2);
  await page.locator('[data-target]').fill('testmail');await page.locator('[data-load]').click();await page.locator('[data-finish]').click();assert.equal(await page.evaluate(()=>adminCalls.filter(c=>c.url.endsWith('/finish')).length),0);
  await page.evaluate(()=>{allowConfirm=true;});await page.locator('[data-finish]').click();await page.waitForFunction(()=>adminCalls.some(c=>c.url.endsWith('/finish')));
  assert.equal(await page.evaluate(()=>adminCalls.find(c=>c.url.endsWith('/finish')).body.id),'100');
  await page.locator('[data-progress="marks"]').fill('123');await page.locator('form.ops-card button').click();await page.waitForFunction(()=>adminCalls.some(c=>c.url.endsWith('/player')));
  await page.screenshot({path:path.resolve(__dirname,'../output/mail-validation/admin-expedition.png'),fullPage:true});
  await page.evaluate(()=>AdminOperations.mail(document.querySelector('#main'),opsApi,async()=>allowConfirm));
  await page.locator('[data-recipient]').fill('testmail');await page.locator('[data-subject]').fill('邮件测试');await page.locator('[data-body]').fill('附上测试物品');await page.locator('[data-qty]').fill('3');await page.locator('[data-add]').click();
  await page.locator('[data-send] button[type=submit]').click();await page.waitForFunction(()=>adminCalls.some(c=>c.url.endsWith('/send')));
  assert.equal(await page.evaluate(()=>adminCalls.find(c=>c.url.endsWith('/send')).body.attachments[0].quantity),3);
  await page.locator('[data-id]').fill('custom_badge');await page.locator('[data-name]').fill('航海纪念章');await page.locator('[data-description]').fill('测试物品');await page.locator('[data-custom] button[type=submit]').click();await page.waitForFunction(()=>adminCalls.some(c=>c.url.endsWith('/item')));
  await page.screenshot({path:path.resolve(__dirname,'../output/mail-validation/admin-mail.png'),fullPage:true});
  const opsFixture=await page.evaluate(()=>opsData);
  const adminPage=await context.newPage();adminPage.on('pageerror',e=>errors.push(e.message));
  await adminPage.route('http://ops.test/shop',route=>route.fulfill({json:{crucian:{base:1}}}));
  await adminPage.route('http://ops.test/api/**',route=>{
   const url=new URL(route.request().url());
   if(!['/api/admin/session','/api/admin/expedition','/api/admin/mail'].includes(url.pathname))return route.fulfill({status:400,json:{error:'测试未启用'}});
   const data=url.pathname==='/api/admin/session'?{username:'testadmin',name:'测试管理员'}:url.pathname==='/api/admin/expedition'?opsFixture:url.pathname==='/api/admin/mail'?{items:[{id:'relic',name:'沉船残片',kind:'material',rarity:'rare',price:1}]}:{};
   return route.fulfill({json:data});
  });
  await adminPage.goto('http://ops.test/admin.html');
  await adminPage.locator('.nav-item').filter({hasText:'远航与套装'}).click();
  await adminPage.locator('[data-exp-config]').waitFor();
  assert.equal(await adminPage.locator('[data-ticket]').inputValue(),String(opsFixture.config.ticket));
  await adminPage.screenshot({path:path.resolve(__dirname,'../output/mail-validation/admin-expedition-shell.png'),fullPage:true});
  await adminPage.locator('.nav-item').filter({hasText:'邮件管理'}).click();
  await adminPage.locator('[data-send]').waitFor();
  assert.equal(await adminPage.locator('[data-item] option').textContent(),'沉船残片 · relic');
  await adminPage.screenshot({path:path.resolve(__dirname,'../output/mail-validation/admin-mail-shell.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS mail unread/read/claim/mobile/escaping; admin config/finish/cancel/progress/send/custom-item forms and actual admin navigation');console.log('通过 12 项，失败 0 项');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
