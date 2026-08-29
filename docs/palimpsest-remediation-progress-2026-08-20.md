# Palimpsest remediation progress — 2026-08-20

This is the execution ledger for the findings in
[`palimpsest-remediation-dossier-2026-08-20.md`](./palimpsest-remediation-dossier-2026-08-20.md).
`completed` means the finding's stated acceptance evidence has been produced;
`in progress` names real local work that does **not** yet satisfy that bar.

## Phase 1 — P0 runtime

| Finding | Status | Current evidence / remaining acceptance work |
|---|---|---|
| F-01 | completed | Reviewed-source local image, immutable base revision, and local remediation-patch fingerprint are rejected when provenance differs. See [P0 runtime acceptance](./palimpsest-p0-runtime-acceptance-2026-08-20.md). |
| F-02 | completed | The executable remediation map and dependency order are tracked in the repository issue tracker. |
| F-03 | completed | Isolated S3-compatible 20 clean + 10 forced restart/write matrix passes without lease surgery. |
| F-04 | in progress | The pinned SlateDB recorder now exposes L0 count, active-compaction bytes, last successful compaction time, GC cycle/deletion counters, and compactor/GC object-store errors through live `/metrics`, including restarts. A recorder error fail-closes the shared readiness/heartbeat path under unit coverage. Live injected verification, total queued-compaction debt, successful-GC time, and the required fault-injected compaction/GC soak remain absent. |
| F-05 | in progress | The supported profile disables the optional disk-cache evictor and proves its queue/drop samples are zero; enabled-cache bounded telemetry and a load SLO remain unproven. |
| F-06 | completed | Pinned Compose profile, restart policy, resource limits, credential-independent preflight, and a graceful capacity stop gate are checked. |
| F-07 | completed | Reviewed server codes and safe TypeScript classification are unit-tested; unreviewed 5xx text is discarded. |

## Phase 2 — transactional ingest and projections

| Finding | Status | Current evidence / remaining acceptance work |
|---|---|---|
| F-08 | in progress | SQLite WAL/FULL transactional SourceRevision state authority, single-step transitions, terminal-failure guards, and an explicit-generation transactional coordinator now exist. A content-addressed extraction artifact is persisted only after source durability and is reused by the bounded source/index operation before an isolated graph retry. The coordinator’s hermetic failure injection resumes every stage with one commit-id-keyed effect and makes an already-committed retry a no-op. It is not yet the commit protocol used by the legacy graph writer: production fault injection at every actual graph write boundary and later-stage checkpoint evidence remain required. |
| F-09 | in progress | The manifest atomically allocates same-revision commits and per-user ordinals; 32 submitted retries/different sessions are unit-covered. The coordinator now holds a non-blocking per-user commit lock, backed by a dedicated SQLite lock file in the live layer; hermetic 32-way same-source contention and independent live-layer contention are covered. Commit-id-keyed projection deltas, a multi-process graph-writer acceptance run, and exact graph counts remain required. |
| F-10 | in progress | The transactional manifest now records canonical commit-id-keyed user, Token, and Slot deltas; maintains manifest-versioned scoped projection snapshots with `consistent`/`stale`/`unknown`; and rebuilds one user from its own deltas. A durable-fixture test deliberately corrupts all three ledger projections and verifies repair without a graph label scan. The legacy HydraDB projections and read receipts do not use this ledger yet, so production consistency/fail-closed behaviour remains required. |
| F-11 | in progress | The accepted model is immutable Entity identities plus versioned, content-addressed `SAME_AS` canonical views. The manifest persists each view’s direct edges and atomically selects or rolls back one active view per user; the isolated `IndexGraph` records immutable `entity_identity_id` values rather than mutable canonical keys. Unit coverage proves a bridge changes only the new view. Retrieval and Slot projections do not yet resolve the active view, so query-visible canonical history and source-lineage acceptance remain required. See [ADR 0002](./adr/0002-immutable-entity-canonical-views.md). |
| F-12 | in progress | `SourceIndex` now gives both the explicit `pnpm index-source` batch command and `POST /users/:uid/source-index` incremental route the same generation-bound `INDEXED` protocol. Composition parses six mandatory immutable configuration values; the release helper refuses a dirty implementation and emits the four local commit/path revisions. The route returns `queryVisible: false` and does not claim terminal ingest. The legacy `ingest` CLI and `POST /users/:uid/sessions` still use the old graph protocol, and active-manifest, retrieval-hash, count, and legacy-to-new equivalence remain absent. |

## Phase 3 — source lineage and generations

