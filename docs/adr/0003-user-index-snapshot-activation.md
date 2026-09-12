# D1: The atomically activated unit is a content-addressed user index snapshot

## Status

Accepted (maintainer decision packet, 2026-09-11). Option A from
`docs/palimpsest-implementation-plan.md` §D1.

## Decision

Add a content-addressed `UserIndexSnapshot` (name `ActiveIndexSnapshot` reserved
for the pointer row) distinct from `IndexGeneration`. `IndexGeneration`
describes the builder (extraction generation + graph writer + graph schema);
a snapshot identifies one immutable, verified per-user projection and is the
target of the active pointer.

Snapshot identity is the canonical encoding of at least:

```text
tenantId
uid
indexGenerationId
canonicalViewId
ordered committed sourceRevisionIds
manifestSchemaVersion
```

All snapshot graph keys include tenant and snapshot scope. Activation happens
only after graph write, read-back verification, and manifest commit succeed,
in one SQLite compare-and-swap that preserves the previous active snapshot
until the terminal transaction commits.

Callers stay independent of the representation behind:

```text
buildSnapshot(scope, orderedCommittedRevisions, generation, canonicalView) -> VerifiedSnapshot
activateSnapshot(scope, expectedManifestVersion, verifiedSnapshotId) -> ActiveSnapshot
resolveQueryContext(principal, requestedUser, temporalCut, minimumReadiness) -> QueryContext
```

`QueryContext` is the only object retrieval/hydration needs (scope,
snapshot/projection identity, canonical view, scoring statistics, temporal
cut, watermark, completeness, causal floor).

## Alternatives considered

- **B, extend generation** (one unique generation per tenant/user/source-set):
  rejected; conflates deploy/config identity with data-release identity and
  multiplies generations.
- **C, active allowlist** (shared graph writes + committed-revision allowlist):
  rejected; pushes complete allowlist filtering and no-leak traversal proofs
  into every read caller.

## Consequences

- S01–S06 build on this: `MemoryScope`, snapshot manifest rows and lifecycle,
  aggregate projection build/verify, atomic activation, active-only reader,
  unified entry points.
- New schema, snapshot lifecycle, and activation-path work; no reuse of the
  shared-generation pointer for query visibility.

## Acceptance evidence

S02–S04 contract tests: crash before activation leaves the old snapshot
active; repeated terminal commit is idempotent; competing activations have a
deterministic winner; snapshot content reconstructs from its manifest row.
