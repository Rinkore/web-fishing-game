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
  panel.innerHTML='<h2>✉️ 邮件</h2><p class="hint">管理员通知与物品附件。打开邮件标记为已读，附件需点击领取。</p><div class="ops-row"><button class="btn mini" data-mail-refresh>刷新邮件</button><select class="ipt" data-mail-filter aria-label="筛选邮件">'+[['','全部'],['unread','未读'],['pending','待领取'],['expiring','三天内到期']].map(([v,t])=>'<option value="'+v+'" '+(filter===v?'selected':'')+'>'+t+'</option>').join('')+'</select><button class="btn primary" data-mail-claim-all '+(claimingAll?'disabled':'')+'>'+(claimingAll?'领取中…':'一键领取')+'</button></div><p role="status">'+esc(notice)+'</p>'+
   (!data?'<p class="ld-state">加载中…</p>':'<p>未读 '+data.unread+' · 待领取 '+data.pending+' · 共 '+data.total+' 封</p>'+(!data.messages.length?'<p class="hint">暂时没有邮件。</p>':data.messages.map(m=>'<details class="mail-card" data-mail="'+esc(m.id)+'" '+(opened.has(m.id)?'open':'')+'><summary>'+(m.read?'':'<span class="mail-dot" aria-label="未读"></span>')+'<b>'+esc(m.subject)+'</b> <span class="hint">'+esc(m.sender)+' · '+new Date(m.createdAt).toLocaleString('zh-CN')+'</span></summary><p class="hint">'+(m.revoked?'附件已撤回':m.expired?'附件已过期':m.expiresAt?'领取截止：'+new Date(m.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）':'永久有效')+'</p><p class="mail-body">'+esc(m.body)+'</p><ul>'+m.attachments.map(a=>'<li>'+(a.itemId==='__coins__'?'金币 ×'+a.quantity:esc(a.name||GameData.itemName(a.itemId))+' ×'+a.quantity+(a.tier==='large'?'（大型）':a.tier==='giant'?'（巨型）':''))+(a.rewardBound?'<span class="reward-bound">奖励绑定 · 不可出售 / 交易 · 直接产物'+(a.bindOutputs?'绑定':'不绑定')+'</span>':'')+(a.itemId.includes('#')?'<br><small>'+esc(a.itemId)+'</small>':'')+(a.description?'<p class="hint">'+esc(a.description)+'</p>':'')+'</li>').join('')+'</ul>'+(m.attachments.length?'<button class="btn primary" data-mail-claim="'+esc(m.id)+'" '+(m.claimed||m.revoked||m.expired||claimingAll||pending.has(m.id)?'disabled':'')+'>'+(m.claimed?'已领取附件':m.revoked?'附件已撤回':m.expired?'附件已过期':pending.has(m.id)?'处理中…':'领取全部附件')+'</button>':'<p class="hint">无附件</p>')+'</details>').join(''))+'<div class="mail-pages"><button class="btn mini" data-mail-page="-1" '+(page<=1?'disabled':'')+'>上一页</button><span>第 '+page+' 页</span><button class="btn mini" data-mail-page="1" '+(page*30>=data.total?'disabled':'')+'>下一页</button></div>');
   (!data?'<p class="ld-state">加载中…</p>':'<p>未读 '+data.unread+' · 待领取 '+data.pending+' · 共 '+data.total+' 封</p>'+(!data.messages.length?'<p class="hint">暂时没有邮件。</p>':data.messages.map(m=>'<details class="mail-card" data-mail="'+esc(m.id)+'" '+(opened.has(m.id)?'open':'')+'><summary>'+(m.read?'':'<span class="mail-dot" aria-label="未读"></span>')+'<b>'+esc(m.subject)+'</b> <span class="hint">'+esc(m.sender)+' · '+new Date(m.createdAt).toLocaleString('zh-CN')+'</span></summary><p class="hint">'+(m.revoked?'附件已撤回':m.expired?'附件已过期':m.expiresAt?'领取截止：'+new Date(m.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）':'永久有效')+'</p><p class="mail-body">'+esc(m.body)+'</p><ul>'+m.attachments.map(a=>'<li>'+(a.itemId==='__coins__'?'金币 ×'+a.quantity:esc(a.name||GameData.itemName(a.itemId))+' ×'+a.quantity+(a.tier==='large'?'（大型）':a.tier==='giant'?'（巨型）':''))+(a.rewardBound?'<span class="reward-bound">奖励绑定 · 不可出售 / 交易 · 直接产物'+(a.bindOutputs?'绑定':'不绑定')+'</span>':'')+(a.itemId.includes('#')?'<br><small>'+esc(a.itemId)+'</small>':'')+(a.description?'<p class="hint">'+esc(a.description)+'</p>':'')+'</li>').join('')+'</ul>'+(m.attachments.length?'<button class="btn primary" data-mail-claim="'+esc(m.id)+'" '+(m.claimed||m.revoked||m.expired||claimingAll||pending.has(m.id)?'disabled':'')+'>'+(m.claimed?'已领取附件':m.revoked?'附件已撤回':m.expired?'附件已过期':pending.has(m.id)?'处理中…':'领取全部附件')+'</button>':'<p class="hint">无附件</p>')+'</details>').join(''))+'<div class="mail-pages"><button class="btn mini" data-mail-page="-1" '+(page<=1?'disabled':'')+'>上一页</button><span>第 '+page+' 页</span><button class="btn mini" data-mail-page="1" '+(page*30>=data.total?'disabled':'')+'>下一页</button></div>');
  panel.querySelector('[data-mail-refresh]').onclick=()=>refresh(false);
  panel.querySelector('[data-mail-filter]').onchange=e=>{filter=e.target.value;page=1;refresh(false);};
  panel.querySelector('[data-mail-claim-all]').onclick=claimAll;
  panel.querySelectorAll('[data-mail-page]').forEach(b=>b.onclick=()=>{if(loading)return;page+=Number(b.dataset.mailPage);refresh(false);});
  panel.querySelectorAll('details[data-mail]').forEach(d=>d.addEventListener('toggle',()=>{const m=data.messages.find(x=>x.id===d.dataset.mail);if(d.open&&!m.read&&!pending.has(m.id))change(m,false);}));
  panel.querySelectorAll('[data-mail-claim]').forEach(b=>b.onclick=()=>change(data.messages.find(x=>x.id===b.dataset.mailClaim),true));
 }
 window.MailUI={render,refresh,reset,stop:function(){reset();stopped=true;}};
})();
