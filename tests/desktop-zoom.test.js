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
 // voyage-map.js 是钓鱼页海图的依赖（缺失时 renderFishing 会在 VoyageMap.create 抛错），
 // 与 tests/mobile-layout.test.js 保持同一份脚本清单。
 for(const file of ['data','features','engine','voyage-map','ui']) await page.addScriptTag({path:path.join(root,'js',file+'.js')});
 await page.evaluate(()=>{
   document.querySelector('#auth').style.display='none';
   const D=GameData; window.ids=[];
   for(let i=1;i<=29;i++) {const id=D.instanceId('rod_bamboo','rare',[{type:'speed',value:i}]); ids.push(id); Engine.state.inventory[id]=2;}
   UI.setView('inventory'); UI.renderNav(); UI.renderView();
   [...document.querySelectorAll('.inv-page-tabs button')].find(b=>b.textContent.includes('组件')).click();
 });




 let pass=0;
 const check=(value,label)=>{assert.equal(value,true,label);pass++;};
 // Equivalent CSS viewport sizes for browser zoom on 1366x768 and 1920x1080 displays.
 const sizes=[];
 for(const [w,h] of [[1366,768],[1920,1080]]) for(const zoom of [.8,1,1.25,1.5,1.75,2]) sizes.push([Math.round(w/zoom),Math.round(h/zoom)]);
 sizes.push([1281,720],[1280,720],[881,500],[880,500],[641,400],[640,400]);
 for(const [width,height] of sizes) {
 await page.setViewportSize({width,height});
 for(const view of ['fishing','inventory','character','bd','codex','records','logs']) {
 await page.evaluate(v=>{UI.setView(v);UI.renderNav();UI.renderTopbar();UI.renderView();},view);
 const result=await page.evaluate(()=>({
 fit: [...document.querySelectorAll('#main > *, .topbar > *')].every(e=>{const r=e.getBoundingClientRect();return r.right<=innerWidth+1&&r.left>=0}),
 scroll: document.querySelector('#main').scrollWidth<=document.querySelector('#main').clientWidth+1,
 nav: (()=>{const a=document.querySelector('.nav-item.active').getBoundingClientRect();return innerWidth>880||a.left>=0&&a.right<=innerWidth;})()
 }));
 check(result.fit,width+' '+view+' panel/header fits');check(result.scroll,width+' '+view+' no horizontal overflow');check(result.nav,'selected navigation visible');
 }
 await page.evaluate(()=>{UI.setView('inventory');UI.renderView();});
 await page.getByRole('button',{name:'属性',exact:true}).first().click();
 await page.locator('.modal-box').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 check(await page.locator('.modal-box').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}),'modal fits '+width+'x'+height);
 await page.locator('.modal-close').click();
 }
 // Zoom across navigation breakpoints without rebuilding the selected page.
 await page.evaluate(()=>{UI.setView('logs');UI.renderNav();UI.renderView();});
 for(const width of [1400,768,390,880]) {
 await page.setViewportSize({width,height:700});
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 check(await page.evaluate(()=>{const r=document.querySelector('.nav-item.active').getBoundingClientRect();return innerWidth>880||r.left>=0&&r.right<=innerWidth;}),'resize keeps selected tab visible');
 }
 assert.deepEqual(errors,[]);pass++;
 console.log('通过 '+pass+' 项，失败 0 项');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
