(function () {
  'use strict';
  const D = window.GameData;
  const escape = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const errors = {
    expedition_active:'已有航次正在航行或等待领取，请先领取返航奖励。', expedition_not_ready:'尚未到返航时间，请稍后领取。',
    expedition_claimed:'该航次已经领取，正在刷新状态。', ship_level_insufficient:'船级不足，请先升级船只。',
    insufficient_items:'深海鳞片不足，请到远洋钓鱼或完成悬赏获取。', marks_insufficient:'远航印记不足。',
    starter_unavailable:'自选资格尚未获得或已经使用。', feature_disabled:'远航暂时关闭，已完成的航次仍可领取。',
    apex_required:'请先装配完整的猎王追踪套。', set_mismatch:'两件套装核心必须属于同一套，请先卸下另一套核心。',
  };
  let busy = false, pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('fishing-expedition-pending') || 'null'); } catch (_) {}
  function rewardText(r) {
    if (!r) return '';
    return [r.coins + ' 金币',r.xp + ' 船经验',r.marks + ' 印记'].concat(Object.entries(r.items || {}).map(([id,n]) => D.itemName(id)+' ×'+n),r.heat ? ['精工热量 +'+r.heat] : [],r.clues ? ['遗物线索 +'+r.clues] : []).join(' · ');
  }
  async function action(host, type, body) {
    if (busy) return;
    busy = true;
    const signature = JSON.stringify({type,body});
    if (!pending || pending.signature !== signature) pending = {signature,key:'exp-'+(window.crypto.randomUUID ? crypto.randomUUID() : Date.now()+'-'+Math.random().toString(36).slice(2))};
    try { sessionStorage.setItem('fishing-expedition-pending',JSON.stringify(pending)); } catch (_) {}
    host.querySelectorAll('button').forEach(b=>b.disabled=true);
    const message = host.querySelector('[data-exp-message]');
    try {
      const r = await window.Net.seaExpedition(type,Object.assign({requestKey:pending.key},body));
      if (r && r.ok && r.data && r.data.sea) {
        pending=null;try{sessionStorage.removeItem('fishing-expedition-pending');}catch(_){}
        host._onChange(r.data.sea,type==='claim'?'远航奖励已入账':type==='redeem'?'套装核心已放入背包':type==='target'?'追踪目标已保存':'已启航，离线期间照常航行');
      } else {
        if (r && r.status>=400 && r.status<500) {pending=null;try{sessionStorage.removeItem('fishing-expedition-pending');}catch(_){}}
        const code=r&&r.data&&r.data.error;
        message.textContent=errors[code]||code||'连接未完成，请重试；同一操作不会重复扣除资源。';
      }
    } catch (_) { message.textContent='连接未完成，请重试；同一操作不会重复扣除资源。'; }
    finally {busy=false;host._signature='';update(host,host._sea,host._onChange);}
  }
  function update(host,sea,onChange) {
    if (!host || !sea || !sea.expedition) return;
    host._onChange=onChange;host._sea=sea;
    const v=sea.expedition, cap=v.captain, current=v.active, lv=sea.ship.lv;
    if(!v.config || !Array.isArray(v.config.routes) || !v.config.routes.length){host.innerHTML='<h3>🧭 远航派遣</h3><p class="hint">当前游戏规则尚未启用远航，请等待管理员完成规则更新。</p>';host._signature='';return;}
    const sig=JSON.stringify([lv,cap,current&&[current.id,current.ready],v.last&&v.last.id,v.gear,v.config,v.sets]);
    if (host._signature!==sig) {
      const oldMessage=host.querySelector('[data-exp-message]');const message=oldMessage?oldMessage.textContent:'';
      const oldHours=host.querySelector('[data-exp-hours]');const hours=oldHours?Number(oldHours.value):8;
      host._signature=sig;
      const set=v.sets.find(x=>x.id===v.gear.set);
      host.innerHTML='<h3>🧭 远航派遣</h3><p class="hint">在线钓鱼与离线远航共同推动船成长。一次只能派遣一航次，返航后领取金币、材料与经验。</p>'+
        '<div class="exp-metrics"><b>远航印记 '+cap.marks+'</b><span>精工热量 '+cap.heat+'/30</span><span>遗物线索 '+cap.clues+'/6</span><span>研究样本 '+cap.samples+'/30</span></div>'+
        '<p class="hint">当前钓竿：'+escape(set?set.name+'（两件套已激活）':'尚未激活两件套')+' · 稳定 '+Number(v.gear.effects.stability||0)+' · 共鸣 '+Number(v.gear.effects.resonance||0)+' · 结算 '+Number(v.gear.effects.settle||0)+'</p>'+
        (v.gear.set==='apex'?'<label>猎王目标 <select data-exp-target aria-label="猎王目标鱼种">'+D.allItems().filter(x=>x.kind==='fish').map(f=>'<option value="'+escape(f.id)+'" '+(cap.target===f.id?'selected':'')+'>'+escape(f.name)+'</option>').join('')+'</select></label> <button class="btn mini" data-exp-target-save>保存追踪目标</button><p class="hint">当前目标：'+escape(cap.target?D.itemName(cap.target):'尚未选择')+' · 追踪 '+cap.tracking+'/3 层；更换目标会清空层数，仅在该鱼出现的钓点生效。</p>':'')+
        '<p class="hint">出发时固定船级、词条和套装效果，途中换装不会改变本航次。前 3 次沿岸贸易免门票；其余每趟消耗 '+v.config.ticket+' 片深海鳞片（持有 '+sea.deepscale+'）。</p>'+
        '<div class="exp-rail" aria-label="船级航线推进">'+D.SHIP.levels.map((s,i)=>'<span class="'+(i+1<=lv?'unlocked':'')+'">Lv'+(i+1)+' '+escape(s.name)+'</span>').join('')+'</div>'+
        (current?'<div class="exp-active"><b>'+escape((v.config.routes.find(r=>r.id===current.route)||{}).name||current.route)+' · '+current.hours+' 小时</b><p data-exp-countdown></p><p class="hint">出发船级 Lv'+current.snapshot.level+' · 成功率 '+current.snapshot.success.toFixed(1)+'% · 套装 '+escape((v.sets.find(s=>s.id===current.snapshot.set)||{}).name||'无')+'</p>'+(current.ready?'<p>'+escape(current.reward.event)+'</p><p>'+escape(rewardText(current.reward))+'</p><button class="btn primary" data-exp-claim>领取返航奖励</button>':'<p class="hint">航行中，可关闭页面。到时返航，不会自动开启下一趟。</p>')+'</div>':'<label>远航时长 <select data-exp-hours aria-label="远航时长">'+v.config.hours.map(n=>'<option value="'+n+'" '+(n===hours?'selected':'')+'>'+n+' 小时 · 成功 '+({2:1,8:5,12:8}[n])+' 印记</option>').join('')+'</select></label>')+
        '<div class="exp-routes">'+v.config.routes.map(r=>{
          const unlocked=lv>=r.level;
          const bonus=25*Math.max(0,v.gear.effects.stability||0)/(50+Math.max(0,v.gear.effects.stability||0))+(v.gear.set==='storm'?10:0);
          return '<article class="exp-route '+(unlocked?'':'locked')+'"><h4>'+escape(r.name)+' <small>Lv'+r.level+'</small></h4><p>'+escape(r.description)+'</p><p class="hint">'+(r.success===100?'稳定':r.success>=90?'低风险':r.success>=80?'中风险':'高风险')+' · 当前成功率 '+Math.min(100,r.success+bonus).toFixed(1)+'%</p><p class="hint">'+v.config.catalysts.filter(c=>c.route===r.id).map(c=>escape(c.name)+(c.minHours>2?'（'+v.config.hours.filter(h=>h>=c.minHours).join('/')+' 小时）':'')).join(' / ')+'</p><button class="btn primary" data-exp-start="'+r.id+'" '+(!unlocked||current?'disabled':'')+'>'+(unlocked?'选择此航线启航':'船级不足')+'</button></article>';
        }).join('')+'</div><p class="hint">成功奖励基础印记；各航线 8 / 12 小时首次成功另奖 10 / 15 印记（账号首次成功改送自选资格）。失败保留部分收获，无印记。催化剂用于工坊定向改造，可玩家交易，不可卖给系统。</p>'+
        (v.last?'<details><summary>上次返航记录</summary><p>'+escape(v.last.reward.event)+'</p><p>'+escape(rewardText(v.last.reward))+'</p></details>':'')+
        '<h3>⚙ 套装核心兑换</h3><p class="hint">竿身 + 饰品装同一套激活效果，五个普通位置负责词条。套装核心固定属性、可交易、不可改造。首次成功的自选资格可以保留。</p>'+
        (cap.starter===1?'<p class="exp-choice">🎁 你有一次整套自选资格，选择已解锁套装后再确认。</p>':'')+
        '<div class="exp-sets">'+v.sets.map(s=>'<article class="exp-route"><h4>'+escape(s.name)+' <small>Lv'+s.level+(s.pending?' · 企划中':'')+'</small></h4><p>'+escape(s.effect)+'</p><p class="hint">'+s.pieces.map(p=>escape(p.name)+'：'+escape(D.AFFIX_LABEL[p.type])+' +'+p.value).join(' / ')+'</p>'+(!s.pending?'<div class="exp-actions">'+(cap.starter===1?'<button class="btn primary" data-exp-choice="'+s.id+'" '+(lv<s.level?'disabled':'')+'>自选整套</button>':'')+s.pieces.map(p=>'<button class="btn mini" data-exp-redeem="'+s.id+'" data-part="'+p.part+'" '+(lv<s.level||cap.marks<s.cost?'disabled':'')+'>'+escape(p.part==='rod'?'竿身':'饰品')+' · '+s.cost+' 印记</button>').join('')+'</div>':'')+'</article>').join('')+'</div><p role="status" class="hint" data-exp-message>'+escape(message)+'</p>';
      host.querySelectorAll('[data-exp-start]').forEach(b=>b.onclick=async()=>{
        if (busy || host._confirming) return;
        const route=v.config.routes.find(r=>r.id===b.dataset.expStart);
        const hours=Number(host.querySelector('[data-exp-hours]').value);
        const cost=route.id==='trade' && Number(v.freeTrades)>0 ? 0 : v.config.ticket;
        host._confirming=true;
        try {
          const ok=await window.UI.confirmModal({title:'确认启航',okText:'确认启航',html:
            '<b>'+escape(route.name)+'</b><p>航行时长：'+hours+' 小时</p><p>门票：'+(cost===0?'本次免费':cost+' 片深海鳞片')+'</p><p>当前船级 Lv'+lv+'。出发后锁定本次船级、词条和套装效果；离线期间照常航行，返航后需领取奖励。</p>'});
          if(ok && host.isConnected && !host._sea.expedition.active) await action(host,'start',{route:route.id,hours:hours});
        } finally {host._confirming=false;}
      });
      const targetSave=host.querySelector('[data-exp-target-save]');if(targetSave)targetSave.onclick=()=>action(host,'target',{target:host.querySelector('[data-exp-target]').value});
      const claim=host.querySelector('[data-exp-claim]');if(claim)claim.onclick=()=>action(host,'claim',{id:current.id});
      host.querySelectorAll('[data-exp-choice]').forEach(b=>b.onclick=()=>{
        const s=v.sets.find(x=>x.id===b.dataset.expChoice);
        const ask = window.UI && window.UI.confirmModal
          ? window.UI.confirmModal({title:'确认套装选择',html:'确认选择「'+escape(s.name)+'」整套？<br>'+escape(s.effect)+'<br>将获得竿身和饰品各一件，并使用账号唯一的整套自选资格。',okText:'确认选择'})
          : Promise.resolve(false);
        ask.then(function(ok){if(ok)action(host,'redeem',{set:s.id,part:'',starter:true});});
      });
      host.querySelectorAll('[data-exp-redeem]').forEach(b=>b.onclick=()=>action(host,'redeem',{set:b.dataset.expRedeem,part:b.dataset.part,starter:false}));
    }
    if(current){const p=host.querySelector('[data-exp-countdown]');if(p)p.textContent=current.ready?'已返航，等待领取':'预计返航：'+new Date(current.endsAt).toLocaleString('zh-CN')+'（服务端计时）';}
  }
  window.ExpeditionUI={update};
})();
