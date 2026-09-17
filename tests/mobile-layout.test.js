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
 for(const file of ['data','engine','ui']) await page.addScriptTag({path:path.join(root,'js',file+'.js')});
 await page.evaluate(()=>{
   document.querySelector('#auth').style.display='none';
   const D=GameData; window.ids=[];
   for(let i=1;i<=29;i++) {const id=D.instanceId('rod_bamboo','rare',[{type:'speed',value:i}]); ids.push(id); Engine.state.inventory[id]=2;}
   UI.setView('inventory'); UI.renderNav(); UI.renderView();
   [...document.querySelectorAll('.inv-page-tabs button')].find(b=>b.textContent.includes('组件')).click();
 });


 let pass=0;
 function check(value,label){assert.equal(value,true,label);pass++;}
 for(const width of [320,390,430]) {
 await page.setViewportSize({width,height:844});
 for(const view of ['fishing','character','bd','inventory','codex','records','feedback','logs']) {
 await page.evaluate(v=>{UI.setView(v);UI.renderNav();UI.renderTopbar();UI.renderView();},view);
 const layout=await page.evaluate(()=>({
 overflow: [...document.querySelectorAll('#main > *')].some(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left<0}),
 compact:document.querySelector('.topbar').offsetHeight<=120,
 nav: (()=>{const a=document.querySelector('.nav-item.active').getBoundingClientRect();return a.left>=0&&a.right<=innerWidth;})(),
 space:parseFloat(getComputedStyle(document.body).paddingBottom)>=document.querySelector('.sidebar').offsetHeight,
 }));
 check(!layout.overflow,width+' '+view+' panel fits'); check(layout.compact,'compact header'); check(layout.nav,'active navigation visible');check(layout.space,'navigation does not cover content');
 }
 await page.evaluate(()=>{UI.setView('inventory');UI.renderView();});
 await page.getByRole('button',{name:'属性',exact:true}).first().click();
 await page.locator('.modal-box').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 check(await page.locator('.modal-box').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight+1;}),'component modal fits');
 check(await page.locator('.modal-close').evaluate(e=>e.getBoundingClientRect().height>=44),'close target');
 await page.locator('.modal-close').click();
 await page.locator('.inv-search input').fill('竹');
 check(await page.locator('.inv-search input').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=16),'input avoids mobile zoom');
 }
 await page.evaluate(()=>{UI.setView('fishing');UI.renderNav();UI.renderView();});
 if(process.env.FISHING_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.FISHING_SCREENSHOT_DIR,'mobile-fishing.png')});
 await page.evaluate(()=>{UI.setView('inventory');UI.renderNav();UI.renderView();});
 if(process.env.FISHING_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.FISHING_SCREENSHOT_DIR,'mobile-inventory.png')});
 assert.deepEqual(errors,[]);pass++;
 console.log('通过 '+pass+' 项，失败 0 项');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
