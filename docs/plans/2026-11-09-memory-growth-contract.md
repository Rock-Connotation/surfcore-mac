# Memory V2 growth and bounded organizer contract

Status: review run 2 ready for parent acceptance. The 29-check suite passes on DSH primary Node 24 and bundled Electron/SQLite after the parent-owned derived-event independence fix. The prior 27-check suite missed that laundering path. This document freezes the interfaces owned by this task; production activation and actual model calls are not authorized here.

## Scope and choices

The original experience ledger remains authoritative. An organizer may propose typed summaries, self reflections, preferences, self views and commitments; only the kernel can accept them. Existing model-produced media reflections are already sources, not new independent behavior evidence when summarized again.

Two routes were considered: add organizer-owned JSON checkpoints, or use the existing role Worker jobs and budget receipts. The latter keeps source ownership, policy revisions, crash recovery and quota ownership in their existing modules, so the organizer owns no journal or database. Missing durable hooks cause `ORGANIZER_HOST_NOT_READY` before any model invocation.

## Pure kernel growth helper

`src/core/memory-v2-growth.js` exports:

```js
validateGrowthProposal({ proposal, rootEvents, previous, counterEvidence = [], asOf })
// { ok, selectionState: 'committed' | 'review' | 'rejected',
//   growth?, commitment?, code?, error?, hint? }
```

This is a policy-free pure check, called only by the kernel **after** exact-span, subject, reality, ACL intersection and version/CAS validation. `rootEvents` contains actual original roots reachable from the candidate's validated evidence references. Derived memories must resolve back through their cited evidence to originals. An ingested event with a nonempty actual inputManifest remains derived: its new event ID cannot become a new independent experience, and the full input manifest is not expanded into growth evidence. Derived-only candidates remain review with `MEMORY_GROWTH_DERIVED_EVIDENCE`; an outer candidate must explicitly cite original events to count them. Uncited batch events still belong in the actual input manifest and its permission intersection, but cannot inflate growth counts. `previous`, counter-evidence and `asOf` come from trusted kernel state/time, never model-supplied counters or current clock claims.

Self means the existing literal `self` convention or an actual root whose subject equals its characterId. A stable self `preference` or `self_view` needs at least three unique independent action/reflection roots on at least two UTC ISO dates. Repeated event roots, repeated segments and derived summary IDs do not add evidence. Trusted unresolved counter-evidence yields `review`; a review candidate is not an active fact. The metadata remains inferred and never updates corePersona.

A single real root can support a `reflection`. A current explicit self statement uses proposal attribution `current_self_statement`, requires an actual self statement/reflection, and yields `growth.classification='current_statement', stable=false, certainty='reported'`. It does not establish external observed truth or a stable trait. Reported user preferences do not inherit the self-behavior threshold; the actual source must be a statement by that stable subject. Joke, quote, plan, conditional and unknown-certainty material alone cannot establish growth. Existing non-growth kinds and legacy commitments without typed metadata keep their prior kernel behavior.

The helper generates growth metadata; the model cannot submit `growth`, root counts, dates, authority or persona/control fields.

## Typed commitment metadata

New organizer commitment candidates require:

```js
commitment: {
  promiserAccountKey,       // namespaced stable account, never a nickname
  beneficiaryAccountKey?, // same requirement when present
  dueAt: null | ISO,       // explicit timezone-anchored timestamp; null means unknown
  status: 'open' | 'completed' | 'cancelled' | 'overdue' | 'disputed',
  transitionEvidenceId?    // actual independent original root ID
}
```

The kernel helper adds `evidenceRootIds` and `confirmation`. New commitments begin open/disputed. Completion or cancellation requires an actual previous commitment and new evidence from the same promiser, not an old cited root or model-declared authority. Changing the deadline likewise requires fresh evidence. Closed commitments retain their state or become disputed. Passing a deadline yields only overdue/unconfirmed, never automatic completion; overdue needs trusted `asOf` later than dueAt. The source date and quoted deadline remain available for review; timestamp syntax checks do not claim semantic understanding of arbitrary natural-language promises.

## Organizer Host interface

`plugins/surfcore/lib/memory-v2-organizer.mjs` exports:

```js
createMemoryOrganizer({ memoryService, modelAdmission, modelCall,
  getModelRequest, getCharacter, now = Date.now, tokenizer })
// => { run({ context, trigger, optIn = false, signal, cursor?, domain? }) }
```

The caller supplies a fresh issued Host context for each new organize job, with purpose `organize`; identity, epoch (`capturedEpoch`), processing grant and route are never taken from model output. Actual input manifests are monotonic for an issued context. Reusing one context across different batches would union prior input references, so `ORGANIZER_CONTEXT_REUSED` stops before another model call and asks the Host to capture a new context. It never clears or rewrites provenance. Allowed triggers are manual, idle5min and before_compact, each requiring optIn=true. There is no timer or automatic dispatch in this module.

