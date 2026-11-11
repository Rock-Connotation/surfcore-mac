import path from 'node:path';
import { voiceSendBudget } from '../src/voice-send-budget.js';

const args=process.argv.slice(2), command=args.shift();
const fields={};
while(args.length) { const key=args.shift(), value=args.shift(); if(!key?.startsWith('--') || value===undefined || Object.hasOwn(fields,key)) throw new Error('参数无效。'); fields[key]=value; }
try {
  const stateDir=fields['--state-dir'];
  if(!path.isAbsolute(stateDir || '')) throw new Error('请传入绝对路径 --state-dir。');
  if(command==='inspect') {
    const data=voiceSendBudget(stateDir,'inspect');
    console.log(JSON.stringify({initialized:data.initialized,day:data.day,count:data.count,pending:data.pending,reconciliations:data.reconciliations},null,2));
  } else if(command==='initialize') {
    if(fields['--confirm']!=='conservative') throw new Error('初始化需要 --confirm conservative；现有账本不会被覆盖。');
    voiceSendBudget(stateDir, fields['--count'] === undefined ? 'initialize' : {type:'initialize',count:Number(fields['--count']),evidence:fields['--evidence']});
    console.log('账本已存在或已完成有记录的首次初始化；现有账本未覆盖。');
  } else if(command==='resolve') {
    const result=fields['--result'];
    if(!['sent','rejected'].includes(result) || fields['--confirm']!==fields['--id'] || !fields['--id'] || !fields['--evidence']) throw new Error('需要 --id、与其相同的 --confirm、--result sent|rejected 和 --evidence。');
    const acceptedAt=result==='sent' ? Date.parse(fields['--accepted-at'] || '') : undefined;
    if(result==='sent' && !Number.isSafeInteger(acceptedAt)) throw new Error('已发送需提供含时区的 --accepted-at ISO 时间。');
    if(result==='sent' && !/(Z|[+-]\d\d:\d\d)$/.test(fields['--accepted-at'])) throw new Error('接受时间必须包含时区。');
    voiceSendBudget(stateDir,{type:'reconcile',id:fields['--id'],result,acceptedAt,evidence:fields['--evidence']});
    console.log('对账已写入账本及持久审计记录。');
  } else throw new Error('用法：inspect --state-dir 绝对路径；initialize --state-dir 绝对路径 --confirm conservative；resolve --state-dir 绝对路径 --id ID --confirm ID --result sent|rejected --evidence 证据摘要 [--accepted-at 含时区ISO时间]。');
} catch(e) { console.error(JSON.stringify({ok:false,code:e.code || 'VOICE_RECONCILE_INVALID',error:e.message,hint:e.hint || '核对账本状态、回执证据和命令参数；不要删除账本。'})); process.exitCode=1; }
