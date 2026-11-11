# Legacy segment registry: private bookkeeping contract

This module **only records identities independently verified by a trusted in-process Host caller**. It does not inspect legacy files, establish lineage, detect physical replacement, grant authority, approve migration, or issue import receipts or checkpoints. The writer observation and importer are not implemented. An absent or uncertain verified identity must remain unregistered; path, inode, filename, content and hash alone do not establish lineage. The returned planner map is an identity lookup, not an authorization.

## API

`openLegacyRegistry({ filePath, create = false })` uses an absolute Host-selected private path. `create:true` creates a new file exclusively; it never overwrites an existing registry. No automatic recreation is allowed after a missing, damaged or uncertain registry. Parent directories must exist. Success returns `{ok:true, read, register}`; failures return `{ok:false, code, error, hint, commitState}`.

`register({ logicalStreamKey, segmentIdentity })` accepts two nonempty opaque ASCII identifiers matching `^[A-Za-z0-9][A-Za-z0-9_:./-]{0,159}$`. `segmentIdentity` is the Host's independently verified immutable per-segment identity; the registry cannot verify that claim. New bindings receive a registry-generated `legacy-stream-<UUID>` and return `{ok:true,legacyStreamId}`. An identical binding is idempotent. A key or identity already bound differently returns `LEGACY_REGISTRY_CONFLICT`; the caller must stop and reconcile with its trusted lineage evidence. Append or a verified rename/copy reuses the same pair; a verified new rotation/replacement uses a new pair. Neither assertion is inferred by this module.

`read()` returns `{ok:true,streamRegistry}`, a frozen plain `{[logicalStreamKey]:legacyStreamId}` map compatible with `planLegacyMigration`. The caller must separately maintain the verified association from an actual descriptor to the pair. The planner still sets `importReady:false`, and unresolved facts remain unauthorized/quarantined.

## Durability and recovery

A dedicated SQLite database uses DELETE journaling, synchronous EXTRA, an immediate transaction for each registration, uniqueness constraints, strict schema, version/application checks, SQLite quick check and a checksum of ordered bindings. The checksum detects accidental inconsistent changes; it is not a signature, a substitute for trusted access control, or proof that a database was not consistently rewritten or rolled back. A concurrent writer that cannot acquire the lock fails closed; there is no implicit busy retry beyond SQLite's 150 ms timeout. No registry file is deliberately removed, replaced or reset on error.

A write whose commit cannot be confirmed returns `LEGACY_REGISTRY_COMMIT_UNKNOWN` with `commitState:'unknown'`; failed creation similarly returns `LEGACY_REGISTRY_CREATE_UNKNOWN`. Keep all database/journal bytes. Stop, reopen and validate the same registry, then examine the binding through trusted Host reconciliation. An existing matching pair is the durable result; a contradictory binding is a conflict. Only after verified absence and independent verification of lineage may the Host retry that exact pair. A failed validation, missing file, lock, or unresolved recovery is not permission to recreate, advance a checkpoint or import.

The implementation is not connected to production. Production lifecycle, migration, route activation and physical source observation require separate implementation and authorization; V1 remains the default.
