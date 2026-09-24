(function(){
 'use strict';
 const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const key=()=> 'ops-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2));
 const E=window.AdminEdit; // 变更摘要共用件
 const num=(label,value,attrs)=>'<label>'+esc(label)+'<input class="ipt" type="number" value="'+value+'" '+attrs+'></label>';
 const text=(label,value,attrs)=>'<label>'+esc(label)+'<input class="ipt" value="'+esc(value)+'" '+attrs+'></label>';
 const HOURS=[2,8,12];
 // 服务端 modules/sea/admin.go 对船长进度的上界；successes/voyages/clears/target 不允许后台改
 const PROGRESS=[['marks','远航印记',1000000000],['starter','整套自选资格（0 未获得 / 1 可用 / 2 已使用）',2]];
 const LEGACY_PROGRESS=[['heat','精工热量（旧制）',30],['clues','遗物线索（旧制）',5],['samples','研究样本（旧制）',30],['tracking','猎王追踪层数（旧制）',3]];
 function error(r){const code=r&&r.data&&r.data.error;return ({catalog_revision_changed:'配置已被其他操作修改，请重新进入页面后编辑。',captain_changed:'玩家进度已变化，请重新查询后编辑。',invalid_input:'输入不符合要求，请检查数量、词条和配置范围。',expedition_claimed:'该航次已经结算，请重新查询。',retry_same_request:'连接未完成，请重试相同操作。'})[code]||code||'请求未完成，请重试';}
 function setup(host){host.innerHTML='';const panel=document.createElement('section');panel.className='panel';host.appendChild(panel);return panel;}
 function setAt(obj,path,value){const bits=String(path).split('.'),last=bits.pop();let at=obj;for(const b of bits)at=at[b];at[last]=value;}

 async function expedition(host,api,confirm,nav){
  const panel=setup(host);panel.innerHTML='<h2>🧭 远航与套装管理</h2><p>加载中…</p>';
  const res=await api('GET','/api/admin/expedition');if(!panel.isConnected)return;if(!res.ok){panel.textContent=error(res);return;}
  let cfg=res.data.config,sets=res.data.sets,revision=res.data.revision;
  const modern=!!(window.GameData&&GameData.GEAR_SYSTEM&&GameData.GEAR_SYSTEM.enabled);
  const form$=()=>panel.querySelector('[data-exp-config]');
  const setStatus=(msg,err)=>panel.querySelectorAll('[data-config-status]').forEach(n=>{n.textContent=msg;n.classList.toggle('err',!!err);});
  let changed=[];
  const names={routes:'航线',catalysts:'催化剂',sets:'套装',ticket:'每次消耗深海鳞片',hours:'开放时长',name:'名称',description:'说明',level:'解锁船级',success:'基础成功率 %',coins:'每小时基础金币',route:'所属航线',minHours:'最低时长',cost:'每件所需印记',pieces:'核心数值',value:'数值'};
  const labelOf=()=>{const m={...names};cfg.routes.forEach((r,i)=>m['config.routes.'+i]=r.name||r.id);cfg.catalysts.forEach((x,i)=>m['config.catalysts.'+i]=x.name||x.id);sets.forEach((s,i)=>m['sets.'+i]=s.name||s.id);return m;};

  function formHTML(){
   return '<h2>🧭 远航与套装管理</h2><p class="hint">保存后新启航使用新规则；已经出发的奖励保持出发时的结果。时长支持 2 / 8 / 12 小时，可分别开放。</p>'
    +'<div class="gear-save"><button class="btn primary" type="submit" form="exp-config" data-save>保存远航与套装配置</button><button class="btn" type="button" data-revert>撤销全部修改</button><span role="status" data-config-status></span></div>'
    +'<details class="gear-diff" data-diff-wrap><summary>待保存变更 <b data-diff-count>0</b> 项</summary><div class="scroll"><table class="tbl"><thead><tr><th>字段</th><th>当前</th><th>改为</th></tr></thead><tbody data-diff-list></tbody></table></div><p class="hint" data-diff-warn></p></details>'
    +'<form data-exp-config id="exp-config"><div class="ops-grid">'+num('每次消耗深海鳞片',cfg.ticket,'data-ticket data-path="config.ticket" min="0" max="1000000" required')+'<fieldset data-path="config.hours"><legend>开放时长</legend>'+HOURS.map(h=>'<label><input type="checkbox" data-hours="'+h+'" '+(cfg.hours.includes(h)?'checked':'')+'>'+h+' 小时</label>').join('')+'</fieldset></div>'
    +cfg.routes.map((r,i)=>'<section class="ops-card" data-route="'+r.id+'"><h3>'+esc(r.name)+'</h3><div class="ops-grid">'+text('航线名称',r.name,'data-field="name" data-path="config.routes.'+i+'.name" maxlength="40" required')+text('说明',r.description,'data-field="description" data-path="config.routes.'+i+'.description" maxlength="500"')+num('解锁船级',r.level,'data-field="level" data-path="config.routes.'+i+'.level" min="1" max="5" required')+num('基础成功率 %',r.success,'data-field="success" data-path="config.routes.'+i+'.success" min="0" max="100" step="0.1" required')+num('每小时基础金币',r.coins,'data-field="coins" data-path="config.routes.'+i+'.coins" min="0" max="1000000000" required')+'</div></section>').join('')
    +'<details data-old-catalysts'+(modern?'':' open')+'><summary>催化剂产出'+(modern?'（当前为新材料装备制，不再随航次发放，仅供追溯）':'')+'</summary>'+(modern?'<p class="hint">九种催化剂已被「强化合金 / 精工合金 / 催化晶」取代，产出改由「装备与套装 → 远航基础材料产出」按航线配置；此表保留以兼容旧存档与旧航次结算。</p>':'')+cfg.catalysts.map((c,i)=>'<div class="ops-row" data-catalyst="'+c.id+'"><span>'+esc(c.name)+'</span><select class="ipt" data-route-choice data-path="config.catalysts.'+i+'.route">'+cfg.routes.map(r=>'<option value="'+r.id+'" '+(r.id===c.route?'selected':'')+'>'+esc(r.name)+'</option>').join('')+'</select><label>最低时长 <select class="ipt" data-min-hours data-path="config.catalysts.'+i+'.minHours">'+HOURS.map(h=>'<option '+(h===c.minHours?'selected':'')+'>'+h+'</option>').join('')+'</select> 小时</label></div>').join('')+'</details>'
    +'<h3>套装兑换</h3><p class="hint">'+(modern?'此处管理解锁船级与兑换印记。核心基础属性、套装效果与材料产出统一在「装备与套装」配置。':'可调整解锁等级、兑换印记和核心数值；套装触发机制沿用现有玩法。')+(nav?' <button class="btn mini" type="button" data-goto-gear>去「装备与套装」编辑核心属性与阶段 →</button>':'')+'</p>'
    +sets.map((s,i)=>'<section class="ops-card" data-set="'+s.id+'"><b>'+esc(s.name)+(s.pending?'（企划中）':'')+'</b><p class="hint">'+esc(s.effect)+'</p><div class="ops-grid">'+text('套装名称',s.name,'data-field="name" data-path="sets.'+i+'.name" maxlength="40" required'+(modern?' readonly':''))+num('解锁船级',s.level,'data-field="level" data-path="sets.'+i+'.level" min="1" max="5" required')+num('每件所需印记',s.cost,'data-field="cost" data-path="sets.'+i+'.cost" min="0" max="1000000" required')+(s.pieces||[]).map((p,j)=>num(p.name+' · '+((window.GameData&&GameData.AFFIX_LABEL&&GameData.AFFIX_LABEL[p.type])||p.type),p.value,'data-piece="'+j+'" data-path="sets.'+i+'.pieces.'+j+'.value" min="0" max="1000" step="1" required'))+'</div></section>').join('')
    +'<div class="gear-save"><button class="btn primary" type="submit" data-save>保存远航与套装配置</button><span role="status" data-config-status></span></div></form>'
    +'<hr><h3>玩家远航测试</h3><div class="ops-row"><input class="ipt" data-target placeholder="玩家账号（登录名）"><button class="btn" data-load>查询玩家航次</button></div><div data-player></div>';
  }
  function collect(){
   const form=form$(),next={config:structuredClone(cfg),sets:structuredClone(sets)},problems=[];
   form.querySelectorAll('input[data-path],select[data-path]').forEach(n=>{
    const raw=n.dataset.path;
    const value=n.tagName==='SELECT'?(/minHours|level|cost/.test(raw)?Number(n.value):n.value):(n.type==='number'?Number(n.value):n.value);
    setAt(next,raw,value);
   });
   next.config.hours=Array.from(form.querySelectorAll('[data-hours]:checked')).map(n=>Number(n.dataset.hours)).sort((a,b)=>a-b);
   if(!next.config.hours.length)problems.push({path:'config.hours',msg:'至少选择一个开放时长',node:form.querySelector('[data-path="config.hours"]')});
   return {next,problems};
  }
  function validate(next){
   const p=[],add=(path,msg)=>p.push({path,msg}),c=next.config;
   if(!(c.ticket>=0&&c.ticket<=1e6))add('config.ticket','需在 0~1000000');
   if(!c.hours.length)add('config.hours','至少选择一个开放时长');
   c.routes.forEach((r,i)=>{
    if(!r.name||Array.from(String(r.name)).length>40)add('config.routes.'+i+'.name','名称需 1~40 字');
    if(String(r.description||'').length>500)add('config.routes.'+i+'.description','说明不能超过 500 字');
    if(!(r.level>=1&&r.level<=5))add('config.routes.'+i+'.level','解锁船级需在 1~5');
    if(!(r.success>=0&&r.success<=100))add('config.routes.'+i+'.success','成功率需在 0~100');
    if(!(r.coins>=0&&r.coins<=1e9))add('config.routes.'+i+'.coins','金币需在 0~10 亿');
   });
   const ids=c.routes.map(r=>r.id);
   c.catalysts.forEach((x,i)=>{if(!ids.includes(x.route))add('config.catalysts.'+i+'.route','必须指向已有航线');if(!HOURS.includes(x.minHours))add('config.catalysts.'+i+'.minHours','最低时长只能是 2 / 8 / 12');});
   next.sets.forEach((s,i)=>{
    if(!s.name||Array.from(String(s.name)).length>40)add('sets.'+i+'.name','名称需 1~40 字');
    if(!(s.level>=1&&s.level<=5))add('sets.'+i+'.level','解锁船级需在 1~5');
    if(!(s.cost>=0&&s.cost<=1e6))add('sets.'+i+'.cost','所需印记需在 0~1000000');
    (s.pieces||[]).forEach((pc,j)=>{const v=pc&&pc.value;if(!(typeof v==='number'&&v>=0&&v<=1000&&Number.isInteger(v)))add('sets.'+i+'.pieces.'+j+'.value','核心数值需为 0~1000 的整数');});
   });
   return p;
  }
  function refresh(){
   const {next,problems}=collect();
   changed=E?E.diff({config:cfg,sets:sets},next):[];
   const cnt=panel.querySelector('[data-diff-count]');if(cnt)cnt.textContent=String(changed.length);
   const list=panel.querySelector('[data-diff-list]');if(list)list.innerHTML=E?E.rowsHTML(changed,labelOf()):'<tr><td class="hint">未加载变更摘要组件</td></tr>';
   const warn=panel.querySelector('[data-diff-warn]');if(warn)warn.textContent=problems.map(x=>x.msg).join('；');
   panel.querySelectorAll('[data-save]').forEach(n=>{n.textContent='保存远航与套装配置'+(changed.length?'（'+changed.length+' 项变更）':'');});
   if(E){E.clearMarks(form$());E.markChanged(form$(),changed);}
  }
  const refreshSoon=E?E.debounce(refresh,150):refresh;
  async function save(next){
   panel.querySelectorAll('[data-save]').forEach(n=>n.disabled=true);
   try{
    const r=await api('POST','/api/admin/expedition/config',{config:next.config,sets:next.sets,expectedRevision:revision,requestKey:key()});
    if(!r.ok){setStatus(error(r),true);return false;}
    const fresh=await api('GET','/api/admin/expedition');
    if(fresh.ok){cfg=fresh.data.config;sets=fresh.data.sets;revision=fresh.data.revision;}
    return true;
   }finally{panel.querySelectorAll('[data-save]').forEach(n=>n.disabled=false);}
  }
  async function submit(){
   const {next,problems}=collect(),bad=[...problems,...validate(next)];
   if(bad.length){if(E){E.clearMarks(form$());const first=E.markInvalid(form$(),bad);if(first&&first.scrollIntoView)first.scrollIntoView({block:'center'});}setStatus('有 '+bad.length+' 项需要先修正：'+bad[0].msg,true);return;}
   if(await save(next)){paint();setStatus('已保存，新启航立即生效');}
  }
  function paint(){
   panel.innerHTML=formHTML();
   const form=form$(),pn=panel;
   form.addEventListener('input',refreshSoon);form.addEventListener('change',refreshSoon);
   form.onsubmit=e=>{e.preventDefault();submit();};
   panel.querySelector('[data-revert]').onclick=()=>{if(!changed.length){setStatus('当前没有未保存的修改。');return;}if(!confirm('放弃全部未保存的修改，恢复到已保存的版本 '+revision+'？'))return;paint();};
   const toGear=panel.querySelector('[data-goto-gear]');
   if(toGear)toGear.onclick=()=>{const {next}=collect();if(next&&changed.length&&!confirm('「装备与套装」是另一个页面，切换后本页未保存的修改会丢失。继续？'))return;nav('gear');};
   panel.querySelector('[data-load]').onclick=loadPlayer;
   refresh();
  }
  async function loadPlayer(){
   const target=panel.querySelector('[data-target]').value.trim(),box=panel.querySelector('[data-player]');if(!target){box.textContent='请输入账号';return;}
   const r=await api('GET','/api/admin/expedition?target='+encodeURIComponent(target));if(!r.ok){box.textContent=error(r);return;}
   const v=r.data.player,active=v.active;
   box.innerHTML='<p>远航印记 '+v.captain.marks+' · 已出航 '+v.captain.voyages+' 次 · 成功 '+v.captain.successes+' 次</p>'+(active?'<div class="ops-card"><b>'+esc((cfg.routes.find(x=>x.id===active.route)||{}).name||active.route)+' · '+active.hours+' 小时</b><p>预计返航 '+new Date(active.endsAt).toLocaleString('zh-CN')+'</p><button class="btn primary" data-finish>立即结束并结算</button><p class="hint">按出发时已确定的奖励结算，不重抽、不强制成功。奖励直接入背包，玩家无需再领取。</p></div>':'<p>该玩家没有待结算航次。</p>')+'<p class="ops-status" role="status" data-result></p>';
   const editor=document.createElement('form');editor.className='ops-card';
   editor.innerHTML='<h3>修改玩家远航进度</h3><p class="hint">用于测试印记兑换与套装计数。保存前校验进度未被钓鱼/结算改变；若提示冲突，请重新查询。</p><div class="ops-grid">'+PROGRESS.map(([id,label,max])=>num(label,v.captain[id],'data-progress="'+id+'" min="0" max="'+max+'" required')).join('')+'</div>'
    +'<details'+(modern?'':' open')+'><summary>旧制船长字段'+(modern?'（新材料装备制下不参与计算，仅在排查旧存档时需要）':'')+'</summary><div class="ops-grid">'+LEGACY_PROGRESS.map(([id,label,max])=>num(label,v.captain[id],'data-progress="'+id+'" min="0" max="'+max+'" required')).join('')+'</div></details>'
    +'<button class="btn primary" type="submit">保存玩家进度</button><p role="status" data-progress-status></p>';
   box.appendChild(editor);
   let before=JSON.parse(JSON.stringify(v.captain));
   editor.onsubmit=async e=>{
    e.preventDefault();const b=editor.querySelector('button');if(b.disabled)return;b.disabled=true;
    try{
     const after=JSON.parse(JSON.stringify(before)),bad=[];
     editor.querySelectorAll('[data-progress]').forEach(n=>{const max=Number(n.getAttribute('max'));const v2=Number(n.value);if(!(v2>=0&&v2<=max))bad.push(n.previousSibling&&n.previousSibling.textContent||n.dataset.progress);after[n.dataset.progress]=v2;});
     if(bad.length){editor.querySelector('[data-progress-status]').textContent='以下字段超出允许范围：'+bad.join('、');return;}
     if(!await confirm('保存「'+target+'」的远航测试进度？'))return;
     const r=await api('POST','/api/admin/expedition/player',{target,before,after,requestKey:key()});editor.querySelector('[data-progress-status]').textContent=r.ok?'玩家进度已保存':error(r);if(r.ok)before=after;
    }finally{b.disabled=false;}
   };
   if(active)box.querySelector('[data-finish]').onclick=async()=>{const b=box.querySelector('[data-finish]');if(b.disabled)return;b.disabled=true;
    try{if(!await confirm('立即结束「'+target+'」的「'+active.route+'」航次并结算奖励？'))return;
     const result=await api('POST','/api/admin/expedition/finish',{target,id:active.id,confirm:true,requestKey:'finish-'+active.id});if(result.ok){b.remove();box.querySelector('[data-result]').textContent='已完成结算：'+JSON.stringify(result.data.result.details);}else box.querySelector('[data-result]').textContent=error(result);
    }finally{b.disabled=false;}
   };
  }
  paint();
 }
 async function mail(host,api,confirm){return window.MailAdmin.render(host,api,confirm);}
 window.AdminOperations={expedition,mail};
})();
