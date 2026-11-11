import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = (code, message, hint) => Object.assign(new Error(message), { code, hint });
const unavailable = () => fail('VOICE_SEND_BUDGET_UNAVAILABLE', '语音发送额度账本不可用。', '停止发送并检查账本权限和完整性，保留原文件。');
const busy = () => fail('VOICE_SEND_BUDGET_BUSY', '另一条语音正在处理。', '等待当前发送完成；若持续出现，检查桥接进程。');
const uncertain = () => fail('VOICE_SEND_UNCERTAIN', '上一条语音的发送结果尚未确认。', '停止重试，使用 voice-send-reconcile.mjs inspect 查看，再根据网关证据对账。');
const day = now => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
function rollDay(data, date) {
  if (date !== data.day) { data.day = date; data.count = 0; data.groups = {}; }
}
function countSuccess(data, key, date) {
  rollDay(data, date);
  if (data.count >= 500) throw unavailable();
  data.count++;
  if (key.startsWith('group:')) data.groups[key] = (data.groups[key] || 0) + 1;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

function lockState(stateDir) {
  let file = path.join(stateDir, 'voice-send-budget.lock');
  for (let depth=0; depth<128; depth++) {
    try {
      const st=fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) throw unavailable();
      const fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let record; try { record=JSON.parse(fs.readFileSync(fd,'utf8')); } finally { fs.closeSync(fd); }
      if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !/^[0-9a-f-]{36}$/.test(record.owner)) throw unavailable();
      if (alive(record.pid)) throw busy();
      const next=crypto.createHash('sha256').update(file+'\0'+record.owner).digest('hex');
      file=path.join(stateDir,`voice-send-budget.recovered-${next}.lock`);
    } catch(e) { if(e.code==='ENOENT') return file; throw e; }
  }
  throw unavailable();
}

