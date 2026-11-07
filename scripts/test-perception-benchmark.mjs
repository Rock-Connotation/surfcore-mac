import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createPerceptionService } from '../src/perception/index.js';
import { probeAudio } from '../src/perception/media.js';
import { requireAssets, requireAssetFiles, requireMedia } from './perception-test-runtime.mjs';
const source=path.resolve(process.env.ASR_BENCH_SAMPLES || '_backups/asr-quality-aishell');
const builds=requireAssets(); requireAssetFiles(builds,['build/bin/whisper-cli','ggml-base.bin','ggml-small.bin']); requireAssetFiles(source,['transcript.txt','BAC009S0764W0121.wav','BAC009S0764W0122.wav']); const {ffmpeg,ffprobe}=requireMedia();
const root=path.resolve('_backups',`asr-quality-run-${Date.now()}-${process.pid}`), state=path.join(root,'state'),assets=path.join(state,'perception/assets'); fs.mkdirSync(assets,{recursive:true});
const names=['BAC009S0764W0121','BAC009S0764W0122'];
const refs=new Map(fs.readFileSync(path.join(source,'transcript.txt'),'utf8').trim().split('\n').map(line=>{const [id,...words]=line.trim().split(/\s+/);return [id,words.join('')]}));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clean=s=>Array.from(s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,''));
function edit(reference,hyp){const a=clean(reference),b=clean(hyp), row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let diag=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,diag+(a[i-1]===b[j-1]?0:1));diag=old;}}return {edits:row[b.length],referenceCharacters:a.length,cer:row[b.length]/a.length};}
const models={base:'60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',small:'1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'};
const binary=path.join(builds,'build/bin/whisper-cli'); let telemetry=null;
const spawnObserved=(exe,args,opts)=>{const child=spawn(exe,args,opts);if(exe===binary && args.includes('-m')){const t={peakRssKiB:0,stderr:''};telemetry=t;child.stderr?.on('data',b=>{t.stderr=(t.stderr+b.toString()).slice(-50000)});const sample=()=>{if(!child.pid)return;execFile('/bin/ps',['-o','rss=','-p',String(child.pid)],(err,out)=>{const n=Number(out.trim());if(!err&&Number.isFinite(n))t.peakRssKiB=Math.max(t.peakRssKiB,n)});};sample();const timer=setInterval(sample,100);child.once('close',()=>clearInterval(timer));}return child;};
let results=[];
for(const name of names){const src=path.join(source,name+'.wav'); const dest=path.join(assets,name+'.wav'); fs.copyFileSync(src,dest,fs.constants.COPYFILE_EXCL);}
for(const backend of ['cpu','metal']) for(const [modelId,digest] of Object.entries(models)){
 const svc=createPerceptionService({dataRoot:state,engine:{provider:'whisper.cpp',executable:binary,runtimeVersion:'1.9.5-dev',...(backend==='cpu'?{backend:'cpu'}:{}),model:{id:modelId,path:path.join(builds,`ggml-${modelId}.bin`),sha256:digest}},ffmpegPath:ffmpeg,ffprobePath:ffprobe,getCharacter:()=>({id:'quality-eval',epoch:1}),dependencies:{spawn:spawnObserved}});await svc.ready;
 try {const d=await svc.doctor(); if(!d.ready)throw Error(JSON.stringify(d));for(const name of names) for(const iteration of [1,2]){
 const file=path.join(assets,name+'.wav'), duration=(await probeAudio(file,ffprobe)).durationMs,range={startMs:0,endMs:duration};
 telemetry=null;const begin=performance.now(); const {jobId}=await svc.submit({activityId:crypto.randomUUID(),asset:{assetId:name,contentSha256:sha(file),localPath:file,durationMs:duration,sourceDurationMs:duration,acquiredRanges:[range],timelineMap:[{localStartMs:0,localEndMs:duration,sourceStartMs:0,sourceEndMs:duration}]},provenance:{channel:'local',sourceId:name,acquiredAtMs:0},source:{channel:'local'},visibility:{classification:'restricted',allowedContexts:[`${backend}-${modelId}-${name}-${iteration}`]},requestedRanges:[range],languageHint:'zh'});let job;
 for(let i=0;i<2400;i++){job=await svc.getJob(jobId);if(['completed','failed','partial'].includes(job.state))break;await new Promise(r=>setTimeout(r,50));}
 const elapsedMs=Math.round(performance.now()-begin), text=job.result?.segments?.map(s=>s.text).join('') || ''; const observedMetal=/whisper_backend_init_gpu: using MTL[0-9]+ backend/.test(telemetry?.stderr||'');
 const result={backend,model:modelId,name,iteration,elapsedMs,peakRssKiB:telemetry?.peakRssKiB||null,observedMetal,state:job.state,error:job.error,coverage:job.coverage,reference:refs.get(name),hypothesis:text,...edit(refs.get(name),text)}; results.push(result);fs.writeFileSync(path.join(root,`${backend}-${modelId}-${name}-${iteration}.engine.log`),telemetry?.stderr||''); console.log(JSON.stringify(result)); if(job.state!=='completed'||!job.coverage?.complete)throw Error('Incomplete job');
 }} finally {await svc.dispose();}
}
fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({results,sampleSha256:Object.fromEntries(names.map(name=>[name,sha(path.join(source,name+'.wav'))])),transcriptSha256:sha(path.join(source,'transcript.txt')),runtimeVersion:'1.9.5-dev'},null,2));console.log('evidenceRoot:',root);
