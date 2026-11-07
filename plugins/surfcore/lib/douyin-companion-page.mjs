// Private role appearance is loaded through the same-origin, epoch-stamped portrait endpoint.
export const douyinCompanionPage = String.raw`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小白鲸的发现日记</title>
<style>
:root{color-scheme:light dark;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;--sea:light-dark(#245e73,#a0d6e7);--line:light-dark(#d3e3e8,#34484f);--muted:light-dark(#526d76,#a6bac2)}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding:20px;color:CanvasText;background:Canvas}header{display:flex;align-items:center;gap:24px;padding-bottom:16px;border-bottom:1px solid var(--line)}
h2{font:600 25px/1.4 "Songti SC","Noto Serif CJK SC",serif;margin:2px 0;color:var(--sea)}p{margin:6px 0}small,.muted{color:var(--muted)}
.portrait-card{width:clamp(120px,24vw,220px);flex:none;text-align:center}.portrait{display:block;width:100%;height:260px;object-fit:contain;object-position:center bottom;border-radius:10px;background:light-dark(#edf7fa,#182e38);animation:portrait-idle 6s ease-in-out infinite}.portrait-status{min-height:2.2em;margin:4px 0;font-size:12px;color:var(--muted)}
body[data-state="running"] .portrait{animation-name:portrait-thinking;animation-duration:3.4s}body[data-state="completed"] .portrait{animation-name:portrait-happy;animation-duration:2.8s}body[data-state="paused"] .portrait{animation:none;opacity:.88;filter:saturate(.82)}
@keyframes portrait-idle{50%{transform:translateY(-2px)}}@keyframes portrait-thinking{50%{transform:translateY(-3px) scale(1.006)}}@keyframes portrait-happy{25%{transform:translateY(-3px) scale(1.01)}75%{transform:translateY(1px)}}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:Canvas;color:CanvasText;border-radius:7px;padding:7px 12px}button:hover{border-color:var(--sea)}button:disabled{opacity:.5;cursor:default}.primary{background:var(--sea);color:light-dark(white,#12242c);border-color:var(--sea)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.error{color:light-dark(#a72e26,#ffb6ae);white-space:pre-wrap}.ledger{display:flex;gap:24px;flex-wrap:wrap;margin:12px 0}.ledger strong{color:var(--sea)}.entry{padding:16px 0;border-top:1px solid var(--line)}.entry h3{font-size:16px;margin:0 0 6px}.entry a{color:var(--sea)}.draft{border-left:3px solid var(--line);padding-left:12px;white-space:pre-wrap}.pill{font-size:12px;letter-spacing:.04em;color:var(--sea)}details{margin-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font-size:12px}
@media(max-width:440px){body{padding:12px}header{gap:12px}.portrait-card{width:120px}.portrait{height:180px}h2{font-size:21px}}
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
<details><summary>活动与额度详情</summary><pre id="details"></pre></details>
<script>
const endpoint='/dsh-surfcore/api/douyin/companion',portraitEndpoint='/dsh-surfcore/api/douyin/companion-portrait',$=id=>document.getElementById(id);
let context=null,stamp='',portraitStamp='',portraitRequest=0,portraitObjectUrl='',portraitController=null,portraitTimer=null,busy=false,refreshing=false,portraitRetryPending=false,seq=0,active=false,actionFailure=null,retired=false;
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
  if(portraitObjectUrl)URL.revokeObjectURL(portraitObjectUrl);portraitObjectUrl=URL.createObjectURL(blob);const image=$('portrait');image.onload=()=>{if(!retired&&token===portraitRequest&&stamp===expectedStamp)$('portrait-status').textContent='当前角色的本机立绘'};image.onerror=()=>{if(!retired&&token===portraitRequest&&stamp===expectedStamp){image.removeAttribute('src');image.hidden=true;$('portrait-status').textContent='立绘解码失败 · COMPANION_PORTRAIT_INVALID · 浏览器无法显示这张 WebP。 · 检查文件后点上方“刷新”重试。'}};image.src=portraitObjectUrl;image.hidden=false;
 }catch(e){if(retired||token!==portraitRequest||stamp!==expectedStamp)return;if(portraitObjectUrl){URL.revokeObjectURL(portraitObjectUrl);portraitObjectUrl=''}$('portrait').removeAttribute('src');$('portrait').hidden=true;const failure=controller.signal.aborted?{code:'COMPANION_PORTRAIT_TIMEOUT',error:'读取本机立绘超过 5 秒，已停止等待。',hint:'点上方“刷新”重试；若持续失败，请重新配置当前角色的本机立绘。'}:e;$('portrait-status').textContent='立绘读取失败 · '+[failure.code||'COMPANION_PORTRAIT_LOAD_FAILED',failure.error||'本机立绘暂时无法显示。',failure.hint||'点上方“刷新”重试。'].filter(Boolean).join(' · ')}
 finally{clearTimeout(timer);if(portraitController===controller)portraitController=null;if(portraitTimer===timer)portraitTimer=null}
}
function clearRole(message){stamp='';portraitStamp='';context=null;active=false;actionFailure=null;clearPortrait(message||'当前没有已载入角色，未显示旧立绘。');$('role').textContent='当前没有已载入角色';$('title').textContent='小白鲸的发现日记';$('diary').replaceChildren();$('details').textContent='';$('notice').textContent='先在角色页载入伙伴。';}
function render(data,retryPortrait=false){
 if(retired)return;
 const role=data.character,next=role.id+':'+role.epoch;
 const roleChanged=stamp!==next;if(stamp&&roleChanged){$('diary').replaceChildren();$('error').textContent='';actionFailure=null;}if(roleChanged){clearPortrait('正在读取本机伙伴立绘…');portraitStamp='';}stamp=next;context={characterId:role.id,characterEpoch:role.epoch};if(roleChanged||retryPortrait||portraitStamp!==next){portraitStamp=next;void loadPortrait({...context},next)}
 $('role').textContent='当前伙伴：'+(role.name||role.id);$('title').textContent=(role.name||'伙伴')+'的发现日记';const value=data.value;const daily=value.daily||{},accept=value.acceptance||{};
 $('acceptance').textContent=(accept.callsUsed??accept.calls??0)+' / 12';$('daily').textContent=(daily.rounds??daily.roundsUsed??0)+' / 2 轮';$('calls').textContent=(daily.calls??daily.callsUsed??0)+' / 8';
 const job=value.activeJob||(value.recentJobs||[])[0];active=!!value.activeJob&&['queued','running'].includes(value.activeJob.state);
 const paused=daily.paused===true,savedItems=(job?.items||[]).filter(item=>item.memorySaved===true),finishedWithoutFailure=job&&!job.code&&!job.error&&!['failed','cancelled','interrupted'].includes(job.state),finishedWithMemory=finishedWithoutFailure&&(['completed'].includes(job.state)||(job.state==='partial'&&savedItems.length>0));
 const manualNeedsRetry=!active&&accept.manualAccepted===false&&['completed','partial'].includes(job?.state)&&finishedWithoutFailure;
 const audioIncomplete=savedItems.some(item=>item.coverage?.transcriptComplete===false),partialSaved=job?.state==='partial'&&savedItems.length>0;
 document.body.dataset.state=active?'running':paused?'paused':finishedWithMemory?'completed':'idle';
 const phases={feed:'正在看看今天的推荐',media:'正在听音轨、看几张关键画面',perceive:'正在听音轨、看几张关键画面',model:'正在整理自己的感受',memory:'正在记进日记',finished:'已经记好啦'};
 $('mood').textContent=active?(phases[job?.phase]||'正在认真看这一轮的小发现…'):paused?'先休息一下，准备好了再继续。':manualNeedsRetry?(audioIncomplete?'部分观看经历已写入日记；本轮音轨未覆盖完整，首次手动验收还没通过。请再手动体验一轮音轨完整的视频。':'观看经历已写入日记；首次手动验收还没通过。请再手动体验一轮符合条件的视频。'):finishedWithMemory?'今天的小发现，已经记进日记了。':'今天也想看看，有什么值得记住的小事。';
 $('start').disabled=busy||active||!data.readiness?.ok||(accept.remaining===0);$('cancel').disabled=busy||!active;$('enable').disabled=busy||active||!data.readiness?.ok||accept.manualAccepted!==true;
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
 $('details').textContent=JSON.stringify(value,null,2);
}
async function refresh(retryPortrait=false){if(retired)return;if(busy||refreshing){if(retryPortrait)portraitRetryPending=true;return}refreshing=true;const token=++seq;try{const data=await request();if(!retired&&token===seq)render(data,retryPortrait)}catch(e){if(!retired&&token===seq){if(['COMPANION_CHARACTER_REQUIRED','COMPANION_CHARACTER_STALE'].includes(e.code)){clearRole('当前角色已清除，未显示旧立绘。');}sayError(e);$('start').disabled=true;$('enable').disabled=true}}finally{refreshing=false;if(retired){portraitRetryPending=false;return}if(portraitRetryPending&&!busy){portraitRetryPending=false;void refresh(true)}}}
async function action(body){if(retired||busy||!context)return;busy=true;seq++;actionFailure=null;for(const id of ['start','cancel','enable','pause'])$(id).disabled=true;$('error').textContent='';try{await request(body)}catch(e){if(!retired)actionFailure=e}finally{busy=false;if(retired)return;await refresh();if(!retired&&actionFailure)sayError(actionFailure)}}
$('start').onclick=()=>action({action:'start'});$('cancel').onclick=()=>action({action:'cancel'});$('enable').onclick=()=>action({action:'configure',enabled:true});$('pause').onclick=()=>action({action:'configure',enabled:false});$('refresh').onclick=()=>refresh(true);
const timer=setInterval(refresh,2000);addEventListener('pagehide',()=>{if(retired)return;retired=true;portraitRetryPending=false;seq++;clearInterval(timer);clearPortrait('日记页已关闭。')});refresh();
</script></body></html>`;
