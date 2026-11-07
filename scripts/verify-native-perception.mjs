#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createPerceptionService} from '../src/perception/index.js';
import {probeAudio} from '../src/perception/media.js';
const args=process.argv.slice(2); const get=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
const fail=(code,error,hint)=>Object.assign(new Error(error),{code,hint});
const hash=async file=>{const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');};
async function main(){
 const whisper=get('--whisper-dir'),media=get('--media-dir'),model=get('--model'),sample=get('--sample'),out=get('--out');
 if(args.length!==10 || ![whisper,media,model,sample,out].every(p=>p&&path.isAbsolute(p)))throw fail('ARGUMENT_INVALID','缺少绝对路径参数。','提供 --whisper-dir、--media-dir、--model、--sample 和新的 --out 目录。');
 if(fs.existsSync(out))throw fail('OUTPUT_EXISTS','验证目录已存在。','选择一个新的隔离 --out 目录。');
 if(process.env.PATH!=='/usr/bin:/bin:/usr/sbin:/sbin'||Object.keys(process.env).some(k=>k.startsWith('DYLD_')))throw fail('ENVIRONMENT_INVALID','测试环境没有使用干净 PATH 或仍含 DYLD 变量。','通过 env -i 设置 PATH=/usr/bin:/bin:/usr/sbin:/sbin 后重试。');
 const binary=path.join(whisper,'bin','whisper-cli'),ffmpeg=path.join(media,'ffmpeg'),ffprobe=path.join(media,'ffprobe');
 for(const [label,file] of Object.entries({binary,ffmpeg,ffprobe,model,sample})){try{if(!fs.statSync(file).isFile())throw Error();}catch{throw fail('ASSET_UNAVAILABLE',`${label} 资产不可用。`,'检查所给便携运行时、媒体工具、模型及样本的绝对路径后重试。');}}
 const modelSha=await hash(model), sampleSha=await hash(sample);
 if(modelSha!=='1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'||sampleSha!=='099755e5f10e168e2b3559c124288ec63eff5d8c9d58a146f84abe9e7897b089')throw fail('ASSET_HASH_MISMATCH','模型或样本摘要不匹配。','使用已核验的 small 模型和公共中文样本。');
 fs.mkdirSync(out,{mode:0o700}); const rows=[]; const duration=(await probeAudio(sample,ffprobe)).durationMs; const range={startMs:0,endMs:duration};
 const wait=async(svc,id)=>{for(let i=0;i<3600;i++){const j=await svc.getJob(id);if(['completed','partial','failed','cancelled'].includes(j.state))return j;await new Promise(r=>setTimeout(r,100));}throw fail('JOB_TIMEOUT','转写作业未按时完成。','保留隔离日志并检查本机推理资源。');};
 for(const backend of ['cpu','metal']){
  let log=''; const observed=(exe,a,opts)=>{const child=spawn(exe,a,opts);if(exe===binary&&a.includes('-m'))child.stderr?.on('data',b=>{log+=b.toString();});return child;};
  const state=path.join(out,`测试 数据 ${backend}`);const svc=createPerceptionService({dataRoot:state,engine:{provider:'whisper.cpp',executable:binary,runtimeVersion:'1.9.5-dev',...(backend==='cpu'?{backend:'cpu'}:{}),model:{id:'small',path:model,sha256:modelSha}},ffmpegPath:ffmpeg,ffprobePath:ffprobe,getCharacter:()=>({id:'native-smoke',epoch:1}),dependencies:{spawn:observed}});await svc.ready;
  try{const doctor=await svc.doctor();if(!doctor.ready)throw fail(doctor.code,doctor.error,doctor.hint);const assets=path.join(state,'perception/assets'),audio=path.join(assets,'公开 中文.wav');fs.copyFileSync(sample,audio,fs.constants.COPYFILE_EXCL);
   const request={activityId:`native-${backend}`,asset:{assetId:'public-sample',contentSha256:sampleSha,localPath:audio,durationMs:duration,sourceDurationMs:duration,acquiredRanges:[range],timelineMap:[{localStartMs:0,localEndMs:duration,sourceStartMs:0,sourceEndMs:duration}]},provenance:{channel:'local',sourceId:'public-sample',acquiredAtMs:0},source:{channel:'local'},requestedRanges:[range],languageHint:'zh'};
   if(backend==='cpu'){const missing={...request,asset:{...request.asset,localPath:path.join(assets,'缺失.wav')}};const {jobId}=await svc.submit(missing),job=await wait(svc,jobId);assert.equal(job.state,'failed');assert.equal(job.error.code,'ASSET_UNAVAILABLE');assert(job.error.error&&job.error.hint);rows.push({backend,fixture:'missing-asset',state:job.state,error:job.error});}
   const start=Date.now(),{jobId}=await svc.submit(request),job=await wait(svc,jobId);const elapsedMs=Date.now()-start;
   fs.writeFileSync(path.join(out,`${backend}.stderr.log`),log,{flag:'wx'});
   assert.equal(job.state,'completed',JSON.stringify(job.error));assert.equal(job.result.coverage.complete,true);assert.deepEqual(job.result.coverage.processedRanges,[range]);assert.deepEqual(job.result.coverage.missingRanges,[]);assert(job.result.segments.length>0);assert.equal(job.progress.chunksDone,1);
   if(backend==='cpu')assert.match(log,/use gpu\s*=\s*0/);else{assert.match(log,/whisper_backend_init_gpu: using MTL\d+ backend/);assert.match(log,/using embedded metal library/);}
   rows.push({backend,state:job.state,elapsedMs,coverage:job.result.coverage,segments:job.result.segments,engine:job.result.engine,backendEvidence:backend==='cpu'?'use gpu = 0':'MTL backend and embedded metal library'});
  }finally{await svc.dispose();}
 }
 const result={ok:true,node:process.version,arch:process.arch,platform:process.platform,path:process.env.PATH,dyldCleared:true,modelSha,sampleSha,whisperSha:await hash(binary),ffmpegSha:await hash(ffmpeg),ffprobeSha:await hash(ffprobe),durationMs:duration,rows};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code||'VERIFY_FAILED',error:e.message,hint:e.hint||'检查隔离验证输出与本地依赖后重试。'}));process.exitCode=1;});
