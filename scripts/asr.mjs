#!/usr/bin/env node
// All work is submitted to the running Host; this command never creates an ASR queue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { probeAudio } from '../src/perception/media.js';
import { sha256File, isPathWithin } from '../src/perception/util.js';
import { createPerceptionClient } from '../plugins/surfcore/tools/lib/perception-client.mjs';

async function main(args) {
  const [action, ...rest] = args;
  const takesValue = ['submit', 'inspect', 'cancel', 'resume'].includes(action);
  const value = takesValue ? rest.shift() : null;
  const options = rest;
  const option = name => { const i=options.indexOf(name); return i < 0 ? null : options[i+1]; };
  const stateDir=option('--state-dir') || process.env.SURFCORE_STATE_DIR;
  if (!stateDir || !path.isAbsolute(stateDir)) throw Object.assign(new Error('需要绝对路径 --state-dir 或 SURFCORE_STATE_DIR。'),{code:'ASR_STATE_DIR_REQUIRED',hint:'指定运行中 Host 的状态目录后重试。'});
  const client=createPerceptionClient({stateDir});
  if (action === 'doctor') return await client.status();
  if (action === 'jobs') return {ok:true,jobs:await client.listJobs()};
  if (action === 'inspect') return {ok:true,job:await client.getJob(value)};
  if (action === 'cancel') return await client.cancel(value);
  if (action === 'resume') return await client.resume(value);
  if (action !== 'submit' || !value) throw Object.assign(new Error('用法：asr.mjs submit <受管音频> --state-dir <绝对路径> [--character-id <角色ID> --character-epoch <版本>] [--ffprobe <绝对路径>] [--lang auto|zh]；或 doctor/jobs/inspect/cancel/resume。'),{code:'ASR_ARGUMENT_INVALID',hint:'先将音频放入 Host perception/assets，再提交其路径。'});
  const explicitId=option('--character-id'), explicitEpoch=option('--character-epoch');
  let current;
  if (explicitId || explicitEpoch) current={id:explicitId,epoch:explicitEpoch};
  else { try { current=JSON.parse(fs.readFileSync(path.join(stateDir,'characters','current.json'),'utf8')); } catch {} }
  const characterId=current?.id, epochText=String(current?.epoch ?? ''), characterEpoch=Number(epochText);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(String(characterId ?? '')) || !/^\d+$/.test(epochText) || !Number.isSafeInteger(characterEpoch) || characterEpoch < 1 || (!(explicitId || explicitEpoch) && !fs.existsSync(path.join(stateDir,'characters',characterId)))) throw Object.assign(new Error('当前角色或其版本不可用。'),{code:'CHARACTER_REQUIRED',hint:'在官方 App 中创建或选择角色后重试；高级参数须同时提供角色 ID 与 epoch。'});
  const assets=await fs.promises.realpath(path.join(stateDir,'perception','assets'));
  const file=await fs.promises.realpath(value);
  if (!isPathWithin(assets,file) || file===assets || !(await fs.promises.stat(file)).isFile()) throw Object.assign(new Error('音频不在 Host 受管资产目录内。'),{code:'ASSET_OUTSIDE_ROOT',hint:'先将音频放入 STATE_DIR/perception/assets 后重试。'});
  const ffprobe=option('--ffprobe') || process.env.FFPROBE_PATH;
  if (!ffprobe || !path.isAbsolute(ffprobe)) throw Object.assign(new Error('需要绝对路径 --ffprobe 或 FFPROBE_PATH。'),{code:'FFPROBE_UNAVAILABLE',hint:'指定可执行的 FFprobe 绝对路径后重试。'});
  const before=await fs.promises.stat(file); const media=await probeAudio(file,ffprobe); const digest=await sha256File(file); const after=await fs.promises.stat(file);
  if (before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ino!==after.ino) throw Object.assign(new Error('音频在检查时发生变化。'),{code:'ASSET_CHANGED',hint:'等待复制完成后重新提交。'});
  const durationMs=media.durationMs, range={startMs:0,endMs:durationMs};
  return await client.submit({characterId,characterEpoch,activityId:crypto.randomUUID(),asset:{assetId:`local:${digest}`,contentSha256:digest,localPath:file,durationMs,sourceDurationMs:durationMs,acquiredRanges:[range],timelineMap:[{localStartMs:0,localEndMs:durationMs,sourceStartMs:0,sourceEndMs:durationMs}]},provenance:{channel:'local',sourceId:`sha256:${digest}`,acquiredAtMs:Date.now()},source:{channel:'local'},visibility:{classification:'restricted'},requestedRanges:[range],languageHint:option('--lang') || 'auto'});
}
main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(JSON.stringify({ok:false,code:error.code || 'ASR_CLI_FAILED',error:error.error || error.message || '操作失败。',hint:error.hint || '检查 Host 状态和参数后重试。'}));process.exitCode=1;});