Required Host hooks:

```js
service.host.readOrganizeBatch(context, {
  limit: 40, maxInputTokens: 5000, cursor?, domain?
})
// complete authorized events, exact inputManifest, inputDigest, one policy
// domain, stable jobId/highWater, opaque durable cursor, jobState/receipt

service.host.bindInputManifest(context, exactCompleteInputRefs)
service.host.finishOrganizeBatch(context, {
  jobId, cursor, inputManifest, requestId, inputDigest,
  state: 'completed' | 'review' | 'rejected' | 'model_unknown' | 'failed',
  candidates
}, operationId)
```

Source cursors are Host-owned persisted cuts backed by source_sequence; the organizer never interprets SQLite row IDs or rewrites cursors. A stable job/model request ID binds the actual job, high-water cut, policy domain, input digest and complete prompt digest. Before model dispatch the Host durably records a `model_unknown` claim; completion uses the same requestId and a separate stable operation ID. Encountering an existing outcome never automatically sends another model request. Candidate operations query existing kernel receipts before proposing again. Budget receipts protect model invocation; durable Host jobs protect batch state.

The complete serialized input contains all actual events and references, never only the cited subset. Reader budget is 5000 conservative input tokens to leave instruction overhead; the complete input must remain at most 6000. With a trusted tokenizer the measurement is labeled tokenizer; otherwise UTF-8 byte count is a conservative estimate, never claimed as exact model tokens. Sources and segments are not truncated to fit.

All-reflection batches directly propose the existing source text as reported reflections without another model call. A reflection whose actual inputManifest already contains dependencies is still derived; the kernel can retain its candidate in review rather than promote it to an independent original. A mixed batch may perform one newly authorized organizer call, but cannot re-run media perception/reflection. The original media coverage and authorship stay in the input and kernel provenance. Every derived summary still resolves to the same original roots.

The accepted model-call admission runner handles installation-wide organize budget, known usage, unknown reservation and actual overruns. `getModelRequest` supplies trusted model/route and optional conservative estimatedTokens/priceSnapshot. `modelCall({requestId,onUsage,signal,input})` reports cumulative authoritative usage through onUsage. No extra recordExternalUsage call is made. Missing usage or a provider exception never triggers automatic retry. Role/generation/grant changes discard late proposals; the runner still settles known usage or retains unknown reservation.

Model output is only `{proposals:[...]}`, at most eight candidates. Unknown envelope/field, persona/control mutations and tampered evidence spans are rejected before application. The final evidence/ACL/CAS decision still belongs to the kernel. Outcomes expose candidate/rejected/review/model_unknown/committed phase receipts and actionable hints; a completed organizer job does not mean every candidate became a fact. Empty or oversized deferred-source batches make no model call and do not claim a durable cursor advance.

## Verification and remaining integration

`node plugins/surfcore/scripts/test-memory-v2-organizer.mjs --require-real` exited 0 with **27 checks passed**. Evidence: `_backups/memory-v2-growth/run-BCLSvI/report.json`; console log `_backups/memory-v2-growth/final-tests.log`. Eight relevant module hashes matched before and after the run. All stores, state and quota homes were synthetic beneath the evidence root; no actual model, network, production profile or running service was used.

Ten pure helper checks cover independent roots/dates, repeated roots/summary laundering, unresolved counterproof, single reflection and unknown source date, current self statements and reported user preference, forbidden fields/reality upgrades, typed accounts/deadlines (including invalid calendar dates), new-evidence participant authority, overdue versus completion, and deadline changes/closed states. Seven injected-Host checks use the **real** budget service and model admission runner with a fake model: known usage, repeat job outcomes, opt-in/not-ready, unknown fields/tampered spans, unknown reservation blocking a new request, charged actual overrun, charged late-role discard, malformed output and private provider failure. These seven are labeled injected; they are not claimed as Worker evidence.

Ten additional checks use the actual service/Worker/SQLite, actual budget/admission runner and a fake model:

1. Three cited original roots commit stable self metadata; the committed candidate receipt and completed cursor survive close/reopen, with no next model call.
2. One cited root stays `review` despite three full actual inputs; no active memory version is created.
3. An existing reported reflection is directly proposed without any model invocation.
4. A persisted `model_unknown` claim survives close/reopen and prevents redispatch; the original source remains.
5. A locally forbidden persona field yields a durable rejected job and no source deletion.
6. Two policy domains with the same proposition key produce separate memory IDs/version chains. Reusing a context for the second batch is stopped before dispatch; a fresh context succeeds.
7. A complete 84,000-byte source, normalized into two UTF-8 parts, is deferred whole: no truncation, model call, source loss or claimed cursor advance. Reader caps of 40 events/6000 conservative tokens reject larger requested limits.
8. Revoking the actual processing policy during an admitted fake call discards output and preserves the measured 23-token charge. Its stale context cannot falsely finish the durable claim.
9. A joke promoted to observed truth is denied by the kernel; its rejected diagnostics finish durably without creating an active memory.
10. An open typed commitment reaches revision 2 on the same memory ID only with a fresh promiser source and actual previous version; the revision-2 receipt survives reopen.

