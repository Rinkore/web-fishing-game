'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
 try {
 const page = await browser.newPage(); const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 const root=path.join(__dirname,'../frontend');
 await page.route('http://fishing.test/**', route => {
   const name=new URL(route.request().url()).pathname;
   if(name==='/') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,'')});
   const file=path.join(root,name);
   if(fs.existsSync(file)) return route.fulfill({path:file});
   return route.fulfill({status:404,body:''});
 });
 await page.goto('http://fishing.test/');
 for(const file of ['data','features','engine','ui']) await page.addScriptTag({path:path.join(root,'js',file+'.js')});
 await page.evaluate(()=>{
   document.querySelector('#auth').style.display='none';
   const D=GameData; window.ids=[];
   for(let i=1;i<=29;i++) {const id=D.instanceId('rod_bamboo','rare',[{type:'speed',value:i}]); ids.push(id); Engine.state.inventory[id]=2;}
   UI.setView('inventory'); UI.renderNav(); UI.renderView();
   [...document.querySelectorAll('.inv-page-tabs button')].find(b=>b.textContent.includes('组件')).click();
 });
 // v0.16.0：组件分类按「行」分页——组头也算一行（折叠组只占 1 行），
 // 所以单个底材组展开时第一页是 1 个组头 + 11 个成员行。
 assert.equal(await page.locator('.inv-group-head').count() + await page.locator('.inv-page-row').count(),12,
   '第一页共 12 行（组头 + 成员）');
 assert.equal(await page.locator('.inv-page-row').count(),11);
 await page.getByRole('button',{name:'下一页',exact:true}).click();
 assert.match(await page.locator('.inv-page-info').innerText(),/第 2 \/ 3/);
 await page.evaluate(()=>{window.savedRow=document.querySelector('.inv-page-row'); Engine.state.inventory[ids[0]]++; UI.refreshAll('assets');});
 assert.equal(await page.evaluate(()=>savedRow===document.querySelector('.inv-page-row')),true);
 await page.getByRole('button',{name:'下一页',exact:true}).click();
 assert.equal(await page.locator('.inv-page-row').count(),6);
 await page.locator('.inv-search input').fill('不存在的组件');
 await page.locator('.inv-search').getByRole('button',{name:'搜索',exact:true}).click();
 assert.equal(await page.locator('.inv-page-row').count(),0);
 assert.match(await page.locator('.inv-page-info').innerText(),/第 1 \/ 1/);
 await page.locator('.inv-search input').fill('竹');
 await page.locator('.inv-search input').press('Enter');
 assert.equal(await page.locator('.inv-page-row').count(),11);
 for(const width of [1440,390,320]) {
   await page.setViewportSize({width,height:800});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
   assert.equal(await page.evaluate(()=>document.querySelector('.inv-page').getBoundingClientRect().height<=innerHeight*.6+1),true);
 }
 await page.getByRole('button',{name:'下一页',exact:true}).click();
 await page.getByRole('button',{name:'下一页',exact:true}).click();
 await page.evaluate(()=>{Engine.state.inventory={[ids[0]]:1}; UI.refreshAll('assets');});
 assert.match(await page.locator('.inv-page-info').innerText(),/第 1 \/ 1/);
 assert.equal(await page.locator('.inv-page-row').count(),1);
 assert.equal(await page.locator('.inv-group-head').count(),1);
 assert.deepEqual(errors,[]);
 console.log('通过 16 项，失败 0 项');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