export function voiceSendBudget(stateDir, action, now = Date.now()) {
  if (!path.isAbsolute(stateDir) || !Number.isSafeInteger(now) || now < 0) throw unavailable();
  let owned='', candidate='';
  try {
    fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
    const st=fs.lstatSync(stateDir); if(!st.isDirectory() || st.isSymbolicLink()) throw unavailable();
    const lock=lockState(stateDir), owner=crypto.randomUUID();
    candidate=path.join(stateDir,`.voice-lock-${owner}.tmp`);
    const fd=fs.openSync(candidate,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid,owner})); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(candidate,lock); owned=lock; } catch(e) { if(e.code==='EEXIST') throw busy(); throw e; }
    const file=path.join(stateDir,'voice-send-budget.json');
    let data, missing=false;
    try {
      const before=fs.lstatSync(file); if(!before.isFile() || before.isSymbolicLink()) throw unavailable();
      const fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const s=fs.fstatSync(fd), after=fs.lstatSync(file);
        if(after.isSymbolicLink() || before.dev!==s.dev || before.ino!==s.ino || after.dev!==s.dev || after.ino!==s.ino || !s.isFile() || s.size>4*1024*1024 || (process.platform!=='win32' && (s.mode & 0o077))) throw unavailable();
        data=JSON.parse(fs.readFileSync(fd,'utf8'));
      } finally { fs.closeSync(fd); }
    } catch(e) {
      if(e.code!=='ENOENT') throw e;
      missing=true; data={version:2,day:day(now),count:500,lastAt:0,pending:null,reconciliations:[]};
    }
    if(!data || data.version!==2 || !/^\d{4}-\d{2}-\d{2}$/.test(data.day) || !Number.isSafeInteger(data.count) || data.count<0 || data.count>500 || !Number.isSafeInteger(data.lastAt) || data.lastAt<0 || data.lastAt>now || !Array.isArray(data.reconciliations) || (data.pending!==null && (!/^[0-9a-f-]{36}$/.test(data.pending.id) || !Number.isSafeInteger(data.pending.pid) || data.pending.pid<1 || !Number.isSafeInteger(data.pending.at) || data.pending.at<0 || data.pending.at>now || typeof data.pending.key!=='string' || !/^(private|group):\d+$/.test(data.pending.key) || !['active','uncertain'].includes(data.pending.state)))) throw unavailable();
    data.groups ??= {};
    if (!data.groups || Array.isArray(data.groups) || typeof data.groups !== 'object' || Object.entries(data.groups).some(([key,count]) => !/^group:\d+$/.test(key) || !Number.isSafeInteger(count) || count<0 || count>data.count) || Object.values(data.groups).reduce((a,b)=>a+b,0)>data.count) throw unavailable();
    const today=day(now); if(today<data.day) throw unavailable();
    let response, deferredError;
    if(action==='inspect') return { ...structuredClone(data), initialized: !missing };
    if(action==='initialize' || action?.type==='initialize') {
      if(!missing) return;
      if(action?.type==='initialize') {
        if(!Number.isSafeInteger(action.count) || action.count<0 || action.count>500 || typeof action.evidence!=='string' || action.evidence.trim().length<5 || action.evidence.length>500) throw unavailable();
        data.count=action.count;
        data.reconciliations.push({type:'opening-balance',count:action.count,recordedAt:now,evidence:action.evidence.trim()});
      }
    }
    else if(action==='check' || action?.type==='check' || action?.type==='reserve') {
      if(data.pending && (data.pending.state==='uncertain' || !alive(data.pending.pid))) throw uncertain();
      if(action?.type==='reserve' && data.pending) throw busy();
      if (action?.groupLimit !== undefined && (!Number.isSafeInteger(action.groupLimit) || action.groupLimit<0 || action.groupLimit>500)) throw unavailable();
      if (today===data.day && action?.key?.startsWith('group:') && action.groupLimit>0 && (data.groups[action.key] || 0)>=action.groupLimit) throw fail('VOICE_GROUP_DAILY_LIMIT','这个群今天的语音已达到 '+action.groupLimit+' 条。','本地午夜后重试，或由主人调整该群日额度。');
      if(today===data.day && data.count>=500) {
        const limit=fail(missing ? 'VOICE_SEND_BASELINE_REQUIRED' : 'VOICE_DAILY_LIMIT', missing ? '缺少当天历史发送次数，今天按 500 条保守处理。' : '今天发送语音已达 500 条。', '保留账本，本地日期进入下一天后再发送。');
        if(!missing) throw limit;
        deferredError=limit;
      } else if(action==='check' || action?.type==='check') return;
      else {
        if(!/^(private|group):\d+$/.test(action.key || '')) throw unavailable();
        rollDay(data,today);
        data.pending={id:crypto.randomUUID(),pid:process.pid,at:now,key:action.key,state:'active'};
        response=data.pending.id;
      }
    } else if(!action?.type && action?.id && data.pending?.id===action.id && ['sent','rejected','uncertain'].includes(action.result)) {
      if(action.result==='sent') countSuccess(data,data.pending.key,today);
      if(action.result==='uncertain') data.pending.state='uncertain'; else data.pending=null;
    } else if(action?.type==='reconcile' && data.pending?.id===action.id && ['sent','rejected'].includes(action.result)) {
      if(data.pending.state==='active' && alive(data.pending.pid)) throw busy();
      if(typeof action.evidence!=='string' || action.evidence.trim().length<5 || action.evidence.length>500) throw unavailable();
      const acceptedAt=action.result==='sent' ? action.acceptedAt : null;
      if(action.result==='sent' && (!Number.isSafeInteger(acceptedAt) || acceptedAt<data.pending.at || acceptedAt>now)) throw unavailable();
      const pendingRecord=data.pending;
      if(acceptedAt!==null) { const acceptedDay=day(acceptedAt); if(acceptedDay<data.day) throw unavailable(); countSuccess(data,data.pending.key,acceptedDay); }
      data.reconciliations.push({ ...pendingRecord,result:action.result,acceptedAt,recordedAt:now,evidence:action.evidence.trim() });
      data.pending=null;
    } else throw unavailable();
    data.lastAt=now;
    if (Buffer.byteLength(JSON.stringify(data)) > 4*1024*1024) throw unavailable();
    const temp=path.join(stateDir,`.voice-send-${crypto.randomUUID()}.tmp`);
    try { const fd=fs.openSync(temp,'wx',0o600); try { fs.writeFileSync(fd,JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp,file); if(process.platform!=='win32') { const dir=fs.openSync(stateDir,'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } }
    finally { try { fs.unlinkSync(temp); } catch {} }
    if(deferredError) throw deferredError;
    return response;
  } catch(e) { if(typeof e?.code==='string' && e.code.startsWith('VOICE_')) throw e; throw unavailable(); }
  finally { if(owned) { try { fs.unlinkSync(owned); } catch {} } if(candidate) { try { fs.unlinkSync(candidate); } catch {} } }
}
