'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'../frontend');
let count=0;function check(name,value){assert.ok(value,name);count++;console.log('PASS '+name);}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://aquaculture.test/**',route=>{
   const p=new URL(route.request().url()).pathname;if(p.startsWith('/api'))return route.fulfill({status:503,contentType:'application/json',body:'{}'});
   const file=path.join(root,p==='/'?'index.html':p);if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   if(file.endsWith('index.html'))return route.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8').replace('window.Engine.init();','').replace('window.UI.init();','')});
   return route.fulfill({path:file});
  });
  await page.goto('http://aquaculture.test/');
  await page.evaluate(async()=>{
   document.getElementById('auth').style.display='none';
   const c=await fetch('assets/genetics/catalog.json').then(r=>r.json());
   window.makeFish=(id,name,habitatId='',size='normal')=>{
    const traits={},ornaments={};
    c.loci.forEach(l=>traits[l]={alleles:[name,name],winner:name,source:name,dominant:name,mode:'complete_dominance',zygosity:'homozygous',hidden:false});
    traits.size={alleles:[size,size],winner:size,source:size,dominant:size,mode:'complete_dominance',zygosity:'homozygous',hidden:false};
    for(const [l,m] of Object.entries({...c.colors,...c.mutations,...c.ornaments})){
     const native=m.reference===name,a=native?m.allele:m.wild;
     traits[l]={alleles:[a,a],winner:a,source:native?name:a,dominant:a,mode:m.dominance,zygosity:'homozygous',hidden:false};
     if(m.reference)ornaments[l]=native;
    }
    return{id,species:name,generation:0,parents:['',''],genes:{},active:true,habitatId,phenotype:{body:name,size,traits,mutations:{},colors:{},ornaments,referenceExact:true,referenceSha256:c.species[name].sha256}};
   };
   const facility=(id,kind,ids,cap)=>({id,kind,name:({aquarium:'淡水观赏鱼缸',freshwater:'淡水养殖场',marine:'海水养殖场'})[kind]+' 1',capacity:cap,fishIds:ids,compatiblePairs:kind==='aquarium'?1:0,nextSpawnAt:Date.now()+600000,status:kind==='aquarium'?'waiting':'no_pair'});
   window.aqua={fish:[makeFish('1','koi','10'),makeFish('2','moonkoi','10'),makeFish('3','bass','11'),makeFish('4','tuna','12'),makeFish('5','koi'),makeFish('6','koi','','giant'),makeFish('9','moonkoi')],
    habitats:[facility('10','aquarium',['1','2'],8),facility('11','freshwater',['3'],12),facility('12','marine',['4'],10)],
    stock:[{species:'koi',tier:'normal',quantity:5},{species:'moonkoi',tier:'normal',quantity:5},{species:'bass',tier:'normal',quantity:2},{species:'tuna',tier:'normal',quantity:2},{species:'koi',tier:'giant',quantity:1}],
    habitatCapacities:{aquarium:8,freshwater:12,marine:10},habitatLimit:2,spawnIntervalSeconds:600,capacity:60,breedCost:100,mutationRate:.01,reagents:{},reagentPrices:{}};
   window.aquaCalls=[];window.nextFounder=100;Net.breedingGet=async()=>({ok:true,data:{breeding:aqua}});
   Net.breedingAction=async body=>{
    aquaCalls.push(body);
    if(window.rejectFull)return{ok:false,status:409,data:{error:'breeding_habitat_full'}};
    let resourceId='';
    if(body.action==='founder'){
     resourceId=String(nextFounder++);const parent=makeFish(resourceId,body.species,body.habitatId||'',body.tier);
     aqua.fish.push(parent);if(body.habitatId)aqua.habitats.find(h=>h.id===body.habitatId).fishIds.push(resourceId);
    }
    if(body.action==='habitat_create'){resourceId='13';aqua.habitats.push(facility('13',body.habitatKind,[],8));}
    if(body.action==='stock'||body.action==='unstock'){
     const f=aqua.fish.find(x=>x.id===body.id);aqua.habitats.forEach(h=>h.fishIds=h.fishIds.filter(id=>id!==f.id));
     f.habitatId=body.action==='stock'?body.habitatId:'';if(f.habitatId)aqua.habitats.find(h=>h.id===f.habitatId).fishIds.push(f.id);
    }
    if(body.action==='breed'){
     const child=makeFish('7','moonkoi');child.generation=1;child.parents=['1','2'];
     child.phenotype.referenceExact=false;child.phenotype.ornaments={goldscale:true,moonlight:false};
     child.phenotype.traits.goldscale={alleles:['K','k'],winner:'K',source:'koi',dominant:'K',recessive:'k',mode:'dominant',zygosity:'heterozygous',hidden:false};
     child.phenotype.traits.moonlight={alleles:['M','m'],winner:'M',source:'M',dominant:'M',recessive:'m',mode:'recessive',zygosity:'heterozygous',hidden:true,reason:'杂合携带'};
     aqua.fish.push(child);
     const carrier=makeFish('8','moonkoi');carrier.generation=2;carrier.phenotype.referenceExact=false;
     carrier.phenotype.ornaments={goldscale:false,moonlight:false};aqua.fish.push(carrier);
    }
    return{ok:true,data:{breeding:aqua,result:{resourceId}}};
   };
   Engine.state.me={name:'tester',admin:false};Engine.state.features={};Engine.state.house={level:5,capacityHours:24,hours:0};
   Net.fetchHouse=async()=>({ok:true,data:{house:Engine.state.house}});
   UI.renderTopbar();UI.renderNav();UI.renderView();HarborShell.syncShell();location.hash='#/house/1';
  });
  const host=page.locator('.breed-system');await host.locator('[data-breed-mode="workbench"]').waitFor();
  check('Manual workbench has its own fish list and stocking controls',await host.locator('.breed-pool [data-fish-id]').count()===3&&await host.locator('[data-stock-section="workbench"]').count()===1&&await host.locator('[data-stock-target]').count()===0&&await host.locator('.breed-habitats').count()===0);
  check('Idle residents cannot be selected as manual parents',await host.locator('[data-pick][data-id="1"]').count()===0&&await host.locator('[data-pick][data-id="2"]').count()===0);
  await host.locator('[data-breed-mode="aquaculture"]').click();
  check('Three habitats are accessible inside the fish house',await host.locator('[data-habitat-tab]').count()===3&&await page.locator('#fishhouse').isVisible());
  check('Aquarium renders resident fish and its eight-fish limit',await host.locator('[data-habitat-id="10"] header').innerText().then(t=>t.includes('2 / 8'))&&await host.locator('[data-habitat-id="10"] .breed-swimmer').count()===2);
  check('Idle cultivation exposes no manual pairing or reagent controls',await host.locator('[data-breed]').count()===0&&await host.locator('[data-pick]').count()===0&&await host.locator('.breed-reagents').count()===0&&await host.locator('[data-stock-section="aquaculture"]').count()===1);
  await host.locator('[data-select-habitat="10"]').click();
  check('Aquarium excludes food fish, marine fish and giant ornamental fish',await host.locator('[data-founder="bass"]').isDisabled()&&await host.locator('[data-founder="tuna"]').isDisabled()&&await host.locator('[data-founder="koi"][data-tier="giant"]').isDisabled()&&await host.locator('[data-founder="moonkoi"]').isEnabled());
  await host.locator('[data-transfer-fish]').selectOption('5');await host.locator('[data-transfer-to-habitat]').click();
  await page.waitForFunction(()=>aqua.fish.find(f=>f.id==='5').habitatId==='10');
  check('Moving a parent updates the shared scene and occupancy',await host.locator('[data-habitat-id="10"] header').innerText().then(t=>t.includes('3 / 8')));
  await host.locator('[data-breed-mode="workbench"]').click();
  check('Explicit transfer removes the fish from the manual workbench',await host.locator('.breed-pool [data-fish-id="5"]').count()===0&&await host.locator('.breed-pool [data-fish-id]').count()===2);
  await host.locator('[data-breed-mode="aquaculture"]').click();
  await host.locator('[data-fish-habitat="5"]').selectOption('');await host.locator('[data-move-fish="5"]').click();
  await page.waitForFunction(()=>aqua.fish.find(f=>f.id==='5').habitatId==='');
  check('Retrieving an idle fish stops its facility membership without cloning',await host.locator('.breed-resident-pool [data-fish-id="5"]').count()===0&&await page.evaluate(()=>aqua.fish.filter(f=>f.id==='5').length===1));
  await host.locator('[data-habitat-tab="freshwater"]').click();
  check('Freshwater farm accepts giants and shows twelve-fish limit',await host.locator('[data-founder="koi"][data-tier="giant"]').isEnabled()&&await host.locator('[data-habitat-id="11"] header').innerText().then(t=>t.includes('1 / 12')));
  await host.locator('[data-habitat-tab="marine"]').click();
  check('Marine farm uses its own ten-fish limit and marine-only stocking',await host.locator('[data-founder="tuna"]').isEnabled()&&await host.locator('[data-founder="bass"]').isDisabled()&&await host.locator('[data-habitat-id="12"] header').innerText().then(t=>t.includes('1 / 10')));
  await host.locator('[data-habitat-tab="aquarium"]').click();await host.locator('[data-create-habitat="aquarium"]').click();
  await host.locator('[data-habitat-id="13"]').waitFor();
  check('Two-per-kind construction limit is visible and enforced by controls',await host.locator('[data-create-habitat="aquarium"]').isDisabled());
  await page.evaluate(()=>window.rejectFull=true);await host.locator('[data-founder="koi"][data-tier="normal"]').click();await host.locator('.breed-notice').filter({hasText:'满员'}).waitFor();
  check('Server capacity rejection is presented without adding a fish',await page.evaluate(()=>aqua.fish.length===7));
  await page.evaluate(()=>window.rejectFull=false);
  await host.locator('[data-breed-mode="workbench"]').click();
  await host.locator('[data-founder="koi"][data-tier="normal"]').click();await host.locator('.breed-pool [data-fish-id="100"]').waitFor();
  check('Workbench stocking never inherits the last selected idle destination',await page.evaluate(()=>!aquaCalls.at(-1).habitatId&&aqua.fish.find(f=>f.id==='100').habitatId===''));
  await host.locator('[data-pick="A"][data-id="5"]').click();await host.locator('[data-pick="B"][data-id="9"]').click();
  check('Manual gold/moon pairing retains gene and reagent controls',await host.locator('[data-breed]').isEnabled()&&await host.locator('.breed-genes').innerText().then(t=>t.includes('黄金鳞光')&&t.includes('月白蓝斑')));
  await host.locator('[data-breed]').click();await host.locator('.breed-pool [data-fish-id="7"] .breed-hybrid-ready').waitFor();
  check('Manual offspring remain in the workbench rather than an idle facility',await page.evaluate(()=>aqua.fish.find(f=>f.id==='7').habitatId===''&&aqua.habitats.every(h=>!h.fishIds.includes('7'))));
  check('Inherited golden scales render on a moonlight body without changing its outline',await page.evaluate(async()=>{
   const canvas=document.querySelector('.breed-pool [data-fish-id="7"] canvas'),actual=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
   const img=new Image();img.src='assets/fish/moonkoi.png';await img.decode();const ref=document.createElement('canvas');ref.width=canvas.width;ref.height=canvas.height;
   const ctx=ref.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,ref.width,ref.height).data;let changed=0;
   for(let i=0;i<actual.length;i+=4){if(actual[i+3]!==pixels[i+3])return false;if(pixels[i+3]&&actual[i]>pixels[i]+10)changed++;}return changed>30;
  }));
  await host.locator('.breed-pool [data-fish-id="8"] .breed-hybrid-ready').waitFor();
  check('A hidden moonlight gene no longer leaks the native blue-white colouring',await page.evaluate(async()=>{
   const canvas=document.querySelector('.breed-pool [data-fish-id="8"] canvas'),actual=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
   const img=new Image();img.src='assets/fish/moonkoi.png';await img.decode();const ref=document.createElement('canvas');ref.width=canvas.width;ref.height=canvas.height;
   const ctx=ref.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,ref.width,ref.height).data;let changed=0;
   for(let i=0;i<actual.length;i+=4){if(actual[i+3]!==pixels[i+3])return false;if(pixels[i+3]&&pixels[i+2]>pixels[i]+15&&Math.abs(actual[i+2]-actual[i])<2)changed++;}return changed>30;
  }));
  check('Breeding drawer gives the wooden facilities enough space',await page.locator('#fh-panel').evaluate(p=>p.getBoundingClientRect().width>700));
  if(process.env.AQUACULTURE_SCREENSHOT_DIR){await page.locator('#fh-pbody > #main').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(process.env.AQUACULTURE_SCREENSHOT_DIR,'manual-workbench.png')});}
  await host.locator('[data-breed-mode="aquaculture"]').click();
  await host.locator('[data-select-habitat="10"]').click();
  await host.locator('[data-founder="moonkoi"]').click();await host.locator('.breed-resident-pool [data-fish-id="101"]').waitFor();
  check('Idle stocking goes directly into its facility and has no manual parent buttons',await page.evaluate(()=>aquaCalls.at(-1).habitatId==='10')&&await host.locator('[data-pick]').count()===0);
  if(process.env.AQUACULTURE_SCREENSHOT_DIR){fs.mkdirSync(process.env.AQUACULTURE_SCREENSHOT_DIR,{recursive:true});await host.locator('.breed-habitats').screenshot({path:path.join(process.env.AQUACULTURE_SCREENSHOT_DIR,'aquarium-desktop.png')});}
  await page.setViewportSize({width:390,height:844});
  check('Mobile aquaculture stays within the drawer without horizontal page overflow',await host.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  if(process.env.AQUACULTURE_SCREENSHOT_DIR)await host.locator('.breed-habitats').screenshot({path:path.join(process.env.AQUACULTURE_SCREENSHOT_DIR,'aquarium-mobile.png')});
  await page.locator('#fh-pbody > #main').evaluate(e=>e.scrollTop=e.scrollHeight);
  check('The final mobile controls can scroll above the fixed house HUD',await host.locator('.breed-resident-pool [data-inspect="101"]').evaluate(e=>{
   const button=e.getBoundingClientRect(),hud=document.querySelector('#fishhouse .h-hud-bottom').getBoundingClientRect();return button.bottom<hud.top;
  }));
  await page.evaluate(()=>{
   window.oldAqua=structuredClone(aqua);window.normalAquaGet=Net.breedingGet;
   Net.breedingGet=()=>new Promise(resolve=>window.resolveOldAquaRead=resolve);
  });
  await host.locator('[data-refresh]').click();
  await host.locator('[data-fish-habitat="101"]').selectOption('');await host.locator('[data-move-fish="101"]').click();
  await page.waitForFunction(()=>aqua.fish.find(f=>f.id==='101').habitatId==='');
  await page.evaluate(()=>{resolveOldAquaRead({ok:true,data:{breeding:oldAqua}});Net.breedingGet=normalAquaGet;});
  check('An older refresh cannot overwrite a newer stocking command',await host.locator('.breed-resident-pool [data-fish-id="101"]').count()===0);
  await page.evaluate(()=>{Net.breedingAction=()=>new Promise(resolve=>window.resolveOldAquaWrite=resolve);});
  await host.locator('[data-transfer-fish]').selectOption('5');await host.locator('[data-transfer-to-habitat]').click();
  await page.evaluate(()=>BreedUI.mount(document.querySelector('.breed-system').parentElement));
  await host.locator('[data-fish-id="5"]').waitFor();
  await page.evaluate(()=>resolveOldAquaWrite({ok:true,data:{breeding:{...aqua,fish:[],stock:[]}}}));
  check('Leaving and reopening during a save ignores the previous page response',await host.locator('.breed-pool [data-fish-id]').count()===7&&await host.locator('[data-refresh]').isEnabled());
  check('No browser script errors',errors.length===0);console.log('通过 '+count+' 项，失败 0 项');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
