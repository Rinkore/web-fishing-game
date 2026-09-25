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
  // 服务端 AllocationEffect 取 min(投入点数, 已解锁阶数)，所以每一点就是一阶效果。
  // 1-3 点各占一行：点数 + 紧凑效果 + 状态；投入且已解锁的行用重点色，其余压暗。
  function effectLine(fx){return Object.entries(fx||{}).map(([k,n])=>esc(G.shortLabels[k]||G.labels[k]||k)+' '+esc(G.value(k,n))).join(' · ');}
  function allocationEffects(x,points,tier){
    const max=Math.min(3,Math.max(0,(x.stages?.length||1)-1)),active=Math.min(points,tier);
    return '<div class="voyage-point-effects" aria-label="专精 1 至 3 点效果">'+Array.from({length:3},(_,i)=>{
      const point=i+1,stage=Math.min(point,max),open=point<=tier,enabled=point<=active;
      const state=enabled?'is-active':open?'is-unassigned':'is-locked';
      const label=enabled?'生效':open?'未投入':'需 '+stage+' 阶';
      return '<div class="voyage-effect-point '+state+'"><b>'+point+' 点</b><span class="voyage-effect-point-fx">'+effectLine(x.stages?.[stage])+'</span><span class="voyage-effect-point-state">'+label+'</span></div>';
    }).join('')+'</div>';
  }
  function liveEffect(points,tier){
    if(!points)return '本次投入：未投入，不生效';
    const stage=Math.min(points,tier);
    return '本次投入：'+points+' / 3 点 · '+(stage?'生效 '+stage+' 阶效果':'仅生效基础效果')+(points>tier?'，'+(points-tier)+' 点待进阶':'');
  }
  function dispatch(sea,c,state){
    const v=sea.expedition,current=v.active,lv=sea.ship.lv,s=selectionState;
    const phase=current?(current.ready?4:3):1;
    // 引导条替代原来的整段说明：先「该做什么」（流程），再「还差几级」（船级航道），最后「开不开得动」（门票条件）。
    const guide='<section class="gear-guide" aria-label="远航流程引导"><div class="gear-steps">'+[['选航线','船级达门槛'],['配专精','3 点配额'],['启航','消耗鳞片门票'],['领取返航','手动领取']].map((x,i)=>'<span class="gear-step '+(i+1===phase?'is-now':i+1<phase?'is-done':'')+'"><b>'+(i+1)+'</b><span>'+x[0]+'<small>'+x[1]+'</small></span></span>').join('<span class="gear-step-arrow" aria-hidden="true">→</span>')+'</div><div class="gear-track"><span class="gear-track-title">船级航道</span><div class="gear-track-nodes" role="img" aria-label="当前船级 LV '+lv+'，最高 LV '+D.SHIP.levels.length+'">'+D.SHIP.levels.map(x=>'<span class="gear-node '+(x.lv===lv?'is-now':x.lv<lv?'is-done':'')+'" title="LV '+x.lv+' · '+esc(x.name)+'"><i>'+x.lv+'</i></span>').join('')+'</div></div><div class="gear-milestones"><span class="gear-mile '+(sea.deepscale>=v.config.ticket?'is-done':'')+'">🎫 每趟门票 '+v.config.ticket+' 深海鳞片</span><span class="gear-mile '+(sea.deepscale>0?'is-done':'')+'">🐟 持有 '+sea.deepscale+' 深海鳞片</span><span class="gear-mile '+(v.freeTrades>0?'is-done':'')+'">⚓ 沿岸贸易免费 '+v.freeTrades+' 次</span><span class="gear-mile">🎣 钓鱼装备不影响远航收益</span></div></section>';
    const form=current?'<p class="gear-caption">本航次专精与规则已在出发时锁定，返航领取后可再次派遣。</p>':'<section class="gear-card voyage-form"><h3>准备下一次远航</h3><label class="voyage-duration">派遣时长<select data-hours>'+v.config.hours.map(h=>G.option(h,h+' 小时',h===s.hours)).join('')+'</select></label><div class="voyage-saved-config"><span class="gear-eyebrow">已保存的远航配置</span><p>'+esc(configurationSummary(c,state))+'</p><button data-voyage-jump="specialization">前往专精工作台</button></div><p class="gear-caption">启航只使用已保存的配置，工作台中未保存的修改不参与派遣。</p></section>';
    return guide+form+'<div class="gear-grid voyage-route-grid">'+v.config.routes.map(route=>'<article class="gear-card"><span class="gear-eyebrow">LV '+route.level+' · 基础成功率 '+route.success+'%</span><h3>'+esc(route.name)+'</h3><p>'+esc(route.description)+'</p><p>每小时基础材料：'+esc(Object.entries(c.baseDrops[route.id]||{}).map(([id,n])=>D.itemName(id)+' × '+n).join(' · '))+'</p><button class="primary" data-start="'+esc(route.id)+'" '+(current||lv<route.level?'disabled':'')+'>'+(current?'等待本次返航':lv<route.level?'船级不足':'选择航线启航')+'</button></article>').join('')+'</div>';
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
  function specializationWorkbench(c,state){
    const s=selectionState,total=allocationTotal(s.allocations);
    return '<section class="gear-card voyage-form"><div class="voyage-allocation-total" role="status">已分配 <b>'+total+' / 3</b> · 剩余 <b>'+(3-total)+'</b> 点 · 可选 3 / 2+1 / 1+1+1</div><div class="gear-grid"><label>专精模式<select data-mode></select></label><label>定向货物<select data-focus>'+G.option('','无定向',!s.focus)+Array.from(new Set(Object.values(c.baseDrops).flatMap(x=>Object.keys(x)).concat('storm_relic'))).map(id=>G.option(id,D.itemName(id),id===s.focus)).join('')+'</select></label></div><p class="gear-caption">模式与定向货物随专精点数一起保存，下一次启航生效；每点解锁一阶效果，阶数不足的点数先保留。</p><div class="gear-grid voyage-specializations">'+Object.entries(c.specializations).map(([id,x])=>{
      const points=s.allocations[id]||0,tier=state.tiers[id]||0,max=x.stages.length-1,unlocked=!!state.unlocked[id];
      // 未解锁的专精只留解锁入口：不出现加点控件与各点效果选项；解锁后完整列出 1-3 点效果。
      const allocation=unlocked?'<div class="voyage-stepper"><button data-allocation="'+esc(id)+'" data-delta="-1" aria-label="减少'+esc(x.name)+'配额" '+(points===0?'disabled':'')+'>−</button><strong>'+points+' / 3</strong><button data-allocation="'+esc(id)+'" data-delta="1" aria-label="增加'+esc(x.name)+'配额" '+(total>=3?'disabled':'')+'>+</button></div><h4>1-3 点效果</h4>'+allocationEffects(x,points,tier)+'<p class="voyage-live-effect">'+liveEffect(points,tier)+'</p>':'<p class="voyage-locked-note">未解锁：解锁后才能投入点数并查看 1-3 点效果。</p>';
      const act=!unlocked?'<div class="voyage-card-action"><p>解锁消耗：'+esc(G.cost({...c.costs.unlock,cores:0}))+'</p><button class="primary" data-unlock="'+esc(id)+'">解锁专精</button></div>':tier<max?'<div class="voyage-card-action"><p>进阶消耗：'+esc(G.cost({...c.costs.stage[tier],cores:0}))+'</p><button data-stage="'+esc(id)+'">进阶至 '+(tier+1)+' 阶</button></div>':'<p class="voyage-card-action">已达到最高阶段</p>';
      return '<article class="gear-card voyage-allocation '+(points?'is-assigned':'')+'"><span class="gear-eyebrow">'+(unlocked?'已解锁 · '+tier+' 阶':'未解锁')+'</span><h3>'+esc(x.name)+'</h3><p>'+esc(x.description)+'</p>'+allocation+act+'</article>';
    }).join('')+'</div><label class="voyage-source">消耗来源<select data-reward-source>'+G.option('bound','优先使用奖励绑定物品',!Engine.state.unboundInputs)+G.option('free','仅使用普通物品',!!Engine.state.unboundInputs)+'</select></label><p class="hint" data-config-status></p><div class="voyage-actions"><button class="primary" data-config-save>保存专精配置</button><button data-config-reset>恢复已保存配置</button><button data-voyage-jump="dispatch">返回远航派遣</button></div></section>';
  }
  function sets(sea,c){
    const v=sea.expedition,lv=sea.ship.lv;
    return '<p class="gear-caption">同套竿身 + 饰品同时装配才生效 · 兑换后到「钓竿」页装配 · 套装进阶在工坊「钓鱼套装」</p>'+(v.captain.starter===1?'<p class="voyage-callout">你有一次整套自选资格，可以选择任一已解锁的钓鱼套装。</p>':'')+'<div class="gear-grid voyage-specializations">'+v.sets.filter(s=>!s.pending&&c.sets[s.id]).map(s=>'<article class="gear-card"><span class="gear-eyebrow">LV '+s.level+' · 每件 '+s.cost+' 印记</span><h3>'+esc(c.sets[s.id].name)+'</h3><p>'+esc(c.sets[s.id].description)+'</p><div class="voyage-card-action">'+(v.captain.starter===1?'<button data-starter="'+esc(s.id)+'" '+(lv<s.level?'disabled':'')+'>自选整套（一次资格）</button>':'')+'<div class="voyage-actions">'+['rod','charm'].map(p=>'<button data-redeem="'+esc(s.id)+'" data-part="'+p+'" '+(lv<s.level||v.captain.marks<s.cost?'disabled':'')+'>'+G.labels[p]+'核心</button>').join('')+'</div></div></article>').join('')+'</div>';
  }
  function history(v,c){
    const last=v.last,route=last&&v.config.routes.find(x=>x.id===last.route);
    return '<p class="gear-caption">领取奖励时按派遣时长累计航程凭证，成功与事故均计入。</p>'+(last?'<article class="gear-card"><span class="gear-eyebrow">最近一次返航</span><h3>'+esc(route?.name||last.route||'上次返航')+'</h3>'+(last.hours?'<p>派遣时长 '+last.hours+' 小时</p>':'')+'<p>'+esc(last.reward?.event||'已完成返航')+'</p><p>'+esc(reward(last.reward))+'</p></article>':'<div class="gear-empty"><span class="gear-empty-icon" aria-hidden="true">🧭</span><b>还没有返航记录</b><small>完成首次派遣并领取奖励后，这里保留最近一次的收获。</small><button class="primary" data-voyage-jump="dispatch">前往远航派遣</button></div>');
  }
  function update(host,sea,onChange){
    if(!D.GEAR_SYSTEM.enabled)return legacy(host,sea,onChange);
    if(!host||!sea?.expedition)return;
    if(activeHost&&activeHost!==host)host._growthMessage=activeHost._growthMessage;activeHost=host;host._sea=sea;host._onChange=onChange;host.classList.add('gear-system','voyage-hub');
    if(!data){host.innerHTML='<div class="voyage-bar"><button class="gear-refresh" data-spec-refresh '+(loading?'disabled':'')+'>重新加载</button></div><p role="status" class="gear-notice">'+esc(host._growthMessage||'读取远航专精…')+'</p>';host.querySelector('[data-spec-refresh]').onclick=()=>load(host);if(!host._growthMessage&&!loading)load(host);return;}
    const c=data.config,state=data.state,v=sea.expedition,current=v.active;
    if(!v.config?.routes?.length){host.innerHTML='<div class="voyage-bar"><button class="gear-refresh" data-spec-refresh>刷新</button></div><p role="status" class="gear-notice">远航暂未开放，请等待管理员完成规则更新。</p>';host.querySelector('[data-spec-refresh]').onclick=()=>load(host);return;}
    if(!selectionState)selectionState={allocations:allocations(state),focus:state.focus||'',hours:8,mode:state.voyageMode||'normal'};
    const signature=JSON.stringify([sea.ship.lv,sea.deepscale,v,state,tab,busy,loading,host._growthMessage]);
    if(host._growthKey===signature)return;host._growthKey=signature;
    host.innerHTML='<div class="voyage-bar"><div class="gear-metrics"><span title="远航产出，用于解锁与进阶专精">远航印记 <b>'+v.captain.marks+'</b></span><span title="领取返航按派遣时长累计">航程凭证 <b>'+state.receipts+'</b></span><span title="每累计 '+c.receiptHours+' 小时远航自动发放一张">凭证累计 <b>'+state.receiptRemainder+' / '+c.receiptHours+'h</b></span></div><button class="gear-refresh" data-spec-refresh '+(loading?'disabled':'')+'>'+(loading?'刷新中…':'刷新')+'</button></div>'+(current?'<section class="gear-card voyage-current"><div><span class="gear-eyebrow">'+(current.ready?'已返航 · 等待领取':'当前航次')+'</span><h3>'+esc(v.config.routes.find(x=>x.id===current.route)?.name||current.route)+' · '+current.hours+' 小时</h3><p>'+esc(allocationSummary(c,allocations(current.snapshot)))+' · 出发成功率 '+current.snapshot.success+'%</p><p>预计返航 '+new Date(current.endsAt).toLocaleString('zh-CN')+'</p>'+(current.ready?'<p>'+esc(current.reward?.event||'')+'</p><p>'+esc(reward(current.reward))+'</p>':'<p class="hint">到时手动领取奖励，再开始下一次航行。</p>')+'</div>'+(current.ready?'<button class="primary" data-claim>领取返航奖励</button>':'<span class="voyage-status">航行中</span>')+'</section>':'')+'<nav class="gear-tabs voyage-tabs" aria-label="远航子菜单">'+tabs.map(([id,title])=>'<button data-voyage-tab="'+id+'" class="'+(tab===id?'primary':'')+'" aria-pressed="'+(tab===id)+'">'+title+'</button>').join('')+'</nav><p role="status" class="gear-notice">'+esc(host._growthMessage||'')+'</p><section class="voyage-panel" aria-label="'+tabs.find(x=>x[0]===tab)[1]+'">'+(tab==='dispatch'?dispatch(sea,c,state):tab==='specialization'?specializationWorkbench(c,state):tab==='sets'?sets(sea,c):history(v,c))+'</section>';
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
