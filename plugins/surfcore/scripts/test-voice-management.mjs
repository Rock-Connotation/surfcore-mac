import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createVoiceManagement } from '../../../src/voice-management.js';

function fixture(options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-voice-management-'));
  const file=path.join(root,'config.json');
  fs.writeFileSync(file,JSON.stringify({other:{keep:'unchanged'},socialV2:{voice:{enabled:false,tts:{enabled:false},trigger:{members:['fixture']}}}}));
  let created=0, active=false, calls=[];
  const manager={ list:async()=>({ok:true,packs:[{id:'voice-local',installed:true,running:false,install:active?{phase:'下载中',progress:41}:null}]}),
    manifests:()=>[{id:'voice-local',startScript:'run.sh'}], install:async()=>{active=true;calls.push('install');return{ok:true};},
    cancelInstall:async()=>{active=false;return{ok:true};},activate:async()=>({ok:true}), stop:async()=>({ok:true}),
    readCloudConfig:async()=>({ok:true,hasAccessKey:false}),sampleFile:async()=>({buffer:Buffer.from('fixture'),name:'fixture.wav'}) };
  const make=(extra={})=>createVoiceManagement({configFile:file,programRoot:root,createPacks:(cfg,opts)=>{created++;assert.equal(opts.configFile,file);return manager;},...options,...extra});
  return {root,file,manager,make,calls,get created(){return created;}};
}
const request=(pathname,body={})=>({method:'POST',pathname,body});

