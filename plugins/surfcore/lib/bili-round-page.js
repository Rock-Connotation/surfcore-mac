// Same-origin UI for an explicit round; raw transport fields stay under diagnostics.
export const biliRoundPage = String.raw`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>B站自主单轮</title>
<style>
:root{color-scheme:light dark;font:14px -apple-system,BlinkMacSystemFont,sans-serif}
body{margin:12px;color:CanvasText;background:Canvas}
h3,h4{margin:8px 0}p{line-height:1.5;margin:8px 0}
button,select{font:inherit;padding:7px 10px;margin:4px 6px 4px 0;max-width:100%}
button{cursor:pointer}button:disabled{cursor:default;opacity:.5}
pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;max-height:280px;overflow:auto;background:color-mix(in srgb,CanvasText 5%,Canvas);padding:10px;border-radius:6px}
.error{color:light-dark(#b42318,#ffb4ab)}.muted{opacity:.75}.actions{display:flex;flex-wrap:wrap}
section{border-top:1px solid color-mix(in srgb,CanvasText 20%,Canvas);margin-top:12px;padding-top:8px}details{margin-top:14px}summary{cursor:pointer}
</style>
<body>
<h3>B站自主单轮</h3>
<p>自动取候选、选择一条、等待转写完成，再生成点评与动态草稿。每轮最多两次模型请求，按下方预算限制输出；消耗所选渠道额度。草稿保存在本机。</p>
<p class="muted">本轮依据完整音轨转写评价；画面采样可另行查看。自动巡航保持暂停。</p>
<div class="actions"><button id="pause">仅运行单轮</button><button id="refresh">刷新</button></div>
<label for="model">本轮模型</label><br><select id="model" aria-label="本轮模型"></select>
<label for="tokens">每次输出上限</label><br><select id="tokens"><option value="2000">2000 tokens</option><option value="8192">8192 tokens</option></select>
<div class="actions"><button id="start" disabled>自主选题并点评</button><button id="cancel" disabled>取消本轮</button></div>
<p id="notice" role="status" aria-live="polite">正在读取状态…</p>
<p id="progress" class="muted"></p>
<section id="selection" hidden><h4>选中的视频</h4><p id="video"></p></section>
<section id="review" hidden><h4>观后点评</h4><p id="score"></p><p id="commentary"></p><h4>动态草稿</h4><pre id="draft"></pre><p class="muted">尚未发布。</p></section>
<details><summary>诊断详情</summary><pre id="result" aria-label="单轮诊断结果"></pre></details>
<script>
const endpoint = '/dsh-surfcore/api/bili/round';
const $ = id => document.getElementById(id);
let jobId = '', working = false, timer;
const stages = {queued:'已排队',feed:'正在获取候选',select:'模型正在选题',media:'正在获取完整素材并转写',review:'模型正在形成点评',score:'正在保存评分',memory:'正在整理记忆',cancelling:'正在取消并确认素材状态',finished:'已结束'};
async function request(body) {
  const url = endpoint + (body ? '' : jobId ? '?jobId=' + encodeURIComponent(jobId) : '');
  const options = body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {};
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error([data.code,data.error,data.hint].filter(Boolean).join(' · '));
  return data;
}
function notify(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = error ? 'error' : '';
}
function clearResult() {
  jobId = ''; working = false;
  for (const id of ['result','progress','video','score','commentary','draft']) $(id).textContent = '';
  $('selection').hidden = true; $('review').hidden = true; $('cancel').disabled = true;
}
function render(value) {
  const job = value && value.jobs ? value.jobs[0] : value && value.job || value;
  $('result').textContent = JSON.stringify(value, null, 2);
  working = !!job && ['queued','running'].includes(job.state);
  if (job && job.jobId) jobId = job.jobId;
  $('cancel').disabled = !working;
  $('progress').textContent = job ? (stages[job.progress] || '正在处理') + ' · 模型请求 ' + (job.calls || 0) + '/2' : '暂无单轮记录';
  $('selection').hidden = !job?.selection;
  $('video').textContent = job?.selection?.title || '';
  $('review').hidden = !job?.review;
  $('score').textContent = job?.review ? '评分 ' + job.review.score + '/20 · ' + job.review.reason : '';
  $('commentary').textContent = job?.review?.commentary || '';
  $('draft').textContent = job?.review?.dynamicText || '';
  return job;
}
async function refresh() {
  try {
    const data = await request();
    const previous = $('model').value;
    $('model').replaceChildren();
    for (const model of data.models || []) {
      const option = document.createElement('option');
      option.value = JSON.stringify({provider:model.provider,model:model.model});
      option.textContent = model.provider + ' / ' + model.name + ' (' + model.model + ')';
      $('model').append(option);
    }
    if ([...$('model').options].some(o => o.value === previous)) $('model').value = previous;
    else {
      const preferred = [...$('model').options].find(o => JSON.parse(o.value).model === 'workbuddy/hy4free');
      if (preferred) $('model').value = preferred.value;
    }
    const job = render(data.value);
    const failed = job && ['failed','cancelled','interrupted'].includes(job.state);
    $('start').disabled = !data.readiness.ok || working || !$('model').value;
    if (failed) notify([job.code,job.error,job.hint].filter(Boolean).join(' · '), true);
    else if (!data.readiness.ok) notify([data.readiness.code,data.readiness.error,data.readiness.hint].filter(Boolean).join(' · '), true);
    else notify(working ? stages[job.progress] || '正在处理本轮' : job?.state === 'completed' ? '本轮已完成，点评与草稿已保存。' : '自动巡航已暂停；可开始一次单轮。');
  } catch (error) {
    clearResult(); notify(error.message, true); $('start').disabled = true;
  }
  clearTimeout(timer); timer = setTimeout(refresh, working ? 1500 : 5000);
}
$('refresh').onclick = refresh;
$('pause').onclick = async () => {
  try {
    const data = await request({action:'pause'});
    window.parent.postMessage({type:'surfcore-bili-mode'}, '*');
    notify(data.restartRequired ? '旧巡航已停止，请重启此 App 后再运行单轮。' : '已设为仅运行单轮。');
    await refresh();
  } catch (error) { notify(error.message, true); }
};
$('start').onclick = async () => {
  $('start').disabled = true;
  try {
    const model = JSON.parse($('model').value);
    const data = await request({action:'start',...model,maxTokens:Number($('tokens').value)});
    jobId = data.jobId; working = true; await refresh();
  } catch (error) { notify(error.message, true); }
};
$('cancel').onclick = async () => {
  notify('正在取消并确认已提交素材；提交阶段可能需要等待最多60秒。');
  try { await request({action:'cancel',jobId}); await refresh(); }
  catch (error) { notify(error.message, true); }
};
refresh();
</script>
</body></html>`;
