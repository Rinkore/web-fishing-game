(function(){
 'use strict';
 const D=window.GameData, esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={speed:'钓速',skill:'技巧',size:'体型',double:'双钓',line:'鱼线',hook:'鱼钩',bait:'拟饵',reel:'卷线器',accessory:'配件',rod:'竿身',charm:'饰品',heatSeconds:'每点热量所需在线垂钓秒数',heatCap:'热量上限',heatDiscount:'精工节省热量',presets:'开放精工预设切换',casts:'每次丰收所需成功抛竿',copies:'丰收额外鱼数',best:'采用近期最高价值鱼',largeMode:'开放大丰收',largeMultiplier:'大丰收周期与数量倍数',recent:'近期候选次数',weightStep:'每层目标权重增幅',maxStacks:'权重层数上限',pityFactor:'保底周期系数',pityCommon:'普通鱼基础保底次数',pityRare:'稀有鱼基础保底次数',pityEpic:'史诗及神话鱼基础保底次数',queue:'开放目标轮换名单',uniformMix:'均匀分布混合比例',bonus:'材料额外收益比例',focus:'指定材料额外比例',minimum:'指定材料最低数量',concentrate:'集中采集额外比例',minRouteLevel:'生效最低航线等级',fragmentsPerHour:'每小时额外宝匣碎片',chestChancePerHour:'每小时完整宝匣惊喜概率',pityHours:'完整宝匣保底小时',highChest:'高阶航线升级宝匣',deepRisk:'深入模式成功率损失（百分点）',deepBonus:'深入模式额外收益比例',specialPerHour:'每小时风暴特产数量',choice:'开放特产选择',retain:'事故货物保留比例',priority:'优先货物完整保全',advanced:'保全覆盖高级材料',evacuate:'开放撤离模式',evacuationLoss:'撤离已得货物损失比例'};
 const percentages=new Set(['weightStep','pityFactor','uniformMix','bonus','focus','concentrate','chestChancePerHour','deepBonus','retain','evacuationLoss']);
 const flags=new Set(['presets','best','largeMode','queue','highChest','choice','priority','advanced','evacuate']);
 function fmt1(v){return typeof v==='number'?Number(v.toFixed(1)):v;}
 function value(k,v){return flags.has(k)?(v?'已开放':'未开放'):percentages.has(k)?fmt1(v*100)+'%':fmt1(v);}
 // 相邻两档的差值标注：百分比补 %，开关项的前后值本身就能看出变化，不再重复标注。
 function delta(k,a,b){if(flags.has(k))return '';const d=Math.round((percentages.has(k)?(b-a)*100:b-a)*1000)/1000;return d?(d>0?'+':'')+fmt1(d)+(percentages.has(k)?'%':''):'';}
 function effect(k,v){return (labels[k]||k)+'：'+value(k,v);}
 function cost(c){if(!c)return '—';return [c.coins?c.coins+' 金币':'',...Object.entries(c.items||{}).map(([id,n])=>D.itemName(id)+' × '+n),c.receipts?'航程凭证 × '+c.receipts:'',c.heat?'精工热量 × '+c.heat:'',c.cores?'同套重复核心 × '+c.cores:''].filter(Boolean).join(' · ')||'免费';}
 const affixes=aa=>(aa||[]).map(a=>esc(labels[a.type]||a.type)+' +'+fmt1(a.value)+'%').join(' · ');
 const option=(v,t,s)=>'<option value="'+esc(v)+'" '+(s?'selected':'')+'>'+esc(t)+'</option>';
 let root=null,view=null,busy=false,loading=false,tab='growth',selected='',notice='',last=0,pending=null,selectedSub='',selectedDirection='main',equipmentFilter='',transferBinding='';
 const equipmentFilters={part:'',quality:'',attribute:'',level:'',status:''};
 const qualities={common:'普通',rare:'稀有',epic:'史诗',mythic:'神话'};
 const eligible=e=>!!e&&!e.locked&&(!Engine.state.unboundInputs||!e.rewardBound);
 // 已装备的组件也能直接在工坊成长：服务端会把成长结果放回同一个配装槽位（见 gear/service.go 的 takeLoadoutSlots）。
 const modifiable=e=>!!e&&(!Engine.state.unboundInputs||!e.rewardBound);
 // 组件选取列表按「已装备优先」置顶，同组内维持服务端给的 id 顺序。
 const equippedFirst=(a,b)=>(b.locked?1:0)-(a.locked?1:0)||Number(a.id)-Number(b.id);
 function matchesEquipment(e){const f=equipmentFilters;return (!equipmentFilter||(e.name+' '+affixes(e.affixes)).toLowerCase().includes(equipmentFilter.toLowerCase()))&&(!f.part||e.part===f.part)&&(!f.quality||e.signature.split('#')[1]===f.quality)&&(!f.attribute||e.affixes.some(a=>a.type===f.attribute&&a.value>0))&&(!f.level||(f.level==='base'?e.growth?.level===0:f.level==='max'?e.growth?.level===view.config.maxLevel:(e.growth?.level||0)>0))&&(!f.status||(f.status==='free'?modifiable(e):f.status==='locked'?e.locked:f.status==='bound'?e.bound:!e.bound));}
 function equipmentFilterControls(){const select=(key,title,items)=>'<label>'+title+'<select data-equipment-select="'+key+'">'+option('','全部',!equipmentFilters[key])+items.map(([id,name])=>option(id,name,equipmentFilters[key]===id)).join('')+'</select></label>';return '<div class="gear-equipment-filters">'+select('part','部位',Object.keys(view.config.parts).map(p=>[p,labels[p]||p]))+select('quality','品质',Object.entries(qualities))+select('attribute','属性',['speed','skill','size','double'].map(a=>[a,labels[a]]))+select('level','强化等级',[['base','基础 +0'],['grown','已强化'],['max','已满级']])+select('status','状态',[['free','可操作'],['locked','已装备'],['bound','已绑定'],['trade','未绑定']])+'<button data-equipment-reset>重置筛选</button></div>';}
 try{pending=JSON.parse(sessionStorage.getItem('gear-pending')||'null');}catch(_){}
 function message(r){return r?.data?.error||'连接未完成，请重试同一操作；不会重复扣费。';}
 async function load(force){if(loading||(!force&&Date.now()-last<3000))return;loading=true;try{const r=await Net.gearApi('GET','/api/gear');if(r.ok){view=r.data;D.setGearSystem(view.config);last=Date.now();draw();}else{notice=message(r);draw();}}finally{loading=false;}}
 async function action(body){if(busy)return;body={...body,unboundInputs:!!Engine.state.unboundInputs};const input=view.equipment.find(e=>e.id===body.id),other=view.equipment.find(e=>e.id===body.otherId),costs=view.config.costs;const recipe=body.action==='upgrade'?costs.upgrade[input?.growth?.level||0]:body.action==='engrave'?(body.useHeat?costs.heatEngrave:costs.engrave):costs[body.action];const inherits=!body.unboundInputs&&body.id&&(input?.bindOutputs||other?.bindOutputs||Object.keys(recipe?.items||{}).some(id=>view.rewardBindings?.[id]?.normal?.inherit>0));if(inherits&&!await UI.confirmModal({title:'产物将继承奖励绑定',html:'本次消耗包含要求继承绑定的奖励物品，本次操作的全部产物不可出售或交易，后续消耗继续继承绑定。',okText:'确认消耗'}))return;busy=true;const sig=JSON.stringify(body);if(!pending||pending.sig!==sig)pending={sig,key:'gear-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2))};sessionStorage.setItem('gear-pending',JSON.stringify(pending));draw();try{const r=await Net.gearApi('POST','/api/gear/action',{...body,requestKey:pending.key});if(r.ok){notice='操作完成，消耗与成长已保存';selected=r.data.result?.details?.id||selected;}else notice=message(r);if(r.ok||(r.status>=400&&r.status<500)){pending=null;sessionStorage.removeItem('gear-pending');}await load(true);}catch(_){notice='连接未完成，请重试同一操作。';}finally{busy=false;draw();}}
  // ---- 图形化引导（替代原「成长总览」介绍页）：步骤条 + 强化路径 + 里程碑 ----
  // 组件选择卡片：空卡片点开选择子窗口，已选卡片点击即取消当前选中的组件。
  function pickCard(e,count){
   if(!e)return '<button type="button" class="gear-pick-card is-empty" data-pick-card="open" '+(!count?'disabled':'')+' aria-haspopup="dialog" aria-label="选择组件"><span class="gear-eyebrow">组件选择</span><b>'+(count?'＋ 点击选择组件':'暂无可选组件')+'</b><small>'+(count?count+' 件可选 · 点击打开选择子窗口':'先获取新制配件，再回来选择')+'</small></button>';
   return '<button type="button" class="gear-pick-card is-picked" data-pick-card="clear" aria-haspopup="dialog" aria-label="取消选中的组件"><span class="gear-eyebrow">已选组件</span><b>'+esc(e.name)+' +'+e.growth.level+'</b><small>'+esc(labels[e.part]||e.part)+' · '+affixes(e.affixes)+'</small><small>点击卡片取消当前选中的组件</small></button>';}
  function guide(e,count){const c=view.config,p=e?c.parts[e.part]:null,lv=e?e.growth.level:0;
   // 高亮「当前该做的那一步」：没选装备→选装备；还没到副属性档→直接强化；可定副属性或未精工→选方向；否则→执行操作。
   const now=!e?1:(e.growth.engrave==='none'&&lv+1>=c.subUnlock?2:3),bound=!!e&&!!e.bound;
   const steps=[['1','选装备','点强化路径里的卡片'],['2','选副属性方向','+'+c.subUnlock+' 解锁'],['3','强化 · 精工 · 转移','材料确定成长']];
   let h='<div class="gear-steps">';
   steps.forEach((d,i)=>{h+=(i?'<span class="gear-step-arrow" aria-hidden="true">→</span>':'')+'<span class="gear-step '+(i+1===now?'is-now':i+1<now?'is-done':'')+'"><b>'+d[0]+'</b><span>'+d[1]+'<small>'+d[2]+'</small></span></span>';});
   h+='</div><div class="gear-track">'+pickCard(e,count)+'<span class="gear-track-title">强化路径</span><div class="gear-track-nodes" role="img" aria-label="'+(e?'当前 +'+lv+'，满级 +'+c.maxLevel:'尚未选择组件，满级 +'+c.maxLevel)+'">';
   for(let i=0;i<=c.maxLevel;i++){
    const mark=i===c.subUnlock?'副':i===c.engraveLevel?'精':i===c.maxLevel?'满':'';
    const color=i===c.subUnlock?'#7fc4ec':i===c.engraveLevel?'#c084fc':'#f5ce56';
    const title='+'+i+(p?' · '+esc(labels[p.main])+' '+(p.mainValues[i]??'')+'%'+(i>=c.subUnlock?' · 副属性 '+(p.subValues[i]??'')+'%':''):'');
    h+='<span class="gear-node '+(e&&i===lv?'is-now':e&&i<lv?'is-done':'')+(mark?' has-mark':'')+'"'+(mark?' style="--gear-mark:'+color+'"':'')+
      ' title="'+title+'"><i>'+i+'</i>'+(mark?'<em>'+mark+'</em>':'')+'</span>';}
   h+='</div></div><div class="gear-milestones">'+[['🔓','+'+c.subUnlock+' 副属性解锁',lv>=c.subUnlock],['🔨','+'+c.engraveLevel+' 精工开放',lv>=c.engraveLevel],['🏁','+'+c.maxLevel+' 满级',lv>=c.maxLevel],['🔒',bound?'已绑定角色':'+'+c.boundLevel+' 或精工后绑定',bound]]
    .map(m=>'<span class="gear-mile '+(m[2]?'is-done':'')+'">'+m[0]+' '+esc(m[1])+'</span>').join('')+'</div>';
   return '<section class="gear-guide" aria-label="成长指引">'+h+'</section>';}
  function pips(tier,max){return '<span class="gear-pips" role="img" aria-label="成长阶段 '+tier+' / '+max+'">'+Array.from({length:max+1},(_,i)=>'<i class="'+(i<=tier?'on':'')+'"></i>').join('')+'</span>';}
  const EMPTY={growth:['🎣','还没有新制装备','装备从制造、基础掉落或开箱获得，再用远航材料确定成长。']};
  // 组件选择子窗口：沿用全局 .modal-overlay / .modal-box 与工坊筛选控件，只有点开卡片时才渲染列表。
  let pickerEl=null;
  function pickerList(){return view.equipment.filter(e=>view.config.parts[e.part]&&!e.set&&e.growth);}
  function pickerClose(){if(pickerEl){pickerEl.remove();pickerEl=null;}}
  function pickerGrid(box){const list=pickerList().slice().sort(equippedFirst),filtered=list.filter(matchesEquipment);
   box.querySelector('.gear-picker-count').textContent='显示 '+filtered.length+' / '+list.length+' 件';
   box.querySelector('.gear-picker-grid').innerHTML=filtered.length?filtered.map(x=>'<button type="button" class="gear-item '+(x.id===selected?'selected':'')+'" data-pick-item="'+esc(x.id)+'"><b>'+esc(x.name)+' +'+x.growth.level+'</b><small>'+esc(labels[x.part]||x.part)+' · '+affixes(x.affixes)+'</small><small>'+(x.locked?'已装备 · ':'')+(x.rewardBound?'奖励绑定 · 产物'+(x.bindOutputs?'绑定':'不绑定'):x.bound?'已绑定':'可交易')+'</small></button>').join(''):'<p class="hint">没有匹配的配件</p>';
   box.querySelectorAll('[data-pick-item]').forEach(b=>b.onclick=()=>{selected=b.dataset.pickItem;selectedSub='';selectedDirection='main';pickerClose();draw();});}
  function openPicker(){if(pickerEl||!view)return;
   document.querySelectorAll('.modal-overlay').forEach(m=>m.remove());
   const overlay=document.createElement('div');overlay.className='modal-overlay';
   overlay.addEventListener('click',ev=>{if(ev.target===overlay)pickerClose();});
   const box=document.createElement('div');box.className='modal-box shop-modal gear-system gear-pick-modal';
   box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','选择组件');
   box.innerHTML='<div class="modal-head"><span class="modal-title">🔧 选择组件</span><button class="mini modal-close">✕ 关闭</button></div>'+
     '<div class="modal-body gear-pick-body"><p class="gear-caption">已装备的组件排在列表最前，可直接选中成长：结果会替换同一配装槽位里的组件。点选一件配件即选中并关闭窗口；再次点击「强化路径」里的卡片可以取消当前选中的组件。</p>'+
     '<div class="gear-picker-controls"><input class="gear-picker-search" data-equipment-filter placeholder="搜索配件或属性" aria-label="搜索配件或属性" value="'+esc(equipmentFilter)+'"/>'+equipmentFilterControls()+'</div>'+
     '<p class="gear-picker-count"></p><div class="gear-picker-grid"></div></div>';
   overlay.appendChild(box);document.body.appendChild(overlay);pickerEl=overlay;
   box.querySelector('.modal-close').onclick=pickerClose;
   const filter=box.querySelector('[data-equipment-filter]');if(filter)filter.oninput=()=>{equipmentFilter=filter.value;pickerGrid(box);};
   box.querySelectorAll('[data-equipment-select]').forEach(el=>el.onchange=()=>{equipmentFilters[el.dataset.equipmentSelect]=el.value;pickerGrid(box);});
   const reset=box.querySelector('[data-equipment-reset]');if(reset)reset.onclick=()=>{equipmentFilter='';Object.keys(equipmentFilters).forEach(k=>equipmentFilters[k]='');filter.value='';box.querySelectorAll('[data-equipment-select]').forEach(el=>el.value='');pickerGrid(box);};
   // Esc 关闭 / Tab 在子窗口内循环焦点，与工坊其它子窗口保持一致。
   box.addEventListener('keydown',ev=>{if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();pickerClose();}
    if(ev.key==='Tab'){const nodes=Array.from(box.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')),first=nodes[0],last=nodes[nodes.length-1];
     if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}}});
   pickerGrid(box);box.querySelector('.modal-close').focus();}
  // 装备成长工作台：组件选择收进「强化路径」框体内的卡片，详情只展示当前选中配件的成长操作。
  function growthTab(){const c=view.config,list=pickerList(),e=list.find(x=>x.id===selected)||null;let h='<div class="gear-workbench"><section class="gear-detail">'+guide(e,list.length);
   if(!e){const [icon,title,note]=EMPTY.growth;
    h+=list.length?'<section class="gear-card gear-pick-empty"><h3>还没有选择组件</h3><p>在「强化路径」的卡片里挑一件配件，这里会显示材料强化、副属性方向、精工锻造与成长转移。</p><button type="button" class="primary" data-pick-card="open">选择组件</button></section>'
     :'<div class="gear-empty"><span class="gear-empty-icon" aria-hidden="true">'+icon+'</span><b>'+title+'</b><small>'+note+'</small><button data-open-chest class="primary">去开箱获取装备</button></div>';
    return h+'</section></div>';}
   const g=e.growth,p=c.parts[e.part],level=g.level,sub=selectedSub||e.affixes.find(a=>a.type!==p.main)?.type||p.subs[0];
   let body='<span class="gear-eyebrow">'+esc(labels[e.part])+' / '+(e.bound?'角色绑定':'未绑定')+'</span><h2>'+esc(e.name)+' +'+level+'</h2><p class="gear-stats">'+affixes(e.affixes)+'</p>';
   // 强化等级不够使用的功能（副属性方向 / 副属性调校 / 精工锻造）在到达对应档位前不渲染，只保留里程碑说明下一步。
   const subPick=level+1>=c.subUnlock,subReady=level>=c.subUnlock,forgeReady=level>=c.engraveLevel;
   if(subPick)body+='<div class="gear-choice-group"><h3>副属性方向</h3><div class="gear-choice-grid">'+p.subs.map(s=>'<button type="button" class="gear-choice '+(s===sub?'selected':'')+'" data-sub-option="'+esc(s)+'"><b>'+esc(labels[s])+'</b><small>'+((e.affixes.find(a=>a.type===s)?.value||0)>0?'当前 +'+e.affixes.find(a=>a.type===s).value+'%':subReady?'可调校到该属性':'强化到 +'+c.subUnlock+' 时采用')+'</small></button>').join('')+'</div></div>';
   body+='<div class="gear-grid">';
   body+='<article class="gear-card"><h3>材料强化</h3>'+(level<c.maxLevel?'<p>+'+level+' → +'+(level+1)+' · '+esc(labels[p.main])+' '+p.mainValues[level]+' → '+p.mainValues[level+1]+'%</p><p>'+esc(cost(c.costs.upgrade[level]))+'</p><button data-action="upgrade">强化到 +'+(level+1)+'</button>':'<p>已达到当前强化上限</p>')+'</article>';
   if(subReady)body+='<article class="gear-card"><h3>副属性调校</h3><p>保留强化等级，使用上方高亮的副属性。</p><p>'+esc(cost(c.costs.tune))+'</p><button data-action="tune">调校副属性</button></article>';
   if(forgeReady)body+='<article class="gear-card"><h3>精工锻造</h3><p>按所选方向加成，主副方向互斥。当前：'+esc(({none:'未精工',main:'主属性精工',sub:'副属性精工'})[g.engrave])+'</p><div class="gear-choice-grid forge-choice-grid">'+[['main','主属性 × '+(1+c.mainEngrave),g.engrave!=='sub'],['sub','副属性 × '+(1+c.subEngrave),g.engrave==='sub']].map(x=>'<button type="button" class="gear-choice '+((selectedDirection||(g.engrave==='sub'?'sub':'main'))===x[0]?'selected':'')+'" data-direction-option="'+x[0]+'"><b>'+x[1]+'</b><small>点击选择</small></button>').join('')+'</div><p>纯材料：'+esc(cost(c.costs.engrave))+'</p><p>热量优惠：'+esc(cost({...c.costs.heatEngrave,heat:Math.max(0,c.costs.heatEngrave.heat-(c.sets.forge.stages[view.state.tiers.forge||0].heatDiscount||0))}))+'</p><button data-action="engrave">材料精工</button> <button data-action="heat">使用热量精工</button>'+(g.presets===3&&(view.state.tiers.forge||0)>=3?'<p>切换已制作预设：'+esc(cost(c.costs.preset))+'</p><button data-action="preset">切换精工预设</button>':'')+'</article>';
   const targets=list.filter(x=>x.id!==e.id&&x.part===e.part&&eligible(x)&&x.growth?.level===0&&x.growth.engrave==='none'&&(!transferBinding||(transferBinding==='bound'?x.bound:!x.bound)));
   body+='<article class="gear-card"><h3>成长转移</h3><p>消耗当前配件与目标 +0 配件，将等级、副属性、精工与绑定状态转至目标。</p><label>目标绑定状态 <select data-transfer-binding>'+option('','全部',!transferBinding)+option('free','未绑定',transferBinding==='free')+option('bound','已绑定',transferBinding==='bound')+'</select></label><p class="hint">同部位可用目标 '+targets.length+' 件</p><select data-transfer>'+targets.map(x=>option(x.id,x.name+' · '+(x.bound?'已绑定':'未绑定')+' #'+x.id,false)).join('')+'</select><p>'+esc(cost(c.costs.transfer))+'</p><button data-action="transfer" '+(!targets.length?'disabled':'')+'>确认转移</button></article></div>';
   // 只列出还没到等级的项：到 +4 后调校已经出现，提示里就不该再说「+4 解锁副属性调校」。
   const pending=[!subReady?'+'+c.subUnlock+' 开放副属性调校':'',!forgeReady?'+'+c.engraveLevel+' 开放精工锻造':''].filter(Boolean).join('，');
   if(pending)body+='<p class="gear-caption">未到等级的功能先不显示：'+pending+'，到达后对应操作会出现在这里。</p>';
   return h+body+(e.locked?'<p class="gear-caption">此配件已装配在钓竿上：成长结果（含成长转移）会直接放回同一配装槽位，不需要先卸下。</p>':'')+'</section></div>';
  }
  // 只保留功能性页签：装备成长 / 钓鱼套装（原「成长总览」介绍页与「旧制转换」页已删除）。
  const GEAR_TABS=[['growth','⚙ 装备成长'],['sets','🎣 钓鱼套装']];
 // 套装效果表与「远洋 → 专精工作台」的 1-3 点效果表同构：参数只出现一次，各阶并排，黄色小字是相对上一阶的变化。
 function stageTable(s,tier,on){
  const stages=s.stages||[],keys=[...new Set(stages.flatMap(x=>Object.keys(x||{})))];
  const cols=stages.map((_,i)=>({stage:i,open:i<=tier,next:i===tier+1,label:i===tier?(on?'生效':'当前'):i<tier?'已达成':i===tier+1?'下一阶':'待进阶'}));
  const head='<tr><th scope="col">效果参数</th>'+cols.map(x=>'<th scope="col" class="'+(x.open?'is-active':x.next?'is-next':'is-locked')+'"><b>'+x.stage+' 阶</b><i>'+x.label+'</i></th>').join('')+'</tr>';
  const rows=keys.map(k=>'<tr><th scope="row">'+esc(labels[k]||k)+'</th>'+cols.map(x=>{
   const raw=stages[x.stage]?.[k],prev=stages[x.stage-1]?.[k];
   const now=value(k,raw??0),before=prev===undefined?null:value(k,prev);
   const d=before!==null&&String(before)!==String(now)?delta(k,prev,raw):'';
   return '<td class="'+(x.open?'is-active':x.next?'is-next':'is-locked')+'">'+esc(now)+(d?' <i class="voyage-delta">'+esc(d)+'</i>':'')+'</td>';
  }).join('')+'</tr>').join('');
  return '<div class="voyage-point-effects" aria-label="四阶效果"><table class="voyage-point-table"><thead>'+head+'</thead><tbody>'+rows+'</tbody></table></div>';
 }
 // 工坊「钓鱼套装」改用与「远洋 → 专精工作台」同构的工作台布局：状态条 + 套装卡片 + 效果表 + 动作。
 // 当前套装用不到的功能不渲染：缺少同套核心时隐藏进阶，偏好只保留当前生效套装的那一张。
 function sets(){const c=view.config,v=view.state,sets=c.sets||{};
  const held=id=>new Set(view.equipment.filter(e=>e.set===id&&(e.part==='rod'||e.part==='charm')).map(e=>e.part));
  const activeId=sets[view.activeSet]?view.activeSet:'',T=id=>v.tiers?.[id]||0;
  const cards=Object.entries(sets).map(([id,s])=>{
   const tier=T(id),on=activeId===id,cores=held(id),ready=cores.has('rod')&&cores.has('charm');
   const parts=['竿身','饰品'].filter((_,i)=>!cores.has(i?'charm':'rod')).join('与');
   const action=tier>=3?'<p class="voyage-card-action">已达到最高阶段</p>':ready?'<div class="voyage-card-action"><p>熔炼进阶：'+esc(cost(c.costs.stage[tier]))+'</p><button data-stage="'+id+'">熔炼至 '+(tier+1)+' 阶</button></div>':'<div class="voyage-card-action"><p class="voyage-locked-note">进阶需要同套竿身与饰品核心，当前缺少'+parts+'核心：在「远洋 → 钓鱼套装」用印记兑换核心后开放。</p></div>';
   return '<article class="gear-card voyage-allocation '+(on?'is-assigned':'')+'"><span class="gear-eyebrow">'+(on?'正在生效':'钓鱼套装')+' · '+tier+' 阶 '+pips(tier,3)+'</span><h3>'+esc(s.name)+'</h3><p>'+esc(s.description)+'</p>'+(s.coreAttributes?Object.entries(s.coreAttributes).map(([p,aa])=>'<p>'+esc(labels[p]||p)+'：'+Object.entries(aa).map(([k,n])=>esc(labels[k]||k)+' +'+n+'%').join(' · ')+'</p>').join(''):'')+'<p class="voyage-live-effect">'+(on?'正在生效：':'未装配：')+(tier?tier+' 阶效果':'基础效果')+'</p><h4>四阶效果</h4>'+stageTable(s,tier,on)+action+'</article>';
  }).join('');
  const tracking=activeId==='apex',harvest=activeId==='harvest';
  const trackingCard='<section class="gear-card"><h3>猎王追踪</h3><p>只对当前鱼池已有鱼种生效；更换目标会清空追踪进度。只有猎王追踪套装生效时才结算。</p><label>目标鱼种 <select data-target>'+D.allItems().filter(x=>x.kind==='fish'&&!c.excludedFish.includes(x.id)&&!x.id.startsWith('unique_')).map(x=>option(x.id,x.name,x.id===v.target)).join('')+'</select></label><label>每个目标命中次数 <input data-goal type="number" min="1" max="10000" value="'+(v.targetGoal||1)+'"></label>'+(T('apex')>=3?'<label>三阶轮换名单（鱼种 ID，用逗号分隔）<input data-queue value="'+esc((v.targetQueue||[]).join(','))+'"></label>':'<p class="voyage-locked-note">三阶轮换名单在猎王追踪达到 3 阶后开放。</p>')+'<button data-target-save>保存追踪</button><p>当前累计 '+v.tracking+' 次；本目标完成 '+v.targetCaught+' 次。</p></section>';
  const harvestCard='<section class="gear-card"><h3>丰收模式</h3><p>成功抛竿累计 '+v.harvest+' 次。额外鱼不重复触发套装、不计体型纪录。只有丰收渔获套装生效时才结算。</p><select data-harvest>'+option('small','小丰收 · 常规频率',v.harvestMode!=='large')+(T('harvest')>=3?option('large','大丰收 · 延长周期、集中收获',v.harvestMode==='large'):'')+'</select><button data-harvest-save>保存丰收模式</button>'+(T('harvest')>=3?'':'<p class="voyage-locked-note">大丰收在丰收渔获达到 3 阶后开放。</p>')+'</section>';
  return '<section class="gear-card voyage-form gear-sets"><div class="voyage-allocation-total" role="status">当前生效 <b>'+esc(activeId?sets[activeId].name:'未装配套装')+'</b>'+(activeId?' · '+T(activeId)+' 阶效果':' · 同套竿身与饰品同时装配后生效')+'</div><p class="gear-caption">进阶消耗金币、材料、航程凭证与同套重复核心（每个核心部位至少保留一件）· 远航专精见「远洋 → 专精工作台」</p><h4>四套钓鱼套装</h4><div class="gear-grid voyage-specializations">'+cards+'</div><h4>钓鱼偏好</h4>'+(tracking?trackingCard:harvest?harvestCard:'<p class="voyage-locked-note">钓鱼偏好只对当前生效的套装结算：装备猎王追踪后在这里设置目标鱼种与轮换名单，装备丰收渔获后在这里选丰收模式。</p>')+'</section>';}
 // 工具条（凭证 / 热量 / 消耗来源 / 刷新）+ 子页签 + 当前功能页；原介绍性大标题与说明段落已移除。
 function draw(){if(!root)return;const s=(view&&view.state)||{},rh=(view&&view.config.receiptHours)||8;
  root.innerHTML='<div class="gear-bar"><div class="gear-metrics"><span title="远航产出；强化、精工与套装进阶都要消耗">航程凭证 <b>'+(s.receipts||0)+'</b></span><span title="在线垂钓自动累积；精工可用热量抵扣材料">精工热量 <b>'+(s.heat||0)+'</b></span><span title="每累计 '+rh+' 小时远航自动发放一张航程凭证">凭证进度 <b>'+(s.receiptRemainder||0)+' / '+rh+'h</b></span></div>'+
   '<label class="gear-source"><span>消耗来源</span><select data-reward-source title="奖励不可出售或交易；直接产物按发奖时的规则继承绑定"><option value="bound" '+(!Engine.state.unboundInputs?'selected':'')+'>优先使用奖励绑定物品</option><option value="free" '+(Engine.state.unboundInputs?'selected':'')+'>仅使用普通物品</option></select></label>'+
   '<button class="gear-refresh" data-refresh>刷新</button></div>'+
   '<nav class="gear-tabs" role="tablist" aria-label="装备与套装功能">'+GEAR_TABS.map(([id,t])=>'<button class="'+(tab===id?'primary':'')+'" data-gear-tab="'+id+'" role="tab" aria-selected="'+(tab===id)+'">'+t+'</button>').join('')+'</nav>'+
   '<p role="status" class="gear-notice">'+esc(notice)+'</p>'+
   (view?(tab==='sets'?sets():growthTab()):'<p class="gear-caption ld-state">读取装备成长状态…</p>');
  root.querySelector('[data-reward-source]').onchange=e=>{Engine.state.unboundInputs=e.target.value==='free';draw();};root.querySelector('[data-refresh]').onclick=()=>load(true);const openChest=root.querySelector('[data-open-chest]');if(openChest)openChest.onclick=()=>{UI.setView('chest');UI.renderNav();UI.renderView();if(window.Net&&Net.fetchChest)Net.fetchChest();};const filter=root.querySelector('[data-equipment-filter]');if(filter)filter.oninput=e=>{const start=e.target.selectionStart;equipmentFilter=e.target.value;draw();const next=root.querySelector('[data-equipment-filter]');next.focus();next.setSelectionRange(start,start);};root.querySelectorAll('[data-sub-option]').forEach(b=>b.onclick=()=>{selectedSub=b.dataset.subOption;draw();});root.querySelectorAll('[data-direction-option]').forEach(b=>b.onclick=()=>{selectedDirection=b.dataset.directionOption;draw();});root.querySelectorAll('[data-gear-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.gearTab;draw();});
   // 强化路径里的组件卡片：空卡片打开选择子窗口，已选卡片点击取消当前选中的组件。
   root.querySelectorAll('[data-pick-card]').forEach(b=>b.onclick=()=>{if(b.dataset.pickCard==='clear'){selected='';selectedSub='';selectedDirection='main';draw();}else openPicker();});
   if(pickerEl){if(!pickerEl.isConnected||!view)pickerEl=null;else pickerGrid(pickerEl);}
   const transferFilter=root.querySelector('[data-transfer-binding]');if(transferFilter)transferFilter.onchange=()=>{transferBinding=transferFilter.value;draw();};
  root.querySelectorAll('[data-equipment-select]').forEach(el=>el.onchange=()=>{equipmentFilters[el.dataset.equipmentSelect]=el.value;draw();});const reset=root.querySelector('[data-equipment-reset]');if(reset)reset.onclick=()=>{equipmentFilter='';Object.keys(equipmentFilters).forEach(k=>equipmentFilters[k]='');draw();};
  root.querySelectorAll('[data-action]').forEach(b=>{if(!modifiable(view.equipment.find(e=>e.id===selected)))b.disabled=true;b.onclick=async()=>{const a=b.dataset.action,body={action:a==='heat'?'engrave':a,id:selected,sub:selectedSub||view.equipment.find(e=>e.id===selected)?.affixes.find(a=>a.type!==view.config.parts[view.equipment.find(e=>e.id===selected)?.part]?.main)?.type||view.config.parts[view.equipment.find(e=>e.id===selected)?.part]?.subs[0]||'',direction:selectedDirection||'main',useHeat:a==='heat',otherId:root.querySelector('[data-transfer]')?.value||''};if(a==='transfer'&&!await UI.confirmModal({title:'确认成长转移',html:'将消耗来源和目标两件配件，生成一件继承成长的配件。',okText:'确认继续'}))return;action(body);};});
  root.querySelectorAll('[data-stage],[data-unlock]').forEach(b=>b.onclick=()=>action({action:b.dataset.stage?'stage':'unlock',set:b.dataset.stage||b.dataset.unlock}));
  // 未达三阶时名单字段不渲染；此时按空名单提交，避免读到空节点并符合服务端的进阶门槛校验。
  const queue=root.querySelector('[data-queue]');const target=root.querySelector('[data-target-save]');if(target)target.onclick=()=>action({action:'target',target:root.querySelector('[data-target]').value,goal:Number(root.querySelector('[data-goal]').value),queue:queue?queue.value.split(',').map(s=>s.trim()).filter(Boolean):[]});
  const harvest=root.querySelector('[data-harvest-save]');if(harvest)harvest.onclick=()=>action({action:'harvest_mode',mode:root.querySelector('[data-harvest]').value});if(busy)root.querySelectorAll('button,input,select').forEach(b=>b.disabled=true);
 }
 window.GearUI={mount(host){if(!root){root=document.createElement('div');root.className='gear-system';draw();}host.append(root);load(false);},invalidate(){last=0;if(root?.isConnected&&!busy)load(true);},cost,effect,value,delta,labels,esc,option,affixes};
})();
