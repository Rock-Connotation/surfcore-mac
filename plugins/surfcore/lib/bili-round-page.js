// A same-origin panel keeps the bounded round UI outside the legacy settings monolith.
export const biliRoundPage = String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>B站自主单轮</title>
<style>
:root{color-scheme:light dark;font:14px -apple-system,BlinkMacSystemFont,sans-serif}body{margin:12px;color:CanvasText;background:Canvas}h3{margin:0 0 8px}p{line-height:1.5;margin:8px 0}button,select{font:inherit;padding:7px 10px;margin:4px 6px 4px 0;max-width:100%}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;max-height:340px;overflow:auto;background:color-mix(in srgb,CanvasText 5%,Canvas);padding:10px;border-radius:6px}.error{color:light-dark(#b42318,#ffb4ab)}.muted{opacity:.75}.actions{display:flex;flex-wrap:wrap}
</style><body><h3>B站自主单轮</h3>
<p>自动取候选、选择一条、等待转写完成，再生成点评与动态草稿。每轮最多两次模型请求，每次最多2000输出 tokens；消耗所选渠道额度。草稿保存在本机。</p>
<p class="muted">本轮依据完整音轨转写评价；画面采样可另行查看。自动巡航保持暂停。</p>
<div class="actions"><button id="pause">仅运行单轮</button><button id="refresh">刷新</button></div>
<label for="model">本轮模型</label><br><select id="model" aria-label="本轮模型"></select>
<div class="actions"><button id="start" disabled>自主选题并点评</button><button id="cancel" disabled>取消本轮</button></div>
<p id="notice" role="status" aria-live="polite">正在读取状态…</p><pre id="result" aria-label="单轮结果"></pre>
<script>
const endpoint='/dsh-surfcore/api/bili/round';let jobId='',working=false,timer;const $=id=>document.getElementById(id);
async function request(body){const r=await fetch(endpoint+(body?'':jobId?'?jobId='+encodeURIComponent(jobId):''),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();if(!r.ok||d.ok===false){const e=new Error([d.code,d.error,d.hint].filter(Boolean).join(' · '));throw e}return d}
function notify(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':''}
function render(value){$('result').textContent=JSON.stringify(value,null,2);const job=value&&value.jobs?value.jobs[0]:value&&value.job||value;const state=job&&job.state;working=['queued','running'].includes(state);if(job&&job.jobId)jobId=job.jobId;$('cancel').disabled=!working}
async function refresh(){try{const d=await request();const selected=$('model').value;$('model').replaceChildren();for(const m of d.models||[]){const o=document.createElement('option');o.value=JSON.stringify({provider:m.provider,model:m.model});o.textContent=m.provider+' / '+m.name+' ('+m.model+')';$('model').append(o)}if([...$('model').options].some(o=>o.value===selected))$('model').value=selected;else{const preferred=[...$('model').options].find(o=>JSON.parse(o.value).model==='workbuddy/hy4free');if(preferred)$('model').value=preferred.value}render(d.value);const last=d.value&&d.value.jobs?d.value.jobs[0]:d.value;const failed=last&&['failed','cancelled','interrupted'].includes(last.state);$('start').disabled=!d.readiness.ok||working||!$('model').value;notify(failed?[last.code,last.error,last.hint].filter(Boolean).join(' · '):d.readiness.ok?'自动巡航已暂停；可开始一次单轮。':[d.readiness.code,d.readiness.error,d.readiness.hint].filter(Boolean).join(' · '),failed||!d.readiness.ok)}catch(e){$('result').textContent='';jobId='';working=false;notify(e.message,true);$('start').disabled=true}clearTimeout(timer);timer=setTimeout(refresh,working?1500:5000)}
$('refresh').onclick=refresh;$('pause').onclick=async()=>{try{const d=await request({action:'pause'});window.parent.postMessage({type:'surfcore-bili-mode'},'*');notify(d.restartRequired?'旧巡航已停止，请重启此 App 后再运行单轮。':'已设为仅运行单轮。');await refresh()}catch(e){notify(e.message,true)}};
$('start').onclick=async()=>{$('start').disabled=true;try{const m=JSON.parse($('model').value);const d=await request({action:'start',...m,maxTokens:2000});jobId=d.jobId;working=true;await refresh()}catch(e){notify(e.message,true)}};
$('cancel').onclick=async()=>{notify('正在取消并确认已提交素材；提交阶段可能需要等待最多60秒。');try{await request({action:'cancel',jobId});await refresh()}catch(e){notify(e.message,true)}};refresh();
</script></body></html>`;
