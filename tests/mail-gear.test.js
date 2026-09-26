const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
(async()=>{
 const executablePath=process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(f=>fs.existsSync(f));
 const browser=await chromium.launch({executablePath,headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const root=path.resolve(__dirname,'../frontend');
  await page.route('http://gear.test/**',r=>{const pathname=new URL(r.request().url()).pathname,file=path.join(root,pathname==='/'?'index.html':pathname);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return r.fulfill({status:404});if(pathname==='/')return r.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8').replace('window.Engine.init();','').replace('window.UI.init();','')});return r.fulfill({path:file});});
  await page.goto('http://gear.test/');
  await page.evaluate(()=>{
   document.querySelector('#auth').remove();window.gearCalls=[];window.confirmations=[];window.approve=false;
   const signature=GameData.gearSignature('gear_reel_1',0,'','none',0),growth={level:0,engrave:'none',presets:0};
   const view={config:structuredClone(GameData.GEAR_SYSTEM),state:{tiers:{},receipts:10,heat:0},equipment:[{id:'1',signature,name:'测试卷线器',part:'reel',base:'gear_reel_1',growth,affixes:[{type:'speed',value:1}],bound:true,rewardBound:true,bindOutputs:true},{id:'2',signature,name:'普通卷线器',part:'reel',base:'gear_reel_1',growth,affixes:[{type:'speed',value:1}],bound:false,rewardBound:false,bindOutputs:false}],rewardBindings:{}};
   UI.confirmModal=async o=>{confirmations.push(o);return approve;};
   Net.gearApi=async(method,url,body)=>{if(method==='POST'){gearCalls.push(body);return {ok:true,data:{result:{details:{id:'1'}}}};}return {ok:true,data:structuredClone(view)};};
   GearUI.mount(document.querySelector('#main'));
  });
  // 组件选择在「强化路径」框体内的卡片里：先点卡片打开子窗口，再点配件选中。
  await page.locator('.gear-pick-card[data-pick-card="open"]').click();
  await page.locator('.gear-pick-modal .gear-item').first().waitFor();
  assert.match(await page.locator('.gear-pick-modal .gear-item').first().textContent(),/奖励绑定/);
  await page.locator('[data-pick-item="1"]').click();
  await page.locator('[data-action="upgrade"]').waitFor();
  await page.locator('[data-action="upgrade"]').click();await page.waitForFunction(()=>confirmations.length===1);assert.equal(await page.evaluate(()=>gearCalls.length),0,'cancel preserves assets');
  await page.evaluate(()=>approve=true);await page.locator('[data-action="upgrade"]').click();await page.waitForFunction(()=>gearCalls.length===1);await page.locator('[data-action="upgrade"]:enabled').waitFor();assert.equal(await page.evaluate(()=>gearCalls[0].unboundInputs),false);
  // 「仅使用普通物品」下奖励绑定装备不可操作，先点卡片取消、再重选普通配件，请求才带 unboundInputs。
  await page.locator('[data-reward-source]').selectOption('free');
  assert.equal(await page.locator('[data-action="upgrade"]').isDisabled(),true);
  await page.locator('.gear-pick-card[data-pick-card="clear"]').click();
  assert.equal(await page.locator('.gear-pick-card[data-pick-card="open"]').count(),1);
  await page.locator('.gear-pick-card[data-pick-card="open"]').click();
  await page.locator('[data-pick-item="2"]').click();
  await page.locator('[data-action="upgrade"]').click();await page.waitForFunction(()=>gearCalls.length===2);assert.equal(await page.evaluate(()=>gearCalls[1].unboundInputs),true);assert.deepEqual(errors,[]);
  console.log('PASS growth picker card, reward binding display, cancellation, confirmation and ordinary-only request');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
