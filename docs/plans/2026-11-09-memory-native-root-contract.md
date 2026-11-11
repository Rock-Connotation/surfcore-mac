# Memory V2 isolated native root

Status: **hand_back; the complete first-call gate did not pass after three native fixture attempts.** The third attempt constructed the actual independent native graph and retained agent, then failed in a fixture call before the first LLM request. The factory must not be accepted as production-ready on this evidence.

This is a private integration seam and an isolated packaged-Host fixture. It does not enable V2 or claim the normal SurfCore profile is ready. V1 remains active until the parent integration gates pass.

## Contract and ownership

`createIsolatedNativeRoot({ nativeModules, llm, getLlmHookContext, corePersona, tools = [], attachments?, storage?, onStream })` is asynchronous. `nativeModules` must be trusted injections of the actual public Cordis `Context`, `SessionProjectionRegistry`, `SessionStore`, `AgentRegistry`, `SystemPrompt`, `ToolsService`, `Loader`, `AgentLoop`, `AgentPresetRegistry`, native executor module and the actual LLM `isAgentLoopRequest` helper. Production code contains no installation paths and imports no installed package by a guessed path.

The factory creates `new Context()`, never a child of the borrowing Host. Its minimal public service graph is session projections → sessions/agents; system prompt → tools; loader → preset registry; actual AgentLoop consumes agents/sessions/LLM/tools/prompt/projections. A real private preset mounts the real native executor through the real loader's public `builtins`/`cordis:` entry route, without module-resolution helpers or a profile file. Actual native plugins are awaited as Cordis fibers; there is no `ctx.start()`.

The only persona is the supplied bounded complete section. Tool definitions must be supplied explicitly. A root guard checks the exact effective definition object from `tools.definitions(agent, toolSet)`, not just its name. It also requires a retained owned agent. Scope-local substitutions therefore fail the guard. No instructions, workspace memory, shell or MCP plugin is mounted in this root.

The result exposes `ctx`, `createAgent({provider, model, sessionId?, setup?})`, `getLlmHookContext()`, `getCurrentCall()`, `ownsAgent(agent)`, `ownsRequest(options)` and `close()`. `createAgent` calls the real public agent factory, awaits private preset mounting, selects the explicit session-local model and verifies the retained registry object and composed preset. It returns the real native AgentHandle. Session-local selection is mutable; the consuming source/admission layer must still verify the prepared provider/model on every request. The optional setup callback, attachments and persistence service are trusted injections, not untrusted transport fields. Persistence is absent by default, so the default sessions are in memory.

## Borrowed LLM boundary

A plain facade calls only the supplied LLM's public `prepareCall` and `stream`; a prepared call is dispatched through its public `stream`. No `streamWithRegistration`, forged brand or second AgentLoop implementation is used. An AsyncLocalStorage record surrounds construction and every iteration of that public stream, retaining the actual agent, original native WeakSet-branded request and private call ID.

`getLlmHookContext` must synchronously return the actual owning native context of the borrowed LLM. The required trusted `onStream(options,next,call)` hook is installed there. Registering a hook on the independent root would not intercept the borrowed service. B may subscribe through the returned owner context and correlate `getCurrentCall()`/`ownsRequest(options)` there. Those methods prove the private native caller; they do not authenticate the contents of every message. The supplied hook remains responsible for full-input provenance, H admission, cancellation and budget accounting. Other owner-root LLM waterfalls can still transform a request; final actual-request checks remain mandatory.

Missing required modules, hook owner, persona, typed definitions or admission hook fail with an error carrying `code: MEMORY_NATIVE_ROOT_UNSUPPORTED`, nonempty `error` and `hint` that retains V1. There is no substitute runtime or permissive default dispatch hook.

## Proof boundary

Isolation removes ancestor AGENTS/pre-step listeners, prompt/context providers and tool registrations because they are outside the actual context ancestry. It does not make future assistant history trusted. The native Session still accepts caller-created assistant events. The fixture explicitly requires an admission policy that rejects further dispatch without captured-output provenance. The proposed `sourceRuntime.captureModelOutput` sidecar and parent B integration are separate work; this factory does not implement them or relabel assistant events as owned.

The fixture adapts the already verified P0 packaged Desktop Host runner by reading its source and generating a new harness only under `_backups/memory-v2-native-root`. It changes the probe payload and evidence directory; the original runner is not edited. The genuine packaged Host loads the probe through its normal loader in a completely temporary profile. The probe creates the independent native root in that same process and uses a purely in-process fake adapter registered on the actual LLM service. No actual provider is called. The P0 outbound/TLS/DNS/child-process guards remain in place, and only that owned Host's ephemeral loopback listener is permitted. The owned Host is shut down through its own IPC handle; no normal Host or service is restarted.

