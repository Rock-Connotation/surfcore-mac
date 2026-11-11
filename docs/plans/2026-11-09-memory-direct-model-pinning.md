# P2-DIRECT-MODEL-PINNING

2026-11-10. This contract covers the existing Douyin direct model factory, its engine/memory caller, and local companion sharing. It does not activate V2, change the Host/kernel/budget/controller/index interfaces, cover agent loops, start services, contact a provider, or post to Douyin. Existing metadata-free V1 direct calls keep their original stream and external-usage path.

## Problem and chosen implementation

A provider name alone cannot identify a processing grant for an exact model. Also, a plain lazy `llm.stream()` can perform asynchronous provider preparation after a successful permission check. An authorization snapshot followed by that preparation leaves a gap before actual dispatch.

The chosen path prepares the exact registered provider/model through public `llm.prepareCall(config, signal)` before paid admission, then starts the prepared stream's first `iterator.next()` synchronously inside `adapter.withNetworkAdmission(originalHandle, dispatch, {signal})`. The Host delegates the original context and full bound manifest to the real kernel FIFO fence. The response is consumed outside that fence, so control commits can complete while the provider response is pending.

A catalog-only check plus plain stream would be smaller but would not pin a registration or close the asynchronous preparation gap. A private `streamWithRegistration` call would depend on internal objects and require forged registration state. Neither is used. Unsupported public preparation or network admission fails closed with a structured code/error/hint.

## Frozen direct-call API

```js
const model = createCompanionModel({ ctx, tokenBudget, getCharacter, route });
await model.call({ system, prompt, images, signal, beforeSend, requestMetadata, admitNetwork });
await model.reply({ system, prompt, signal, beforeSend, requestMetadata, admitNetwork });
```

`route` remains the explicit factory route; its default is `{provider: 'surfcore-companion-hy3', model: 'workbuddy/hy3'}`. The factory copies and freezes those two values. V2 does not resolve an alias, use a default selector, replace a provider, or fall back to plain stream.

`requestMetadata` remains caller-supplied stable metadata for `createModelCallAdmission`: requestId, jobId, category, purpose, role, epoch, providerRouteId, model, estimatedTokens, and optional supported price/session fields. The factory snapshots it before its first await. Request IDs, estimates and CNY prices are never invented.

`providerRouteId` comes from `deriveMemoryProviderRouteId({provider, model})`, which hashes the exact JSON pair as `dsh-route:<sha256>`. The model verifies both the factory route and the frozen `prepared.config` against metadata; `metadata.model` must equal the exact prepared model. Douyin and sharing separately check that their original captured sourceStamp has the same expected hash before any source/context use. The metadata callback cannot rewrite a captured grant. The same model name under another provider gets a different route ID, as do delimiter-containing pairs that would collide under concatenation.

`beforeSend({phase})` remains mandatory for admitted calls and must return true or `{ok:true}`. It validates prepared permission for new sends; completion checks retain current context/full-manifest validation without requiring the short preparation package to remain alive after generation.

`admitNetwork(dispatch, {signal})` is a private, trusted JavaScript closure. Douyin passes a closure through `memory.admitNetwork(session, dispatch, options)`. Sharing passes a closure over its actual adapter and original capture handle. Both delegate to the real `adapter.withNetworkAdmission`; HTTP bodies and model output cannot provide this closure or select its context. Missing capability returns `MODEL_NETWORK_UNSUPPORTED`.

## Preparation, dispatch and accounting order

1. Validate input limits, the trusted guard and exact catalog image declaration. Finish image validation and `attachments.saveImages`; require one actual attachment ref per frame. The original image bytes/digests already belong to the caller's bound source/model-input events.
2. Call public `llm.prepareCall` with the exact factory route and generation controls, linked to a local AbortSignal. Require frozen prepared config and a prepared stream function. Check exact provider/model/hash against the original metadata. Revalidate after asynchronous preparation and attachment work.
3. Only then enter the existing shared runner's reserve/admit/authorize sequence. Preparation failures have no synthetic paid admission receipt. The runner remains the only usage-settlement writer for admitted calls.
4. Inside its invocation, call the trusted network closure. The private dispatch callback has no await: it creates the prepared stream, obtains its iterator, invokes the first `.next()` immediately, and attaches usage handling. It returns a private non-thenable frozen `{firstNext}` box. Only that exact box is accepted on return; a retained callback cannot dispatch twice or after the gate closes.
5. Consume chunks and report authoritative usage before cancellation, privacy or role/output checks. Provider errors carrying complete usage are reported before the shared runner checks the current role. The existing same-turn abort/usage drain remains: usage 5+4 charges 9 even when its chunk triggers cancellation.
6. Current role, permissions and output constraints decide adoption. Known usage still settles when output is discarded. Missing usage stays `usage_unknown` with the original estimate held; it is not treated as known actual usage, refunded, automatically retried or sent again under the same request ID. Unpriced settled usage has `actualCostCny:null`; an unknown-usage receipt retains its unknown state without an invented CNY charge.

