import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createQQV2NativeOwner } from '../lib/qq-v2-native-owner.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createQQV2NativeLedger } from '../lib/qq-v2-native-ledger.mjs';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';

const identified = value => ({ id: randomUUID(), ...structuredClone(value) });
const codec = {
  AssistantStreamAccumulator: class { push(value) { return structuredClone(value); } },
  BlockAssembler: class { content = []; push(chunk) { if (chunk.type === 'block-end') this.content.push(chunk.block); if (chunk.type === 'finish') this.replayState = chunk.replayState; } blocks() { return this.content; } },
  createSystemMessage: text => identified({ role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }),
  createUserMessage: ({ source, content }) => identified({ role: 'user', source, content }),
  createAssistantMessage: ({ source, content }) => identified({ role: 'assistant', source, content }),
  createToolResultMessage: ({ callId, content, isError }) => identified({ role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content, isError }),
};
const specs = [{ name: 'qq_test', description: 'A fixed fixture tool', parameters: { text: { type: 'string', required: true }, mode: { type: 'string', enum: ['a', 'b'] } } }];
const nativeSpecs = [{ name: 'qq_test', description: 'A fixed fixture tool', parameters: { type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['text'] } }];
const persona = 'Host-approved persona';
const config = Object.freeze({ provider: 'fixture-provider', model: 'fixture-model', maxTokens: 20 });
const text = value => [{ type: 'text', text: value }];
const digest = options => createHash('sha256').update(JSON.stringify({ messages: options.messages, toolHistory: options.toolHistory, tools: options.tools ?? [] })).digest('hex');
const ok = result => assert.equal(result?.ok, true, JSON.stringify(result));
const bad = result => { assert.equal(result?.ok, false, JSON.stringify(result)); assert.ok(result.code && result.error && result.hint); };
function setup() {
  const owned = new WeakSet(), ledger = createQQV2NativeLedger({ nativeCodec: codec, corePersona: persona, toolSpecs: specs, validateOwnedToolContext: exec => ({ ok: owned.has(exec) }) });
  const content = text('trusted composed input'); ok(ledger.seed({ sessionId: 'session-1', requestId: 'request-1', content }));
  const messages = [codec.createSystemMessage(persona), codec.createUserMessage({ source: { kind: 'user-rpc', requestId: 'request-1' }, content })];
  let current = 0;
  function call() { const options = { ...config, sessionId: 'session-1', messages: structuredClone(messages), toolHistory: { tools: [], updates: [] }, tools: structuredClone(nativeSpecs) }; return { options, request: { sessionId: 'session-1', inputDigest: digest(options) }, preparedConfig: config, dispatchId: 'dispatch-' + ++current }; }
  const validate = state => ledger.validateInput(state);
  const phase = (state, phase, chunk) => ledger.captureModelOutput({ ...state, phase, ...(chunk ? { chunk } : {}) });
  const appendOutput = blocks => messages.push(codec.createAssistantMessage({ content: blocks, source: { provider: config.provider, model: config.model } }));
  return { ledger, messages, owned, call, validate, phase, appendOutput, content };
}
function start(f, c) { ok(f.phase(c, 'start')); ok(f.validate(c)); }
function finish(f, c, blocks) { for (const [index, block] of blocks.entries()) ok(f.phase(c, 'chunk', { type: 'block-end', index, block })); ok(f.phase(c, 'chunk', { type: 'finish', reason: { kind: 'stop' } })); ok(f.phase(c, 'complete')); f.appendOutput(blocks); }
const callBlock = (id = 'call-1', args = '{"text":"hello"}') => ({ type: 'tool-call', id, name: 'qq_test', arguments: args });
let checks = 0;
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); checks++; console.log('PASS', name); }
async function runOrdinary() {
await test('seed is one-shot and validates entire first input', () => { const f = setup(), c = f.call(); start(f, c); bad(f.ledger.seed({ sessionId: 'x', requestId: 'y', content: text('x') })); assert.equal(f.ledger.getStatus().messages, 2); });
await test('start before validation never accepts output', () => { const f = setup(), c = f.call(); ok(f.phase(c, 'start')); bad(f.phase(c, 'chunk', { type: 'finish', reason: { kind: 'stop' } })); });
await test('reordered or extra messages are rejected', () => { for (const mutate of [m => m.reverse(), m => m.push(codec.createUserMessage({ source: { kind: 'user-rpc', requestId: 'other' }, content: text('extra') }))]) { const f = setup(), c = f.call(); mutate(c.options.messages); c.request.inputDigest = digest(c.options); bad(f.validate(c)); } });
await test('pinned first-seen ids cannot change', () => { const f = setup(), c = f.call(); ok(f.validate(c)); c.options.messages[0].id = randomUUID(); c.request.inputDigest = digest(c.options); bad(f.validate(c)); });
await test('hidden options config and stale input digests are rejected', () => { for (const mutate of [c => { c.options.temperature = 1; c.request.inputDigest = digest(c.options); }, c => { c.options.maxTokens++; c.request.inputDigest = digest(c.options); }, c => { c.request.inputDigest = 'bad'; }]) { const f = setup(), c = f.call(); mutate(c); bad(f.validate(c)); } });
await test('tool schema and tool-history updates are rejected', () => { for (const mutate of [c => { c.options.tools[0].parameters.properties.extra = { type:'string' }; }, c => { c.options.toolHistory.updates.push({}); }, c => { c.options.toolHistory.tools.push({ name: 'foreign' }); }]) { const f = setup(), c = f.call(); mutate(c); c.request.inputDigest = digest(c.options); bad(f.validate(c)); } });
await test('image, hidden source fields, and malformed messages fail', () => { for (const mutate of [m => m[1].content.push({type:'image', url:'x'}), m => { m[1].source.extra = 'x'; }, m => { m[0].hidden = 'x'; }]) { const f = setup(), c = f.call(); mutate(c.options.messages); c.request.inputDigest = digest(c.options); bad(f.validate(c)); } });
await test('normal actual assistant output becomes next expected input', () => { const f = setup(), c = f.call(); start(f, c); finish(f, c, [{ type: 'text', text: 'reply' }]); const next = f.call(); ok(f.validate(next)); });
await test('failed or partial output cannot be appended or replayed', () => { const f = setup(), c = f.call(); start(f, c); ok(f.phase(c, 'chunk', { type:'block-end', index:0, block:{ type:'text', text:'partial' } })); ok(f.phase(c, 'failed')); bad(f.phase(c, 'complete')); f.appendOutput([{ type:'text', text:'partial' }]); bad(f.validate(f.call())); bad(f.phase(c, 'start')); });
await test('unowned, mismatched and replayed tool results are denied', () => { const f = setup(), c = f.call(); start(f, c); finish(f, c, [callBlock()]); const exec = { name:'qq_test', callId:'call-1', arguments:{text:'hello'} }; bad(f.ledger.captureToolResult({ execution:exec, content:text('result') })); f.owned.add(exec); exec.arguments.text='wrong'; bad(f.ledger.captureToolResult({ execution:exec, content:text('result') })); exec.arguments.text='hello'; ok(f.ledger.captureToolResult({ execution:exec, content:text('result') })); bad(f.ledger.captureToolResult({ execution:exec, content:text('result') })); f.messages.push(codec.createToolResultMessage({ callId:'call-1', content:text('result'), isError:false })); ok(f.validate(f.call())); });
await test('tool-call ids cannot duplicate or reuse', () => { const f = setup(), c = f.call(); start(f,c); ok(f.phase(c,'chunk',{type:'block-end',index:0,block:callBlock()})); ok(f.phase(c,'chunk',{type:'block-end',index:1,block:callBlock()})); ok(f.phase(c,'chunk',{type:'finish',reason:{kind:'stop'}})); bad(f.phase(c,'complete')); });
await test('unknown tool, extra args and duplicate JSON keys fail', () => { for (const block of [{...callBlock(), name:'other'}, callBlock('a','{"text":"x","extra":"y"}'), callBlock('b','{"text":"x","text":"y"}')]) { const f = setup(), c = f.call(); start(f,c); bad(f.phase(c,'chunk',{type:'block-end', index:0, block})); } });
await test('tool results follow observed call order', () => { const f = setup(), c = f.call(); start(f,c); finish(f,c,[callBlock('a'),callBlock('b')]); const exec={ name:'qq_test',callId:'b',arguments:{text:'hello'} }; f.owned.add(exec); bad(f.ledger.captureToolResult({execution:exec,content:text('wrong order')})); });
await test('unknown chunk type and malformed finish fail closed', () => { for (const chunk of [{type:'other'}, {type:'finish',reason:{kind:'stop', secret:'x'}}]) { const f=setup(), c=f.call(); start(f,c); bad(f.phase(c,'chunk',chunk)); } });
await test('retirement erases ledger and rejects later use', () => { const f=setup(), c=f.call(); ok(f.ledger.retire()); bad(f.validate(c)); bad(f.phase(c,'start')); assert.equal(f.ledger.getStatus().messages, 0); });
await test('non-enumerable hidden source properties are rejected', () => { const f = setup(), c = f.call(); Object.defineProperty(c.options.messages[1].source, 'hidden', { value: 'x', enumerable: false }); bad(f.validate(c)); });
await test('Native string arrays, integer, number and boolean arguments are bounded', () => {
  const allSpecs = [{ name: 'qq_send', description: 'bounded', parameters: { messages: { type: 'array', items: { type: 'string' }, required: true }, wait: { type: 'integer' }, scale: { type: 'number' }, quiet: { type: 'boolean' } } }];
  const projected = [{ name: 'qq_send', description: 'bounded', parameters: { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } }, wait: { type: 'integer' }, scale: { type: 'number' }, quiet: { type: 'boolean' } }, required: ['messages'] } }];
  function make(value) { const f = setup(); const ledger = createQQV2NativeLedger({ nativeCodec: codec, corePersona: persona, toolSpecs: allSpecs, validateOwnedToolContext: () => ({ok:true}) }); ok(ledger.seed({ sessionId:'session-1', requestId:'request-1', content:f.content })); const c=f.call(); c.options.tools=projected; c.request.inputDigest=digest(c.options); ok(ledger.captureModelOutput({ ...c,phase:'start' })); ok(ledger.validateInput(c)); return {ledger,c,block:{type:'tool-call',id:'typed',name:'qq_send',arguments:JSON.stringify(value)}}; }
  for (const value of [{messages:['one','two'],wait:10,scale:0.5,quiet:true}, {messages:[],wait:0}]) { const x=make(value); ok(x.ledger.captureModelOutput({...x.c,phase:'chunk',chunk:{type:'block-end',index:0,block:x.block}})); }
  for (const value of [{messages:[3]}, {messages:['x'],wait:1.5}, {messages:['x'],quiet:'true'}, {messages:new Array(129).fill('x')}, {messages:['x'],wait:9007199254740992}]) { const x=make(value); bad(x.ledger.captureModelOutput({...x.c,phase:'chunk',chunk:{type:'block-end',index:0,block:x.block}})); }
});
await test('unsupported nested object tool schema is rejected', () => { assert.throws(() => createQQV2NativeLedger({nativeCodec:codec,corePersona:persona,toolSpecs:[{name:'x',description:'x',parameters:{v:{type:'object',properties:{}}}}],validateOwnedToolContext:()=>({ok:true})}), error => error.code === 'QQ_NATIVE_LEDGER_UNSUPPORTED' && !!error.hint); });
await test('hidden tool schema fields cannot escape the digest', () => { const f=setup(), c=f.call(); Object.defineProperty(c.options.tools[0].parameters.properties.text, 'hidden', {value:'x',enumerable:false}); bad(f.validate(c)); });
await test('one options object cannot be rebound to a new admission tuple', () => { const f=setup(), c=f.call(); ok(f.validate(c)); bad(f.validate({...c,request:{...c.request}})); bad(f.validate({...c,preparedConfig:{...c.preparedConfig}})); });
await test('tool call identifiers remain retired after their result', () => { const f=setup(), first=f.call(); start(f,first); finish(f,first,[callBlock()]); const execution={name:'qq_test',callId:'call-1',arguments:{text:'hello'}}; f.owned.add(execution); ok(f.ledger.captureToolResult({execution,content:text('done')})); f.messages.push(codec.createToolResultMessage({callId:'call-1',content:text('done'),isError:false})); const second=f.call(); start(f,second); ok(f.phase(second,'chunk',{type:'block-end',index:0,block:callBlock()})); ok(f.phase(second,'chunk',{type:'finish',reason:{kind:'stop'}})); bad(f.phase(second,'complete')); });
await test('previously observed chunks cannot mutate before commit', () => { const f=setup(), c=f.call(); start(f,c); const block={type:'text',text:'observed'}; ok(f.phase(c,'chunk',{type:'block-end',index:0,block})); ok(f.phase(c,'chunk',{type:'finish',reason:{kind:'stop'}})); block.text='forged'; bad(f.phase(c,'complete')); });
await test('aborted, error and truncated finishes never commit', () => { for(const kind of ['aborted','error','max-tokens']) { const f=setup(), c=f.call(); start(f,c); bad(f.phase(c,'chunk',{type:'finish',reason:{kind}})); bad(f.phase(c,'complete')); } });
await test('route validation follows exact Core provider and model contract', () => {
  const valid = [['fixture + provider', '模型 [preview]+beta'], ['p'.repeat(512), '模'.repeat(512)]];
  for (const [provider,model] of valid) { const f=setup(), c=f.call(); assert.equal(deriveMemoryProviderRouteId({provider,model}).ok,true); Object.assign(c.options,{provider,model}); c.preparedConfig={...config,provider,model}; ok(f.validate(c)); const changed={...c.preparedConfig, model:model+'x'}; bad(f.validate({...c,preparedConfig:changed})); }
  for (const invalid of ['', ' ', ' leading', 'trailing ', 'x\n', 'x\u007f', 'x'.repeat(513)]) for (const field of ['provider','model']) { const f=setup(), c=f.call(); const route={provider:config.provider,model:config.model,[field]:invalid}; assert.equal(deriveMemoryProviderRouteId(route).ok,false); Object.assign(c.options,route); c.preparedConfig={...config,...route}; bad(f.validate(c)); }
});
await test('tool-call finish is a normal Native outcome', () => { const f=setup(), c=f.call(); start(f,c); ok(f.phase(c,'chunk',{type:'block-end',index:0,block:callBlock()})); ok(f.phase(c,'chunk',{type:'finish',reason:{kind:'tool-calls'}})); ok(f.phase(c,'complete')); assert.equal(f.ledger.getStatus().pendingCalls,1); });
await test('Native sparse safe indices are supported but negative zero is rejected', () => { const f=setup(), c=f.call(); start(f,c); ok(f.phase(c,'chunk',{type:'block-end',index:Number.MAX_SAFE_INTEGER,block:{type:'text',text:'sparse'}})); ok(f.phase(c,'chunk',{type:'finish',reason:{kind:'stop'}})); ok(f.phase(c,'complete')); const g=setup(), d=g.call(); start(g,d); bad(g.phase(d,'chunk',{type:'block-end',index:-0,block:{type:'text',text:'invalid'}})); });
console.log(`PASS ${checks} QQ ledger ordinary scenarios`);
}



