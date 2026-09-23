const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const root=path.resolve(__dirname,'../frontend');
  await page.route('http://gear.test/**',r=>{const pathname=new URL(r.request().url()).pathname,file=path.join(root,pathname==='/'?'index.html':pathname);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return r.fulfill({status:404});if(pathname==='/')return r.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8').replace('window.Engine.init();','').replace('window.UI.init();','')});return r.fulfill({path:file});});
  await page.goto('http://gear.test/');
  await page.evaluate(()=>{
   document.querySelector('#auth').remove();window.gearCalls=[];window.confirmations=[];window.approve=false;
   const view={config:structuredClone(GameData.GEAR_SYSTEM),state:{tiers:{},receipts:10,heat:0},equipment:[{id:'1',signature:GameData.gearSignature('gear_reel_1',0,'','none',0),name:'测试卷线器',part:'reel',base:'gear_reel_1',growth:{level:0,engrave:'none',presets:0},affixes:[{type:'speed',value:1}],bound:true,rewardBound:true,bindOutputs:true}],rewardBindings:{}};
   UI.confirmModal=async o=>{confirmations.push(o);return approve;};
   Net.gearApi=async(method,url,body)=>{if(method==='POST'){gearCalls.push(body);return {ok:true,data:{result:{details:{id:'1'}}}};}return {ok:true,data:structuredClone(view)};};
   GearUI.mount(document.querySelector('#main'));
  });
  await page.locator('[data-action="upgrade"]').waitFor();
  assert.match(await page.locator('.gear-item').textContent(),/奖励绑定/);
  await page.locator('[data-action="upgrade"]').click();await page.waitForFunction(()=>confirmations.length===1);assert.equal(await page.evaluate(()=>gearCalls.length),0,'cancel preserves assets');
  await page.evaluate(()=>approve=true);await page.locator('[data-action="upgrade"]').click();await page.waitForFunction(()=>gearCalls.length===1);await page.locator('[data-action="upgrade"]:enabled').waitFor();assert.equal(await page.evaluate(()=>gearCalls[0].unboundInputs),false);
  await page.locator('[data-reward-source]').selectOption('free');await page.locator('[data-action="upgrade"]').click();await page.waitForFunction(()=>gearCalls.length===2);assert.equal(await page.evaluate(()=>gearCalls[1].unboundInputs),true);assert.deepEqual(errors,[]);
  console.log('PASS growth reward binding display, cancellation, confirmation and ordinary-only request');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