The local signal is linked to the caller signal and request timeout. For admitted failures, cleanup runs inside the shared runner invocation, before its one settlement. It aborts the old prepared invocation, waits for any already pending iterator operation, then calls the same iterator's `return()` once. If the finalizer yields more values, cleanup drains them with `next()` without adopting text or starting another prepared call. Every returned chunk and thrown `error.usage` goes through the existing onUsage hook before settlement. The cleanup budget is 100ms and at most four return/drain operations. An unresolved first flight is never overlapped with return/next; unresolved, absent or no-progress cleanup retains the unknown hold. Usage arriving after settlement does not trigger reconciliation. Cleanup's internal abort can make the runner's terminal code `MODEL_CANCELLED`; the original output remains rejected and any known usage still settles. Metadata-free V1 retains its original finalization path.

This fixes the parent R6 reproduction: a generator yielded rejected text, then yielded usage 14+9 in its finally block after policy revocation. Former fire-and-forget outer cleanup ran after settlement and left a hold of 100. Invocation-scoped cleanup now settles known actualTokens23 with actualCostCny:null and one network dispatch. A later request requires a fresh authorized context and a caller-supplied request identity. A duplicate may do preparation again, but the shared runner prevents another paid dispatch.

## Failure visibility

The direct factory reports `MODEL_NETWORK_UNSUPPORTED`, `MODEL_PREPARE_UNSUPPORTED`, `COMPANION_ROUTE_MISMATCH`, missing-guard errors, and existing structured Host/runner failures with actionable hints. Sharing preserves these structured model/companion failures in the current response; its durable terminal record uses the existing sharing schema's compatible failure projection. No provider error text or credentials are added to public diagnostics.

The source receipt remains committed when later preparation, generation or adoption fails. The previous full source/coverage, complete input-manifest and exact response-lease contracts continue to apply. Read/controller/ledger modules are outside this task's write boundary.

## Offline verification and evidence limits

`test-memory-v2-model-pinning.mjs` uses the real memory service, SQLite worker, real Host adapter and real `withNetworkAdmission` fence. Its fake public LLM service models capture-before-await registration semantics and uses no actual provider. Positive dispatch asserts that the first iterator step has already started before the kernel callback returns. The suite checks exact hashes and model mismatches, unsupported APIs, provider preparation failure, role/revocation during preparation, revocation during attachment work, captured-registration drift, pending-response control commits, usage23 before role/privacy discard, error-carried usage, unknown holds, duplicate no-resend, final-gate denial after admission, a real separately authorized wrong-route capture, finalizer-yielded and error-carried cleanup usage, absent/stalled/no-progress finalizers, and an abort-ignoring first flight with no overlapping iterator operation.

The fake public LLM fixture proves these callers' use of the public contract. It does not prove a complete installed DSH service/middleware/provider composition. That combination belongs to the parent integration fixture. Installed SDK read-only evidence is recorded in `2026-11-09-memory-network-admission.md`: public prepareCall captures the exact registration before adapter preparation and returns a frozen, single-use prepared call. No native provider preparation is executed by this child.

Run on CLI Node 26.5.1 and bundled Node 24.21.0:

```sh
node plugins/surfcore/scripts/test-memory-v2-model-pinning.mjs
node plugins/surfcore/scripts/test-memory-v2-douyin.mjs
node plugins/surfcore/scripts/test-memory-v2-sharing.mjs
node plugins/surfcore/scripts/test-douyin-companion.mjs
node plugins/surfcore/scripts/test-douyin-companion-host.mjs
```

After the cleanup repair, CLI26 and bundled24 both passed focused pinning22, V2 Douyin24, V2 sharing29 and unchanged common-admission27. The parent's original bundled24 finalizer-usage reproduction also changed from unknown hold100 to settled actualTokens23, one network dispatch and rejected output. Logs are `/tmp/pinning-run3-{0,1}-<test>.log`; run-one snapshots for all eight task files are preserved under `_backups/memory-v2-model-pinning/run2/`.

Before this repair, the required dual-runtime matrix also passed existing engine, Host, recall, media, Douyin UI and basic-sharing suites. Run-one audit passed 176/176 scripts and regressions passed; these heavy gates were not repeated for the cleanup-only repair at the parent's direction. Extra CLI sharing race, production UI-controller, reflection and platform suites passed in run one.

The voluntary standalone sharing UI run stayed open for more than five minutes without output and was stopped at the parent's direction. A read-only, in-memory replay of that same fixture with step logging completed all 30 checks; no UI source or fixture was changed. The original exact pending await remains unproven. The parent owns this optional fixture investigation; remaining optional bundled-sharing runs were not claimed. This is separate from the required dual-runtime matrix above. No actual provider/network/profile/service/commit activation is part of these tests; local fixture HTTP is stubbed and external browser requests are blocked.

## Scope, rollback and release handoff

Exactly eight task paths: four existing modules (`douyin-companion-model.mjs`, `douyin-companion.mjs`, `douyin-companion-memory.mjs`, `companion-sharing.mjs`), two existing V2 suites (`test-memory-v2-douyin.mjs`, `test-memory-v2-sharing.mjs`), this document and the new focused pinning suite. The six old task-start files are backed up with their relative paths under `_backups/memory-v2-model-pinning/`. They include the previously accepted response/provenance work; rollback must use these task-start backups rather than older pre-V2 originals.

Release handoff: exact-route V2 direct model pinning is implemented through public prepareCall plus the original-handle kernel dispatch fence. Host wiring must derive the same exact provider/model route hash and provide trusted getModelRequest metadata. Verify installed public preparation and middleware dispatch composition before enabling V2. Restart the plugin-owning DSH process only through the parent/release workflow. V1 remains the default; no activation or migration is performed here.