export async function runNativeQQLedgerProbe(outer, moduleRoot, dshHome) {
  const load = name => import(pathToFileURL(path.join(moduleRoot, '@deepseek-ai', name, 'lib/index.js')).href);
  const names = ['cordis','dsh-session-projection','dsh-session','dsh-agent','dsh-system-prompt','dsh-tools','cordis-plugin-loader','dsh-agent-loop','dsh-agent-preset-registry','dsh-tool-executor-native','dsh-llm'];
  const [cordis,projections,sessions,agents,prompt,tools,loader,loop,presets,executor,llm] = await Promise.all(names.map(load));
  const roots=[], fibers=[], calls=[], errors=[], phases=[]; let owner, ledger, gates=0, toolCalls=0, hookOn=0, hookOff=0;
  class FixtureContext extends cordis.Context { constructor() { super(); roots.push(this); } }
  const nativeModules = { Context:FixtureContext, SessionProjectionRegistry:projections.default, SessionStore:sessions.default, AgentRegistry:agents.default, SystemPrompt:prompt.default, ToolsService:tools.default, Loader:loader.default, AgentLoop:loop.default, AgentPresetRegistry:presets.default, nativeExecutor:executor, isAgentLoopRequest:llm.isAgentLoopRequest };
  const mount = async plugin => { const fiber=outer.plugin(plugin); fibers.push(fiber); await fiber; };
  const originalOn=outer.on; outer.on=function(name, callback,...rest) { const off=originalOn.call(this,name,callback,...rest); if(name!=='llm/stream') return off; hookOn++; return () => { const result=off(); hookOff++; return result; }; };
  const budget=createTokenBudgetService({ctx:{},dshHome,qqStateDir:path.join(dshHome,'qq-fixture')});
  const specs=[{ name:'qq_owned_test', description:'fixture', parameters:{ messages:{type:'array',items:{type:'string'},required:true}, wait:{type:'integer'}, scale:{type:'number'}, quiet:{type:'boolean'} } }];
  const sourceAuthority = {
    async prepareInput(args) { const result=ledger.validateInput(args); if(!result.ok) console.log('LEDGER_INPUT_DENIAL',JSON.stringify({ result, options:args.options, preparedConfig:args.preparedConfig, request:args.request })); return result.ok ? {ok:true,handle:{}} : result; },
    async validate(args) { return ledger.validateInput(args); },
    async admitNetwork({dispatch}) { gates++; return dispatch(); },
    async captureModelOutput(args) { phases.push(args.phase); const result=ledger.captureModelOutput(args); if(!result.ok) console.log('LEDGER_OUTPUT_DENIAL', JSON.stringify({result,phase:args.phase,chunk:args.chunk})); return result; },
  };
  try {
    await mount(prompt.default); await mount(tools.default); await mount(llm.default);
    class FakeAdapter extends llm.LlmAdapter { async *stream(options) {
      calls.push(options); yield {type:'usage',usage:{inputTokens:10,outputTokens:5}};
      if(calls.length===1) yield {type:'block-end',index:Number.MAX_SAFE_INTEGER,block:{type:'tool-call',id:'native-ledger-call',name:'qq_owned_test',arguments:JSON.stringify({messages:['first','second'],wait:10,scale:0.5,quiet:true})}};
      else yield {type:'block-end',index:0,block:{type:'text',text:'synthetic reply'}};
      yield {type:'finish',reason:{kind:calls.length===1?'tool-calls':'stop'}};
    } }
    const off=outer.get('llm').registerAdapter(['qq-fixture-provider'],new FakeAdapter());
    try {
      budget.saveLimits({qq:{cny:null,tokens:100},bili:{cny:null,tokens:null},other:{cny:null,tokens:null},total:{cny:null,tokens:null}});
      const tool=tools.defineTool({ ...specs[0], output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(args,execution)=>{ toolCalls++; const content=[{type:'text',text:'synthetic tool result'}]; const result=ledger.captureToolResult({execution,content}); assert.equal(result.ok,true,JSON.stringify(result)); return 'synthetic tool result'; } });
      owner=await createQQV2NativeOwner({nativeModules,llm:outer.get('llm'),getLlmHookContext:()=>outer,corePersona:'Owned QQ ledger fixture.',tools:[tool],tokenBudget:budget,getCharacter:()=>({id:'whale',epoch:1}),provider:'qq-fixture-provider',model:'exact-model',estimatedTokens:20,sourceAuthority,onAgentError:error=>errors.push({code:error?.code,error:error?.error})});
      ledger=createQQV2NativeLedger({nativeCodec:llm,corePersona:'Owned QQ ledger fixture.',toolSpecs:specs,validateOwnedToolContext:execution=>owner.validateOwnedToolContext(execution)});
      const requestId='native-ledger-request', content=[{type:'text',text:'synthetic trusted seed'}]; assert.equal(ledger.seed({sessionId:owner.sessionId,requestId,content}).ok,true);
      owner.followup(llm.createUserMessage({source:{kind:'user-rpc',requestId},content})); await owner.whenIdle();
      assert.equal(calls.length,2,JSON.stringify(errors)); assert.equal(toolCalls,1); assert.equal(gates,2); assert.equal(phases.filter(p=>p==='complete').length,2);
      const status=ledger.getStatus(); assert.equal(status.messages,5); assert.equal(status.pendingCalls,0); assert.equal(status.toolResults,1); assert.equal(status.completedOutputs,2); assert.ok(status.validatedInputs>=2);
      const root=roots.find(ctx=>ctx.get('agents')?.get(owner.sessionId)), registry=root.get('agents'); await owner.retire(); assert.equal(registry.get(owner.sessionId),undefined); assert.equal(owner.getStatus().pendingCleanup,0); ledger.retire(); assert.equal(ledger.getStatus().messages,0); assert.equal(hookOn,hookOff);
      return {ok:true,checks:['actual-native-complete-input-twice','actual-observed-tool-call-and-execution','compiled-array-number-integer-boolean-schema','tool-calls-finish-and-sparse-index','full-tool-result-order','ledger-and-owner-retired'],fakeProviderCalls:calls.length,tokens:30,gates,toolCalls,hookOn,hookOff,sourceBinding:false,aclAuthority:false,bridgeIntegration:false};
    } finally { off(); }
  } finally { if(owner) await owner.retire(); budget.dispose(); outer.on=originalOn; for(const fiber of fibers.reverse()) await fiber.dispose(); }
}

