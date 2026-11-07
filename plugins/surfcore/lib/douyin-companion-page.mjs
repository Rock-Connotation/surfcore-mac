// Original inline whale artwork; no third-party media, fonts or network requests.
export const douyinCompanionPage = String.raw`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小白鲸的发现日记</title>
<style>
:root{color-scheme:light dark;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;--sea:light-dark(#245e73,#a0d6e7);--line:light-dark(#d3e3e8,#34484f);--muted:light-dark(#526d76,#a6bac2)}
*{box-sizing:border-box}body{margin:0;padding:20px;color:CanvasText;background:Canvas}header{display:flex;align-items:center;gap:24px;padding-bottom:16px;border-bottom:1px solid var(--line)}
h2{font:600 25px/1.4 "Songti SC","Noto Serif CJK SC",serif;margin:2px 0;color:var(--sea)}p{margin:6px 0}small,.muted{color:var(--muted)}
.ocean{width:145px;flex:none;background:light-dark(#edf7fa,#182e38);border-radius:50%;overflow:visible}.whale{transform-origin:center;animation:float 5s ease-in-out infinite}.tail{transform-origin:174px 100px;animation:tail 4s ease-in-out infinite}.eye{transform-origin:88px 84px;animation:blink 7s infinite}.cheek{opacity:.6}
body[data-state="running"] .whale{animation-duration:2.3s}body[data-state="completed"] .tail{animation-duration:1.1s}body[data-state="paused"] .whale{animation-duration:8s}body[data-state="paused"] .eye{transform:scaleY(.2);animation:none}
@keyframes float{50%{transform:translateY(-5px)}}@keyframes tail{50%{transform:rotate(-7deg)}}@keyframes blink{0%,46%,50%,100%{transform:scaleY(1)}48%{transform:scaleY(.15)}}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:Canvas;color:CanvasText;border-radius:7px;padding:7px 12px}button:hover{border-color:var(--sea)}button:disabled{opacity:.5;cursor:default}.primary{background:var(--sea);color:light-dark(white,#12242c);border-color:var(--sea)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.error{color:light-dark(#a72e26,#ffb6ae);white-space:pre-wrap}.ledger{display:flex;gap:24px;flex-wrap:wrap;margin:12px 0}.ledger strong{color:var(--sea)}.entry{padding:16px 0;border-top:1px solid var(--line)}.entry h3{font-size:16px;margin:0 0 6px}.entry a{color:var(--sea)}.draft{border-left:3px solid var(--line);padding-left:12px;white-space:pre-wrap}.pill{font-size:12px;letter-spacing:.04em;color:var(--sea)}details{margin-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font-size:12px}
@media(max-width:440px){body{padding:12px}header{gap:12px}.ocean{width:100px}h2{font-size:21px}}
@media(prefers-reduced-motion:reduce){.whale,.tail,.eye{animation:none!important}}
</style><body data-state="idle">
<header>
<svg class="ocean" viewBox="0 0 220 170" role="img" aria-label="原创小白鲸伙伴">
<g class="whale"><g class="tail"><path d="M166 101Q191 66 208 82Q210 97 190 112Q202 130 188 139Q169 131 166 101" fill="#b5dce9" stroke="#6eacbf" stroke-width="2"/></g>
<path d="M172 103C172 139 119 150 73 138C26 125 26 76 57 54C91 31 169 45 172 103Z" fill="#fcfefe" stroke="#6eacbf" stroke-width="2"/>
<path d="M111 116Q128 103 139 113Q144 129 121 137" fill="#d6edf4" stroke="#6eacbf" stroke-width="2"/>
<path d="M54 114Q76 133 103 126" fill="none" stroke="#d4eaf1" stroke-width="2"/>
<ellipse class="eye" cx="74" cy="86" rx="4" ry="5" fill="#294d5c"/><ellipse class="eye" cx="110" cy="87" rx="4" ry="5" fill="#294d5c"/>
<path d="M84 96Q91 102 99 96" fill="none" stroke="#567985" stroke-width="2" stroke-linecap="round"/>
<ellipse class="cheek" cx="64" cy="98" rx="9" ry="4" fill="#efb3bb"/><ellipse class="cheek" cx="120" cy="99" rx="9" ry="4" fill="#efb3bb"/>
<path d="M91 44Q82 30 89 25M96 43Q104 24 111 29" fill="none" stroke="#8ac7dc" stroke-width="3" stroke-linecap="round"/></g>
<path d="M35 153Q75 146 110 153T195 151" fill="none" stroke="#a4cfdd" stroke-width="2"/></svg>
<div><span class="pill">发现 · 感受 · 记住</span><h2 id="title">小白鲸的发现日记</h2><p id="mood">今天也想看看，有什么值得记住的小事。</p><small id="role">正在核对角色…</small></div></header>
<p class="muted">每轮最多 2 条短视频，结合音轨、稀疏画面和文案。这里只留下日记与待审草稿。</p>
<div class="ledger"><span>升级验收 <strong id="acceptance">— / 12</strong></span><span>今日活动 <strong id="daily">— / 2 轮</strong></span><span>今日请求 <strong id="calls">— / 8</strong></span></div>
<div class="actions"><button id="start" class="primary" disabled>一起发现一轮</button><button id="cancel" disabled>停下休息</button><button id="enable" disabled>启用每天两轮</button><button id="pause">暂停日常活动</button><button id="refresh">刷新</button></div>
<p class="muted">每天 12:30、20:30（上海时间），只在 DSH 运行时活动；错过不补跑。首次手动验收通过后才能开启。</p>
<p id="notice" role="status" aria-live="polite">正在读取状态…</p><p id="error" class="error" role="alert"></p>
<section id="diary" aria-label="观看日记"></section>
<details><summary>活动与额度详情</summary><pre id="details"></pre></details>
<script>
const endpoint='/dsh-surfcore/api/douyin/companion', $=id=>document.getElementById(id);
let context=null,stamp='',busy=false,refreshing=false,seq=0,active=false,actionFailure=null;
const sayError=e=>{$('error').textContent=[e.code,e.error||e.message,e.hint].filter(Boolean).join(' · ')};
async function request(body){const response=await fetch(endpoint,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,...context})}:{});const data=await response.json();if(!response.ok||data.ok===false)throw data;return data}
function text(tag,value,cls){const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el}
function render(data){
 const role=data.character,next=role.id+':'+role.epoch;
 if(stamp&&stamp!==next){$('diary').replaceChildren();$('error').textContent='';actionFailure=null;}stamp=next;context={characterId:role.id,characterEpoch:role.epoch};
 $('role').textContent='当前伙伴：'+(role.name||role.id);$('title').textContent=(role.name||'伙伴')+'的发现日记';const value=data.value;const daily=value.daily||{},accept=value.acceptance||{};
 $('acceptance').textContent=(accept.callsUsed??accept.calls??0)+' / 12';$('daily').textContent=(daily.rounds??daily.roundsUsed??0)+' / 2 轮';$('calls').textContent=(daily.calls??daily.callsUsed??0)+' / 8';
 const job=value.activeJob||(value.recentJobs||[])[0];active=!!value.activeJob&&['queued','running'].includes(value.activeJob.state);
 const paused=daily.paused===true;document.body.dataset.state=active?'running':paused?'paused':job?.state==='completed'?'completed':'idle';
 const phases={feed:'正在看看今天的推荐',media:'正在听音轨、看几张关键画面',perceive:'正在听音轨、看几张关键画面',model:'正在整理自己的感受',memory:'正在记进日记',finished:'已经记好啦'};
 $('mood').textContent=active?(phases[job?.phase]||'正在认真看这一轮的小发现…'):paused?'先休息一下，准备好了再继续。':['completed','partial'].includes(job?.state)?'今天的小发现，已经记进日记了。':'今天也想看看，有什么值得记住的小事。';
 $('start').disabled=busy||active||!data.readiness?.ok||(accept.remaining===0);$('cancel').disabled=busy||!active;$('enable').disabled=busy||active||!data.readiness?.ok||accept.manualAccepted!==true;
 $('enable').textContent=daily.enabled&&!paused?'日常活动已开启':'启用每天两轮';$('pause').disabled=busy;
 $('notice').textContent=active?'本轮进行中 · 请求 '+(job.calls||0)+'/4':daily.enabled&&!paused?'每天两轮已开启；错过时段不补跑。':'日常活动已暂停，可先手动体验一轮。';
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
async function refresh(){if(busy||refreshing)return;refreshing=true;const token=++seq;try{const data=await request();if(token===seq)render(data)}catch(e){if(token===seq){sayError(e);$('start').disabled=true;$('enable').disabled=true}}finally{refreshing=false}}
async function action(body){if(busy||!context)return;busy=true;seq++;actionFailure=null;for(const id of ['start','cancel','enable','pause'])$(id).disabled=true;$('error').textContent='';try{await request(body)}catch(e){actionFailure=e}finally{busy=false;await refresh();if(actionFailure)sayError(actionFailure)}}
$('start').onclick=()=>action({action:'start'});$('cancel').onclick=()=>action({action:'cancel'});$('enable').onclick=()=>action({action:'configure',enabled:true});$('pause').onclick=()=>action({action:'configure',enabled:false});$('refresh').onclick=refresh;
const timer=setInterval(refresh,2000);addEventListener('pagehide',()=>{seq++;clearInterval(timer)});refresh();
</script></body></html>`;
