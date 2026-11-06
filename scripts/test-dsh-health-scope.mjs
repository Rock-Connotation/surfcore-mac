import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {checkProfileMcp} from '../src/dsh-health.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh 健康 空格 '));
const common=path.join(root,'common'),isolated=path.join(root,'isolated');
const complete=['mcp-snowluma','mcp-snowluma-host','mcp-web-search-safe'].map(id=>`- insert:\n    - id: ${id}`).join('\n')+'\n';
function write(home,name,text,installed=true){const dir=path.join(home,'profiles',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'cordis.patch.yml'),text);fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({dsh:{profile:{bundles:installed?['surfcore']:[]}}}));}
async function audit(env, options = {}) {
 const events=[],acks=[]; let sessionReads=0, retired=0;const source=fs.readFileSync(new URL('../src/bridge.js',import.meta.url),'utf8');
 const a=source.indexOf("  async function auditDshHealth("),b=source.indexOf('\n  function reconcileAllowlist(',a);assert.ok(a>=0&&b>a);
 const ctx={process:{env},os:{homedir:()=>common},checkProfileMcp,gateEvents:{record:e=>events.push(e),ackByDedupe:k=>acks.push(k)},log(){},api:{sessions:{list:async()=>{sessionReads++;return {items:[{sessionId:'fixture-session',agentPreset:'old'}]}}}},unwrap:x=>x,withTimeout:p=>p,DSH_CONTROL_TIMEOUT_MS:1,state:{sessions:{'private:fixture':'fixture-session'}},modePreset(){return 'new'},currentMode:'chat',cfg:{},presetMismatch:(expected,actual)=>expected!==actual,retireSession(){retired++}};
 const f=vm.runInNewContext(`(${source.slice(a,b).trim()})`,ctx);await f('fixture',options);return {events,acks,sessionReads,retired};
}
async function firstReady(mode, env) {
 const source=fs.readFileSync(new URL('../src/bridge.js',import.meta.url),'utf8');
 const a=source.indexOf('  const checkDsh = async () => {'), b=source.indexOf('  function startDshWatch()',a);assert.ok(a>=0&&b>a);
 let pending, called, wakeCount=0;
 const ctx={api:{settings:{describe:async()=>({})}},refreshMode:async()=>{},dshReady:false,dshPresetIds:[],refreshPresetList:async()=>{},reconcileSessionPolicies(){},currentMode:mode,lastMode:'',log(){},scheduleMorningGreeting(){},startProactiveScheduler(){},cfg:{purpose:{enabled:false}},socialV2:{conversations:new Map()},setupSleepTimerV2(){},scheduleProactiveCheckV2(){},reconcileAllowlist(){},wakeBacklogConversations(){wakeCount++},auditDshHealth:(reason,options)=>{called=options;pending=audit(env,options)},flushQueue:async()=>{},slangWindows:new Map(),maybeQueueSlangExtraction(){}};
 const expr=source.slice(a,b).trim().replace(/^const checkDsh = /,'').replace(/;$/,'');
 await vm.runInNewContext(`(${expr})`,ctx)(); await pending;
 return {called,result:await pending,wakeCount};
}
try {
 write(path.join(common,'.dsh'),'desktop','- id: surfcore\n');write(isolated,'desktop',complete);
 let result=await audit({USERPROFILE:common,DSH_HOME:isolated,DSH_PROFILE:'desktop'});
 assert.equal(result.events.filter(e=>e.event==='dsh-profile-mcp-missing').length,0,'healthy selected isolated profile must not inherit broken common-home alert');
 write(path.join(common,'.dsh'),'desktop',complete);write(isolated,'desktop','- id: surfcore\n');write(isolated,'sibling',complete);
 result=await audit({USERPROFILE:common,DSH_HOME:isolated,DSH_PROFILE:'desktop'});
 assert.equal(result.events.filter(e=>e.event==='dsh-profile-mcp-missing').length,1,'healthy sibling must not hide broken selected profile');assert.equal(result.events[0].reason.code,'DSH_PROFILE_MCP_MISSING');assert.match(result.events[0].reason.message,/desktop/);
 const direct=checkProfileMcp(common,{dshHome:isolated,profile:'desktop'});assert.equal(direct.ok,false);assert.equal(direct.broken[0].profile,'desktop');
 fs.unlinkSync(path.join(isolated,'profiles','desktop','cordis.patch.yml'));
 const missing=checkProfileMcp(common,{dshHome:isolated,profile:'desktop'});assert.equal(missing.ok,false);assert.equal(missing.status,'unknown');assert.ok(missing.code&&missing.hint);

 result=await audit({USERPROFILE:common,DSH_HOME:isolated,DSH_PROFILE:'desktop'});assert.equal(result.events[0].reason.code,'DSH_PROFILE_PATCH_UNREADABLE');assert.equal(result.events[0].confidence,'unknown');assert.equal(result.acks.includes('dsh-profile-mcp-missing'),false);
 write(isolated,'desktop',complete+'- id: mcp-snowluma\n  disabled: true\n');
 const disabled=checkProfileMcp(common,{dshHome:isolated,profile:'desktop'});assert.equal(disabled.status,'broken');assert.deepEqual(disabled.broken[0].missing,['mcp-snowluma']);
 write(isolated,'desktop','- insert: [bad\n');const malformed=checkProfileMcp(common,{dshHome:isolated,profile:'desktop'});assert.equal(malformed.status,'unknown');assert.ok(malformed.code&&malformed.hint);
 write(isolated,'desktop','');const empty=checkProfileMcp(common,{dshHome:isolated,profile:'desktop'});assert.equal(empty.status,'broken');assert.equal(empty.broken[0].missing.length,3);
 write(isolated,'desktop',complete);result=await audit({USERPROFILE:common,DSH_HOME:isolated,DSH_PROFILE:'desktop'});assert.ok(result.acks.includes('dsh-profile-mcp-missing'));assert.ok(result.acks.includes('dsh-profile-mcp-unknown'));
 let ready=await firstReady('chat',{USERPROFILE:common,DSH_HOME:isolated,DSH_PROFILE:'desktop'});assert.equal(ready.called.profileOnly,true);assert.equal(ready.result.sessionReads,0);assert.equal(ready.result.retired,0);assert.ok(ready.result.acks.includes('dsh-profile-mcp-missing'));assert.equal(ready.wakeCount,0);
 ready=await firstReady('reserved2',{USERPROFILE:common,DSH_HOME:isolated,DSH_PROFILE:'desktop'});assert.equal(ready.called.profileOnly,false);assert.equal(ready.result.sessionReads,1);assert.equal(ready.result.retired,1);assert.equal(ready.wakeCount,1);
 const ambiguous=checkProfileMcp(common,{dshHome:isolated,resolveProfile:true});assert.equal(ambiguous.status,'unknown');assert.equal(ambiguous.code,'DSH_PROFILE_AMBIGUOUS');assert.ok(ambiguous.hint);
 result=await audit({USERPROFILE:common,DSH_HOME:isolated});assert.equal(result.events[0].reason.code,'DSH_PROFILE_AMBIGUOUS');assert.equal(result.acks.includes('dsh-profile-mcp-missing'),false);
 write(isolated,'sibling',complete,false);const unique=checkProfileMcp(common,{dshHome:isolated,resolveProfile:true});assert.equal(unique.status,'healthy');assert.equal(unique.profile,'desktop');
 write(isolated,'desktop','- id: mcp-snowluma\n  disabled: false\n- id: mcp-snowluma-host\n- id: mcp-web-search-safe\n');const overrides=checkProfileMcp(common,{dshHome:isolated,profile:'desktop'});assert.equal(overrides.status,'broken');assert.equal(overrides.broken[0].missing.length,3);
 const traversal=checkProfileMcp(common,{dshHome:isolated,profile:'../other'});assert.equal(traversal.status,'unknown');assert.equal(traversal.code,'DSH_PROFILE_INVALID');
 console.log('PASS current profile scope, malformed/disabled, ambiguity and actual bridge audit');
} finally {fs.rmSync(root,{recursive:true,force:true});}
