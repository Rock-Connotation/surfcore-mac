# P2-DOUYIN — capture before model and direct admission

2026-11-09. Scope: the current Douyin companion engine, memory factory, direct model adapter, strict companion ledger, and production companion controller. Production wiring remains owned by the Host/index coordinator. V1 remains the fresh-install default. No platform posting, real model request, profile change, or production activation is part of this change.

## Problem and chosen path

The engine previously built one memory context for a two-item round, then recorded a clipped reflection only after model success. `createCompanionModel().call()` discarded `beforeSend`. This could lose the original observation on model failure and could send stale memory after a control or character change. The strict ledger also rejected newly attached provenance.

Two approaches were considered: put V2 behind the old `buildContext/recordMemory` callbacks, or add an optional trusted V2 adapter alongside the existing V1 path. The former cannot capture before perception/model awaits or distinguish a prepared packet from an old round string. The latter keeps V1 callers compatible and gives each model step an independently checked source, packet, and manifest. The implementation uses the latter, within the existing modules; it does not change kernel, budget, client, common runner, or sharing modules.

## Factories and trusted wiring

`createCompanionMemory({ getCharacter, maintainMemory, stateDir, memoryV2 })` and `createDouyinCompanion({ ..., memoryV2, getModelRequest })` accept optional `memoryV2`:

```js
{
  adapter,       // channel-specific createMemoryHost adapter, canBindInput:true
  getRouting,    // trusted synchronous closure; optional
  onBlocked     // awaited retirement callback
}
```

`getRouting()` returns `{ok:true,backend:'v1'|'v2'}` or `{ok:false,code,error,hint}`. Its default is `readMemoryRouting({stateDir})`. HTTP inputs, model output and prompt fields cannot select a backend. V2 and routing failures never enter the legacy card/life/purpose path. Unknown free-form legacy history is excluded; the current query uses the actual current object/transcript, bounded to 6,000 characters, without old global briefs or unauthorized turns.

The Host owner must provide trusted account, requester, audience and provider-grant resolution and set `handleTtlMs:300000` when it creates the adapter. The Douyin selector is `douyin:homepage-recommendation`. Source/account/policy authority comes from that resolver; media/model output cannot enlarge it. Existing feed material has stable object IDs but no reliable author account or source revision. The source therefore records `external-author:unknown` with reported attribution, and uses stable initial observation identity `douyin:<jobId>:<objectId>:v1`. A different payload under that identity conflicts; no revision is fabricated.

`getModelRequest` is a trusted synchronous engine callback:

```js
getModelRequest({
  jobId, activityId, step, characterId, characterEpoch,
  providerRouteId, model, system, prompt, images
})
```

It returns the accepted admission request fields:

```js
{
  requestId, category, purpose, jobId, role, epoch,
  providerRouteId, model, estimatedTokens,
  // Optional verified fields: quotaDay, sessionId, priceSnapshot
}
```

The Host caller supplies stable per-step IDs and estimates. The direct model adapter checks the supplied route against its actual `route.provider` and `route.model`. No IDs, prices or CNY values are invented. V2 requires this callback and fails visibly without it. Existing V1 callers can omit metadata and retain their legacy call path.

## Actual execution and persistence gates

1. Capture the trusted role synchronously, then obtain the channel handle before perception. A late callback after a role/epoch change is rejected and its handle released.
2. Verify actual perception object, URL, homepage origin and duration. Before any reflection model, ingest the full privacy-redacted transcript and complete structured observation metadata through Host normalization. Preserve exact transcript coverage, speech state, warnings, raw frame metadata and frame identities. Image bytes are represented by SHA-256 split into four 16-hex groups so the shared long-token redactor does not erase their identity. No full-watch claim is inferred from sparse frames or a media `complete` flag with missing ranges.
3. Keep external author quotation separate from the role's observed processing action. Source and processing events share an idempotent source operation. Require the real kernel committed receipt and bind its canonical `eventRefs`.
4. Prepare a fresh packet per model step using the real `prepareCharacterContext(request,{adapter,handle,query})` helper. The selected retrieval manifest is attached by the Host. Record and bind the exact system/user prompt and selected image identities as an actual-input event. Existing bound source/retrieval refs cannot be narrowed by later model-selected references.
5. Before generation, call `validate(handle,preparedHandle)` through `beforeSend`. The direct model adapter invokes this hook at the actual stream boundary and around asynchronous setup. During generation and after completion it uses current-control/full-manifest validation via the hook's `completion` phase.
6. After model completion and before result adoption/persistence, call `validate(handle)`. The prepared packet may expire during generation; current control and the complete actual manifest remain mandatory. Reflection ingestion inherits those actual inputs and revalidates before committing.
7. On denial, worker loss or role change, discard unadopted result fields, abort the activity, and await retirement proof. `onBlocked({ok:false,code,error,hint,jobId,handle,characterId,characterEpoch})` must resolve `{ok:true,retired:true}`. Missing, rejected or incomplete proof surfaces `MEMORY_RETIREMENT_UNCONFIRMED`. Release handles on every exit. A source already committed remains saved when a later model fails.

