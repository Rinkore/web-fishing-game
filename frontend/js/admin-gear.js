(function(){
 'use strict';
 const G=window.GearUI,D=window.GameData,esc=G.esc,labels=G.labels;
 const E=window.AdminEdit; // 变更摘要共用件；缺失时面板照常可用，只是不显示摘要
 // crypto.randomUUID 只在安全上下文可用；HTTP 打开的运营后台里会直接抛异常
 const key=()=> 'gear-admin-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2));
 const title={enabled:'启用新装备系统',maxLevel:'最高强化等级',subUnlock:'副属性解锁等级',boundLevel:'绑定等级',receiptHours:'每张航程凭证所需小时',engraveLevel:'精工开放等级',mainEngrave:'主属性精工增幅（比例）',subEngrave:'副属性精工增幅（比例）',upgrade:'逐级强化',tune:'副属性调校',engrave:'纯材料精工',heatEngrave:'热量优惠精工',transfer:'成长转移',convert:'旧制转换',preset:'精工预设切换',unlock:'远航专精认证',stage:'套装／专精进阶',coins:'金币',receipts:'航程凭证',heat:'精工热量',cores:'重复核心（仅钓鱼套装）',mainValues:'主属性数值（%）',subValues:'副属性数值（%）',main:'主属性',subs:'可选副属性',items:'消耗材料',name:'名称',description:'介绍',stages:'四阶段效果',coreAttributes:'核心基础属性',common:'普通',rare:'稀有',epic:'史诗',mythic:'神话',trade:'沿岸贸易',gather:'深海采集',salvage:'沉船打捞',danger:'凶险远征',king:'海王航线',allocations:'专精点数分配',voyageMode:'航行模式',focus:'定向货物',tiers:'套装／专精阶段',unlocked:'已认证专精',harvest:'丰收进度',tracking:'追踪进度',archaeologyHours:'考古保底累计小时',receiptRemainder:'凭证余下小时',heatMs:'热量累积毫秒',fishPity:'保底覆盖',excludedFish:'排除鱼种',legacyConvertReceipts:'旧制转换凭证',parts:'部位',sets:'钓鱼套装',specializations:'远航专精',baseDrops:'远航材料产出'};
 const MODES=[['','不启用'],['deep','深海突进（依赖风暴远洋）'],['evacuate','紧急撤离（依赖救生护航）'],['concentrate','集中投放（依赖潮汐采集）']];
 const MODE_NEED={deep:['storm','deepRisk'],evacuate:['rescue','evacuate'],concentrate:['tide','concentrate']};
 // 服务端 ValidateGear 的阶段数值细则（本地预检镜像；最终仍以服务端校验为准）
 const FLAG_KEYS=['presets','best','largeMode','queue','highChest','choice','priority','advanced','evacuate'];
 const INT_KEYS=['heatSeconds','casts','pityCommon','pityRare','pityEpic','largeMultiplier','recent'];
 const RATIO_KEYS=['retain','bonus','focus','concentrate','deepBonus','chestChancePerHour','evacuationLoss'];
  // 玩家进度字段及其服务端上界（gear_growth.go adminGearPlayer 的范围校验）
 const PLAYER_FIELDS=[['receipts','航程凭证',1000000,'1'],['receiptRemainder','凭证余下小时',168,'1'],['heat','精工热量',10000,'1'],['heatMs','热量累积毫秒',1000000000,'1'],['harvest','丰收进度',100000,'1'],['tracking','追踪进度',100000,'1'],['archaeologyHours','考古保底累计小时',100000,'1']];
 function input(path,n,step='1'){return '<input aria-label="'+esc(path)+'" type="number" min="0" step="'+step+'" data-path="'+esc(path)+'" value="'+n+'" required>'}
 function label(path,name,n,step){return '<label>'+esc(name)+input(path,n,step)+'</label>';}
 function numField(path,name,n,max,step){return '<label>'+esc(name)+'<input aria-label="'+esc(path)+'" type="number" min="0" max="'+max+'" step="'+step+'" data-path="'+esc(path)+'" value="'+n+'" required></label>';}
 function itemRows(path,items,materials){return '<div class="gear-cost-items" data-items="'+path+'">'+Object.entries(items).map(([id,n])=>itemRow(id,n,materials,path.startsWith('baseDrops')?'.01':'1')).join('')+'</div><button type="button" data-add-item="'+path+'">添加材料</button>';}
 function itemRow(id,n,materials,step){return '<div class="ops-row" data-material><select data-material-id>'+materials.map(x=>G.option(x.id,x.name,x.id===id)).join('')+'</select><input aria-label="材料数量" type="number" min="0" step="'+step+'" data-amount value="'+n+'" required><button type="button" data-remove>移除</button></div>';}
 function costEditor(path,c,materials){return '<section class="gear-card"><h4>'+esc(path.startsWith('costs.upgrade.')?'强化至 +'+(Number(path.split('.').at(-1))+1):path.startsWith('costs.stage.')?'进阶至 '+(Number(path.split('.').at(-1))+1)+' 阶':title[path.split('.').at(-1)])+'</h4><div class="ops-grid">'+['coins','receipts','heat',...(path.startsWith('costs.stage.')?['cores']:[])].map(k=>label(path+'.'+k,title[k],c[k]||0)).join('')+'</div>'+itemRows(path+'.items',c.items||{},materials)+'</section>';}
 function setAt(obj,path,value){const bits=path.split('.'),last=bits.pop();let at=obj;for(const b of bits)at=at[b];at[last]=value;}

 /** 序列按等差延拓（末段增量>0 就继续，否则保持末值），保证服务端要求的「单调不减」 */
 function growSeries(arr,len){
  if(arr.length>len){arr.length=len;return;}
  const d=arr.length>1?arr[arr.length-1]-arr[arr.length-2]:0;
  const step=d>0?d:0;
  while(arr.length<len)arr.push(Math.round((((arr[arr.length-1]||0)+step))*1000)/1000);
 }
 /** 把「最高强化等级」与所有定长数组对齐；返回给运营看的自动调整说明 */
 function syncLevels(next){
  const warns=[],n=next.maxLevel;
  Object.entries(next.parts).forEach(([id,p])=>{
    const before=p.mainValues.length+'/'+p.subValues.length;
    growSeries(p.mainValues,n+1);growSeries(p.subValues,n+1);
    if(before!==p.mainValues.length+'/'+p.subValues.length)warns.push('「'+p.name+'」成长数值已同步为 '+(n+1)+' 项');
  });
  const before=next.costs.upgrade.length;
  while(next.costs.upgrade.length<n)next.costs.upgrade.push(structuredClone(next.costs.upgrade[next.costs.upgrade.length-1]));
  if(next.costs.upgrade.length>n)next.costs.upgrade.length=n;
  if(before!==next.costs.upgrade.length)warns.push('逐级强化消耗已同步为 '+n+' 级；新增等级沿用上一级数值，请按需调整金币与材料');
  const clamp=(k,lo,hi)=>{const v=Math.min(Math.max(Number(next[k]),lo),hi);if(v!==Number(next[k])){next[k]=v;warns.push(title[k]+' 自动夹取为 '+v);}};
  clamp('maxLevel',1,100);clamp('engraveLevel',1,next.maxLevel);clamp('subUnlock',1,next.engraveLevel);clamp('boundLevel',1,next.maxLevel);
  return warns;
 }
 function stageProblem(k,v){
  if(typeof v!=='number'||!isFinite(v))return '需为数字';
  if(v<0||v>100000)return '需在 0~100000';
  if(FLAG_KEYS.includes(k)&&v!==0&&v!==1)return '只能是 0 或 1（开关）';
  if(RATIO_KEYS.includes(k)&&v>1)return '需在 0~1（比例）';
  if(k==='deepRisk'&&v>100)return '需在 0~100';
  if(k==='uniformMix'&&v>0.15)return '需在 0~0.15';
  if(k==='pityFactor'&&!(v>0&&v<=1))return '需在 0~1（比例）';
  if(k==='copies'&&(v<1||v>20||!Number.isInteger(v)))return '需为 1~20 的整数';
  if(k==='heatCap'&&(v<1||v>1e4||!Number.isInteger(v)))return '需为 1~10000 的整数';
  if(k==='minRouteLevel'&&(v<1||v>5||!Number.isInteger(v)))return '需为 1~5 的整数';
  if(INT_KEYS.includes(k)&&(v<1||!Number.isInteger(v)))return '需为不小于 1 的整数';
  return null;
 }
 /** 本地预检：镜像服务端 ValidateGear，把最常见的「改了等级没同步数组」在上传前拦住 */
 function validate(g,materialIds){
  const p=[],add=(path,msg)=>p.push({path,msg});
  if(!(g.maxLevel>=1&&g.maxLevel<=100))add('maxLevel','需在 1~100');
  if(!(g.subUnlock>=1&&g.subUnlock<=g.maxLevel))add('subUnlock','需在 1~最高等级');
  if(!(g.boundLevel>=1&&g.boundLevel<=g.maxLevel))add('boundLevel','需在 1~最高等级');
  if(!(g.engraveLevel>=g.subUnlock&&g.engraveLevel<=g.maxLevel))add('engraveLevel','需满足「副属性解锁 ≤ 精工开放 ≤ 最高等级」');
  if(!(g.receiptHours>=1&&g.receiptHours<=168))add('receiptHours','需在 1~168 小时');
  [['mainEngrave','主属性精工增幅'],['subEngrave','副属性精工增幅']].forEach(([k,t])=>{if(!(g[k]>=0&&g[k]<=1))add(k,t+'需在 0~1（0.1 代表 10%）');});
  if(g.costs.upgrade.length!==g.maxLevel)add('costs.upgrade','条目数必须等于最高等级（当前 '+g.costs.upgrade.length+' ≠ '+g.maxLevel+'）');
  if(g.costs.stage.length!==3)add('costs.stage','必须恰好 3 阶');
  const attrs=['speed','skill','double','size'];
  Object.entries(g.parts).forEach(([id,part])=>{
    if(!attrs.includes(part.main))add('parts.'+id+'.main','主属性非法');
    if(part.subs.length<1||part.subs.length>3)add('parts.'+id+'.subs','可选副属性需 1~3 个');
    if(part.subs.includes(part.main))add('parts.'+id+'.main','主属性不能同时作为副属性');
    [['mainValues','主属性数值'],['subValues','副属性数值']].forEach(([k,t])=>{
      const arr=part[k];
      if(!Array.isArray(arr)||arr.length!==g.maxLevel+1)add('parts.'+id+'.'+k,t+'长度必须为最高等级+1（当前 '+(arr||[]).length+' ≠ '+(g.maxLevel+1)+'）');
      else arr.forEach((v,i)=>{if(!(v>=0&&v<=1000))add('parts.'+id+'.'+k+'.'+i,t+'需在 0~1000');else if(i>0&&v<arr[i-1])add('parts.'+id+'.'+k+'.'+i,t+'不能低于上一级（需单调不减）');});
    });
  });
  Object.entries(g.costs).forEach(([k,c])=>{
    const list=Array.isArray(c)?c.map((x,i)=>['costs.'+k+'.'+i,x]):[['costs.'+k,c]];
    list.forEach(([path,x])=>{
      if(!x||typeof x!=='object'){add(path,'消耗项缺失');return;}
      if(!(x.coins>=0&&x.coins<=1e9))add(path+'.coins','金币需在 0~10 亿');
      if(!(x.receipts>=0&&x.receipts<=1e4))add(path+'.receipts','凭证需在 0~10000');
      if(x.heat!=null&&!(x.heat>=0&&x.heat<=1e4))add(path+'.heat','热量需在 0~10000');
      if(x.cores!=null&&!(x.cores>=0&&x.cores<=100))add(path+'.cores','核心需在 0~100');
      Object.entries(x.items||{}).forEach(([id,n])=>{if(!materialIds.includes(id))add(path+'.items','材料必须来自物品目录');else if(!(n>=1&&n<=1e6))add(path+'.items','材料数量需在 1~1000000');});
    });
  });
  [['sets','钓鱼套装'],['specializations','远航专精']].forEach(([grp,gn])=>{
    Object.entries(g[grp]).forEach(([id,a])=>{
      if(!a.name||Array.from(a.name).length>40)add(grp+'.'+id+'.name','名称需 1~40 字');
      if(!Array.isArray(a.stages)||a.stages.length!==4)add(grp+'.'+id+'.stages','必须恰好 4 阶');
      else a.stages.forEach((st,i)=>Object.entries(st).forEach(([k,v])=>{const msg=stageProblem(k,v);if(msg)add(grp+'.'+id+'.stages.'+i+'.'+k,gn+'「'+a.name+'」'+i+' 阶的 '+(labels[k]||k)+msg);}));
    });
  });
  return p;
 }
 let MATS=[];
 async function render(host,api,confirm){
  host.innerHTML='<section class="panel gear-system gear-admin"><h2>装备与套装管理</h2><p>读取权威配置…</p></section>';const panel=host.firstElementChild;
  const r=await api('GET','/api/admin/gear');if(!panel.isConnected)return;if(!r.ok){panel.textContent=r.data?.error||'配置读取失败';return;}
  let cfg=r.data.config,revision=r.data.revision;const mats=r.data.items.filter(i=>i.kind==='material');const fishes=r.data.items.filter(i=>i.kind==='fish');MATS=mats;
  const names={...title};Object.entries(cfg.parts).forEach(([id,p])=>names[id]=p.name);Object.entries({...cfg.sets,...cfg.specializations}).forEach(([id,a])=>names[id]=a.name);
  const form$=()=>panel.querySelector('[data-config]');
  const setStatus=(msg,err)=>panel.querySelectorAll('[data-status]').forEach(n=>{n.textContent=msg;n.classList.toggle('err',!!err);});
  let changed=[];

  function formHTML(){
   return '<div class="gear-header"><div><span class="gear-eyebrow">全量配置 · 版本 '+revision+'</span><h2>装备成长、钓鱼套装与远航专精</h2></div></div>'
    +'<p class="hint">保存后普通装备和钓鱼套装采用新数值；已出发远航保留出发快照。数值为百分比的字段按实际数值填写；标有“比例”的字段 0.1 代表 10%。所有材料均从物品目录选择。远航专精共用 3 点配置配额，效果按投入点数比例发挥；专精解锁与进阶不消耗装备核心。</p>'
    +'<div class="gear-save"><button class="primary" type="submit" form="gear-config" data-save>保存全部装备与套装配置</button><button type="button" data-revert>撤销全部修改</button><span role="status" data-status></span></div>'
    +'<details class="gear-diff" data-diff-wrap><summary>待保存变更 <b data-diff-count>0</b> 项</summary><div class="scroll"><table class="tbl"><thead><tr><th>字段</th><th>当前</th><th>改为</th></tr></thead><tbody data-diff-list></tbody></table></div><p class="hint" data-diff-warn></p><p class="hint">只有点「保存」后才会生效；服务端会再次校验。</p></details>'
    +'<form data-config id="gear-config"><details open><summary>成长通则</summary><div class="gear-grid">'+['maxLevel','subUnlock','boundLevel','engraveLevel','receiptHours','mainEngrave','subEngrave'].map(k=>label(k,title[k],cfg[k],k.includes('Engrave')?'.001':'1')).join('')+'</div><p class="hint">改动「最高强化等级」后，下方五个部位的成长数值数组与逐级强化消耗会<strong>自动同步长度</strong>（新等级沿用上一级的增量），无需再手工改数组。</p></details>'
    +'<details open><summary>五个普通部位 · 主副属性与逐级成长</summary>'+Object.entries(cfg.parts).map(([id,p])=>'<section class="gear-card"><h3>'+esc(p.name)+'</h3><label>主属性<select data-text-path="parts.'+id+'.main">'+['speed','skill','double','size'].map(k=>G.option(k,labels[k],k===p.main)).join('')+'</select></label><fieldset data-subs="'+id+'"><legend>可选副属性（不能与主属性相同）</legend>'+['speed','skill','double','size'].map(k=>'<label><input type="checkbox" value="'+k+'" '+(p.subs.includes(k)?'checked':'')+'>'+labels[k]+'</label>').join('')+'</fieldset><div class="scroll"><table><thead><tr><th>等级</th><th>主属性 %</th><th>副属性 %</th></tr></thead><tbody>'+p.mainValues.map((n,i)=>'<tr><td>+'+i+'</td><td>'+input('parts.'+id+'.mainValues.'+i,n,'.01')+'</td><td>'+input('parts.'+id+'.subValues.'+i,p.subValues[i],'.01')+'</td></tr>').join('')+'</tbody></table></div></section>').join('')+'</details>'
    +'<details><summary>强化、调校、精工、转移与进阶消耗</summary><div class="gear-grid">'+Object.entries(cfg.costs).map(([id,c])=>Array.isArray(c)?c.map((x,i)=>costEditor('costs.'+id+'.'+i,x,mats)).join(''):costEditor('costs.'+id,c,mats)).join('')+'</div></details>'
    +[['sets','钓鱼套装'],['specializations','远航专精']].map(([group,name])=>'<details open><summary>'+name+' · 基础属性与四阶段效果</summary>'+Object.entries(cfg[group]).map(([id,a])=>'<section class="gear-card"><h3>'+esc(a.name)+'</h3><label>名称<input data-text-path="'+group+'.'+id+'.name" value="'+esc(a.name)+'" required maxlength="40"></label><label>介绍<input data-text-path="'+group+'.'+id+'.description" value="'+esc(a.description)+'" maxlength="500"></label>'+(group==='sets'?'<h4>核心基础属性（与普通装备一样参与钓鱼计算）</h4><p class="hint">只有填了非零数值的属性才会写进配置；留 0 表示该套装不给这个属性。</p><div class="scroll"><table><tr><th>部位</th>'+['speed','skill','double','size'].map(k=>'<th>'+labels[k]+'</th>').join('')+'</tr>'+['rod','charm'].map(p=>'<tr><th>'+labels[p]+'</th>'+['speed','skill','double','size'].map(k=>'<td>'+input(group+'.'+id+'.coreAttributes.'+p+'.'+k,a.coreAttributes[p][k]||0,'.01')+'</td>').join('')+'</tr>').join('')+'</table></div>':'')+'<div class="scroll"><table><thead><tr><th>效果参数</th>'+[0,1,2,3].map(n=>'<th>'+n+' 阶</th>').join('')+'</tr></thead><tbody>'+Object.keys(a.stages[0]).map(k=>'<tr><td>'+esc(labels[k]||k)+'</td>'+a.stages.map((fx,i)=>'<td>'+input(group+'.'+id+'.stages.'+i+'.'+k,fx[k],'.001')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></section>').join('')+'</details>').join('')
    +'<details><summary>远航基础材料产出 · 每小时</summary><div class="gear-grid">'+Object.entries(cfg.baseDrops).map(([id,items])=>'<section class="gear-card"><h3>'+esc(title[id]||id)+'</h3>'+itemRows('baseDrops.'+id,items,mats)+'</section>').join('')+'</div></details>'
    +'<details><summary>追踪保底覆盖、特殊鱼排除与旧制补偿</summary><p>鱼种保底覆盖使用“鱼种 ID:次数”，每行一项。留空使用套装按稀有度的默认周期。</p><textarea data-pity>'+esc(Object.entries(cfg.fishPity).map(([id,n])=>id+':'+n).join('\n'))+'</textarea><label>排除丰收／追踪的鱼种<select multiple data-excluded size="7">'+fishes.map(f=>G.option(f.id,f.name,cfg.excludedFish.includes(f.id))).join('')+'</select></label><div class="gear-grid">'+Object.entries(cfg.legacyConvertReceipts).map(([q,n])=>label('legacyConvertReceipts.'+q,title[q]+'旧制转换凭证',n)).join('')+'</div></details>'
    +'<div class="gear-save"><button class="primary" type="submit" data-save>保存全部装备与套装配置</button><span role="status" data-status></span></div></form>'
    +'<details><summary>高级完整配置（导入 / 导出）</summary><p>导出当前已保存配置；导入会覆盖全部装备规则并接受相同校验。用于批量编辑等级数组。</p><textarea data-json aria-label="完整装备配置"></textarea><button data-export>导出配置</button> <button data-import>校验并导入配置</button><p data-json-status></p></details>'
    +'<hr><h3>玩家成长进度管理</h3><div class="ops-row"><input data-player-name placeholder="玩家登录名"><button data-player-load>查询玩家</button></div><div data-player-box></div>';
  }
  /** 从表单读回一份完整配置。格式问题走 problems 返回而不抛异常，避免摘要刷新被一个坏行打断 */
  function collect(){
   const form=form$(),next=structuredClone(cfg),problems=[];
   form.querySelectorAll('[data-path]').forEach(n=>{
    const raw=n.dataset.path,value=Number(n.value);
    // 套装核心属性：面板把四个属性都渲染成输入框，但配置里只声明它真正给的那几个。
    // 未声明且仍为 0 的一律不写回，否则一保存就会给套装件塞进 0 值词条（词条列表与实例签名都会变）。
    if(/^sets\.[^.]+\.coreAttributes\./.test(raw)){
     const bits=raw.split('.'),declared=(cfg.sets[bits[1]].coreAttributes||{})[bits[3]]||{};
     if(!(bits[4] in declared)&&value===0)return;
    }
    setAt(next,raw,value);
   });
   form.querySelectorAll('[data-text-path]').forEach(n=>setAt(next,n.dataset.textPath,n.value));
   form.querySelectorAll('[data-subs]').forEach(n=>next.parts[n.dataset.subs].subs=Array.from(n.querySelectorAll(':checked')).map(x=>x.value));
   form.querySelectorAll('[data-items]').forEach(n=>{const items={};n.querySelectorAll('[data-material]').forEach(row=>{const id=row.querySelector('[data-material-id]').value;if(id in items)problems.push({path:n.dataset.items,msg:'同一项费用里材料重复：'+id,node:row});items[id]=Number(row.querySelector('[data-amount]').value);});setAt(next,n.dataset.items,items);});
   next.fishPity={};form.querySelector('[data-pity]').value.split('\n').filter(x=>x.trim()).forEach(line=>{const pair=line.trim().split(':');if(pair.length!==2||!Number.isInteger(Number(pair[1])))problems.push({path:'fishPity',msg:'保底格式应为 fish_id:次数（问题行：'+line.trim()+'）',node:form.querySelector('[data-pity]')});else next.fishPity[pair[0]]=Number(pair[1]);});
   next.excludedFish=Array.from(form.querySelector('[data-excluded]').selectedOptions).map(x=>x.value);
   return {next,problems,warns:syncLevels(next)};
  }
  function refresh(){
   const {next,problems,warns}=collect();
   changed=E?E.diff(cfg,next):[];
   const cnt=panel.querySelector('[data-diff-count]');if(cnt)cnt.textContent=String(changed.length);
   const list=panel.querySelector('[data-diff-list]');if(list)list.innerHTML=E?E.rowsHTML(changed,names):'<tr><td class="hint">未加载变更摘要组件</td></tr>';
   const warn=panel.querySelector('[data-diff-warn]');if(warn)warn.textContent=[...problems.map(p=>p.msg),...warns].join('；');
   panel.querySelectorAll('[data-save]').forEach(n=>{n.textContent='保存全部装备与套装配置'+(changed.length?'（'+changed.length+' 项变更）':'');});
   if(E){E.clearMarks(form$());E.markChanged(form$(),changed);}
   panel.querySelectorAll('[data-status].err').forEach(n=>{n.textContent='';n.classList.remove('err');});
  }
  const refreshSoon=E?E.debounce(refresh,150):refresh;
  async function save(next){
   panel.querySelectorAll('[data-save]').forEach(n=>n.disabled=true);
   try{
    const res=await api('POST','/api/admin/gear/config',{config:next,expectedRevision:revision,requestKey:key()});
    if(!res.ok){setStatus(res.data?.error||'保存失败',true);return false;}
    const fresh=await api('GET','/api/admin/gear');
    if(fresh.ok){cfg=fresh.data.config;revision=fresh.data.revision;D.setGearSystem(cfg);}
    return true;
   }finally{panel.querySelectorAll('[data-save]').forEach(n=>n.disabled=false);}
  }
  async function submit(){
   const {next,problems,warns}=collect(),bad=[...problems,...validate(next,mats.map(m=>m.id))];
   if(bad.length){if(E){E.clearMarks(form$());const first=E.markInvalid(form$(),bad);if(first&&first.scrollIntoView)first.scrollIntoView({block:'center'});}setStatus('有 '+bad.length+' 项需要先修正：'+bad[0].msg,true);return;}
   const ok=await save(next);
   if(ok){paint();setStatus('已保存，版本 '+revision+'。玩家端已推送更新。'+(warns.length?('自动调整：'+warns.join('；')):''));}
  }
  function paint(){
   panel.innerHTML=formHTML();
   const form=form$(),pn=panel;
   pn.onclick=e=>{const remove=e.target.closest('[data-remove]');if(remove){remove.closest('[data-material]').remove();refresh();return;}const add=e.target.closest('[data-add-item]');if(add){const box=Array.from(form.querySelectorAll('[data-items]')).find(x=>x.dataset.items===add.dataset.addItem);box.insertAdjacentHTML('beforeend',itemRow(mats[0].id,1,mats,box.dataset.items.startsWith('baseDrops')?'.01':'1'));refresh();}};
   form.addEventListener('input',refreshSoon);form.addEventListener('change',refreshSoon);
   form.onsubmit=e=>{e.preventDefault();submit();};
   panel.querySelector('[data-revert]').onclick=async()=>{const {next}=collect();const n=E?E.diff(cfg,next).length:0;if(!n){setStatus('当前没有未保存的修改。');return;}if(!await confirm('放弃全部未保存的修改，恢复到已保存的版本 '+revision+'？'))return;paint();};
   panel.querySelector('[data-export]').onclick=()=>panel.querySelector('[data-json]').value=JSON.stringify(cfg,null,2);
   panel.querySelector('[data-import]').onclick=async e=>{const status=panel.querySelector('[data-json-status]');try{const next=JSON.parse(panel.querySelector('[data-json]').value);const bad=validate(next,mats.map(m=>m.id));if(bad.length){status.textContent='校验未通过（'+bad.length+' 项）：'+bad[0].msg;return;}if(!await confirm('导入完整装备配置并覆盖当前规则？'))return;if(await save(next)){paint();setStatus('已通过导入保存，版本 '+revision+'。');}}catch(err){status.textContent='配置格式错误：'+err.message;}};
   panel.querySelector('[data-player-load]').onclick=loadPlayer;
   refresh();
  }
  async function loadPlayer(){
   const name=panel.querySelector('[data-player-name]').value.trim(),box=panel.querySelector('[data-player-box]');
   const res=await api('GET','/api/admin/gear?target='+encodeURIComponent(name));if(!res.ok||!res.data.player){box.textContent=res.data?.error||'请输入有效账号';return;}
   const before=res.data.player.state,specIds=Object.keys(cfg.specializations);
   box.innerHTML='<form class="gear-card" data-progress><h3>'+esc(name)+' · 成长状态</h3><div class="gear-grid">'+PLAYER_FIELDS.map(([k,t,max,step])=>numField(k,t,before[k]||0,max,step)).join('')+'</div>'
    +'<div class="gear-grid">'+Object.entries({...cfg.sets,...cfg.specializations}).map(([id,a])=>numField('tiers.'+id,a.name+'阶段',before.tiers[id]||0,3,'1')).join('')+'</div>'
    +'<h4>远航专精认证与配置</h4><p class="hint">只有已认证的专精才能投入点数，三项合计不能超过 3 点。航行模式要求对应专精的「投入点数」与「阶段」都到 3 阶。</p>'
    +'<div class="gear-grid">'+specIds.map(id=>'<label><input type="checkbox" data-unlocked="'+id+'" '+(before.unlocked&&before.unlocked[id]?'checked':'')+'>已认证 '+esc(cfg.specializations[id].name)+'</label><label>'+esc(cfg.specializations[id].name)+'点数<input type="number" min="0" max="3" step="1" data-alloc="'+id+'" value="'+((before.allocations&&before.allocations[id])||0)+'"></label>').join('')+'</div>'
    +'<div class="gear-grid"><label>航行模式<select data-voyage-mode>'+MODES.map(([v,t])=>'<option value="'+v+'" '+(v===(before.voyageMode||'')?'selected':'')+'>'+esc(t)+'</option>').join('')+'</select></label><label>定向货物<select data-focus>'+G.option('','（不指定）',!(before.focus||''))+mats.map(m=>G.option(m.id,m.name,m.id===before.focus)).join('')+'</select></label></div>'
    +'<p class="hint" data-alloc-hint></p><button type="submit">保存玩家成长进度</button><p role="status" data-progress-status></p></form>';
   const pf=box.querySelector('[data-progress]'),allocInputs=()=>Array.from(pf.querySelectorAll('[data-alloc]'));
   const modeStage=(mode)=>{const [spec,key2]=MODE_NEED[mode];const pts=Number(pf.querySelector('[data-alloc="'+spec+'"]').value)||0;const tier=Number(pf.querySelector('[data-path="tiers.'+spec+'"]').value)||0;return {spec,key2,spec2:cfg.specializations[spec],stage:(cfg.specializations[spec].stages[Math.min(pts,tier)]||{})};};
   function syncAlloc(){
    allocInputs().forEach(n=>{const un=pf.querySelector('[data-unlocked="'+n.dataset.alloc+'"]').checked;n.disabled=!un;if(!un)n.value='0';});
    const total=allocInputs().reduce((a,n)=>a+(Number(n.value)||0),0),notes=[];
    MODES.slice(1).forEach(([mode,text])=>{const {key2,spec2,stage}=modeStage(mode);const ok=!!stage[key2];const opt=Array.from(pf.querySelector('[data-voyage-mode]').options).find(o=>o.value===mode);if(opt)opt.disabled=!ok;notes.push(text.replace(/（.*/,'')+'：'+(ok?'可用':'需「'+spec2.name+'」点数与阶段都到 3 阶'));});
    const hint=pf.querySelector('[data-alloc-hint]');if(hint)hint.textContent='已分配 '+total+' / 3 点。'+notes.join('；');
    const sel=pf.querySelector('[data-voyage-mode]');if(sel&&sel.selectedOptions[0]&&sel.selectedOptions[0].disabled)sel.value='';
   }
   pf.addEventListener('input',syncAlloc);pf.addEventListener('change',syncAlloc);syncAlloc();
   pf.onsubmit=async e=>{
    e.preventDefault();
    const after=structuredClone(before);pf.querySelectorAll('[data-path]').forEach(n=>setAt(after,n.dataset.path,Number(n.value)));
    after.unlocked={...before.unlocked};pf.querySelectorAll('[data-unlocked]').forEach(n=>{after.unlocked[n.dataset.unlocked]=n.checked;});
    after.allocations={};let total=0,err='';
    allocInputs().forEach(n=>{const v=Number(n.value)||0;if(!(v>=0&&v<=3))err=err||'单个专精的点数需在 0~3';if(v>0){if(!after.unlocked[n.dataset.alloc])err=err||'「'+cfg.specializations[n.dataset.alloc].name+'」未认证，不能投入点数';after.allocations[n.dataset.alloc]=v;total+=v;}});
    if(total>3)err=err||'专精点数合计不能超过 3 点（当前 '+total+'）';
    const mode=pf.querySelector('[data-voyage-mode]').value;after.voyageMode=mode;
    if(mode){const {key2,spec2,stage}=modeStage(mode);if(!stage[key2])err=err||'航行模式需要「'+spec2.name+'」的点数与阶段都到 3 阶';}
    after.focus=pf.querySelector('[data-focus]').value;
    if(err){pf.querySelector('[data-progress-status]').textContent=err;return;}
    const b=pf.querySelector('[type=submit]');b.disabled=true;
    try{const rr=await api('POST','/api/admin/gear/player',{target:name,before,after,requestKey:key()});pf.querySelector('[data-progress-status]').textContent=rr.ok?'已保存':rr.data?.error||'更新失败';if(rr.ok)Object.assign(before,after);}finally{b.disabled=false;}
   };
  }
  paint();
 }
 window.AdminGear={render};
})();
