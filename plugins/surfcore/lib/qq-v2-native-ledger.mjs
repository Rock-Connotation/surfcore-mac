import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';

const fail = (code) => ({ ok: false, code, error: 'The native message ledger could not verify this operation.', hint: 'Keep this request blocked and restore the trusted native input and ordered observations.' });
const requireValue = (condition) => { if (!condition) throw Error(); };
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inputDigest = options => digest({ messages: options.messages, toolHistory: options.toolHistory, tools: options.tools ?? [] });
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return typeof key === 'string' && keys.includes(key) && descriptor?.enumerable === true && 'value' in descriptor; });
};
function json(value, stack = new Set(), depth = 0, count = { value: 0 }) {
  if (++count.value > 50000 || depth > 32) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return Buffer.byteLength(value) <= 1024 * 1024;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || types.isProxy(value) || stack.has(value)) return false;
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (proto !== (array ? Array.prototype : Object.prototype)) return false;
  stack.add(value);
  const keys = Reflect.ownKeys(value);
  const good = keys.every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return false;
    if (array && key === 'length') return true;
    if (!descriptor.enumerable) return false;
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false;
    return json(descriptor.value, stack, depth + 1, count);
  }) && (!array || Object.keys(value).length === value.length);
  stack.delete(value);
  return good;
}
const clone = value => structuredClone(value);
function messageSemantic(message) {
  requireValue(exact(message, ['id', 'role', 'source', 'content', 'toolCallId', 'isError']) && identity(message.id) && json(message));
  const result = { ...message }; delete result.id; return clone(result);
}
function textContent(content) {
  return Array.isArray(content) && content.length > 0 && content.length <= 128 && json(content)
    && content.every(block => exact(block, ['type', 'text']) && block.type === 'text' && typeof block.text === 'string');
}
function validParameter(parameter, item = false) {
  if (!exact(parameter, ['type', 'required', 'enum', 'items', 'description']) || !['string', 'boolean', 'number', 'integer', 'array'].includes(parameter.type)) return false;
  if (parameter.required !== undefined && (item || parameter.required !== true)) return false;
  if (parameter.description !== undefined && typeof parameter.description !== 'string') return false;
  if (parameter.enum !== undefined && (parameter.type !== 'string' || !Array.isArray(parameter.enum) || parameter.enum.length === 0 || parameter.enum.length > 128 || !parameter.enum.every(value => typeof value === 'string'))) return false;
  if (parameter.type === 'array') return !item && exact(parameter.items, ['type', 'enum', 'description']) && parameter.items.type === 'string' && validParameter(parameter.items, true);
  return parameter.items === undefined;
}
function snapshotSpecs(specs) {
  requireValue(Array.isArray(specs) && specs.length <= 32 && json(specs));
  const names = new Set();
  for (const spec of specs) {
    requireValue(exact(spec, ['name', 'description', 'parameters']) && identity(spec.name) && typeof spec.description === 'string' && exact(spec.parameters, Object.keys(spec.parameters)) && !names.has(spec.name));
    names.add(spec.name);
    for (const parameter of Object.values(spec.parameters)) requireValue(validParameter(parameter));
  }
  return clone(specs);
}
function projectSpec(spec) {
  const properties = {}, required = [];
  for (const [name, parameter] of Object.entries(spec.parameters)) {
    const projected = { type: parameter.type };
    if (parameter.description !== undefined) projected.description = parameter.description;
    if (parameter.enum !== undefined) projected.enum = clone(parameter.enum);
    if (parameter.items !== undefined) {
      projected.items = { type: 'string' };
      if (parameter.items.description !== undefined) projected.items.description = parameter.items.description;
      if (parameter.items.enum !== undefined) projected.items.enum = clone(parameter.items.enum);
    }
    Object.defineProperty(properties, name, { value: projected, enumerable: true, writable: true, configurable: true });
    if (parameter.required) required.push(name);
  }
  return { name: spec.name, description: spec.description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } };
}
function validArgument(rule, value) {
  if (rule.type === 'string') return typeof value === 'string' && Buffer.byteLength(value) <= 65536 && (rule.enum === undefined || rule.enum.includes(value));
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'integer') return Number.isSafeInteger(value);
  if (rule.type === 'number') return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  return Array.isArray(value) && value.length <= 128 && value.every(item => validArgument(rule.items, item));
}
function makeQQV2NativeLedger({ nativeCodec, corePersona, toolSpecs, validateOwnedToolContext } = {}) {
  const codecKeys = ['AssistantStreamAccumulator', 'BlockAssembler', 'createSystemMessage', 'createUserMessage', 'createAssistantMessage', 'createToolResultMessage'];
  requireValue(nativeCodec && codecKeys.every(key => typeof nativeCodec[key] === 'function') && typeof corePersona === 'string' && corePersona.length > 0 && Buffer.byteLength(corePersona) <= 65536 && typeof validateOwnedToolContext === 'function');
  const codec = Object.freeze(Object.fromEntries(codecKeys.map(key => [key, nativeCodec[key]])));
  const specs = snapshotSpecs(toolSpecs), sortedSpecs = specs.map(projectSpec).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), specsByName = new Map(specs.map(spec => [spec.name, spec]));
  const expected = [], calls = new Map(), pending = [], candidates = new Map(), dispatches = new Set();
  let optionsSeen = new WeakSet(), admissions = new WeakMap();
  let sessionId, seeded = false, retired = false, validated = 0, completed = 0, failed = 0, toolResults = 0, active;
  const alive = () => requireValue(seeded && !retired);
  const append = message => { requireValue(expected.length < 1024); expected.push({ semantic: messageSemantic(message), id: undefined }); };
  function matchMessages(options, pin) {
    requireValue(Array.isArray(options.messages) && options.messages.length === expected.length && json(options.messages) && Buffer.byteLength(JSON.stringify(options.messages)) <= 4 * 1024 * 1024);
    const ids = new Set();
    for (let index = 0; index < expected.length; index++) {
      const actual = options.messages[index], entry = expected[index];
      requireValue(!ids.has(actual.id) && (!entry.id || entry.id === actual.id) && isDeepStrictEqual(messageSemantic(actual), entry.semantic)); ids.add(actual.id);
    }
    if (pin) for (let index = 0; index < expected.length; index++) expected[index].id ??= options.messages[index].id;
  }
  function input(options, request, preparedConfig, pin = false) {
    alive(); requireValue(pending.length === 0 && exact(options, ['provider', 'model', 'maxTokens', 'reasoningEffort', 'messages', 'toolHistory', 'tools', 'sessionId', 'signal']) && exact(preparedConfig, ['provider', 'model', 'maxTokens', 'reasoningEffort']));
    requireValue(deriveMemoryProviderRouteId({ provider: preparedConfig.provider, model: preparedConfig.model }).ok === true && (preparedConfig.maxTokens === undefined || Number.isSafeInteger(preparedConfig.maxTokens) && preparedConfig.maxTokens > 0) && (preparedConfig.reasoningEffort === undefined || identity(preparedConfig.reasoningEffort)));
    const actualConfig = {}; for (const key of ['provider', 'model', 'maxTokens', 'reasoningEffort']) if (Object.hasOwn(options, key)) actualConfig[key] = options[key];
    requireValue(isDeepStrictEqual(actualConfig, preparedConfig) && options.sessionId === sessionId && request?.sessionId === sessionId);
    const history = options.toolHistory;
    requireValue(exact(history, ['tools', 'updates']) && json(history) && (options.tools === undefined || json(options.tools)) && Array.isArray(history.tools) && Array.isArray(history.updates) && history.updates.length === 0 && (history.tools.length === 0 || isDeepStrictEqual(history.tools, sortedSpecs)) && (options.tools === undefined ? isDeepStrictEqual(history.tools, sortedSpecs) : isDeepStrictEqual(options.tools, sortedSpecs)));
    matchMessages(options, pin); requireValue(request.inputDigest === inputDigest(options));
  }
  function validArgs(block) {
    requireValue(exact(block, ['type', 'id', 'name', 'arguments']) && block.type === 'tool-call' && identity(block.id) && specsByName.has(block.name) && typeof block.arguments === 'string' && Buffer.byteLength(block.arguments) <= 65536);
    const args = JSON.parse(block.arguments), spec = specsByName.get(block.name);
    requireValue(exact(args, Object.keys(spec.parameters)) && json(args));
    const keys = [...block.arguments.matchAll(/"(?:\\.|[^"\\])*"/g)].filter(match => /^\s*:/.test(block.arguments.slice(match.index + match[0].length))).map(match => JSON.parse(match[0]));
    requireValue(keys.length === Object.keys(args).length && keys.length === new Set(keys).size);
    for (const [name, rule] of Object.entries(spec.parameters)) {
      requireValue(!rule.required || Object.hasOwn(args, name));
      if (Object.hasOwn(args, name)) requireValue(validArgument(rule, args[name]));
    }
    return args;
  }
  function blocks(items) {
    requireValue(Array.isArray(items) && items.length > 0 && items.length <= 256 && json(items));
    for (const block of items) {
      if (block?.type === 'text' || block?.type === 'reasoning') requireValue(exact(block, ['type', 'text']) && typeof block.text === 'string');
      else validArgs(block);
    }
  }
  function chunk(candidate, value) {
    const fields = { 'block-end': ['type', 'index', 'block'], 'block-start': ['type', 'index', 'blockType'], 'text-delta': ['type', 'index', 'text'], 'reasoning-delta': ['type', 'index', 'text'], 'tool-call-delta': ['type', 'index', 'id', 'name', 'argumentsDelta'], usage: ['type', 'usage'], finish: ['type', 'reason', 'replayState'] }[value?.type];
    requireValue(fields && exact(value, fields) && json(value) && !candidate.finish);
    if (value.type === 'block-end') { requireValue(Number.isSafeInteger(value.index) && value.index >= 0 && !Object.is(value.index, -0)); blocks([value.block]); }
    else if (value.type === 'block-start') requireValue(Number.isSafeInteger(value.index) && value.index >= 0 && !Object.is(value.index, -0) && ['text', 'reasoning', 'tool-call'].includes(value.blockType));
    else if (['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(value.type)) requireValue(Number.isSafeInteger(value.index) && value.index >= 0 && !Object.is(value.index, -0) && typeof (value.type === 'tool-call-delta' ? value.argumentsDelta : value.text) === 'string');
    else if (value.type === 'usage') requireValue(exact(value.usage, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) && Object.values(value.usage).every(n => Number.isSafeInteger(n) && n >= 0));
    else { requireValue(exact(value.reason, ['kind']) && ['stop', 'tool-calls'].includes(value.reason.kind)); candidate.finish = true; }
    candidate.bytes += Buffer.byteLength(JSON.stringify(value)); requireValue(++candidate.chunks <= 4096 && candidate.bytes <= 8 * 1024 * 1024);
    const timed = candidate.accumulator.push({ time: Date.now(), chunk: value }); candidate.assembler.push(timed.chunk); candidate.seenChunks.push({ value, digest: digest(value) });
  }
  const wrap = (code, fn) => (...args) => { try { return fn(...args); } catch { return fail(code); } };
  return Object.freeze({
    seed: wrap('QQ_NATIVE_LEDGER_SEED_UNPROVEN', ({ sessionId: id, requestId, content } = {}) => {
      requireValue(!seeded && !retired && identity(id) && identity(requestId) && textContent(content)); sessionId = id;
      const system = codec.createSystemMessage(corePersona), user = codec.createUserMessage({ source: { kind: 'user-rpc', requestId }, content: clone(content) });
      const systemSemantic = messageSemantic(system), userSemantic = messageSemantic(user); expected.push({ semantic: systemSemantic, id: undefined }, { semantic: userSemantic, id: undefined }); seeded = true; return { ok: true };
    }),
    validateInput: wrap('QQ_NATIVE_LEDGER_INPUT_UNPROVEN', ({ options, request, preparedConfig } = {}) => {
      input(options, request, preparedConfig); const prior = admissions.get(options);
      requireValue(!prior || prior.request === request && prior.preparedConfig === preparedConfig && prior.digest === inputDigest(options));
      matchMessages(options, true); if (!prior) admissions.set(options, { request, preparedConfig, digest: inputDigest(options) }); validated++; return { ok: true };
    }),
    captureModelOutput: wrap('QQ_NATIVE_LEDGER_OUTPUT_UNPROVEN', ({ options, request, preparedConfig, dispatchId, phase, chunk: item, signal } = {}) => {
      alive(); requireValue(identity(dispatchId));
      if (phase === 'start') {
        requireValue(!signal?.aborted && !active && !dispatches.has(dispatchId) && options && typeof options === 'object' && !optionsSeen.has(options) && dispatches.size < 1024);
        const candidate = { options, request, preparedConfig, accumulator: new codec.AssistantStreamAccumulator(), assembler: new codec.BlockAssembler(), chunks: 0, bytes: 0, seenChunks: [], finish: false, invalid: false };
        candidates.set(dispatchId, candidate); dispatches.add(dispatchId); optionsSeen.add(options); active = dispatchId; return { ok: true };
      }
      const candidate = candidates.get(dispatchId); requireValue(candidate && active === dispatchId && candidate.options === options && candidate.request === request && candidate.preparedConfig === preparedConfig);
      if (phase === 'failed') { candidates.delete(dispatchId); active = undefined; failed++; return { ok: true }; }
      try {
        requireValue(!signal?.aborted && !candidate.invalid);
        const admitted = admissions.get(options); requireValue(admitted && admitted.request === request && admitted.preparedConfig === preparedConfig && admitted.digest === inputDigest(options)); input(options, request, preparedConfig);
        if (phase === 'chunk') { chunk(candidate, item); return { ok: true }; }
        requireValue(phase === 'complete' && candidate.finish);
        for (const observed of candidate.seenChunks) requireValue(json(observed.value) && digest(observed.value) === observed.digest);
        const items = candidate.assembler.blocks(); blocks(items);
        const observed = new Map();
        for (const block of items) if (block.type === 'tool-call') { requireValue(!calls.has(block.id) && !observed.has(block.id) && calls.size + observed.size < 1024); observed.set(block.id, { name: block.name, args: validArgs(block) }); }
        const source = { provider: options.provider, model: options.model, ...(candidate.assembler.replayState === undefined ? {} : { replayState: candidate.assembler.replayState }) };
        requireValue(json(source)); const message = codec.createAssistantMessage({ content: clone(items), source }); append(message);
        for (const [id, call] of observed) { calls.set(id, call); pending.push(id); }
        candidates.delete(dispatchId); active = undefined; completed++; return { ok: true };
      } catch (error) { candidate.invalid = true; throw error; }
    }),
    captureToolResult: wrap('QQ_NATIVE_LEDGER_TOOL_UNPROVEN', ({ execution, content, isError = false } = {}) => {
      alive(); requireValue(!active && execution && validateOwnedToolContext(execution)?.ok === true && typeof isError === 'boolean' && textContent(content));
      const call = calls.get(execution.callId); requireValue(call && pending[0] === execution.callId && execution.name === call.name && json(execution.arguments) && isDeepStrictEqual(execution.arguments, call.args));
      const message = codec.createToolResultMessage({ callId: execution.callId, content: clone(content), isError }); append(message); pending.shift(); toolResults++; return { ok: true };
    }),
    retire: wrap('QQ_NATIVE_LEDGER_RETIRE_UNPROVEN', () => { if (retired) return { ok: true }; retired = true; expected.length = 0; pending.length = 0; calls.clear(); candidates.clear(); dispatches.clear(); admissions = new WeakMap(); optionsSeen = new WeakSet(); active = undefined; sessionId = undefined; return { ok: true }; }),
    getStatus: () => Object.freeze({ retired, messages: expected.length, pendingCalls: pending.length, activeDispatches: candidates.size, validatedInputs: validated, completedOutputs: completed, failedOutputs: failed, toolResults }),
  });
}

export function createQQV2NativeLedger(options) {
  try { return makeQQV2NativeLedger(options); } catch { const result = fail('QQ_NATIVE_LEDGER_UNSUPPORTED'); throw Object.assign(new Error(result.error), result); }
}