All failures preserve structured `code/error/hint` through the existing job/status path, including MEMORY, MODEL, COMPANION, CHARACTER and BUDGET families. A failure does not silently reuse an old packet or legacy context.

## Direct model adapter contract

`createCompanionModel({ctx,tokenBudget,getCharacter,route?})` preserves `.call(options)` and `.reply(options)`. Both now preserve `beforeSend` and accept optional `requestMetadata`. For admitted calls the hook may be async and must explicitly return `true` or `{ok:true}`; absence or undefined denies. Legacy hooks without admission metadata retain their existing undefined-return compatibility.

`beforeSend({phase})` receives admission/stream phases including `reserve`, `dispatch`, and `completion`. The accepted `createModelCallAdmission` owns reservation, admission and settlement. Only `ok && send` reaches the stream. Duplicate or unknown requests are not resent and produce an actionable error. Admitted calls do not also call `recordExternalUsage`.

Each returned usage chunk reaches `onUsage` before role, privacy and abort checks. Cancellation drains an already-returning same-turn chunk before closing accounting; genuinely absent/later usage retains the conservative unknown reservation for explicit reconciliation. Known usage is charged even when output is discarded. Without reliable prices the authoritative `actualCostCny` remains `null`. This covers direct `llm.stream` calls only; agent-loop calls are not claimed covered.

## Persisted provenance shared with the local opening owner

Job and item projections retain:

- `memoryV2Refs`: canonical `{type:'event'|'memory',id,revision,payloadDigest}` array; job cap 64, item cap 32.
- `memoryV2Receipts`: array of FULL real Host ingestion receipts plus `phase:'source'|'model-input'|'reflection'`; job cap 12, item cap 6.
- `memoryV2Receipt`: optional compatibility alias equal to the latest plural receipt.

For the current ingestion seam, a full receipt carries `ok:true`, `operationId`, `acceptance:'volatile'`, `sourceState:'committed'`, `selectionState:'not_selected'`, `indexState:'ready'`, `operationState:'completed'`, `retry:'none'`, actual positive `commitSequence`, `eventIds`, `eventRefs`, and `nextOffset:null|nonnegative integer`, plus phase. These fields come from `src/core/memory-v2-contract.js:164` and the actual ingestion return; the engine does not synthesize or compact them. The strict ledger permits only this whitelist. IDs are bounded, event revisions are 1, digests are 64 lowercase hex, event IDs and refs are unique and have exact membership, receipt refs occur in the target's refs, and unknown keys are rejected. Normal read/write ledger cycles preserve this proof. Delivery classification booleans remain compatibility projections, without granting access.

## Current-ACL response and HTTP send boundary

Completed diary output is a derived memory read. Generation/save checks alone cannot authorize a later status response. The engine therefore uses the same trusted channel adapter to capture a fresh read handle, bind the union of every projected job AND item reference, and validate current policy, roots, worker generation and role before returning successful V2 views. It uses no admin or wildcard authority. Source IDs, titles, reasons, summaries, drafts and provenance are not returned after binding or validation fails. Source receipts remain in the protected ledger.

