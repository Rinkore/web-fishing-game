(function () {
  'use strict';
  const legacy=window.ExpeditionUI.update,G=window.GearUI,D=window.GameData,esc=G.esc;
  const tabs=[['dispatch','远航派遣'],['specialization','专精工作台'],['sets','钓鱼套装'],['history','返航记录']];
  let data=null,loading=false,busy=false,pending=null,tab='dispatch',selectionState=null,activeHost=null;
  try{pending=JSON.parse(sessionStorage.getItem('growth-voyage-pending')||'null');}catch(_){}
  function savePending(){try{if(pending)sessionStorage.setItem('growth-voyage-pending',JSON.stringify(pending));else sessionStorage.removeItem('growth-voyage-pending');}catch(_){}}
  function reward(r){if(!r)return '暂无奖励';return [r.coins+' 金币',r.xp+' 船经验',r.marks+' 印记',...Object.entries(r.items||{}).map(([id,n])=>D.itemName(id)+' × '+n)].join(' · ');}
  function redraw(host){host=activeHost||host;host._growthKey='';update(host,host._sea,host._onChange);}
  async function load(host){
    if(loading)return;loading=true;
    try{const r=await Net.gearApi('GET','/api/gear');host=activeHost||host;if(r.ok){data=r.data;D.setGearSystem(data.config);}else host._growthMessage=r.data?.error||'读取专精失败，请刷新重试';}
    catch(_){(activeHost||host)._growthMessage='连接未完成，请刷新重试';}
    finally{loading=false;redraw(host);}
  }
  async function action(host,type,body,gear){
    if(busy)return;busy=true;
    if(gear)body={...body,unboundInputs:!!Engine.state.unboundInputs};
    const sig=JSON.stringify({type,body,gear:!!gear});
    if(!pending||pending.sig!==sig)pending={sig,key:'voyage-growth-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2))};
    savePending();redraw(host);
    try{
      const r=gear?await Net.gearApi('POST','/api/gear/action',{...body,requestKey:pending.key}):await Net.seaExpedition(type,{...body,requestKey:pending.key});
      host=activeHost||host;
      if(r.ok){
        host._growthMessage=gear?(type==='preferences'?'专精配置已保存，下次启航时使用':type==='unlock'?'远航专精已解锁，可在专精工作台配置':'远航专精已进阶'):type==='start'?'已启航，离线期间照常航行':type==='claim'?'返航奖励已入账':'钓鱼套装核心已放入背包';
        if(type==='preferences'&&gear){data.state.allocations={...body.allocations};data.state.selected="";data.state.focus=body.focus;data.state.voyageMode=body.mode;}
        if(r.data.sea){host._sea=r.data.sea;host._onChange(r.data.sea,host._growthMessage);}
        G.invalidate();
      }else host._growthMessage=r.data?.error||'连接未完成，请重试同一操作；不会重复扣费';
      if(r.ok||(r.status>=400&&r.status<500)){pending=null;savePending();}
      await load(host);
    }catch(_){(activeHost||host)._growthMessage='连接未完成，请重试同一操作；不会重复扣费';}
    finally{busy=false;redraw(host);}
  }
  function effects(fx){return '<ul class="voyage-effects">'+Object.entries(fx||{}).map(([k,n])=>'<li>'+esc(G.effect(k,n))+'</li>').join('')+'</ul>';}
  // Render each point as its own capability so the player can immediately see
  // which effects are active for the current allocation and growth tier.
  function allocationEffects(x,points,tier){
    const max=Math.min(3,Math.max(0,x.stages?.length-1||0)),active=Math.min(points,tier);
    return '<div class="voyage-point-effects" aria-label="专精三点效果">'+Array.from({length:3},(_,i)=>{
      const point=i+1,fx=x.stages?.[Math.min(point,max)]||{},enabled=point<=active,assigned=point<=points,locked=point>tier;
      const state=enabled?'is-active':locked?'is-locked':'is-unassigned';
      const label=enabled?'生效':locked?'未解锁':'未投入';
      return '<div class="voyage-effect-point '+state+'"><div class="voyage-effect-point-head"><b>第 '+point+' 点</b><span>'+label+'</span></div>'+effects(fx)+'</div>';
    }).join('')+'</div>';
  }
  function dispatch(sea,c,state){
    const v=sea.expedition,current=v.active,lv=sea.ship.lv,s=selectionState;
    const form=current?'<p class="hint">本航次专精与规则已在出发时锁定。返航领取后可再次派遣。</p>':'<section class="gear-card voyage-form"><h3>准备下一次远航</h3><label class="voyage-duration">派遣时长<select data-hours>'+v.config.hours.map(h=>G.option(h,h+' 小时',h===s.hours)).join('')+'</select></label><div class="voyage-saved-config"><span class="gear-eyebrow">已保存的远航配置</span><p>'+esc(configurationSummary(c,state))+'</p><button data-voyage-jump="specialization">前往专精工作台</button></div><p class="hint">启航使用已保存配置，工作台中尚未保存的修改不会用于派遣。</p></section>';
    return '<h3>选择航线</h3><p class="hint">钓鱼装备不影响远航收益。每趟门票 '+v.config.ticket+' 深海鳞片，沿岸贸易剩余 '+v.freeTrades+' 次免费。持有 '+sea.deepscale+' 深海鳞片。</p>'+form+'<div class="gear-grid voyage-route-grid">'+v.config.routes.map(route=>'<article class="gear-card"><span class="gear-eyebrow">LV '+route.level+' · 基础成功率 '+route.success+'%</span><h3>'+esc(route.name)+'</h3><p>'+esc(route.description)+'</p><p>每小时基础材料：'+esc(Object.entries(c.baseDrops[route.id]||{}).map(([id,n])=>D.itemName(id)+' × '+n).join(' · '))+'</p><button class="primary" data-start="'+esc(route.id)+'" '+(current||lv<route.level?'disabled':'')+'>'+(current?'等待本次返航':lv<route.level?'船级不足':'选择航线启航')+'</button></article>').join('')+'</div>';
  }
  function allocations(state){
    state=state||{};
    return {...(state.allocations??(state.selected?{[state.selected]:3}:state.set?{[state.set]:3}:{}))};
  }
  function allocationTotal(values){return Object.values(values).reduce((sum,n)=>sum+n,0);}
  function allocationSummary(c,values){
    return Object.entries(values).filter(([,n])=>n>0).map(([id,n])=>(c.specializations[id]?.name||id)+' '+n+'/3').join(' + ')||'不使用专精';
  }
  function configurationSummary(c,state){
    const mode={normal:'常规模式',concentrate:'集中采集',deep:'深入风暴',evacuate:'遇险提前撤离'};
    return allocationSummary(c,allocations(state))+' · '+(mode[state.voyageMode]||mode.normal)+' · '+(state.focus?D.itemName(state.focus):'无定向货物');
  }
  function configuration(c,state){
    const s=selectionState,total=allocationTotal(s.allocations);
    return '<h3>专精配置</h3><p class="hint">每次远航共有 3 点专精配额，可集中投入 3 点、搭配 2 + 1，或组合 1 + 1 + 1。保存后用于下一次启航，当前航次保持不变。</p><section class="gear-card voyage-form"><div class="voyage-saved-config"><span class="gear-eyebrow">已保存配置</span><p>'+esc(configurationSummary(c,state))+'</p></div><div class="voyage-allocation-total" role="status">已分配 <b>'+total+' / 3</b> · 剩余 <b>'+(3-total)+'</b> 点</div><p class="hint">专精成长阶段独立保留；每项收益按投入点数 / 3 发挥。可以保留空余配额，全部留空则不使用专精。</p><div class="gear-grid voyage-specializations">'+Object.entries(c.specializations).map(([id,x])=>{
      const points=s.allocations[id]||0,tier=state.tiers[id]||0,unlocked=!!state.unlocked[id];
      return '<article class="gear-card voyage-allocation '+(points?'is-assigned':'')+'"><span class="gear-eyebrow">'+(unlocked?'成长 '+tier+' 阶':'尚未解锁')+'</span><h3>'+esc(x.name)+'</h3><p>'+esc(x.description)+'</p><div class="voyage-stepper"><button data-allocation="'+esc(id)+'" data-delta="-1" aria-label="减少'+esc(x.name)+'配额" '+(!unlocked||points===0?'disabled':'')+'>−</button><strong>'+points+' / 3</strong><button data-allocation="'+esc(id)+'" data-delta="1" aria-label="增加'+esc(x.name)+'配额" '+(!unlocked||total>=3?'disabled':'')+'>+</button></div><p>'+(unlocked?'投入比例 '+points+'/3 · '+(points===0?'本次不生效':+(points/3*100).toFixed(1)+'%'):'前往专精成长解锁后可分配')+'</p><details><summary>'+tier+' 阶满额效果（投入 3 点）</summary>'+effects(x.stages[tier])+'</details></article>';
    }).join('')+'</div><p class="hint">材料加成、惊喜概率、特殊产量与风险按配额比例计算；考古保底按有效时长累计，护航在基础保留比例上增强。特殊模式需对应专精至少投入 1 点并达到要求阶段。</p><div class="gear-grid"><label>专精模式<select data-mode></select></label><label>定向货物<select data-focus>'+G.option('','无定向',!s.focus)+Array.from(new Set(Object.values(c.baseDrops).flatMap(x=>Object.keys(x)).concat('storm_relic'))).map(id=>G.option(id,D.itemName(id),id===s.focus)).join('')+'</select></label></div><p class="hint" data-config-status></p><div class="voyage-actions"><button class="primary" data-config-save>保存远航配置</button><button data-config-reset>恢复已保存配置</button><button data-voyage-jump="dispatch">返回远航派遣</button></div></section><p class="hint">需要解锁或提升专精？前往「专精成长」查看四项专精与成长消耗。</p><button data-voyage-jump="specializations">前往专精成长</button>';
  }
  function specializationWorkbench(c,state){
    const s=selectionState,total=allocationTotal(s.allocations);
    return '<h3>专精工作台</h3><p class="hint">在同一页面解锁、进阶和配置远航专精。总配额为 3 点，可选择 3、2+1 或 1+1+1；点数变化会实时预览本次投入后的效果。</p><section class="gear-card voyage-form"><div class="voyage-allocation-total" role="status">已分配 <b>'+total+' / 3</b> · 剩余 <b>'+(3-total)+'</b> 点</div><div class="gear-grid"><label>专精模式<select data-mode></select></label><label>定向货物<select data-focus>'+G.option('','无定向',!s.focus)+Array.from(new Set(Object.values(c.baseDrops).flatMap(x=>Object.keys(x)).concat('storm_relic'))).map(id=>G.option(id,D.itemName(id),id===s.focus)).join('')+'</select></label></div><p class="hint">模式和定向货物与专精点数一起保存，下一次启航生效。</p><div class="gear-grid voyage-specializations">'+Object.entries(c.specializations).map(([id,x])=>{
      const points=s.allocations[id]||0,tier=state.tiers[id]||0,max=x.stages.length-1,unlocked=!!state.unlocked[id],ratio=points/3;
      return '<article class="gear-card voyage-allocation '+(points?'is-assigned':'')+'"><span class="gear-eyebrow">'+(unlocked?'已解锁 · '+tier+' 阶':'未解锁')+'</span><h3>'+esc(x.name)+'</h3><p>'+esc(x.description)+'</p><div class="voyage-stepper"><button data-allocation="'+esc(id)+'" data-delta="-1" aria-label="减少'+esc(x.name)+'配额" '+(!unlocked||points===0?'disabled':'')+'>−</button><strong>'+points+' / 3</strong><button data-allocation="'+esc(id)+'" data-delta="1" aria-label="增加'+esc(x.name)+'配额" '+(!unlocked||total>=3?'disabled':'')+'>+</button></div><h4>三点效果状态</h4>'+allocationEffects(x,points,tier)+'<p class="voyage-live-effect">本次投入：'+(points?Math.round(ratio*100)+'% 效果':'未投入，不生效')+'</p>'+(!unlocked?'<div class="voyage-card-action"><p>解锁消耗：'+esc(G.cost({...c.costs.unlock,cores:0}))+'</p><button class="primary" data-unlock="'+esc(id)+'">解锁专精</button></div>':tier<max?'<div class="voyage-card-action"><p>进阶消耗：'+esc(G.cost({...c.costs.stage[tier],cores:0}))+'</p><button data-stage="'+esc(id)+'">进阶至 '+(tier+1)+' 阶</button></div>':'<p class="voyage-card-action">已达到最高阶段</p>')+'</article>';
    }).join('')+'</div><label class="voyage-source">消耗来源<select data-reward-source>'+G.option('bound','优先使用奖励绑定物品',!Engine.state.unboundInputs)+G.option('free','仅使用普通物品',!!Engine.state.unboundInputs)+'</select></label><p class="hint" data-config-status></p><div class="voyage-actions"><button class="primary" data-config-save>保存专精配置</button><button data-config-reset>恢复已保存配置</button><button data-voyage-jump="dispatch">返回远航派遣</button></div></section>';
  }
  function sets(sea,c){
    const v=sea.expedition,lv=sea.ship.lv;
    return '<h3>四套钓鱼装备</h3><p class="hint">同套竿身与饰品装配后激活钓鱼效果；兑换后前往钓竿页装配，在工坊「钓鱼套装」进阶。</p>'+(v.captain.starter===1?'<p class="voyage-callout">你有一次整套自选资格，可以选择任一已解锁的钓鱼套装。</p>':'')+'<div class="gear-grid voyage-specializations">'+v.sets.filter(s=>!s.pending&&c.sets[s.id]).map(s=>'<article class="gear-card"><span class="gear-eyebrow">LV '+s.level+' · 每件 '+s.cost+' 印记</span><h3>'+esc(c.sets[s.id].name)+'</h3><p>'+esc(c.sets[s.id].description)+'</p><div class="voyage-card-action">'+(v.captain.starter===1?'<button data-starter="'+esc(s.id)+'" '+(lv<s.level?'disabled':'')+'>自选整套（一次资格）</button>':'')+'<div class="voyage-actions">'+['rod','charm'].map(p=>'<button data-redeem="'+esc(s.id)+'" data-part="'+p+'" '+(lv<s.level||v.captain.marks<s.cost?'disabled':'')+'>'+G.labels[p]+'核心</button>').join('')+'</div></div></article>').join('')+'</div>';
  }
  function history(v,c){
    const last=v.last;
    return '<h3>最近一次返航</h3><p class="hint">这里保留最近一次已领取的航次。领取奖励时按派遣时长累计航程凭证，成功与事故均计入。</p>'+(last?'<article class="gear-card"><h3>'+esc(v.config.routes.find(x=>x.id===last.route)?.name||last.route||'上次返航')+'</h3>'+(last.hours?'<p>派遣时长 '+last.hours+' 小时</p>':'')+'<p>'+esc(last.reward?.event||'已完成返航')+'</p><p>'+esc(reward(last.reward))+'</p></article>':'<div class="gear-card"><h3>还没有返航记录</h3><p>完成首次派遣并领取奖励后，在这里查看最近的收获。</p><button data-voyage-jump="dispatch">前往远航派遣</button></div>');
  }
  function update(host,sea,onChange){
    if(!D.GEAR_SYSTEM.enabled)return legacy(host,sea,onChange);
    if(!host||!sea?.expedition)return;
    if(activeHost&&activeHost!==host)host._growthMessage=activeHost._growthMessage;activeHost=host;host._sea=sea;host._onChange=onChange;host.classList.add('gear-system','voyage-hub');
    if(!data){host.innerHTML='<h2>远航中心</h2><p role="status">'+esc(host._growthMessage||'读取远航专精…')+'</p><button data-spec-refresh '+(loading?'disabled':'')+'>重新加载</button>';host.querySelector('[data-spec-refresh]').onclick=()=>load(host);if(!host._growthMessage&&!loading)load(host);return;}
    const c=data.config,state=data.state,v=sea.expedition,current=v.active;
    if(!v.config?.routes?.length){host.innerHTML='<h2>远航中心</h2><p>远航暂未开放，请等待管理员完成规则更新。</p>';return;}
    if(!selectionState)selectionState={allocations:allocations(state),focus:state.focus||'',hours:8,mode:state.voyageMode||'normal'};
    const signature=JSON.stringify([sea.ship.lv,sea.deepscale,v,state,tab,busy,loading,host._growthMessage]);
    if(host._growthKey===signature)return;host._growthKey=signature;
    host.innerHTML='<div class="gear-header"><div><span class="gear-eyebrow">船级 LV '+sea.ship.lv+' · 离线期间照常航行</span><h2>🧭 远航中心</h2></div><button data-spec-refresh '+(loading?'disabled':'')+'>'+(loading?'刷新中…':'刷新专精与进度')+'</button></div><div class="gear-metrics"><span>远航印记 <b>'+v.captain.marks+'</b></span><span>航程凭证 <b>'+state.receipts+'</b></span><span>凭证累计 <b>'+state.receiptRemainder+' / '+c.receiptHours+'h</b></span></div>'+(current?'<section class="gear-card voyage-current"><div><span class="gear-eyebrow">'+(current.ready?'已返航 · 等待领取':'当前航次')+'</span><h3>'+esc(v.config.routes.find(x=>x.id===current.route)?.name||current.route)+' · '+current.hours+' 小时</h3><p>'+esc(allocationSummary(c,allocations(current.snapshot)))+' · 出发成功率 '+current.snapshot.success+'%</p><p>预计返航 '+new Date(current.endsAt).toLocaleString('zh-CN')+'</p>'+(current.ready?'<p>'+esc(current.reward?.event||'')+'</p><p>'+esc(reward(current.reward))+'</p>':'<p class="hint">到时手动领取奖励，再开始下一次航行。</p>')+'</div>'+(current.ready?'<button class="primary" data-claim>领取返航奖励</button>':'<span class="voyage-status">航行中</span>')+'</section>':'')+'<nav class="gear-tabs voyage-tabs" aria-label="远航子菜单">'+tabs.map(([id,title])=>'<button data-voyage-tab="'+id+'" class="'+(tab===id?'primary':'')+'" aria-pressed="'+(tab===id)+'">'+title+'</button>').join('')+'</nav><p role="status" class="gear-notice">'+esc(host._growthMessage||'')+'</p><section class="voyage-panel" aria-label="'+tabs.find(x=>x[0]===tab)[1]+'">'+(tab==='dispatch'?dispatch(sea,c,state):tab==='specialization'?specializationWorkbench(c,state):tab==='sets'?sets(sea,c):history(v,c))+'</section>';
    host.querySelector('[data-spec-refresh]').onclick=()=>load(host);
    host.querySelectorAll('[data-voyage-tab],[data-voyage-jump]').forEach(b=>b.onclick=()=>{tab=b.dataset.voyageTab||b.dataset.voyageJump;redraw(host);});
    function selection(){
      const select=host.querySelector('[data-mode]');if(!select)return;
      selectionState.focus=host.querySelector('[data-focus]').value;
      const values=selectionState.allocations,keep=selectionState.mode;
      const open=(id,key)=>values[id]>0&&(c.specializations[id]?.stages[state.tiers[id]||0]?.[key]||0)>0;
      select.innerHTML=G.option('normal','常规模式',keep==='normal')+(open('tide','concentrate')?G.option('concentrate','集中采集',keep==='concentrate'):'')+(open('storm','deepRisk')?G.option('deep','深入风暴（额外风险）',keep==='deep'):'')+(open('rescue','evacuate')?G.option('evacuate','遇险提前撤离',keep==='evacuate'):'');
      selectionState.mode=select.value;
    }
    function configurationStatus(){
      const status=host.querySelector('[data-config-status]');if(!status)return;
      const saved=allocations(state),changed=Object.keys(c.specializations).some(id=>(selectionState.allocations[id]||0)!==(saved[id]||0))||selectionState.focus!==(state.focus||'')||selectionState.mode!==(state.voyageMode||'normal');
      status.textContent=changed?'有未保存的修改；请保存后再启航。':'当前配置已保存，可返回远航派遣。';
    }
    if(tab==='specialization'){
      selection();configurationStatus();
      host.querySelectorAll('[data-allocation]').forEach(b=>b.onclick=()=>{
        if(busy)return;
        const id=b.dataset.allocation,delta=Number(b.dataset.delta),n=(selectionState.allocations[id]||0)+delta;
        if(!state.unlocked[id]||n<0||n>3||allocationTotal(selectionState.allocations)+delta>3)return;
        if(n)selectionState.allocations[id]=n;else delete selectionState.allocations[id];
        redraw(host);
      });
      host.querySelector('[data-focus]').onchange=()=>{selection();configurationStatus();};
      host.querySelector('[data-mode]').onchange=e=>{selectionState.mode=e.target.value;configurationStatus();};
      host.querySelector('[data-config-save]').onclick=()=>action(host,'preferences',{action:'preferences',allocations:{...selectionState.allocations},focus:selectionState.focus,mode:selectionState.mode},true);
      host.querySelector('[data-config-reset]').onclick=()=>{selectionState={...selectionState,allocations:allocations(state),focus:state.focus||'',mode:state.voyageMode||'normal'};redraw(host);};
    }
    const hours=host.querySelector('[data-hours]');if(hours)hours.onchange=e=>{selectionState.hours=Number(e.target.value);};
    host.querySelectorAll('[data-start]').forEach(b=>b.onclick=async()=>{
      if(busy||host._confirming)return;host._confirming=true;
      const route=v.config.routes.find(x=>x.id===b.dataset.start),values=allocations(state),hours=selectionState.hours,fx=c.specializations.storm?.stages[state.tiers.storm||0]||{},success=route.success-(values.storm>0&&state.voyageMode==='deep'&&route.level>=fx.minRouteLevel?fx.deepRisk*values.storm/3:0);
      try{if(await UI.confirmModal({title:'确认启航',okText:'确认启航',html:esc(route.name)+' · '+hours+' 小时<p>已保存配置：'+esc(configurationSummary(c,state))+'</p><p>成功率 '+Math.max(0,+success.toFixed(2))+'%</p><p>门票：'+(route.id==='trade'&&v.freeTrades>0?0:v.config.ticket)+' 深海鳞片。出发后固定本航次规则。</p>'})&&!(activeHost||host)._sea.expedition.active)await action(activeHost||host,'start',{route:route.id,hours,useSaved:true});}finally{host._confirming=false;}
    });
    const claim=host.querySelector('[data-claim]');if(claim)claim.onclick=()=>action(host,'claim',{id:current.id});
    host.querySelectorAll('[data-redeem]').forEach(b=>b.onclick=()=>action(host,'redeem',{set:b.dataset.redeem,part:b.dataset.part,starter:false}));
    host.querySelectorAll('[data-starter]').forEach(b=>b.onclick=async()=>{if(busy||host._confirming)return;host._confirming=true;try{if(await UI.confirmModal({title:'确认自选整套',html:'将使用账号唯一自选资格，获得「'+esc(c.sets[b.dataset.starter].name)+'」竿身和饰品各一件。',okText:'确认兑换'}))await action(host,'redeem',{set:b.dataset.starter,part:'',starter:true});}finally{host._confirming=false;}});
    host.querySelectorAll('[data-unlock],[data-stage]').forEach(b=>b.onclick=()=>{const type=b.dataset.unlock?'unlock':'stage';action(host,type,{action:type,set:b.dataset.unlock||b.dataset.stage},true);});
    const source=host.querySelector('[data-reward-source]');if(source)source.onchange=e=>{Engine.state.unboundInputs=e.target.value==='free';};
    if(busy)host.querySelectorAll('button,select').forEach(b=>b.disabled=true);
  }
  window.ExpeditionUI={update};
})();
