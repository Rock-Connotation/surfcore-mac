# Memory V2 Host administration contract

Status: frozen API for P4-ADMIN-IDENTITY-CORRECTION, run 1. Production remains V1. No migration or activation is authorized.

## Ownership and decision

The sole signed SQLite Worker owns current-role administration. The Host owns original WeakMap management capabilities and preview capabilities. Control records contain identifiers, revisions, digests, and state only; source and correction text live exclusively in the selected role database.

An external person resolver would leave identity dependent on an unimplemented registry. The chosen alternative is a small confirmed-person registry in the existing control database, populated only by explicit administrator confirmation against actual stable source actors. This also prevents role restore from rolling identity back. Model outputs, nicknames, and arbitrary person strings cannot register identities.

## Exact Host API

All methods are under `memoryService.host.admin`. All contexts must be original `captureAdminContext` results for the current native role and epoch. Calls return structured `{ok:false,code,error,hint}` failures. Mutations use the existing service FIFO shared with final network admission.

- `status(ctx)` returns only the current role's counts, policy summaries, backup/operation summaries, confirmed persons, bindings, and actual capabilities. No text, paths, credentials, or other roles.
- `inspect(ctx, {query?, limit?:20})` returns at most 20 current-role event/formal records, including administratively visible suppressed history. Exact lookup uses `{recordId, recordRevision}`. Records expose `id,type,revision,content,status,roots,payloadDigest,subject,provenance,hot,identity` and bounded temporal metadata. Missing/ambiguous IDs fail explicitly.
- `preview(ctx, {action,payload}, expectedRevision)` is read-only. It returns a `previewDigest` binding the exact normalized action payload, current role/epoch/control head, target revision/domain and proposed changes. The Host privately remembers the preview under this exact capability.
- `commit(ctx, {action,payload,previewDigest}, expectedRevision, operationId)` requires that private preview and exact CAS. A new business operation never invents an ID. Reusing an ID for different immutable inputs fails with `MEMORY_DIGEST_CONFLICT`.
- `resume(ctx, {operationId, content?})` explicitly advances the original durable admin operation; it never creates a replacement operation. After a crash between control intent and role commit, a correction may need its original confirmed text again. Missing text leaves a pending receipt with `MEMORY_CORRECTION_CONTENT_REQUIRED`; supplied text must match the original durable digest. Once the role transaction committed, no text is needed. Receipt queries alone never advance work.
- `bindRequest(ctx, {operationId,action,payloadDigest,expectedRevision,characterId,characterEpoch})` persists a content-free HTTP-request binding before any business mutation. `payloadDigest` is SHA-256 over the manager's canonical actual UI payload. Same ID and all six typed fields replay the original binding; any difference fails. First creation requires the real context's role and captured epoch, and cannot attach a new assertion to a pre-existing unbound business receipt. Existing bindings never change their original epoch. This transaction does not increment privacy revisions.

`getMemoryReceipt(ctx, operationId)` returns durable `requestBinding` metadata alongside the real operation receipt. A binding alone is `operationState:'not_started'`, never a committed business/source result. Missing original business work remains `not_found`/`not_started` across restart. Cross-role receipt/binding access is denied.

## Actions and payloads

- `remove_hot`: `{recordId,recordRevision}`. Persist a content-free `hot_selection` job for that exact record revision. Prepare selection omits it; formal versions, raw sources, and explicit search remain intact. This does not suppress or invalidate the record.
- `create_person`: `{platform,accountId}`. Platform is `qq|bili|douyin|local`; normalize to a stable namespaced account key. The selected role must contain an original, non-derived source whose actual actor is this account. Explicit commit creates `person-<scope hash>` plus an anchor binding, administrator ID, confirmation time, role, and binding revision. Existing active anchor/person conflicts; same operation replays. No automatic merge.
- `bind_account`: `{platform,accountId,personId}`. Require a confirmed person in this exact role and actual source evidence for the account. An existing different person requires explicit unbinding. No ACL or source-author rewrite.
- `unbind_account`: `{bindingId}`. Revoke this role's actual active binding, increment binding revision, and invalidate only derivatives that actually depended on the binding. Preserve legal original sources. Unknown identity stays unknown.
- `correct`: `{recordId,recordRevision,content}`. Require a real current record, unexpired original source roots, and a currently approved original policy/grant intersection. Redact complete text before persistence; reject empty/oversized text. Control-first intent and root invalidation fail closed. A role transaction creates an independent reported administrator-statement source and a genuine new formal version in the original proposition/domain. Preserve original subject/time and an exact old-version pointer. New assertion roots are independent of withdrawn old roots; both the new source and formal version retain the earliest original source expiry. Receipts and control snapshots never contain correction text. Existing pointer-only `applyMemoryAction(type:'correct')` remains a separate supported primitive.

## Ordering, recovery, and identity

Request binding is independent of business intent. A business intent increments the current control head before source/version effects. The role effect and receipt are atomic. Control completion is content-free. COMMIT uncertainty retires the connection and directs callers to query the original ID after reopening.

Identity/correction intents keep ordinary role admission closed until real Host session/in-flight retirement, actual native epoch advance, signed proof acknowledgement, and a fresh Worker generation. Missing retirement support remains pending and actionable. Current control changes cannot silently complete an older intent. Explicit resume rechecks current approved policies and controls.

The first durable admin request binding or business intent raises the fsynced installation compatibility lower bound to kernel 2 (snapshot format remains 1). The new reader accepts bounds 1 and 2; the accepted earlier kernel requires 1 and must reject this installation rather than ignore pending operations or identity invalidations. Backups and generation pointers inherit the actual bound, and bound-2 current controls must contain all five admin/identity tables. After this boundary, rollback requires an admin-aware compatible kernel; do not run an earlier reader or restore old controls.

Identity decoration occurs only after each candidate passes its actual audience/provider ACL. Search by confirmed `personId` still filters every source independently. Binding dependencies are content-free role jobs, propagated through actual inputs and re-applied during role restore; identity changes never rewrite raw speakers, broaden audience/grants, merge cross-domain version chains, or invent facts about a person.

## Verification and limits

Use synthetic SQLite fixtures and real Workers only. Verify scoped/forged reads, actual hot selection versus suppression, stable anchor evidence, role isolation, cross-audience canaries, binding-dependent invalidation, new reported correction versions and clean control snapshots, same-ID request conflicts after reopen, staged failures, COMMIT uncertainty and same-ID resume. Preserve accepted kernel/lifecycle/native-admission suites under CLI Node 26.5.1 and bundled Node 24.21.0. Exact Node 22.13, actual Windows, power loss, real models and production data are not claimed. Parent owns full audit while disk pressure persists, external management/UI wiring, case/release notes, and activation gates.

## Status inventory scope

`status.policies` uses the union of this role's actual event policy IDs and this role's persisted `configure_policy` / `revoke_policy` action policy IDs. Configured policies appear before any ingestion; current approval comes from the actual policy row. Another role's control history is excluded.

`status.operations` combines current-role durable admin rows and lifecycle rows, with `operationId`, `characterId`, canonical `action`, actual `phase` and `complete`. Lifecycle `requestDelete` / `continueDelete` become `request_delete` / `continue_delete`; restore stays `restore`, and resume uses its persisted effective kind. Original IDs follow the same-role persisted resume chain for their effective phase, bounded to 32 links. Only `completed` and `backup_verified` lifecycle phases are complete. The lifecycle directory retains up to 20 rows with unfinished rows prioritized, alongside the existing latest 20 admin rows. It projects no roots, nonce, source text, paths, payload or manifest; backups retain their actual scoped state.