Historical V1 rows without provenance are quarantined from V2 `recentJobs`/`activeJob`; schedule windows pointing at excluded jobs are omitted. Uncommitted live candidate items are omitted until they have canonical committed source proof. This prevents an unproven candidate ID/title from escaping through progress metadata. Fresh locally queued jobs can expose their opaque activity identifier with no candidate content after normal current-context authorization.

The engine exposes:

```js
const value = await engine.status(context); // same response lease behavior for successful start/cancel/configure/tick
try {
  const check = await engine.validateResponse(context, value);
  if (!check.ok) return check;
  // Serialize this exact value now, after all other asynchronous work.
} finally {
  engine.releaseResponse(value);
}
```

A V2 lease belongs to the exact returned object, pinned role and fingerprint of its complete body. Clones, mutated bodies, changed routing, changed role, revoked source roots/policies and unavailable workers fail with structured code/error/hint. Validation uses current full-manifest control rather than a prepared packet, so normal packet expiry after a model does not incorrectly hide an otherwise currently authorized diary. `releaseResponse` is idempotent; disposal releases retained leases. V1 values retain the legacy behavior.

The production `douyin-companion-controller.mjs` validates the actual GET value AFTER asynchronous readiness and immediately before JSON. POST start/cancel/configure results are revalidated before JSON too. Every path, including role mismatch, readiness error, denial and success, releases its held exact value in `finally`. Aggregate/index owners must call the same APIs after their last await and before their own response; a previous successful callback or serialized provenance field is not send authority.

## Verification and operational handoff

The new `plugins/surfcore/scripts/test-memory-v2-douyin.mjs` uses a real worker/kernel and Host with isolated generated fixtures under `_backups/memory-v2-douyin/`; only media/model transport is fake. It checks capture/source-before-model, original redaction and exact coverage, idempotency, two fresh sequential packets, model failure with saved source, revoke at query/pre-model/during generation/pre-save, worker loss, stale-role late callbacks, completed-diary policy/root revocation, production-controller readiness/POST races, exact response leases, legacy-row quarantine, private-A/public-B lineage laundering denial, prepared TTL versus adoption, no legacy canary, strict ledger round trips and malformed proofs, default-deny admission, duplicate no-resend, unknown CNY, and known usage on privacy/role/abort rejection.

Existing requested test names do not exist. Actual existing fixtures, kept unchanged, are `test-douyin-companion.mjs` and `test-douyin-companion-host.mjs`. Run all three under CLI Node 26 and bundled Node 24:

```sh
node plugins/surfcore/scripts/test-douyin-companion.mjs
node plugins/surfcore/scripts/test-douyin-companion-host.mjs
node plugins/surfcore/scripts/test-memory-v2-douyin.mjs
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-douyin-companion.mjs
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-douyin-companion-host.mjs
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-memory-v2-douyin.mjs
```

Verified on 2026-11-09: all six Douyin fixtures (engine, Host, new V2, recall, media, UI) passed on CLI Node 26.5.1 and bundled Node 24.21.0. The final V2 suite passes 24 offline scenarios on both runtimes, including the response-gate repair. After that repair, `npm run test:audit` again passed 176/176 scripts and `npm run test:regressions` passed all regressions. Scoped `git diff --check` passed. No real network, model, Douyin posting, profile write, service start or commit is authorized. Production activation requires the Host owner to wire the above factories and restart the plugin-owning DSH process through the release workflow. This child does not activate that path.

Rollback: the five pre-existing module originals are saved under `_backups/memory-v2-douyin/plugins/surfcore/lib/`. The parent can restore those exact originals and isolate the two new files after review; no rollback deletion is performed here. Fresh V1 has no new routing write or activation side effect.

Release handoff: P2-DOUYIN adds optional capture-before-model V2 and direct admission, with strict provenance persistence; user impact is limited to explicitly Host-wired V2. Owner must carry the validated runtime tests, factory wiring, trusted identity/grant resolver, 300000ms handle TTL, stable admission metadata, and awaited retirement proof into its integration review. No version, commit, production service or release has been changed.

Independent review repair (run 2): completed diary reads previously lacked current-ACL/full-manifest validation. The engine-owned lease and controller send checks above close that path; no UI or index file was edited. Controller scope expansion was explicitly approved, bringing this child to seven files.
