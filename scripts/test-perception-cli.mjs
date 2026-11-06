import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createPerceptionService } from '../src/perception/index.js';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { requireMedia } from './perception-test-runtime.mjs';
const {ffmpeg,ffprobe}=requireMedia();
const root=path.resolve('_backups',`asr-cli-test-${Date.now()}-${process.pid}`), tree=path.join(root,'tree'), state=path.join(root,'state');
const source=process.env.PERCEPTION_CLIENT_SOURCE || path.resolve('plugins/surfcore/tools/lib');
fs.mkdirSync(path.join(tree,'scripts'),{recursive:true}); fs.mkdirSync(path.join(tree,'src'),{recursive:true}); fs.mkdirSync(path.join(tree,'plugins/surfcore/tools'),{recursive:true});
fs.writeFileSync(path.join(tree,'package.json'),'{"type":"module"}');
fs.copyFileSync('scripts/asr.mjs',path.join(tree,'scripts/asr.mjs')); fs.cpSync('src/perception',path.join(tree,'src/perception'),{recursive:true}); fs.cpSync(source,path.join(tree,'plugins/surfcore/tools/lib'),{recursive:true});
const assets=path.join(state,'perception/assets'); fs.mkdirSync(assets,{recursive:true}); fs.mkdirSync(path.join(state,'characters','fixture'),{recursive:true}); fs.writeFileSync(path.join(state,'characters','current.json'),JSON.stringify({id:'fixture',epoch:1})); const file=path.join(assets,'tone.wav'); execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=duration=1','-ar','16000','-ac','1',file]);
const runtime=path.join(root,'engine.cjs'), model=path.join(root,'model'); fs.writeFileSync(model,'model'); fs.writeFileSync(runtime,`#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv.slice(2);if(a.includes('--version'))console.log('1.9.5-dev');else fs.writeFileSync(a[a.indexOf('-of')+1]+'.json',JSON.stringify({transcription:[{offsets:{from:0,to:500},text:'fixture'}]}));\n`,{mode:0o755});
const svc=createPerceptionService({dataRoot:state,engine:{provider:'whisper.cpp',executable:runtime,runtimeVersion:'1.9.5-dev',model:{id:'fixture',path:model,sha256:crypto.createHash('sha256').update('model').digest('hex')}},ffmpegPath:ffmpeg,ffprobePath:ffprobe,getCharacter:()=>({id:'fixture',epoch:1})});await svc.ready;
const hostSource=process.env.PERCEPTION_HOST_SOURCE || path.resolve('plugins/surfcore/lib/perception-api.js');
const {createPerceptionApiService}=await import(pathToFileURL(hostSource).href); let server;
const api=createPerceptionApiService({service:svc,stateDir:state,currentDshUrl:()=>`http://127.0.0.1:${server.address().port}`,getCharacter:()=>({id:'fixture',epoch:1})});
server=http.createServer((req,res)=>void api.handle(req,res,new URL(req.url,'http://localhost'))); await new Promise(r=>server.listen(0,'127.0.0.1',r)); api.writeHostFile();

const run=(args)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(tree,'scripts/asr.mjs'),...args],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));});
try { const missingState=path.join(root,'missing-state'); fs.mkdirSync(missingState); await assert.rejects(run(['submit',file,'--state-dir',missingState,'--ffprobe',ffprobe]),/CHARACTER_REQUIRED/); const common=['--state-dir',state]; await assert.rejects(run(['submit',file,...common,'--ffprobe',ffprobe,'--character-id','fixture','--character-epoch','2']),/CHARACTER_STALE/); const status=await run(['doctor',...common]);assert.equal(status.status.ready,true);const submitted=await run(['submit',file,...common,'--ffprobe',ffprobe,'--lang','zh']);assert(submitted.jobId);let job;for(let i=0;i<200;i++){job=(await run(['inspect',submitted.jobId,...common])).job;if(['completed','failed'].includes(job.state))break;await new Promise(r=>setTimeout(r,50));}assert.equal(job.state,'completed');assert.equal(job.result.segments[0].text,'fixture');assert.equal(job.result.source.channel,'local');assert.equal(job.result.provenance.channel,'local');assert.equal(job.request,undefined);assert(!JSON.stringify(job).includes(file));console.log('CLI shared Host integration passed; evidence root:',root); } finally {await svc.dispose(); await new Promise(r=>server.close(r));}