| Finding | Status | Current evidence / remaining acceptance work |
|---|---|---|
| F-13 | in progress | Canonical session source bytes/digests exclude evaluation labels and allocated ordinal. `SourceTranscript` now verifies manifest bytes before writing immutable `SourceSession` / `SourceTurn` / `SourceTurnChunk` records whose keys include the full digest; a same logical ID with changed bytes creates a distinct record without replacing the old text. The legacy Session/Turn graph and reader remain unmigrated, and live HydraDB fault/retry evidence is still required. |
| F-14 | in progress | Canonical ExtractionGeneration descriptors record extractor/model/tokenizer revisions plus hashes of the exact live extraction prompt and Effect output schema, rejecting descriptor/ID mismatches before a SourceRevision is accepted. Content-addressed IndexGeneration descriptors pin extraction, graph-writer, and graph-schema revisions; a fail-closed parser refuses blank or missing deployment values. The manifest requires a known extraction generation and atomically activates or rolls back one index generation per user. `IndexGraph` writes isolated source- and generation-bound records. Retrieval does not filter by the active generation, and graph-write recovery/activation validation is still required. |
| F-15 | in progress | The slot API now exposes `assertions[].derivedText` rather than a claim/evidence field, and requires each derived index assertion to carry its linked verbatim transcript excerpt, exact offsets, and canonical source digest. The demo labels model output `NOT EVIDENCE` and renders the source span alongside it; the slot CLI follows the same contract, while `ask` now prints verbatim source spans only. Fresh legacy writes persist the canonical source witness; records missing it or a resolvable source span fail closed. Hermetic mapper and HTTP-schema contract tests cover this surface. The legacy projection is still not manifest-backed SourceRevision storage, and live migration/retrieval proof remains required. |
| F-16 | in progress | Every direct vertex/relationship read and upsert now claims the full key in a local registry, preflights the persisted full-key witness, and writes `__palimpsest_full_key` with the lossy numeric ID. Traversed paths validate each stored identity before return. A forced-collision test injects a constant numeric hasher and proves a redacted typed integrity error; legacy records without the witness fail closed. A pinned live-engine forced-collision probe, relationship-query grammar validation, and an approved backfill/rebuild plan for existing records remain required. |

## Remaining phases

| Findings | Status | Entry condition |
|---|---|---|
| F-17 | in progress | The raw-adapter inventory confirms unrestricted `query`, `msPaths`, Cypher rendering, paths, and scalar rows still cross into production ingest/retrieval; the eval backfill scan is a candidate admin-only escape hatch. No production boundary has been claimed complete. |
| F-18 | in progress | `HydraClient` now stores causal tokens in a fiber-local context rather than one process-global mutable reference. `ask` accepts the opaque bookmark returned by ingest, scopes every handler read to it, and the demo carries it explicitly; a hermetic concurrent-fiber test proves one caller’s token does not leak into another. No bookmark means no read-your-writes guarantee; stale same-target bookmarks remain valid lower floors, while malformed/cross-target/future tokens are rejected by HydraDB. A two-process pinned-engine ingest/read acceptance run remains required. |
| F-19 | in progress | Public wording now calls the receipt a replayable trace rather than proof. Receipt v2’s immutable-version, completeness, source-hash, plan, signature, and tamper-detection fields are not yet implemented. |
| F-20 | in progress | The typed HTTP receipt now includes serialisable Query 1 parameters, using a tested projection shared by the handler; the demo renders them. The hermetic projection/schema contract prevents a drop at this boundary, but an end-to-end HTTP replay against declared immutable versions remains required. |
| F-21 | untouched | Requires receipt v2 candidate-boundary, cap, and integrity-digest design. |
| F-22 | untouched | Requires versioned historical DF/N snapshots wired into as-of retrieval. |
| F-23–F-31 | untouched | Start only after the P0 gate is fully green; no new ingest/scale evidence before then. |
| F-32–F-37 | untouched | Requires valid evaluation denominator, receipts, and benchmark protocol. |
| F-38–F-40 | untouched | Requires selected bitemporal, tenancy, and retention domain decisions. |
| F-41–F-45 | untouched | Requires all P0/runtime, transactional, and security gates plus declared benchmark protocol. |

## Latest local verification

- `pnpm exec vitest run --project unit` — 33 files, 197 tests passed, including
  terminal-failure guards, fault injection at each reusable transactional stage
  boundary, 32-way same-source contention, independent live-layer durable lock
  contention, a deliberately corrupted projection-ledger repair fixture, and
  Entity Canonical View activation/rollback, immutable source write planning,
  index-generation activation/rollback, and source/generation-bound index
  graph planning; the latest run also verifies descriptor/ID mismatch rejection,
  durable extraction-artifact persistence, an `INDEXED`-bounded transaction,
  exact live prompt/schema generation construction, fail-closed configuration,
  shared batch/HTTP source-index planning, forced numeric-ID collision plus
  missing-full-key integrity rejection, derived-assertion/source-span HTTP
  contracts, receipt-parameter preservation, and fiber-scoped causal context.
- `pnpm typecheck` — passed.
- `scripts/build-hydradb-runtime.ps1` — final runtime image
  `sha256:514349a17890bf2a35e5e5eb81b41c09b771b07e497fa3f51eb22e7727d66081`,
  patch fingerprint `6c711ec5c63b42b99620600f8bd09c146e6b9e83d670562e331a6610ebac6638`.
- Pinned-container `cargo test ... storage_maintenance` — 3 focused tests
  passed (SlateDB mapping, graph-node rendering, and readiness withdrawal).
- The final isolated restart matrix passed 20 clean starts, 10 forced restarts,
  31 writes, provenance checks, cache-off samples, and all six storage metric
  families. Manifest-backed `p0-hydradb-preflight.ps1 -SkipReadiness` passed.
  These results do not include a compaction/GC soak and must not be interpreted
  as a benchmark entry gate.
