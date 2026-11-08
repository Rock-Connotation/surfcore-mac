// Isolated child fixture. No engine, QQ, user profile or network is involved.
import fs from 'node:fs';
import path from 'node:path';
import { createVoiceManagement } from '../../../src/voice-management.js';
const [root,name]=process.argv.slice(2);const authority=path.join(root,'state','voice-management.lock');
const read=fs.readFileSync,rename=fs.renameSync;let first=true;
const wait=predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('fixture barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}};
fs.readFileSync=function(file,...args){const result=read.call(this,file,...args);if(String(file)===authority&&first){first=false;fs.writeFileSync(path.join(root,name+'.ready'),'');wait(()=>fs.existsSync(path.join(root,'go')));}return result;};
// On the original implementation B must not rename until A has published its
// live owner and entered install. The fixed implementation never renames it.
fs.renameSync=function(from,to){if(name==='b'&&String(from)===authority)wait(()=>fs.existsSync(path.join(root,'a.entered')));return rename.call(this,from,to);};
let active=false;
const manager={list:async()=>({ok:true,packs:[{id:'voice-local',installed:true,install:active?{phase:'下载中'}:null}]}),manifests:()=>[{id:'voice-local',startScript:'run.sh'}],install:async()=>{active=true;fs.writeFileSync(path.join(root,name+'.entered'),'');return{ok:true}},cancelInstall:async()=>{active=false;return{ok:true}}};
const service=createVoiceManagement({configFile:path.join(root,'config.json'),programRoot:root,createPacks:()=>manager});
const result=await service.dispatch({method:'POST',pathname:'/packs/install',body:{id:'voice-local'}});
process.stdout.write(JSON.stringify(result)+'\n');
process.stdin.once('data',async()=>{active=false;await service.dispose();process.exit(0);});
process.stdin.resume();