async function runNativeFixture() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const evidence = path.join(repo, '_backups/memory-v2-qq-native-ledger');
  fs.mkdirSync(evidence, { recursive: true });
  let harness = fs.readFileSync(path.join(repo, 'scripts/test-memory-v2-host-runtime.mjs'), 'utf8');
  const replace = (from, to) => { assert.equal(harness.split(from).length, 2); harness = harness.replace(from, to); };
  replace("const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_backups/memory-v2-host-runtime');", `const root = ${JSON.stringify(evidence)};`);
  const start = harness.indexOf("create('project/probe.mjs', `"), end = harness.indexOf('\nconst env = {', start); assert.ok(start > 0 && end > start);
  const payload = `import { runNativeQQLedgerProbe } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};\nexport const name='memory-runtime-probe';\nexport const inject=['webServer','connection'];\nexport async function apply(ctx,config){const profile=ctx.get('profileContext');if(profile.dir!==config.project||profile.home!==config.dshHome)throw new Error('fixture profile mismatch');const result=await runNativeQQLedgerProbe(ctx,${JSON.stringify('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules')},config.dshHome);process.send?.({type:'memory-runtime-probe',ok:result.ok,pid:process.pid,execPath:process.execPath,worker:result,denied:globalThis.memoryGateDenied});}`;
  harness = harness.slice(0, start) + `create('project/probe.mjs', ${JSON.stringify(payload)});\n` + harness.slice(end);
  const file = path.join(evidence, `host-harness-${randomUUID()}.mjs`); fs.writeFileSync(file, harness, { flag: 'wx' }); await import(pathToFileURL(file).href);
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { if (process.argv.includes('--native')) await runNativeFixture(); else await runOrdinary(); }