test('management reads work without bridge, engine or config changes',async()=>{
 const f=fixture();const svc=f.make();const bytes=fs.readFileSync(f.file);
 assert.equal((await svc.dispatch({pathname:'/packs'})).data.packs.length,1);
 assert.equal((await svc.dispatch({pathname:'/rules'})).data.aiEnabled,false);
 assert.deepEqual(fs.readFileSync(f.file),bytes);
 assert.equal(fs.existsSync(path.join(f.root,'state')),false);
 const unknown=await svc.dispatch({pathname:'/packs/invalid'});assert.equal(unknown.status,404);assert(unknown.data.code&&unknown.data.hint);
 const unsupported=await svc.dispatch({method:'DELETE',pathname:'/packs/start'});assert.equal(unsupported.status,405);
 await svc.dispose();
});
test('same-process handles share live progress and fresh configuration without losing cancellation',async()=>{
 const f=fixture();const a=f.make(),b=f.make();
 assert.equal((await a.dispatch(request('/packs/install',{id:'voice-local'}))).data.ok,true);
 const disk=JSON.parse(fs.readFileSync(f.file));disk.other.newField='later';fs.writeFileSync(f.file,JSON.stringify(disk));
 assert.equal((await a.dispatch({pathname:'/packs'})).data.packs[0].install.progress,41);assert.equal(f.created,1);
 assert.equal((await b.dispatch({pathname:'/packs'})).data.packs[0].install.progress,41);
 await a.dispose();
 assert.equal((await b.dispatch(request('/packs/cancel',{id:'voice-local'}))).data.ok,true);
 assert.equal((await b.dispatch(request('/rules',{aiEnabled:true,route:'cloud'}))).data.ok,true);
 const saved=JSON.parse(fs.readFileSync(f.file));assert.equal(saved.other.newField,'later');assert.equal(saved.other.keep,'unchanged');assert.deepEqual(saved.socialV2.voice.trigger.members,['fixture']);assert.equal(saved.socialV2.voice.enabled,false);assert.equal(saved.socialV2.voice.tts.route,'cloud');
 await a.dispose();await b.dispose();
});
test('pack path config changes take effect after background operation, not unrelated mtime changes',async()=>{
 const f=fixture();const a=f.make();await a.dispatch(request('/packs/install',{id:'voice-local'}));
 const cfg=JSON.parse(fs.readFileSync(f.file));cfg.voicePacks={dir:path.join(f.root,'new-packs')};fs.writeFileSync(f.file,JSON.stringify(cfg));
 await a.dispatch({pathname:'/packs'});assert.equal(f.created,1);
 await a.dispatch(request('/packs/cancel',{id:'voice-local'}));await a.dispatch({pathname:'/packs'});assert.equal(f.created,2);await a.dispose();
});
test('invalid config is visible and never overwritten',async()=>{
 const f=fixture();fs.writeFileSync(f.file,'{broken');const a=f.make();const result=await a.dispatch(request('/rules',{aiEnabled:true}));
 assert.equal(result.data.code,'VOICE_CONFIG_INVALID');assert(result.data.hint);assert.equal(fs.readFileSync(f.file,'utf8'),'{broken');await a.dispose();
});
test('unconfigured synthesis never reaches a service; failed health never causes a charged synthesis',async()=>{
 const f=fixture();let fetches=0,synths=0;const a=f.make({fetchImpl:async()=>{fetches++;throw new Error('fixture');},synthesize:async()=>{synths++;}});
 const off=await a.dispatch(request('/tts-check'));assert.equal(off.data.code,'VOICE_TTS_DISABLED');assert(off.data.hint);assert.equal(fetches,0);
 const cfg=JSON.parse(fs.readFileSync(f.file));cfg.socialV2.voice.tts.enabled=true;fs.writeFileSync(f.file,JSON.stringify(cfg));
 const down=await a.dispatch(request('/tts-check'));assert.equal(down.data.code,'VOICE_SERVICE_UNAVAILABLE');assert(down.data.hint);assert.equal(fetches,1);assert.equal(synths,0);await a.dispose();
});
test('self-check targets exactly the selected provider wrapper and never sends QQ or retries',async()=>{
 const f=fixture();const cfg=JSON.parse(fs.readFileSync(f.file));cfg.socialV2.voice.tts={enabled:true,route:'cloud',endpoints:{cloud:'http://127.0.0.1:18767'}};fs.writeFileSync(f.file,JSON.stringify(cfg));
 let health=0,synth=0;const a=f.make({fetchImpl:async url=>{health++;assert.equal(url,'http://127.0.0.1:18767/v1/health');return{ok:true};},synthesize:async opts=>{synth++;assert.equal(opts.baseUrl,'http://127.0.0.1:18767');return{durationMs:500};}});
 const result=await a.dispatch(request('/tts-check'));assert.equal(result.data.ok,true);assert.equal(result.data.stages[2].name,'scope');assert.equal(health,1);assert.equal(synth,1);await a.dispose();
});
test('Windows-only runtime is refused on Mac before download or launch',async()=>{
 const f=fixture();f.manager.manifests=()=>[{id:'voice-local',startScript:'run.bat'}];const a=f.make({platform:'darwin'});
 for(const op of ['install','start','activate','stop']){const r=await a.dispatch(request('/packs/'+op,{id:'voice-local'}));assert.equal(r.data.code,'VOICE_PACK_PLATFORM_UNSUPPORTED');assert(r.data.hint);}
 assert.equal(f.calls.length,0);await a.dispose();
});

test('retired self-check never starts synthesis after a late health reply',async()=>{
 const f=fixture();const cfg=JSON.parse(fs.readFileSync(f.file));cfg.socialV2.voice.tts.enabled=true;fs.writeFileSync(f.file,JSON.stringify(cfg));
 let release,synths=0;const a=f.make({fetchImpl:()=>new Promise(r=>{release=r}),synthesize:async()=>{synths++;return{}}});
 const waiting=a.dispatch(request('/tts-check'));while(!release)await new Promise(r=>setImmediate(r));await a.dispose();release({ok:true});
 const result=await waiting;assert.equal(result.data.code,'VOICE_MANAGEMENT_CLOSED');assert.equal(synths,0);
});
test('new handle after dispose can inspect and cancel old background install',async()=>{
 const f=fixture();const a=f.make();await a.dispatch(request('/packs/install',{id:'voice-local'}));await a.dispose();
 assert.equal((await a.dispatch({pathname:'/packs'})).data.code,'VOICE_MANAGEMENT_CLOSED');
 const b=f.make();assert.equal((await b.dispatch({pathname:'/packs'})).data.packs[0].install.progress,41);
 assert.equal((await b.dispatch(request('/packs/cancel',{id:'voice-local'}))).data.ok,true);assert.equal(f.created,1);await b.dispose();
});