## Verification record

Command, from the worktree:

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-memory-v2-native-root.mjs
```

Native fixture attempt 1: parent command exit 1; actual Host exited cleanly with code 0 after owned shutdown. Evidence `_backups/memory-v2-native-root/run-Tun7Pm/result.json` and `attempt-1.log`. The packaged probe accessed a service property outside its declared injection and failed with `Error: cannot get property "systemPrompt" without inject`. The fix uses the public explicit context service lookup in the probe. This attempt did not reach or prove the independent native graph.

Native fixture attempt 2: command exit 1; owned Host shutdown code 0/signal null. Evidence `_backups/memory-v2-native-root/run-J32nOY/result.json` and `attempt-2.log`. The actual public `defineTool` authoring API takes a per-property parameter map, so the fixture's raw object-root JSON Schema failed with `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`. The fixture was corrected to a property map and a typed string output after reading that compiler contract.

Native fixture attempt 3, final: command exit 1; owned Host shutdown code 0/signal null. Evidence `_backups/memory-v2-native-root/run-MyVnJR/result.json` and `attempt-3.log`. Before failure, the actual independent native root initialized, the real private preset mounted, the real native agent was created and retained, its exact session-local provider/model matched, the selected executor was the actual `NativeToolExecutor`, its visible tool was the exact owned definition object, and a copied agent object failed ownership. The next fixture call, `root.ctx.tools.resolve({agent, scope: agent})`, omitted the required AbortSignal. It failed at installed `@deepseek-ai/dsh-tools/lib/index.js:544` with `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`.

The three-attempt cap was reached. There was no fourth native run or further dependency exploration. This is a precise fixture-premise failure, not proof that the independent root is impossible. The first real AgentLoop request, native request brand at dispatch, actual borrowed-owner LLM interception, sentinel absence in the final request, assistant settlement, follow-up rejection and successful independent-root teardown **remain unverified**. Their assertions exist in the fixture but did not execute. In particular, this brief produced no successful fake-provider dispatch and no complete request capture. The normal installed Host was not exercised or restarted.

The controller command uses the previously verified bundled Node v24.21.0 on macOS arm64 and spawns the actual installed Electron executable in Node mode through the existing P0 harness. Each result records the exact command, clean temporary environment, IPC lifecycle, logs and exit status; no successful native probe runtime payload was emitted. No exact Node 22.13 or Windows runtime is available. The helper uses ordinary Node APIs available in 22.13; the installed native packages retain their own bundled-runtime requirements. The same bundled Node ran `--check plugins/surfcore/lib/memory-v2-native-root.mjs` and `--check plugins/surfcore/scripts/test-memory-v2-native-root.mjs`: both exit 0 with empty stderr. Scoped `git diff --check` and a direct trailing-whitespace check passed. These checks do not substitute for the missing behavioral gate. The source and test are frozen for the parent's separately scoped fixture repair; this child will not run a fourth native attempt.

## Integration and rollback

Parent integration must supply actual modules, the correct LLM owner, approved content, owned typed tools and a trusted full-input admission hook. A successful first-call fixture does not authorize production QQ/Bilibili sessions, unknown attachments, arbitrary history, global model changes or normal-profile installation. Close the returned owned root to dispose its handles, preset, external owner hook and actual plugin fibers. Roll back by leaving the factory unused and retaining V1. No release, production profile edit or restart is included.

## Parent verification and dynamic scoped tools

The parent repaired the actual fixture's required ToolContext signal and user-message source; packaged Host exited 0 with ten first-call/denied-followup checks (`_backups/memory-v2-native-root/run-6G2zzf`). This supersedes the child hand-back as the first-call result only; complete output provenance is still required.

`registerTool(definition, agentCtx = root.ctx)` is a private Host capability. It accepts only this root or an actual retained agent context, validates a distinct typed definition, and keeps the exact-definition guard set synchronized with registration and its idempotent disposer. At most 32 simultaneous definitions are allowed. A stale resolved tool set is denied after disposal. Root close also revokes dynamic registrations; no model tool receives this capability.

## 私有 prepared.config 来源（2026-11-10）

`getCurrentCall().preparedConfig` 保留本 root LLM facade 从实际公开 `prepareCall` 收到的 `prepared.config` 原指针；它在接收待验 request 之前确定，不从 request/options 反推。来源 factory 必须逐调用验证这个配置与当前私有 agent/request 关联；未准备的 stream 没有该字段，不能据此推定已 pin。`ownsRequest` 只承认当前调用的原对象，同 sessionId 的浅拷贝也不成立。字段是配置来源，不是完整输入或 writer 身份证明。
