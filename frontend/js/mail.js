(function(){
 'use strict';
 const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let filter='',claimingAll=false;
 let owner='',page=1,data=null,loading=false,epoch=0,notice='',pending=new Set(),stopped=false;
 function reset(){stopped=false;owner=String((Engine.state.me||{}).id||'');filter='';claimingAll=false;page=1;data=null;loading=false;epoch++;pending.clear();Engine.state.mailUnread=0;Engine.state.mailPending=0;notice='';}
 function currentOwner(){return String((Engine.state.me||{}).id||'');}
 async function refresh(summary){
  if(stopped||!currentOwner())return;if(owner!==currentOwner())reset();if(loading)return;
  loading=true;const run=epoch;
  try{const r=await Net.mailGet(page,summary,filter);if(run!==epoch||owner!==currentOwner())return;
   if(r&&r.ok){Engine.state.mailUnread=r.data.unread;Engine.state.mailPending=r.data.pending;UI.renderNav();
    if(!summary){data=r.data;notice='';if(UI.getView()==='mail')render(document.getElementById('main'));}
   }else if(!summary){notice=(r&&r.data&&r.data.error)||'邮件加载失败，请重试';if(UI.getView()==='mail')render(document.getElementById('main'));}
  }catch(_){if(run===epoch&&!summary){notice='邮件加载失败，请点击刷新重试';if(UI.getView()==='mail')render(document.getElementById('main'));}}finally{if(run===epoch)loading=false;}
 }
 async function change(m,claim){
  if(pending.has(m.id))return;pending.add(m.id);render(document.getElementById('main'));
  const run=epoch;
  try{const r=await Net.mailChange(claim?'claim':'read',{id:m.id,requestKey:'mail-'+(claim?'claim-':'read-')+m.id});
   if(run!==epoch||owner!==currentOwner())return;
   if(r&&r.ok){if(claim){UI.toast('附件已放入背包');await UI.resyncAssets();}await refresh(false);}
   else UI.toast((r&&r.data&&r.data.error)||'操作未完成，请重试；附件不会重复发放');
  }catch(_){if(run===epoch)UI.toast('连接中断，请重试；附件不会重复发放');}finally{pending.delete(m.id);if(run===epoch&&UI.getView()==='mail')render(document.getElementById('main'));}
 }
 async function claimAll(){
  if(claimingAll)return;claimingAll=true;render(document.getElementById('main'));
  const run=epoch,key='mail-all-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2));let cursor='0',claimed=0,failed=0;
  try{let more=true;while(more&&run===epoch&&owner===currentOwner()){
   const r=await Net.mailChange('claim',{id:'all',afterId:cursor,requestKey:key});
   if(run!==epoch||owner!==currentOwner())return;
   if(!r||!r.ok)throw new Error((r&&r.data&&r.data.error)||'领取中断，可重试；已领取奖励不会重复到账');
   claimed+=r.data.claimed;failed+=r.data.failed.length;more=r.data.more;cursor=r.data.afterId;
  }
  if(run===epoch){await UI.resyncAssets();await refresh(false);notice='已领取 '+claimed+' 封'+(failed?'，'+failed+' 封未完成，可单独重试。':'。');}
  }catch(e){if(run===epoch)notice=e.message;}finally{if(run===epoch){claimingAll=false;if(UI.getView()==='mail')render(document.getElementById('main'));}}
 }
 function render(main){
  let panel=main.querySelector('.mail-panel');if(!panel){main.innerHTML='';panel=document.createElement('section');panel.className='panel wide mail-panel';main.appendChild(panel);}
  const sig=JSON.stringify([data,notice,filter,claimingAll,Array.from(pending)]);if(panel._sig===sig)return;panel._sig=sig;
  const opened=new Set(Array.from(panel.querySelectorAll('details[open]')).map(n=>n.dataset.mail));
  // 设计稿 v2 · 邮筒（a-room-mail.png）：工具栏（未读 / 待领取 / 共 n 封 + 筛选 + 刷新 + 一键领取）
  // → 信封列表（信封 + 蜡封 + 标题 + 发件人·时间 + 附件 chip）→ 展开即 .letter 正文与「领取附件」。
  // 信封仍用 <details>/<summary>：展开即已读、纯文本转义、data-mail* 契约与旧口径完全一致。
  const RU=window.RoomUI;
  const whenTxt=m=>new Date(m.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
  const stateTxt=m=>m.revoked?'附件已撤回':m.expired?'附件已过期':m.expiresAt?'领取截止：'+new Date(m.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）':'永久有效';
  const claimLabel=m=>m.claimed?'已领取附件':m.revoked?'附件已撤回':m.expired?'附件已过期':pending.has(m.id)?'处理中…':'领取全部附件';
  const chipOf=a=>a.itemId==='coins'
    ?(RU?RU.coinChip(a.quantity):'<span class="chip">💰 '+a.quantity+'</span>')
    :(RU?RU.chip(a.itemId,a.quantity):'<span class="chip">'+esc(a.name||GameData.itemName(a.itemId))+' ×'+a.quantity+'</span>');
  const attLine=a=>'<div class="att-line"><span class="att-name">'+esc(a.name||GameData.itemName(a.itemId))+' ×'+a.quantity+
    (a.tier==='large'?'（大型）':a.tier==='giant'?'（巨型）':'')+'</span>'+
    (a.rewardBound?'<span class="reward-bound">奖励绑定 · 不可出售 / 交易 · 直接产物'+(a.bindOutputs?'绑定':'不绑定')+'</span>':'')+
    (a.itemId.includes('#')?'<small>'+esc(a.itemId)+'</small>':'')+
    (a.description?'<p class="hint">'+esc(a.description)+'</p>':'')+'</div>';
  panel.innerHTML=
   '<div class="toolbar mail-tool"><span class="mail-stat">未读 <b>'+(!data?'—':data.unread)+'</b> · 待领取 <b>'+(!data?'—':data.pending)+'</b> · 共 <b>'+(!data?'—':data.total)+'</b> 封</span><span class="mail-spacer"></span>'+
    '<select class="ipt" data-mail-filter aria-label="筛选邮件">'+[['','全部'],['unread','未读'],['pending','待领取'],['expiring','三天内到期']].map(([v,t])=>'<option value="'+v+'" '+(filter===v?'selected':'')+'>'+t+'</option>').join('')+'</select>'+
    '<button class="mini" data-mail-refresh>刷新邮件</button>'+
    '<button class="mini gold" data-mail-claim-all '+(claimingAll?'disabled':'')+'>'+(claimingAll?'领取中…':'一键领取')+'</button></div>'+
   '<p class="hint" role="status">'+esc(notice)+'</p>'+
   (!data?'<p class="ld-state">邮件加载中…</p>'
    :(!data.messages.length?'<p class="hint">暂时没有邮件。</p>'
     :'<div class="envs">'+data.messages.map(m=>'<details class="mail-card env'+(m.read?' read':' unread')+(m.claimed?' claimed':'')+'" data-mail="'+esc(m.id)+'" '+(opened.has(m.id)?'open':'')+'>'+
        '<summary><span class="ev" aria-hidden="true"></span>'+
        '<span class="env-main">'+(m.read?'':'<span class="dot" aria-label="未读"></span>')+'<b>'+esc(m.subject)+'</b><small>'+esc(m.sender)+' · '+esc(whenTxt(m))+'</small></span>'+
        '<span class="env-atts">'+m.attachments.map(chipOf).join('')+'</span></summary>'+
        '<div class="letter"><p class="hint">'+esc(stateTxt(m))+'</p><p class="mail-body">'+esc(m.body)+'</p>'+
        (m.attachments.length?'<div class="letter-atts">'+m.attachments.map(attLine).join('')+'</div>':'<p class="hint">无附件</p>')+
        (m.attachments.length?'<div class="row"><button class="mini gold" data-mail-claim="'+esc(m.id)+'" '+(m.claimed||m.revoked||m.expired||claimingAll||pending.has(m.id)?'disabled':'')+'>'+esc(claimLabel(m))+'</button></div>':'')+
        '</div></details>').join('')+'</div>'+
      '<div class="mail-pages"><button class="mini" data-mail-page="-1" '+(page<=1?'disabled':'')+'>上一页</button><span>第 '+page+' 页</span><button class="mini" data-mail-page="1" '+(page*30>=data.total?'disabled':'')+'>下一页</button></div>'));
  const q=s=>panel.querySelector(s);
  const rf=q('[data-mail-refresh]');if(rf)rf.onclick=()=>refresh(false);
  const fl=q('[data-mail-filter]');if(fl)fl.onchange=e=>{filter=e.target.value;page=1;refresh(false);};
  const ca=q('[data-mail-claim-all]');if(ca)ca.onclick=claimAll;
  panel.querySelectorAll('[data-mail-page]').forEach(b=>b.onclick=()=>{if(loading)return;page+=Number(b.dataset.mailPage);refresh(false);});
  panel.querySelectorAll('details[data-mail]').forEach(d=>d.addEventListener('toggle',()=>{const m=data.messages.find(x=>x.id===d.dataset.mail);if(d.open&&m&&!m.read&&!pending.has(m.id))change(m,false);}));
  panel.querySelectorAll('[data-mail-claim]').forEach(b=>b.onclick=()=>change(data.messages.find(x=>x.id===b.dataset.mailClaim),true));
 }
 window.MailUI={render,refresh,reset,stop:function(){reset();stopped=true;}};
})();
