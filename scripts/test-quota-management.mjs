import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createVoiceManagement} from '../src/voice-management.js';
import {saveVolcKey} from '../src/voice-volc-key.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-management-quota-'));
const configFile=path.join(root,'config.json'); fs.writeFileSync(configFile,JSON.stringify({socialV2:{voice:{}}}));
const m=createVoiceManagement({configFile,programRoot:root,synthesize:async()=>{throw Object.assign(new Error('火山语音月字符额度已达到上限。'),{code:'VOICE_VOLC_BUDGET_EXHAUSTED',hint:'核对本月用量。'});}});
try {
  const updated=await m.dispatch({method:'POST',pathname:'/volc-config',body:{monthlyQuota:900000}});
  assert.equal(updated.status,200); assert.equal(updated.data.monthlyLimit,900000);
  const invalid=await m.dispatch({method:'POST',pathname:'/volc-config',body:{monthlyQuota:900001}});
  assert.equal(invalid.data.code,'VOICE_VOLC_QUOTA_INVALID'); assert.ok(invalid.data.hint);
  const id=saveVolcKey(configFile,'fixture-key');
  const config=JSON.parse(fs.readFileSync(configFile)); Object.assign(config.socialV2.voice.tts,{enabled:true,route:'cloud',cloudProvider:'volc',volcKeyId:id}); fs.writeFileSync(configFile,JSON.stringify(config));
  const diagnostic=await m.dispatch({method:'POST',pathname:'/tts-check'});
  assert.equal(diagnostic.data.code,'VOICE_VOLC_BUDGET_EXHAUSTED'); assert.match(diagnostic.data.error,/月字符额度/); assert.ok(diagnostic.data.hint);
  const client=fs.readFileSync(new URL('../plugins/surfcore/lib/client.js',import.meta.url),'utf8');
  assert.match(client,/value > 900000\).*月上限需为1至900000/);
  assert.match(client,/id: "volc-month-limit", type: "number", min: 1, max: 900000/);
  console.log('management regression passed: 900000 accepted; 900001 rejected with hint; UI bounds');
} finally { await m.dispose(); fs.rmSync(root,{recursive:true,force:true}); }
