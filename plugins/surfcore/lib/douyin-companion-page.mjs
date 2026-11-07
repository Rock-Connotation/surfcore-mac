// Private role appearance is loaded through the same-origin, epoch-stamped portrait endpoint.
export const douyinCompanionPage = String.raw`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小白鲸的发现日记</title>
<style>
:root{color-scheme:light dark;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;--sea:light-dark(#245e73,#a0d6e7);--line:light-dark(#d3e3e8,#34484f);--muted:light-dark(#526d76,#a6bac2)}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding:20px;color:CanvasText;background:Canvas}header{display:flex;align-items:center;gap:24px;padding-bottom:16px;border-bottom:1px solid var(--line)}
h2{font:600 25px/1.4 "Songti SC","Noto Serif CJK SC",serif;margin:2px 0;color:var(--sea)}p{margin:6px 0}small,.muted{color:var(--muted)}
.portrait-card{width:220px;max-width:42%;flex:none;text-align:center}.portrait{display:block;width:100%;height:auto;aspect-ratio:auto 1;max-height:260px;object-fit:contain;object-position:center;border-radius:10px;background:light-dark(#edf7fa,#182e38);animation:portrait-idle 6s ease-in-out infinite}.portrait-status{min-height:2.2em;margin:4px 0;font-size:12px;color:var(--muted)}
body[data-state="running"] .portrait{animation-name:portrait-thinking;animation-duration:3.4s}body[data-state="completed"] .portrait{animation-name:portrait-happy;animation-duration:2.8s}body[data-state="paused"] .portrait{animation:none;opacity:.88;filter:saturate(.82)}
@keyframes portrait-idle{50%{transform:translateY(-2px)}}@keyframes portrait-thinking{50%{transform:translateY(-3px) scale(1.006)}}@keyframes portrait-happy{25%{transform:translateY(-3px) scale(1.01)}75%{transform:translateY(1px)}}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:Canvas;color:CanvasText;border-radius:7px;padding:7px 12px}button:hover{border-color:var(--sea)}button:disabled{opacity:.5;cursor:default}.primary{background:var(--sea);color:light-dark(white,#12242c);border-color:var(--sea)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.error{color:light-dark(#a72e26,#ffb6ae);white-space:pre-wrap}.ledger{display:flex;gap:24px;flex-wrap:wrap;margin:12px 0}.ledger strong{color:var(--sea)}.entry{padding:16px 0;border-top:1px solid var(--line)}.entry h3{font-size:16px;margin:0 0 6px}.entry a{color:var(--sea)}.draft{border-left:3px solid var(--line);padding-left:12px;white-space:pre-wrap}.pill{font-size:12px;letter-spacing:.04em;color:var(--sea)}details{margin-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font-size:12px}
.conversation{margin:24px 0;padding:16px;border:1px solid var(--line);border-radius:10px;max-width:760px}.conversation-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.conversation-head h2{font-size:20px}.opening-card,.message{margin:10px 0;padding:12px;border:1px solid var(--line);border-radius:8px;background:light-dark(#f5fafb,#162b34)}.opening-card h3{font-size:15px;margin:0 0 4px}.opening-text,.message-text{white-space:pre-wrap;overflow-wrap:anywhere}.opening-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.conversation-messages{list-style:none;margin:10px 0;padding:0;max-height:270px;overflow:auto}.message[data-role="user"]{margin-left:8%;background:light-dark(#edf7fa,#1c3540)}.message[data-role="assistant"]{margin-right:8%}.message-author{font-size:12px;color:var(--muted)}.conversation-form{margin-top:12px}.conversation-form label{display:block;margin-bottom:5px}.conversation-form textarea{display:block;width:100%;min-height:84px;resize:vertical;padding:9px;border:1px solid var(--line);border-radius:7px;color:CanvasText;background:Canvas;font:inherit}.conversation-form textarea:focus-visible,.conversation button:focus-visible{outline:2px solid var(--sea);outline-offset:2px}.conversation-form textarea:disabled{opacity:.65}.conversation-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}.conversation-actions>div{display:flex;gap:8px;flex-wrap:wrap}.conversation-empty{padding:12px;border:1px dashed var(--line);border-radius:8px;color:var(--muted)}
@media(max-width:440px){body{padding:12px}header{gap:12px}.portrait-card{width:120px}.portrait{max-height:180px}h2{font-size:21px}}
@media(prefers-reduced-motion:reduce){.portrait{animation:none!important}}
</style><body data-state="idle">
<header>
<div class="portrait-card"><img id="portrait" class="portrait" alt="少女鲸鱼娘立绘" hidden><p id="portrait-status" class="portrait-status" role="status" aria-live="polite">正在读取本机伙伴立绘…</p></div>
<div><span class="pill">发现 · 感受 · 记住</span><h2 id="title">小白鲸的发现日记</h2><p id="mood">今天也想看看，有什么值得记住的小事。</p><small id="role">正在核对角色…</small></div></header>
<p class="muted">每轮最多 2 条短视频，结合音轨、稀疏画面和文案。这里只留下日记与待审草稿。</p>
<div class="ledger"><span>升级验收 <strong id="acceptance">— / 12</strong></span><span>今日活动 <strong id="daily">— / 2 轮</strong></span><span>今日请求 <strong id="calls">— / 8</strong></span></div>
<div class="actions"><button id="start" class="primary" disabled>一起发现一轮</button><button id="cancel" disabled>停下休息</button><button id="enable" disabled>启用每天两轮</button><button id="pause">暂停日常活动</button><button id="refresh">刷新</button></div>
<p class="muted">每天 12:30、20:30（上海时间），只在 DSH 运行时活动；错过不补跑。首次手动验收通过后才能开启。</p>
<p id="notice" role="status" aria-live="polite">正在读取状态…</p><p id="error" class="error" role="alert"></p>
<section id="diary" aria-label="观看日记"></section>
<section id="conversation" class="conversation" aria-label="看完后的聊天">
<div class="conversation-head"><div><span class="pill">看完后 · 留在本机</span><h2 id="conversation-title">和小白鲸聊聊</h2><p class="muted">只围绕刚刚的新发现说一句，不会替你向平台发送消息。</p></div></div>
<p id="conversation-status" role="status" aria-live="polite">正在读取新的小发现…</p>
<p id="sharing-error" class="error" role="alert" aria-live="polite" hidden></p>
<div id="conversation-openings" aria-label="新的观看分享"></div>
<ol id="conversation-message-list" class="conversation-messages" aria-label="聊天记录" aria-live="polite"></ol>
<form id="conversation-form" class="conversation-form">
<label for="conversation-input">给伙伴回一句</label><textarea id="conversation-input" maxlength="1000" rows="3" aria-describedby="conversation-limit" disabled></textarea>
<div class="conversation-actions"><small id="conversation-limit" class="muted">最多 1000 字；发送前会显示错误，失败不会自动重发。</small><div><button id="conversation-cancel" type="button" hidden disabled>取消回复</button><button id="conversation-send" class="primary" type="submit" disabled>发送回复</button></div></div>
</form>
</section>
<details><summary>活动与额度详情</summary><pre id="details"></pre></details>
<script>
const endpoint='/dsh-surfcore/api/douyin/companion',portraitEndpoint='/dsh-surfcore/api/douyin/companion-portrait',sharingEndpoint='/dsh-surfcore/api/douyin/companion-sharing',$=id=>document.getElementById(id);
let context=null,stamp='',portraitStamp='',portraitRequest=0,portraitObjectUrl='',portraitController=null,portraitTimer=null,busy=false,refreshing=false,portraitRetryPending=false,seq=0,active=false,actionFailure=null,retired=false;
let sharingSeq=0,sharingPollTimer=null,sharingRefreshing=false,sharingReadController=null,sharingValue=null,sharingStamp='',sharingPending=null,sharingCancelBusy=false,sharingControllers=new Set(),sharingAcking=new Set(),sharingActionFailure=null,preserveSharingErrorOnRoleChange=false,sharingRoleRefreshPending=false,selectedOpeningId='',startReady=false;
const sayError=e=>{$('error').textContent=[e.code,e.error||e.message,e.hint].filter(Boolean).join(' · ')};
async function request(body){const response=await fetch(endpoint,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,...context})}:{});const data=await response.json();if(!response.ok||data.ok===false)throw data;return data}
function text(tag,value,cls){const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el}
function clearPortrait(message){portraitRequest++;if(portraitController){portraitController.abort();portraitController=null}if(portraitTimer){clearTimeout(portraitTimer);portraitTimer=null}if(portraitObjectUrl){URL.revokeObjectURL(portraitObjectUrl);portraitObjectUrl=''}$('portrait').removeAttribute('src');$('portrait').hidden=true;$('portrait-status').textContent=message}
async function loadPortrait(expectedContext,expectedStamp){
 if(retired)return;
 if(portraitController){portraitController.abort();portraitController=null}if(portraitTimer){clearTimeout(portraitTimer);portraitTimer=null}
 const token=++portraitRequest,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000),url=portraitEndpoint+'?characterId='+encodeURIComponent(expectedContext.characterId)+'&characterEpoch='+encodeURIComponent(String(expectedContext.characterEpoch));portraitController=controller;portraitTimer=timer;
 $('portrait-status').textContent='正在读取本机伙伴立绘…';
 try{
  const response=await fetch(url,{cache:'no-store',headers:{accept:'image/webp, application/json'},signal:controller.signal});if(retired||token!==portraitRequest||stamp!==expectedStamp)return;
  if(!response.ok){let failure;try{failure=await response.json()}catch{}if(retired||token!==portraitRequest||stamp!==expectedStamp)return;throw failure||{code:'COMPANION_PORTRAIT_LOAD_FAILED',error:'本机立绘读取失败。',hint:'点刷新重试。'}}
  const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();if(type!=='image/webp')throw{code:'COMPANION_PORTRAIT_INVALID',error:'立绘接口没有返回 WebP 图片。',hint:'检查本机立绘文件后点刷新。'};
  const blob=await response.blob();if(retired||token!==portraitRequest||stamp!==expectedStamp)return;if(!blob.size)throw{code:'COMPANION_PORTRAIT_INVALID',error:'本机立绘文件为空。',hint:'提供有效 WebP 立绘后点刷新。'};
  if(portraitObjectUrl)URL.revokeObjectURL(portraitObjectUrl);portraitObjectUrl=URL.createObjectURL(blob);const image=$('portrait');image.onload=()=>{if(!retired&&token===portraitRequest&&stamp===expectedStamp)$('portrait-status').textContent='当前角色的本机立绘'};image.onerror=()=>{if(!retired&&token===portraitRequest&&stamp===expectedStamp){image.removeAttribute('src');image.hidden=true;$('portrait-status').textContent='立绘解码失败 · COMPANION_PORTRAIT_INVALID · 浏览器无法显示这张 WebP。 · 检查文件后点“刷新”重试。'}};image.src=portraitObjectUrl;image.hidden=false;
 }catch(e){if(retired||token!==portraitRequest||stamp!==expectedStamp)return;if(portraitObjectUrl){URL.revokeObjectURL(portraitObjectUrl);portraitObjectUrl=''}$('portrait').removeAttribute('src');$('portrait').hidden=true;const failure=controller.signal.aborted?{code:'COMPANION_PORTRAIT_TIMEOUT',error:'读取本机立绘超过 5 秒，已停止等待。',hint:'点“刷新”重试；若持续失败，请重新配置当前角色的本机立绘。'}:e;$('portrait-status').textContent='立绘读取失败 · '+[failure.code||'COMPANION_PORTRAIT_LOAD_FAILED',failure.error||'本机立绘暂时无法显示。',failure.hint||'点“刷新”重试。'].filter(Boolean).join(' · ')}
 finally{clearTimeout(timer);if(portraitController===controller)portraitController=null;if(portraitTimer===timer)portraitTimer=null}
}
function sharingText(tag,value,cls){const el=document.createElement(tag);el.textContent=value==null?'':String(value);if(cls)el.className=cls;return el}
function sharingError(error){const e=error||{};return{code:e.code||'SHARING_REQUEST_FAILED',error:e.error||e.message||'本机伙伴对话请求失败。',hint:e.hint||'检查状态后再手动重试；系统不会自动重发。'}}
function sharingCharacterRequired(code){return code==='COMPANION_CHARACTER_REQUIRED'||code==='DOUYIN_CHAT_CHARACTER_REQUIRED'}
function sharingCharacterStale(code){return code==='COMPANION_CHARACTER_STALE'||code==='DOUYIN_STALE_CHARACTER'}
function showSharingError(error){const e=sharingError(error),node=$('sharing-error');node.textContent=[e.code,e.error,e.hint].filter(Boolean).join(' · ');node.hidden=false}
function clearSharingError(){const node=$('sharing-error');node.textContent='';node.hidden=true}
function retireSharingRead(){sharingSeq++;if(sharingPollTimer){clearTimeout(sharingPollTimer);sharingPollTimer=null}const controller=sharingReadController;sharingReadController=null;if(controller)controller.abort()}
function retireSharingForStale(error){retireSharingRead();for(const controller of sharingControllers)controller.abort();sharingControllers.clear();sharingReadController=null;sharingValue=null;sharingStamp='';sharingPending=null;sharingCancelBusy=false;sharingAcking.clear();selectedOpeningId='';$('conversation-input').value='';$('conversation-openings').replaceChildren();$('conversation-message-list').replaceChildren();sharingActionFailure=sharingError(error);preserveSharingErrorOnRoleChange=true;sharingRoleRefreshPending=true;showSharingError(sharingActionFailure);$('conversation-status').textContent='正在重新核对当前伙伴；旧分享和草稿已收起。';renderSharingControls();void refresh()}
function renderSharingControls(){
 const openings=Array.isArray(sharingValue?.openings)?sharingValue.openings:[],hasOpening=openings.some(item=>item.id===selectedOpeningId),working=!!sharingPending||!!sharingValue?.active;
 $('conversation-input').disabled=!context||!hasOpening||working||sharingCancelBusy||sharingRoleRefreshPending;$('conversation-send').disabled=!context||!hasOpening||working||sharingCancelBusy||sharingRoleRefreshPending;$('start').disabled=busy||active||!startReady||!context||working||sharingRoleRefreshPending;
 const canCancel=!!(sharingPending?.requestId||sharingValue?.active?.requestId);$('conversation-cancel').hidden=!canCancel;$('conversation-cancel').disabled=!canCancel||sharingCancelBusy;
}
function renderSharingOpenings(){
 const root=$('conversation-openings');root.replaceChildren();const openings=Array.isArray(sharingValue?.openings)?sharingValue.openings:[];
 if(!openings.length){root.append(sharingText('p','还没有新的小发现，等下一次发现时再聊。','conversation-empty'));return}
 for(const opening of openings){
  const card=document.createElement('article');card.className='opening-card';card.dataset.openingId=String(opening.id||'');
  card.append(sharingText('small',opening.sourceTitle||'刚刚的一处小发现','pill'));
  const details=[opening.sourceId||'',opening.occurredAt?new Date(opening.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'',opening.coverage?.transcriptComplete?'音轨完整':'音轨部分',String(Number(opening.coverage?.frameSamples)||0)+' 张稀疏画面'].filter(Boolean).join(' · ');
  if(details)card.append(sharingText('small',details,'muted'));
  card.append(sharingText('p',opening.text||'','opening-text'));
  if(opening.question)card.append(sharingText('p',opening.question,'opening-question'));
  const actions=document.createElement('div');actions.className='opening-actions';
  const seen=document.createElement('button');seen.type='button';seen.textContent=sharingAcking.has(opening.id)?'正在标记…':opening.unread?'我看到了':'已读';seen.disabled=!opening.unread||sharingAcking.has(opening.id);seen.setAttribute('aria-label',opening.unread?'我看到了':'已读');seen.onclick=()=>ackSharingOpening(opening.id);actions.append(seen);
  const reply=document.createElement('button');reply.type='button';reply.textContent='回一句';reply.onclick=()=>{selectedOpeningId=opening.id;renderSharingControls();if(opening.unread)void ackSharingOpening(opening.id);};actions.append(reply);card.append(actions);root.append(card);
 }
}
function renderSharingMessages(){
 const list=$('conversation-message-list');list.replaceChildren();
 for(const message of Array.isArray(sharingValue?.messages)?sharingValue.messages:[]){
  const item=document.createElement('li');item.className='message';item.dataset.role=message.role==='user'?'user':message.role==='assistant'?'assistant':'system';
  const author=message.role==='user'?'你':message.role==='assistant'?(context?.characterId?$('role').textContent.replace(/^当前伙伴：/,''):'伙伴'):'对话记录';
  item.append(sharingText('span',author,'message-author'));item.append(sharingText('p',message.text||'','message-text'));list.append(item);
 }
}
function renderSharing(data){
 if(retired||!data?.character||data.character.id!==context?.characterId||data.character.epoch!==context?.characterEpoch)return;
 const next=data.character.id+':'+data.character.epoch;if(sharingStamp&&sharingStamp!==next){sharingValue=null;sharingPending=null;sharingActionFailure=null;selectedOpeningId='';$('conversation-input').value='';}
 sharingStamp=next;sharingValue=data.value||{openings:[],messages:[],active:null,unread:0,lastError:null};
 const openings=Array.isArray(sharingValue.openings)?sharingValue.openings:[];if(!openings.some(item=>item.id===selectedOpeningId))selectedOpeningId=openings[0]?.id||'';
 $('conversation-title').textContent='和'+(data.character.name||'伙伴')+'聊聊';renderSharingOpenings();renderSharingMessages();
 $('conversation-status').textContent=sharingPending?'正在整理这条回复…':sharingValue.active?'这条对话正在继续，可以取消等待。':openings.length?'我看完啦，想听听你的想法。':'还没有新的小发现，等下一次发现日记再聊。';
 const failure=sharingActionFailure||sharingValue.lastError;if(failure)showSharingError(failure);else clearSharingError();renderSharingControls();
}
function resetSharing(message){
 sharingSeq++;if(sharingPollTimer){clearTimeout(sharingPollTimer);sharingPollTimer=null}for(const controller of sharingControllers)controller.abort();sharingControllers.clear();sharingReadController=null;sharingValue=null;sharingStamp='';sharingPending=null;sharingCancelBusy=false;sharingAcking.clear();if(preserveSharingErrorOnRoleChange)preserveSharingErrorOnRoleChange=false;else sharingActionFailure=null;selectedOpeningId='';$('conversation-input').value='';$('conversation-openings').replaceChildren();$('conversation-message-list').replaceChildren();if(!sharingActionFailure)clearSharingError();$('conversation-status').textContent=message||'先在角色页载入伙伴。';renderSharingControls();
}
function scheduleSharingPoll(delay=5000){if(retired||!context||sharingRoleRefreshPending||sharingPollTimer)return;sharingPollTimer=setTimeout(()=>{sharingPollTimer=null;void refreshSharing()},delay)}
async function refreshSharing(){
 if(retired||!context||sharingRoleRefreshPending)return;if(sharingRefreshing){scheduleSharingPoll(100);return}if(sharingPollTimer){clearTimeout(sharingPollTimer);sharingPollTimer=null}sharingRefreshing=true;
 const token=++sharingSeq,expectedStamp=stamp,expectedContext={...context},controller=new AbortController();sharingReadController=controller;sharingControllers.add(controller);const timeout=setTimeout(()=>controller.abort(),5000);
 try{
  const response=await fetch(sharingEndpoint,{cache:'no-store',headers:{accept:'application/json'},signal:controller.signal});let data={};try{data=await response.json()}catch{}
  if(retired||token!==sharingSeq||stamp!==expectedStamp)return;
  if(!response.ok||data.ok===false){const failure=sharingError(data);if(sharingCharacterRequired(failure.code)){clearRole('当前角色已清除，未显示旧立绘。',failure);}else if(sharingCharacterStale(failure.code))retireSharingForStale(failure);else{sharingActionFailure=failure;showSharingError(failure);$('conversation-status').textContent='分享状态暂时无法读取；可以点刷新后再试。'}return}
  if(data.character?.id!==expectedContext.characterId||data.character?.epoch!==expectedContext.characterEpoch){retireSharingForStale({code:'DOUYIN_STALE_CHARACTER',error:'分享返回的角色已经变化。',hint:'正在重新核对角色状态；请稍后再操作。'});return}
  renderSharing(data);
 }catch(error){if(!retired&&token===sharingSeq&&stamp===expectedStamp){sharingActionFailure=controller.signal.aborted?{code:'SHARING_READ_TIMEOUT',error:'读取本机分享超过 5 秒，已停止等待。',hint:'点刷新重试；系统不会自动重复发送回复。'}:sharingError(error);showSharingError(sharingActionFailure);$('conversation-status').textContent='分享状态暂时无法读取；可以点刷新后再试。'}}
 finally{clearTimeout(timeout);sharingControllers.delete(controller);if(sharingReadController===controller)sharingReadController=null;sharingRefreshing=false;if(!retired&&stamp===expectedStamp&&!sharingRoleRefreshPending)scheduleSharingPoll()}
}
async function postSharing(body,controller=new AbortController()){
 if(retired||!context)return{stale:true};const expectedStamp=stamp,expectedContext={...context};sharingControllers.add(controller);const timeout=setTimeout(()=>controller.abort(),185000);
 try{
  const response=await fetch(sharingEndpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({...body,...expectedContext}),signal:controller.signal});let data={};try{data=await response.json()}catch{}
  if(retired||stamp!==expectedStamp||context?.characterId!==expectedContext.characterId||context?.characterEpoch!==expectedContext.characterEpoch)return{stale:true};
  if(!response.ok||data.ok===false){const failure=sharingError(data);if(sharingCharacterRequired(failure.code)){clearRole('当前角色已清除，未显示旧立绘。',failure);return{stale:true}}if(sharingCharacterStale(failure.code)){retireSharingForStale(failure);return{stale:true}}return{ok:false,error:failure}}
  if(data.character?.id!==expectedContext.characterId||data.character?.epoch!==expectedContext.characterEpoch){const failure={code:'DOUYIN_STALE_CHARACTER',error:'回复结果属于已经变化的角色。',hint:'正在重新核对角色状态；请确认后再继续。'};retireSharingForStale(failure);return{stale:true}}
  retireSharingRead();
  return{ok:true,data};
 }catch(error){if(retired||stamp!==expectedStamp)return{stale:true};return{ok:false,error:controller.signal.aborted?{code:'SHARING_REQUEST_TIMEOUT',error:'等待本机伙伴操作超过 185 秒，已停止等待。',hint:'点刷新核对已有结果；若仍在处理中，不要重发同一条消息。'}:sharingError(error)}}
 finally{clearTimeout(timeout);sharingControllers.delete(controller)}
}
async function ackSharingOpening(openingId){
 if(retired||!context||sharingAcking.has(openingId))return;const opening=sharingValue?.openings?.find(item=>item.id===openingId);if(!opening?.unread)return;const expectedStamp=sharingStamp;sharingAcking.add(openingId);renderSharingOpenings();
 const result=await postSharing({action:'ack',openingId});sharingAcking.delete(openingId);if(retired||expectedStamp!==sharingStamp||result.stale)return;if(result.ok){sharingActionFailure=null;renderSharing(result.data)}else{sharingActionFailure=result.error;showSharingError(result.error);renderSharingOpenings()}
}
function sharingUuid(){if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20)}
async function sendSharingReply(){
 if(retired||!context||sharingPending||sharingValue?.active||sharingCancelBusy)return;const openingId=selectedOpeningId,textValue=$('conversation-input').value,text=textValue.trim();
 if(!openingId){sharingActionFailure={code:'SHARING_OPENING_REQUIRED',error:'当前没有可回复的新发现。',hint:'等下一次发现日记出现后再聊。'};showSharingError(sharingActionFailure);return}
 if(!text){sharingActionFailure={code:'SHARING_TEXT_REQUIRED',error:'先写一句想说的话。',hint:'输入最多 1000 字后再发送。'};showSharingError(sharingActionFailure);return}
 if(text.length>1000){sharingActionFailure={code:'SHARING_TEXT_TOO_LONG',error:'回复超过 1000 字。',hint:'缩短内容后再发送。'};showSharingError(sharingActionFailure);return}
 const requestId=sharingUuid(),controller=new AbortController(),pending={requestId,openingId,controller,stamp:sharingStamp};sharingPending=pending;sharingActionFailure=null;clearSharingError();renderSharingControls();$('conversation-status').textContent='正在整理这条回复…';
 const result=await postSharing({action:'reply',openingId,requestId,text},controller);if(retired||pending.stamp!==sharingStamp||sharingPending?.requestId!==requestId)return;sharingPending=null;
 if(result.stale)return;if(!result.ok){sharingActionFailure=result.error;showSharingError(result.error);$('conversation-status').textContent='回复没有完成；输入仍保留，可以检查后手动再试。';renderSharingControls();return}
 if($('conversation-input').value===textValue)$('conversation-input').value='';sharingActionFailure=null;renderSharing(result.data);
}
async function cancelSharingReply(){
 if(retired||sharingCancelBusy)return;const pending=sharingPending,requestId=pending?.requestId||sharingValue?.active?.requestId;if(!requestId)return;const expectedStamp=sharingStamp;sharingCancelBusy=true;renderSharingControls();
 const result=await postSharing({action:'cancel',requestId});if(retired||expectedStamp!==sharingStamp||result.stale)return;sharingCancelBusy=false;
 if(!result.ok){sharingActionFailure=result.error;showSharingError(result.error);renderSharingControls();return}
 if(sharingPending?.requestId===requestId){const controller=sharingPending.controller;sharingPending=null;controller.abort()}
 sharingActionFailure=null;renderSharing(result.data);$('conversation-status').textContent='这次回复已取消，原输入仍保留。';renderSharingControls();
}
function clearRole(message,sharingFailure=null){const priorFailure=!context?sharingActionFailure:null;stamp='';portraitStamp='';context=null;active=false;actionFailure=null;sharingRoleRefreshPending=false;resetSharing('先在角色页载入伙伴。');const visibleFailure=sharingFailure||priorFailure;if(visibleFailure){sharingActionFailure=sharingError(visibleFailure);showSharingError(sharingActionFailure)}clearPortrait(message||'当前没有已载入角色，未显示旧立绘。');$('role').textContent='当前没有已载入角色';$('title').textContent='小白鲸的发现日记';$('diary').replaceChildren();$('details').textContent='';$('notice').textContent='先在角色页载入伙伴。';}
function render(data,retryPortrait=false){
 if(retired)return;
 const role=data.character,next=role.id+':'+role.epoch;
 const roleChanged=stamp!==next;if(stamp&&roleChanged){$('diary').replaceChildren();$('error').textContent='';actionFailure=null;}if(roleChanged){clearPortrait('正在读取本机伙伴立绘…');portraitStamp='';resetSharing('角色已变化，正在读取新伙伴的分享…');}else if(preserveSharingErrorOnRoleChange)preserveSharingErrorOnRoleChange=false;const verifySharingRole=sharingRoleRefreshPending;sharingRoleRefreshPending=false;stamp=next;context={characterId:role.id,characterEpoch:role.epoch};if(roleChanged||verifySharingRole)scheduleSharingPoll(0);if(roleChanged||retryPortrait||portraitStamp!==next){portraitStamp=next;void loadPortrait({...context},next)}
 $('role').textContent='当前伙伴：'+(role.name||role.id);$('title').textContent=(role.name||'伙伴')+'的发现日记';const value=data.value;const daily=value.daily||{},accept=value.acceptance||{};
 $('acceptance').textContent=(accept.callsUsed??accept.calls??0)+' / 12';$('daily').textContent=(daily.rounds??daily.roundsUsed??0)+' / 2 轮';$('calls').textContent=(daily.calls??daily.callsUsed??0)+' / 8';
 const job=value.activeJob||(value.recentJobs||[])[0];active=!!value.activeJob&&['queued','running'].includes(value.activeJob.state);
 const paused=daily.paused===true,savedItems=(job?.items||[]).filter(item=>item.memorySaved===true),finishedWithoutFailure=job&&!job.code&&!job.error&&!['failed','cancelled','interrupted'].includes(job.state),finishedWithMemory=finishedWithoutFailure&&(['completed'].includes(job.state)||(job.state==='partial'&&savedItems.length>0));
 const manualNeedsRetry=!active&&accept.manualAccepted===false&&['completed','partial'].includes(job?.state)&&finishedWithoutFailure;
 const audioIncomplete=savedItems.some(item=>item.coverage?.transcriptComplete===false),partialSaved=job?.state==='partial'&&savedItems.length>0;
 document.body.dataset.state=active?'running':paused?'paused':finishedWithMemory?'completed':'idle';
 const phases={feed:'正在看看今天的推荐',media:'正在听音轨、看几张关键画面',perceive:'正在听音轨、看几张关键画面',model:'正在整理自己的感受',memory:'正在记进日记',finished:'已经记好啦'};
 $('mood').textContent=active?(phases[job?.phase]||'正在认真看这一轮的小发现…'):paused?'先休息一下，准备好了再继续。':manualNeedsRetry?(audioIncomplete?'部分观看经历已写入日记；本轮音轨未覆盖完整，首次手动验收还没通过。请再手动体验一轮音轨完整的视频。':'观看经历已写入日记；首次手动验收还没通过。请再手动体验一轮符合条件的视频。'):finishedWithMemory?'今天的小发现，已经记进日记了。':'今天也想看看，有什么值得记住的小事。';
 startReady=!!data.readiness?.ok&&accept.remaining!==0;$('start').disabled=busy||active||!startReady||!!sharingPending||!!sharingValue?.active||sharingRoleRefreshPending;$('cancel').disabled=busy||!active;$('enable').disabled=busy||active||!data.readiness?.ok||accept.manualAccepted!==true;
 $('enable').textContent=daily.enabled&&!paused?'日常活动已开启':'启用每天两轮';$('pause').disabled=busy;
 $('notice').textContent=active?'本轮进行中 · 请求 '+(job.calls||0)+'/4':paused?'日常活动已暂停，可先手动体验一轮。':manualNeedsRetry?(partialSaved?(audioIncomplete?'部分观看经历已保存；本轮音轨尾部不完整，首次手动验收尚未通过。请再手动体验一轮音轨完整的视频，然后启用日常活动。':'部分观看经历已保存；首次手动验收尚未通过。请再手动体验一轮符合条件的视频，然后启用日常活动。'):'观看经历已保存；首次手动验收尚未通过。请再手动体验一轮符合条件的视频，然后启用日常活动。'):daily.enabled?'每天两轮已开启；错过时段不补跑。':'日常活动已暂停，可先手动体验一轮。';
 $('enable').title=manualNeedsRetry?'首次手动验收尚未通过；请按上方提示再手动体验一轮。':'';
 $('error').textContent='';if(actionFailure)sayError(actionFailure);else if(daily.lastError)sayError(daily.lastError);else if(job&&['failed','interrupted'].includes(job.state))sayError(job);else if(!data.readiness?.ok)sayError(data.readiness);
 $('diary').replaceChildren();const jobs=[...(value.activeJob?[value.activeJob]:[]),...(value.recentJobs||[])];const seen=new Set();
 for(const j of jobs){
  if(seen.has(j.jobId))continue;seen.add(j.jobId);
  for(const item of j.items||[]){
   const el=document.createElement('article');el.className='entry';const h=document.createElement('h3'),a=document.createElement('a');a.textContent=item.title||'这次的小发现';
   if(/^https:\/\/www\.douyin\.com\/video\/[0-9]+$/.test(item.url)){a.href=item.url;a.target='_blank';a.rel='noreferrer'}h.append(a);el.append(h);
   const scope=item.state==='skipped'?'已跳过 · 未形成观看经历':(item.coverage?.transcriptComplete?'音轨处理完整':'部分音轨覆盖')+' · '+(item.coverage?.frameSamples||0)+'张稀疏画面';
   el.append(text('small',(item.occurredAt?new Date(item.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'')+' · '+scope));
   if(item.summary)el.append(text('p',item.summary));if(item.reason)el.append(text('p','感受理由：'+item.reason));
   if(item.error||item.hint)el.append(text('p',[item.code,item.error,item.hint].filter(Boolean).join(' · '),'error'));
   if(item.draft){el.append(text('small','待审草稿 · 尚未发布'));el.append(text('p',item.draft,'draft'));}$('diary').append(el);
  }
 }
 $('details').textContent=JSON.stringify(value,null,2);renderSharingControls();
}
async function refresh(retryPortrait=false){if(retired)return;if(busy||refreshing){if(retryPortrait)portraitRetryPending=true;return}refreshing=true;const token=++seq;try{const data=await request();if(!retired&&token===seq)render(data,retryPortrait)}catch(e){if(!retired&&token===seq){if(['COMPANION_CHARACTER_REQUIRED','COMPANION_CHARACTER_STALE'].includes(e.code)){clearRole('当前角色已清除，未显示旧立绘。');}sayError(e);$('start').disabled=true;$('enable').disabled=true}}finally{refreshing=false;if(retired){portraitRetryPending=false;return}if(portraitRetryPending&&!busy){portraitRetryPending=false;void refresh(true)}}}
async function action(body){if(retired||busy||!context)return;busy=true;seq++;actionFailure=null;for(const id of ['start','cancel','enable','pause'])$(id).disabled=true;$('error').textContent='';try{await request(body)}catch(e){if(!retired)actionFailure=e}finally{busy=false;if(retired)return;await refresh();if(!retired&&actionFailure)sayError(actionFailure)}}
$('start').onclick=()=>action({action:'start'});$('cancel').onclick=()=>action({action:'cancel'});$('enable').onclick=()=>action({action:'configure',enabled:true});$('pause').onclick=()=>action({action:'configure',enabled:false});$('refresh').onclick=()=>{void refresh(true);void refreshSharing()};
$('conversation-form').addEventListener('submit',event=>{event.preventDefault();void sendSharingReply()});$('conversation-cancel').onclick=()=>void cancelSharingReply();
const timer=setInterval(refresh,2000);addEventListener('pagehide',()=>{if(retired)return;retired=true;portraitRetryPending=false;seq++;clearInterval(timer);if(sharingPollTimer){clearTimeout(sharingPollTimer);sharingPollTimer=null}sharingSeq++;for(const controller of sharingControllers)controller.abort();sharingControllers.clear();sharingReadController=null;sharingAcking.clear();sharingPending=null;$('conversation-status').textContent='日记页已关闭。';$('conversation-input').disabled=true;$('conversation-send').disabled=true;$('conversation-cancel').hidden=true;clearPortrait('日记页已关闭。')});refresh();
</script></body></html>`;
