'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { waitHttp } = require('./_util');
const base = 'http://localhost:8298';
// 与 run-all.js 的汇总口径对齐：统计断言条数，最后打印「通过 N 项，失败 0 项」
// （此前只打印一句话，run-all 解析不到小结会把通过判成失败）
let checks = 0;
['ok', 'equal', 'deepEqual', 'strictEqual', 'notEqual'].forEach(k => {
  const f = assert[k];
  if (typeof f !== 'function') return;
  assert[k] = function () { checks++; return f.apply(this, arguments); };
});
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-touch-trade-'));
async function pageApi(page, route, body) {
 const r = await page.evaluate(async ({ route, body }) => {
  const res = await fetch('/api/' + route, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
 }, { route, body });
 assert.equal(r.status, 200, route + ': ' + JSON.stringify(r.data)); return r.data;
}
let server, browser;
async function api(route, body) {
 const headers = {'Content-Type':'application/json'}; const payload = body ? { ...body } : body; if (payload && payload.token) { headers.Authorization = 'Bearer ' + payload.token; delete payload.token; } const r = await fetch(base + '/api/' + route, {method:'POST',headers,body:JSON.stringify(payload)});
 const result = await r.json(); assert.equal(r.status,200,route + ': ' + JSON.stringify(result)); return result;
}
(async()=>{
 server=spawn(process.execPath,['backend/server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:'8298',FISHING_DATA_DIR:data,FISHING_DEV:'1'},stdio:['pipe','ignore','inherit']});
 await waitHttp(base+'/api/version');
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const pages=[], tokens=[], errors=[];
 for(let i=0;i<3;i++) {
  const token=(await api('register',{username:'touchtrade'+i,password:'test1234-secure',qq:'123456'})).token; tokens.push(token);
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});pages.push(page);
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{const Native=window.EventSource;window.EventSource=class extends Native {constructor(...a){super(...a);window.testStream=this;window.testEvents=[];this.addEventListener('message',ev=>{const m=JSON.parse(ev.data);testEvents.push(...(m.type==='batch'?m.list:[m]));});}};});
  await page.goto(base);tokens[i] = await page.evaluate(async ({u,p})=>{const r=await Net.login(u,p);if(!r.ok)throw new Error(r.data&&r.data.error||'login failed');Net.setAuth(r.data.token,r.data.profile);document.getElementById("auth").remove();return r.data.token;},{u:'touchtrade'+i,p:'test1234-secure'});
  await page.waitForFunction(()=>Engine.state.me&&window.testEvents.some(m=>m.type==='init'));
 }
 const page=pages[0], spot='.px-node[data-g="rapids"][data-s="shoal"]';
 await page.evaluate(()=>{UI.setView('fishing');UI.renderNav();UI.renderView();});
 const calls=[];page.on('request',r=>{if(/\/api\/fishing\/(start|stop)$/.test(r.url()))calls.push(r.url().split('/').pop());});
 await page.locator(spot+' .pn-name').tap();
 await page.waitForTimeout(450);
 assert.equal(await page.evaluate(()=>Engine.state.fishing.active),true,'mobile tap remains fishing');
 assert.deepEqual(calls,['start'],'one tap must not also stop fishing');
 await page.locator(spot+' .pn-name').tap();await page.waitForTimeout(250);
 assert.deepEqual(calls,['start','stop'],'second tap stops once');
 await page.locator(spot).click();await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>Engine.state.fishing.active),true,'mouse starts once');
 await page.locator(spot).focus();await page.keyboard.press('Enter');await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>Engine.state.fishing.active),false,'keyboard stops');
 await page.locator(spot).focus();await page.keyboard.press('Space');await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>Engine.state.fishing.active),true,'keyboard starts');
 const dock='.px-node[data-g="stillwater"][data-s="dock"]';
 await page.locator(dock+' .pn-bob').tap();await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>Engine.state.player.spotId),'dock','float tap switches spots');
 assert.equal(calls.at(-1),'start','switch does not stop');
 await page.locator(dock+' .pn-name').tap();await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>Engine.state.fishing.active),false);
 // A touch cancelled by scrolling must not start fishing at pointerdown.
 await page.locator(dock).dispatchEvent('pointerdown',{pointerType:'touch',button:0});
 await page.locator(dock).dispatchEvent('pointercancel',{pointerType:'touch'});
 assert.equal(await page.evaluate(()=>Engine.state.fishing.active),false,'cancelled touch does not fish');
 await pageApi(pages[0],'dev/seed',{inventory:{crucian:5},coins:1000});
 const tradeId=(await pageApi(pages[0],'trade/invite',{target:'touchtrade1'})).tradeId;
 await pageApi(pages[1],'trade/respond',{tradeId,accept:true});
 await pageApi(pages[0],'trade/set',{tradeId,items:[{id:'crucian',qty:2}]});
 await pages[2].evaluate(()=>{Engine.state.trade={id:'unrelated-active-trade'};});
 await pageApi(pages[0],'trade/confirm',{tradeId});await pageApi(pages[1],'trade/confirm',{tradeId});
 for(const p of pages.slice(0,2))await p.waitForFunction(()=>testEvents.some(m=>m.type==='tradeDone'));
 await pages[2].waitForTimeout(350);
 assert.equal(await pages[2].evaluate(()=>testEvents.some(m=>m.type==='tradeDone')),false,'outsider receives no trade settlement');
 const logs=await Promise.all(pages.map(p=>p.evaluate(()=>JSON.parse(localStorage.getItem('fishing_log_'+Engine.state.me.id)||'[]').filter(e=>e.kind==='trade'))));
 assert.equal(logs[0].length,1);assert.equal(logs[1].length,1);assert.equal(logs[2].length,0,'outsider log stays empty');
 const settlement=await page.evaluate(()=>testEvents.find(m=>m.type==='tradeDone'));
 // Older servers may still broadcast globally: the client must also reject unrelated events.
 await pages[2].evaluate(m=>testStream.onmessage({data:JSON.stringify({type:'batch',list:[m]})}),settlement);
 assert.equal(await pages[2].evaluate(()=>Engine.state.trade.id),'unrelated-active-trade','unrelated settlement preserves ongoing trade');
 assert.equal(await pages[2].evaluate(()=>JSON.parse(localStorage.getItem('fishing_log_'+Engine.state.me.id)||'[]').filter(e=>e.kind==='trade').length),0);
 assert.deepEqual(errors,[]);
 console.log('通过 ' + checks + ' 项，失败 0 项（手机输入 + 三人交易回归）');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(browser)await browser.close();
 if(server)await new Promise(resolve=>{server.once('exit',resolve);server.stdin.end('q\n');});
});
