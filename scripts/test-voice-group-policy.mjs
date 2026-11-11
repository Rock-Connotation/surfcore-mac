import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {voiceGroupPolicies,voiceGroupPoliciesFromRows} from '../src/voice-group-policy.js';
import {voiceSendBudget} from '../src/voice-send-budget.js';
import {createVoiceManagement} from '../src/voice-management.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-group-'));
const groups=voiceGroupPoliciesFromRows([{groupId:'12345',triggerWho:'mention',maxPerDay:1},{groupId:'22345',triggerWho:'owner',maxPerDay:0}]);
assert.deepEqual(voiceGroupPolicies(groups),groups);
for(const rows of [[{groupId:'12345',triggerWho:'anyone',maxPerDay:0}],[{groupId:'12345',triggerWho:'owner',maxPerDay:501}],[{groupId:'12345',triggerWho:'owner',maxPerDay:1.2}],[{groupId:'12345',triggerWho:'owner',maxPerDay:1},{groupId:'12345',triggerWho:'owner',maxPerDay:0}]]) assert.throws(()=>voiceGroupPoliciesFromRows(rows),e=>e.code==='VOICE_GROUP_RULES_INVALID'&&!!e.hint);
const now=Date.now();
voiceSendBudget(root,{type:'initialize',count:0,evidence:'isolated fixture starts empty'},now);
let id=voiceSendBudget(root,{type:'reserve',key:'group:12345',groupLimit:1},now+1);
voiceSendBudget(root,{id,result:'rejected'},now+2);
id=voiceSendBudget(root,{type:'reserve',key:'group:12345',groupLimit:1},now+3);
voiceSendBudget(root,{id,result:'sent'},now+4);
assert.throws(()=>voiceSendBudget(root,{type:'check',key:'group:12345',groupLimit:1},now+5),e=>e.code==='VOICE_GROUP_DAILY_LIMIT'&&!!e.hint);
id=voiceSendBudget(root,{type:'reserve',key:'group:22345',groupLimit:0},now+5);voiceSendBudget(root,{id,result:'sent'},now+6);
assert.equal(voiceSendBudget(root,'inspect',now+7).count,2);
assert.equal(voiceSendBudget(root,'inspect',now+7).groups['group:12345'],1);
const next=new Date(now);next.setDate(next.getDate()+1);next.setHours(0,0,1,0);
id=voiceSendBudget(root,{type:'reserve',key:'group:12345',groupLimit:1},next.getTime());voiceSendBudget(root,{id,result:'sent'},next.getTime()+1);
assert.equal(voiceSendBudget(root,'inspect',next.getTime()+2).groups['group:12345'],1);
const h=await bridgeHarness({config:{socialV2:{voice:{enabled:true,trigger:{who:'owner'},groupPolicies:groups}}}});
try{
 assert.match(h.voiceTriggerBlock('group:12345','group','12345'),/@/);
 h.voiceMentionAt.set('group:12345',Date.now());
 assert.equal(h.voiceTriggerBlock('group:12345','group','12345'),null);
 assert.match(h.voiceTriggerBlock('group:22345','group','22345'),/主人/);
 h.voiceLastSentAt.set('group:12345',Date.now()+1);
 assert.match(h.voiceTriggerBlock('group:12345','group','12345'),/已发送/);
 h.voiceOwnerAt.set('group:22345',Date.now());assert.equal(h.voiceTriggerBlock('group:22345','group','22345'),null);
 assert.match(h.voiceTriggerBlock('group:32345','group','32345'),/主人/);
 assert.match(h.voiceTriggerBlock('private:999','private','999'),/主人/);
}finally{await h.close();}
const configFile=path.join(root,'config.json');fs.writeFileSync(configFile,JSON.stringify({ownerQQ:123,socialV2:{voice:{trigger:{who:'owner'}}}}));
const m=createVoiceManagement({configFile,programRoot:root});
try{
 const before=await m.dispatch({method:'GET',pathname:'/rules'});
 const saved=await m.dispatch({method:'POST',pathname:'/rules',body:{baseStamp:before.data.configStamp,groupRules:[{groupId:'12345',triggerWho:'mention',maxPerDay:10}]}});
 assert.equal(saved.status,200);
 const loaded=await m.dispatch({method:'GET',pathname:'/rules'});assert.equal(loaded.data.triggerWho,'owner');assert.equal(loaded.data.groupRules[0].maxPerDay,10);assert.equal(loaded.data.maxPerDay,500);
 const invalid=await m.dispatch({method:'POST',pathname:'/rules',body:{groupRules:[{groupId:'12345',triggerWho:'owner',maxPerDay:-1}]}});assert.equal(invalid.status,400);assert.equal(invalid.data.code,'VOICE_GROUP_RULES_INVALID');assert.ok(invalid.data.hint);
 const conflict=await m.dispatch({method:'POST',pathname:'/rules',body:{baseStamp:before.data.configStamp,groupRules:[]}});assert.equal(conflict.data.code,'CONFIG_STALE');assert.ok(conflict.data.hint);
}finally{await m.dispose();}
console.log('PASS group policy: permissions, one voice per mention, daily counters, midnight, API validation and stale writes');
