import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { testHome, shareTestRoot } from './isolate-test-home.mjs';
// 本测试既会被仓库根跑（test:audit），也会被插件包跑（npm --prefix plugins/surfcore test，cwd=plugins/surfcore）。
// 因此所有仓库内路径都必须从本文件位置推导，不能依赖 cwd。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readPluginIndex = () => fs.readFileSync(path.join(repoRoot, 'plugins', 'surfcore', 'lib', 'index.js'), 'utf8');
const dir = path.join(testHome, 'surfcore', 'bili'); fs.mkdirSync(dir, {recursive:true});
const cfg = path.join(testHome, 'surfcore', 'bili.config.json');
fs.writeFileSync(cfg, JSON.stringify({ owner:{mid:'22000'}, self:{mid:'9'}, listen:{dm:true,dmScope:'owner',comment:true,allDay:true,scope:'reply',live:false}, night:{windows:[]} }));
fs.writeFileSync(path.join(dir,'credentials.json'), JSON.stringify({sessdata:'SYNTHETIC',bili_jct:'SYNTHETIC'}));
Object.assign(process.env, shareTestRoot(), {DSH_HOME:testHome,SURFCORE_BILI_CONFIG:cfg, DSH_NODE:process.execPath});
const shim=path.join(testHome,'offline.mjs'), ready=path.join(testHome,'ready'), release=path.join(testHome,'release');
fs.writeFileSync(shim, `import fs from 'node:fs';\nglobalThis.fetch=async()=>{fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); while(!fs.existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10)); return {ok:true,status:200,json:async()=>({code:0,data:{session_list:[{talker_id:22000,account_info:{name:'fixture'},unread_count:1,last_msg:{sender_uid:22000,timestamp:1700000000,msg_key:'99001',content:JSON.stringify({content:'fixture'})}}]}})} };\n`);
const state=path.join(dir,'dm-await-state.json');
const empty={cursor:0,seen:{},pending:{},receipts:{},initialized:true}; fs.writeFileSync(state,JSON.stringify({version:2,scopes:{owner:empty,all:empty}}));
const {startScheduler}=await import('../lib/scheduler.js');
const host={enqueue:async()=>({ok:true}),retire:async()=>({ok:true,retired:true})};
const create=()=>startScheduler({get:()=>null,sessionController:{cancel:async()=>({ok:true})}},{dshHome:testHome,biliMjs:path.join(repoRoot,'plugins','surfcore','tools','bili.mjs'),cwd:testHome,memoryV2:{getRouting:()=>({ok:true,backend:'v2'})},biliV2Agent:host,log:()=>{}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let failed=0; async function test(name,fn){try{await fn();console.log('PASS '+name)}catch(e){failed++;console.log('FAIL '+name+': '+e.message)}}
await test('real descendant cannot write after retire ACK',async()=>{
 process.env.NODE_OPTIONS='--import '+shim; const s=create(); const tick=s.dmTick().catch(()=>{});
 try {
  for(let i=0;i<300&&!fs.existsSync(ready);i++) await sleep(10);
  assert.ok(fs.existsSync(ready),'offline GET not reached'); const pid=Number(fs.readFileSync(ready,'utf8'));
  const result=await s.retire({timeoutMs:500}); const before=Object.keys(JSON.parse(fs.readFileSync(state)).scopes.owner.pending).length;
  let alive=true; try{process.kill(pid,0)}catch{alive=false} fs.writeFileSync(release,'1'); await sleep(300);
  const after=Object.keys(JSON.parse(fs.readFileSync(state)).scopes.owner.pending).length;
  console.log(`DM retire=${JSON.stringify(result)} childAliveAtAck=${alive} pendingBefore=${before} pendingAfter=${after}`);
  await tick; assert.equal(after,0); assert.equal(result.ok,true); assert.equal(alive,false);
 } finally {
  // 断言失败也必须放行夹具后代，否则挂住的事件循环会让整条门禁永不返回。
  delete process.env.NODE_OPTIONS; fs.writeFileSync(release,'1'); await Promise.race([tick,sleep(2000)]);
 }
});
await test('deadline requires descendant close and retries same instance',async()=>{
 const holdReady=path.join(testHome,'hold-ready'), holdRelease=path.join(testHome,'hold-release'), holdShim=path.join(testHome,'hold.mjs');
 fs.writeFileSync(holdShim, `import fs from 'node:fs';\nprocess.on('SIGTERM',()=>{});\nglobalThis.fetch=async()=>{fs.writeFileSync(${JSON.stringify(holdReady)},String(process.pid));while(!fs.existsSync(${JSON.stringify(holdRelease)}))await new Promise(r=>setTimeout(r,10));return {ok:true,status:200,json:async()=>({code:0,data:{session_list:[]}})}};\n`);
 process.env.NODE_OPTIONS='--import '+holdShim; const s=create(), tick=s.dmTick().catch(()=>{});
 try {
  for(let i=0;i<300&&!fs.existsSync(holdReady);i++) await sleep(10);
  assert.ok(fs.existsSync(holdReady)); const first=await s.retire({timeoutMs:100});
  console.log('DEADLINE first='+JSON.stringify(first)); assert.equal(first.ok,false); assert.equal(first.code,'BILI_SCHEDULER_RETIRE_TIMEOUT');
  fs.writeFileSync(holdRelease,'1'); await tick; await sleep(150); const retry=await s.retire({timeoutMs:1000});
  console.log('DEADLINE retry='+JSON.stringify(retry)); assert.equal(retry.ok,true);
 } finally {
  delete process.env.NODE_OPTIONS; fs.writeFileSync(holdRelease,'1'); await Promise.race([tick,sleep(2000)]);
 }
});
await test('invalidate after retirement preserves actual plan and listener',async()=>{
 const plan=path.join(dir,'whale-night.json'),listen=path.join(dir,'whale-listen.json');
 const value=JSON.stringify({date:new Date().toLocaleDateString('sv-SE'),wakes:1,slot:'s',action:'wake',at:'23:00'}); const listenValue=JSON.stringify({lastSeen:12345});
 fs.writeFileSync(plan,value);fs.writeFileSync(listen,listenValue);const s=create();await s.retire({timeoutMs:500});try{s.invalidate()}catch{}
 const p=fs.readFileSync(plan,'utf8'),l=fs.readFileSync(listen,'utf8');console.log(`INVALIDATE plan=${p.trim()} listener=${l.trim()}`);assert.equal(p,value);assert.equal(l,listenValue);
});
await test('comment network cancellation actually aborts',async()=>{
 let started;const start=new Promise(r=>started=r);let aborted=false;const prior=globalThis.fetch;
 globalThis.fetch=(_url,opts)=>new Promise((resolve,reject)=>{started();opts.signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'))},{once:true});setTimeout(()=>resolve({json:async()=>({code:0,data:{items:[]}})}),200)});
 const listen=path.join(dir,'whale-listen.json'), before=fs.readFileSync(listen,'utf8');
 const s=create();const tick=s.listenTick();await start;const result=await s.retire({timeoutMs:500});await tick;globalThis.fetch=prior;
 const unchanged=fs.readFileSync(listen,'utf8')===before;console.log(`COMMENT retire=${JSON.stringify(result)} networkAborted=${aborted} listenerUnchanged=${unchanged}`);assert.equal(aborted,true);assert.equal(unchanged,true);
});
await test('lifecycle propagates host retirement failure',async()=>{
 const src=readPluginIndex();const begin=src.indexOf('retireForLifecycle: async '),end=src.indexOf('\n    lifecycleInventory:',begin);const expr='({'+src.slice(begin,end)+'})';
 const failure={ok:false,code:'BILI_TEST',error:'unconfirmed',hint:'retry',operationId:'same'};const instance=vm.runInNewContext(expr,{pluginLog(){},biliMemoryHost:{retire:async()=>failure},scheduler:null});const result=await instance.retireForLifecycle({characterId:'fixture',operationId:'same'});console.log('LIFECYCLE '+JSON.stringify(result));assert.equal(result.ok,false);assert.equal(result.operationId,'same');
});
await test('unload enters retirement protocol',async()=>{const src=readPluginIndex();const begin=src.indexOf('ctx.effect(() => () => {',src.indexOf('startSyncTimer();'));const end=src.indexOf('// 诊断日志',begin);const block=src.slice(begin,end);console.log('UNLOAD scheduler.retire='+/scheduler\?\.retire/.test(block)+' scheduler.stop='+/scheduler\?\.stop/.test(block));assert.match(block,/scheduler\?\.retire/)});
await test('unload returns structured retirement failure',async()=>{
 const src=readPluginIndex(), begin=src.indexOf('ctx.effect(() => () => {',src.indexOf('startSyncTimer();')),end=src.indexOf('// 诊断日志',begin);let cleanup;
 const failure={ok:false,code:'BILI_TEST',error:'unconfirmed',hint:'retry',operationId:'same'},reports=[];const dispose={dispose:async()=>{},stop(){}};
 const scope={ctx:{effect:fn=>{cleanup=fn()}},clearInterval(){},clearTimeout(){},companionTimer:null,memoryV2Ready:Promise.resolve(),scheduler:{retire:async()=>failure},biliMemoryHost:{close:async()=>{throw Error('must not close host')}},qqReplyHost:dispose,memoryV2:{close:async()=>{}},reportMemoryBlocked:x=>reports.push(x),voiceManagement:dispose,companionSharing:dispose,douyinCompanion:dispose,douyin:{...dispose,dispose:async()=>({ok:true})},unregisterDouyinRuntime:null,unregisterDouyin(){},biliRoundController:dispose,updates:dispose,petPurpose:dispose,petHostTimer:null,sessionEventOff:null,billing:dispose,tokenBudget:dispose,perceptionHostTimer:null,perception:dispose,closeAllQrLogins(){},characterInitial:null,characterTimer:null,syncTimer:null,bridgeRepairTimer:null,extensionHost:{deactivateAll:async()=>{}},platforms:dispose,disposers:[],pluginLog(){}};
 vm.runInNewContext(src.slice(begin,end),scope);const result=await cleanup();console.log('UNLOAD result='+JSON.stringify(result));assert.equal(result.ok,false);assert.equal(result.operationId,'same');assert.equal(reports.length,1);
});
// 夹具会 spawn CLI 后代；断言失败时若后代仍存活，事件循环会被挂住、整条门禁永不返回。
// 后代已在各测试的 finally 里放行，这里显式退出；退出码仍然如实反映断言结果。
console.log(`r3: ${failed} failures`); process.exit(failed ? 1 : 0);