The real tests exposed a Host completion-hook mismatch: locally rejected candidates had no committed kernel operation receipt. The parent kernel owner added a bounded Host-local rejection diagnostic path; the organizer never fabricates a committed receipt. They also exposed issued-context reuse across batches; the organizer now rejects that before a further model call. The source sequence/cursor and active fact decisions remain kernel-owned.

The required `npm run test:audit` exited 0: **176/176 scripts passed**, with log `_backups/memory-v2-growth/run-BCLSvI/audit.log`. The repository audit additionally runs its existing isolated fixtures under their usual ignored artifact directories, including local HTTP plus deterministic-provider tests; those are separate from the new suite's ten real Worker fixtures. Syntax checks for all three new JavaScript modules and owned-file whitespace checks passed. The frozen evaluation corpus SHA-256 remained `70c664208a85f1d7dedac7cb28aeb2dc8e7f5102881203cff46a5023f2fdecc3`.

Parent review owns the combined case and release handoff. No production activation or model quality, arbitrary promise semantics, UI or end-to-end delivery claim is made.

### Review run 2: derived-event independence regression

Parent independent review found a missing kernel boundary: a derived event can inherit the correct original ACL/root closure while its new event ID is still counted as an independent growth experience. The pure helper expects trustworthy original roots; correcting that selection belongs to the parent-owned store.

The new real Worker regression ingests one original, completes its organizer batch with zero proposals, then uses three fresh Host contexts to bind that exact original reference before three derived ingests. The derived sequence is observed action / reported reflection / observed action on two dates. After close/reopen, the bounded next batch contains all three derived sources, each with a persisted actual inputManifest pointing to `one-original`; the candidate cites only those three derived records. It must remain review with no active memory version. A separate real three-distinct-original preference case is the positive control.

Before the kernel fix, `_backups/memory-v2-growth/review2-derived-bounded.log` records the concrete failure: `actual 'committed' expected 'review'` at the negative assertion. No source cap was bypassed and no kernel file was edited by this task. The parent fixed the kernel collector so nonempty event inputManifest prevents the event's own ID from becoming an independent growth root; it does not expand the whole input manifest into uncited growth evidence.

After that fix, the suite exits 0 with **29/29 checks**: ten pure, seven injected-Host/real-budget/fake-model, and twelve real Host/Worker/SQLite/real-budget/fake-model cases. The derived-only preference returns `review`, `MEMORY_GROWTH_DERIVED_EVIDENCE`, and zero active memory versions; three explicitly cited distinct originals on two dates still commit a stable self preference. Eight relevant module hashes match before and after each run.

| Runtime | Evidence | Log | Result |
| --- | --- | --- | --- |
| DSH primary Node `v24.21.0` | `_backups/memory-v2-growth/run-MM2QwI/report.json` | `_backups/memory-v2-growth/review2-primary-cli.log` | 29/29 PASS |
| DSH bundled Electron Node `v24.21.0`, SQLite enabled | `_backups/memory-v2-growth/run-Mnvmmx/report.json` | `_backups/memory-v2-growth/review2-bundled-cli.log` | 29/29 PASS |

Exact runtime commands:

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-memory-v2-organizer.mjs --require-real
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --experimental-sqlite plugins/surfcore/scripts/test-memory-v2-organizer.mjs --require-real
```

The report records process.version and process.execPath. Here bundled refers to the embedded runtime, not a JavaScript bundle. A further Homebrew Node `v24.21.0` run also passed 29/29 (`run-t4t7W7/report.json`). Only after the kernel fix landed, `npm run test:audit` was restarted with DSH primary Node first in PATH. It exited 0 with **176/176 scripts passed**; the post-fix log is `_backups/memory-v2-growth/run-MM2QwI/review2-audit.log`.

## Adoption, failures and rollback

The four files are additive; importing the factory does not start timers, models or a Worker. The parent kernel owner integrates the pure helper and the existing Host hooks, and owns combined case/release documentation outside this task's write boundary. No caller/index/channel/budget files are edited here. Until explicit Host adoption this feature has no production path to restart. Adoption requires the updated Host/kernel process to load the matching modules.

Failures return ok:false with code, error and hint; original sources remain stored. A failed or unknown model job must be inspected through its original request and job receipts. Never report a review/rejected candidate as remembered. Rollback is to stop invoking the additive organizer and keep the source ledger and existing model receipts; do not erase source data or refund already admitted unknown usage. Repository activation, privacy, lifecycle, source delivery, corePersona and budget policy remain owned by their existing modules.