test('two processes recovering one dead owner cannot both enter installation',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const {once}=await import('node:events');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-stale-race-'));fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'config.json'),'{}');
 fs.writeFileSync(path.join(root,'state','voice-management.lock'),JSON.stringify({pid:99999999,owner:'dead-owner'}));
 const children=['a','b'].map(name=>spawn(process.execPath,[fileURLToPath(new URL('./voice-management-race-child.mjs',import.meta.url)),root,name],{stdio:['pipe','pipe','pipe']}));
 const responses=children.map(child=>new Promise((resolve,reject)=>{let out='',err='';child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>{if(code)reject(new Error(err))});child.stdout.on('data',b=>{out+=b;if(out.includes('\n'))resolve(JSON.parse(out.split('\n')[0]));});}));
 try {
  const deadline=Date.now()+5000;while(!['a','b'].every(n=>fs.existsSync(path.join(root,n+'.ready')))){assert(Date.now()<deadline,'both stale readers must reach barrier');await new Promise(r=>setTimeout(r,5));}
  fs.writeFileSync(path.join(root,'go'),'');const results=await Promise.all(responses);
  assert.equal(results.filter(r=>r.data.ok).length,1,'only one process may own the live installation');
  const refused=results.find(r=>!r.data.ok);assert.equal(refused.data.code,'VOICE_MANAGEMENT_BUSY');assert(refused.data.hint);
 }finally{await Promise.all(children.map(async child=>{const exited=once(child,'exit');child.stdin.write('finish');await exited;}));}
});

test('late settle cannot release the lease of a newer background install',async()=>{
 const f=fixture();const a=f.make();await a.dispatch({pathname:'/packs'});
 let oldListRelease,gate=true,active=false;
 f.manager.list=async()=>{
  if(gate){gate=false;return await new Promise(resolve=>{oldListRelease=()=>resolve({ok:true,packs:[{id:'voice-local',installed:true}]})})}
  return{ok:true,packs:[{id:'voice-local',installed:true,install:active?{phase:'下载中'}:null}]};
 };
 f.manager.install=async()=>{active=true;return{ok:true}};
 const older=a.dispatch(request('/rules',{aiEnabled:false}));while(!oldListRelease)await new Promise(r=>setImmediate(r));
 assert.equal((await a.dispatch(request('/packs/install',{id:'voice-local'}))).data.ok,true);
 oldListRelease();await older;
 assert.equal(fs.existsSync(path.join(f.root,'state','voice-management.lock')),true,'newer live job retains exclusive ownership');
 active=false;await a.dispose();
});

test('concurrent refresh cannot replace the manager of a new installation',async()=>{
 const f=fixture();let created=0,gated=false;const gates=[];const managers=[];
 const a=f.make({createPacks:()=>{
  const index=++created;const state={active:false,cancelled:false};managers.push(state);
  return {manifests:()=>[{id:'voice-local',startScript:'run.sh'}],
   list:async()=>{if(index===1&&gated&&gates.length<2)return await new Promise(resolve=>gates.push(()=>resolve({ok:true,packs:[{id:'voice-local',installed:true}]})));
    return {ok:true,packs:[{id:'voice-local',installed:true,install:state.active?{phase:'下载中',progress:73}:null}]};},
   install:async()=>{state.active=true;return{ok:true}},cancelInstall:async()=>{state.cancelled=true;state.active=false;return{ok:true}}};
 }});
 await a.dispatch({pathname:'/packs'});const cfg=JSON.parse(fs.readFileSync(f.file));cfg.voicePacks={dir:path.join(f.root,'changed')};fs.writeFileSync(f.file,JSON.stringify(cfg));gated=true;
 const install=a.dispatch(request('/packs/install',{id:'voice-local'})),poll=a.dispatch({pathname:'/packs'});
 while(gates.length<2)await new Promise(r=>setImmediate(r));gates[0]();await install;gates[1]();
 assert.equal((await poll).data.packs[0].install.progress,73);assert.equal(created,2,'only one refresh may create a new manager');
 assert.equal((await a.dispatch(request('/packs/cancel',{id:'voice-local'}))).data.ok,true);assert.equal(managers[1].cancelled,true);await a.dispose();
});
