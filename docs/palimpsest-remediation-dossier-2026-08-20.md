# Palimpsest remediation dossier

**Purpose:** execution source of truth for resolving the 2026-08-20 Palimpsest audit findings  
**Baseline application commit:** `bbfe01518f8474c24ed6d9cd88a63fb09374ddf1`  
**HydraDB submodule:** `6a2fbb192f37f51a93690a2ae2d2f5e27e6e4219`  
**Status:** plan only; none of the remediations below are implemented by this document  
**Owner for next execution session:** fresh implementation agent, expected model `terra`

This dossier translates every material finding in the [evidence audit](review-2026-08-20-palimpsest-evidence-audit.md) into required engineering work and acceptance evidence. The [primary-source research report](research-memory-context-landscape-2026-08-20.md) supplies the research basis for retrieval, sufficiency, bitemporal modelling, and evaluation experiments.

Do not use the project write-up or prior handoff as implementation truth where it conflicts with these two reviewed documents or executable evidence.

## Desired end state

Palimpsest should become a source-grounded, bitemporal context layer with these enforceable properties:

1. an immutable source revision is the authority for every answer and citation;
2. derived graph/index state is versioned, rebuildable, and never mistaken for source evidence;
3. session ingestion is resumable and exactly-once at the logical commit level;
4. reads declare the memory/index version and completeness watermark they observed;
5. abstention reflects calibrated evidence sufficiency and premise support, not lexical reachability alone;
6. receipts are replayable, completeness-aware, and tied to immutable source bytes;
7. evaluation is protocol-pinned, paired, uncertainty-aware, and budget-matched;
8. runtime recovery, tenancy, deletion, and scale are demonstrated rather than inferred.

## Stop conditions and constraints

Until the P0 gate is complete:

- **Do not ingest the remaining 40 users or start a 500-user run.** The persisted HydraDB volume currently reads but cannot write after restart.
- **Do not delete or clear `.cache/llm`.** It contains approximately $30.46 of paid calls and is required for zero-cost replay.
- **Do not delete, reset, repair, or move files inside the HydraDB volume without explicit user approval.** The audit deliberately left the volume unchanged.
- **Do not change extraction prompts, `ATTRIBUTE_VOCABULARY`, `ENTITY_TYPES`, `RawClaim`, `stems()`, or `claimTokens()` in place.** A prompt/index change needs a declared new extraction generation and must not mix with the current graph.
- **Do not use `ghcr.io/hydra-db/hydradb:latest` for new evidence.** Pin a reviewed digest and record its source commit/build metadata.
- Preserve unrelated user work. The three 2026-08-20 review documents are uncommitted unless repository state has changed since this dossier was written.

## Execution sequence

The order is intentional. Accuracy experiments must not run on a store whose writes, generations, and result protocol are untrustworthy.

| Phase | Objective | Blocking dependencies |
|---|---|---|
| 0 | Freeze evidence and establish issue/branch plan | none |
| 1 | Make HydraDB persistence and recovery reliable | none |
| 2 | Make ingestion and projections logically atomic | Phase 1 write stability |
| 3 | Enforce immutable source lineage and index generations | Phase 2 commit model |
| 4 | Deepen the Hydra adapter and build receipt v2 | Phases 2–3 version contracts |
| 5 | Repair and freeze the evaluation protocol | can start read-only, final rerun needs Phases 1–3 |
| 6 | Improve retrieval, reading, and calibrated sufficiency | Phase 5 protocol |
| 7 | Prove scale, tenancy, retention, and operational SLOs | Phases 1–4 |
| 8 | Run final benchmarks and revise product claims | all prior acceptance gates |

## Phase 0 — evidence freeze and work decomposition

### F-01 — Runtime and source are not the same build

**Problem:** the reviewed submodule is `v0.1.1-2-g6a2fbb1`, while the running unpinned `latest` image reports HydraDB `0.1.0`. Runtime claims cannot be traced to the checked-out code.

**Resolution:**

- inspect the running image digest and build labels;
- map the image to an exact HydraDB source commit, or build a versioned local image from the vendored commit;
- pin the digest in the documented run command/configuration;
- record image digest, source commit, config, volume schema/version, and dataset hash in result manifests.

**Acceptance evidence:** two fresh containers created from the pinned digest report identical build metadata; the runtime manifest is checked in; no benchmark uses `latest`.

### F-02 — Findings are not yet tracked as executable work

**Problem:** the audit is comprehensive, but a single large implementation session would be risky and hard to review.

**Resolution:** split this dossier into dependency-ordered GitHub Issues using the repository's canonical triage labels. Keep P0 runtime recovery and atomic ingestion separate from retrieval experiments. One issue must name one acceptance gate and the evidence artifact it will produce.

**Acceptance evidence:** issues cover every finding ID in this dossier with no orphaned requirement; dependencies are explicit; no extraction/benchmark spend issue is unblocked before the P0 gate.

## Phase 1 — HydraDB runtime and persistence

### F-03 — Persisted local store returns permanently read-only after restart

**Problem:** focused writes and all write-oriented live tests fail with `internal query execution error`. HydraDB logs reveal that `LocalFileSystem(file:///data/store)` does not implement `put_opts` with `PutMode::Update`, required by writer-lease takeover.

**Resolution options, in preference order:**

1. fix the HydraDB/SlateDB local object-store implementation so conditional update works correctly, add upstream tests, and build the pinned image;
2. use a supported object-store backend whose conditional update semantics are implemented;
3. if neither is possible for the hackathon, implement a documented disposable local profile and a separate supported persistence profile—never call the disposable profile durable.

Manual stale-lease movement is emergency recovery, not the fix.

**Acceptance evidence:** on a copy of the volume, repeat at least 20 cycles of write → clean stop/restart → write and 10 cycles of write load → forced kill → restart → write. No lease surgery, read-only state, frozen epoch, or lost committed source is allowed.

### F-04 — Garbage collection and compaction also fail on `PutMode::Update`

**Problem:** the same backend gap repeatedly breaks SlateDB manifest/compaction garbage collection. Store growth can continue while maintenance silently fails.

**Resolution:** include manifest/compaction/GC operations in the backend fix; expose backlog, failure count, last-success time, and bytes pending as metrics; make readiness fail or degrade when maintenance has been unhealthy past a declared threshold.

**Acceptance evidence:** sustained write/read soak produces successful compactions and GC; backlog returns below threshold; fault injection makes health/readiness expose the degradation.

### F-05 — Severe cache-event queue drops

**Problem:** after restart, logs showed tens to hundreds of thousands of cache write/access events dropped per 30-second interval.

**Resolution:** determine whether the queue is undersized, the consumer is stalled by the object-store fault, or the workload overwhelms it. Add bounded queue depth/drop metrics, alert thresholds, and load tests. Tune only after the persistence defect is fixed so tuning does not mask the root cause.

**Acceptance evidence:** under the declared maximum load, queue depth remains bounded, drop rate is zero or below an explicitly justified target, and latency/RSS do not regress outside SLO.

### F-06 — Container has no restart policy, resource budget, or capacity gate

**Problem:** the node used about 5.50 GiB of 7.76 GiB at 60 users, had no container memory limit, and used restart policy `no`.

**Resolution:** define separate development and benchmark profiles with pinned CPU/RAM/swap/disk budgets, health checks, restart policy, and preflight headroom. Add a stop-the-run capacity monitor rather than letting WSL collapse.

**Acceptance evidence:** resource profile is versioned; the node survives the restart matrix; a deliberate threshold breach stops ingestion cleanly and preserves committed data.

### F-07 — Generic HTTP errors hide actionable engine failures

**Problem:** different admission, lease, idempotency, and object-store errors arrive as a bare 500/`HydraUnavailable` unless logs are inspected.

**Resolution:** have HydraDB return stable error codes and correlation/query IDs without exposing sensitive internals; map them to typed client errors. At minimum, the client/server should preserve a safe engine reason code in logs and receipts.

**Acceptance evidence:** tests distinguish parse, admission, timeout, stale lease, idempotency conflict, object-store failure, and unavailable-node states without log scraping.

## Phase 2 — atomic, resumable ingestion and consistent projections

### F-08 — Session existence is incorrectly used as the ingest commit marker

**Problem:** `ingestSession` writes Session/Turns before extraction, claims, counts, supersession, and User stats. Any later failure leaves a Session that makes every retry return `alreadyPresent` without repair.

**Resolution:** introduce an immutable source revision and explicit ingest state machine keyed by `(tenant, user, sourceDigest, extractionGeneration)`:

`RECEIVED -> SOURCE_DURABLE -> INDEXED -> ENRICHED -> CONSOLIDATED -> COMMITTED`, with terminal/retryable failure metadata.

Session/source existence must mean only source durability. The API reports success only after `COMMITTED`, or clearly reports the achieved readiness level. Retrying resumes the first incomplete idempotent stage.

**Acceptance evidence:** fault injection after every write boundary proves retry completes exactly once; no stage can turn a partial ingest into `alreadyPresent`; committed counts/edges match the source revision.

### F-09 — User manifest, Token DF, Slot counts, and session ordinals race

**Problem:** concurrent sessions can read the same User totals, assign the same `sessionOrd`, and overwrite each other's Token, Slot, supersession, and User increments. Same-session concurrent posts can both pass the existence check.

**Resolution:**

- serialize commit per `(tenant,user)` or implement compare-and-swap on a manifest version;
- allocate session sequence numbers through the same atomic authority;
- apply idempotent projection deltas keyed by `ingestCommitId`, never read-modify-write totals without a version;
- make same-source concurrent requests join or conflict deterministically;
- retain source/event time separately from recorded sequence.

If HydraDB lacks the required primitive, use a small transactional manifest/queue store and treat HydraDB as the retrieval data plane.

**Acceptance evidence:** concurrency tests with same/different sessions and 2/8/32 writers show unique monotonic ordinals, one logical commit per digest, exact counts, and no lost or doubled deltas.

### F-10 — Materialised counts are treated as truth without reconciliation

**Problem:** User counts, `Token.df`, and `Slot.n_claims` can silently drift after partial failure, races, alias bridging, or mixed generations. Reads have no consistency indicator.

**Resolution:** make them rebuildable versioned projections. Record their source manifest version and last reconciled commit. Add per-user reconciliation rooted at the User vertex, not store-wide label scans. Reads must expose `stats_consistency = consistent | stale | unknown` and may fail closed when ranking would be invalid.

**Acceptance evidence:** deliberately corrupt each projection in a fixture; reconciliation detects and repairs it; receipt/version state changes correctly; no global label scan occurs.

### F-11 — Entity-canon bridge does not migrate existing graph state

**Problem:** a new alias can union two existing canonical entities, but reconciliation only renames new writes. Existing Entity vertices, Claim edges, Slot keys, and User edges remain split.

**Resolution:** choose and document one model:

- immutable entity identities plus versioned `SAME_AS`/canonical-view edges; or
- transactional migration to a new index generation followed by active-generation swap.

Do not mutate identities in place without preserving lineage. Counts and slot histories must derive from the selected canonical view.

**Acceptance evidence:** adversarial bridge fixtures prove one query-visible canonical history, preserved source lineage, deterministic rollback/as-of behaviour, and consistent counts.

### F-12 — Full-user ingest and live-session ingest have different unsafe semantics

**Problem:** full ingest overwrites whole-run counts and re-merges content; live ingest increments read values. Neither shares one commit protocol, so behaviour differs under retries and prompt changes.

**Resolution:** make both entry points use the same source-revision, generation, state-machine, delta, and manifest primitives. Whole-user ingest is a batch of the same logical session commits plus one declared activation, not a separate correctness model.

**Acceptance evidence:** ingesting the same history through batch and incremental paths produces the same active source/index manifests, retrieval hashes, and counts.

## Phase 3 — immutable source lineage and generation management

### F-13 — Transcript vertices are overwriteable, not immutable

**Problem:** `MERGE ... SET` can replace Turn text under an existing key while old Claim offsets and evidence edges survive.

**Resolution:** key Session/Turn/Chunk source vertices by full content digest and revision. Reject a logical session ID reused with different bytes unless the caller explicitly creates a new revision. Store the complete digest and length; never overwrite committed source bytes.

**Acceptance evidence:** same ID/same bytes is idempotent; same ID/different bytes creates a declared revision or fails; old citations still resolve to the exact old bytes.

### F-14 — Derived index generations can mix silently

**Problem:** a prompt/model/schema/tokenizer change creates additional Claim/Token/edge state while older generations remain. A prefix convention is not an enforced generation model.

**Resolution:** introduce `SourceRevision`, `ExtractionGeneration`, `IndexGeneration`, and `ActiveGeneration` identifiers. Every derived vertex/edge carries them. Build a new generation in isolation, validate it, then atomically activate it per user/tenant. Retrieval filters by one explicit generation.

**Acceptance evidence:** two generations can coexist without cross-generation paths or counts; activation/rollback changes the selected generation atomically; receipts name it.

### F-15 — Generated Claim text is exposed as evidence

**Problem:** the final reader uses source spans correctly, but the CLI labels `claim.text` as `EVIDENCE`, and the slot API/demo renders it without a derived-data warning.

**Resolution:** rename these surfaces to `derived claim/index assertion`; always display the linked verbatim span beside it or require an explicit debug/admin mode. Public answer/citation APIs expose source spans as evidence, not generated claims.

**Acceptance evidence:** UI/API contract tests prevent a derived claim from being labelled evidence; every displayed assertion resolves to source revision and offsets.

### F-16 — 53-bit hash IDs can collide silently

**Problem:** content keys are reduced to JavaScript-safe 53-bit IDs. At an estimated 4.78M vertices, collision probability is about 0.127%, and edge IDs have their own larger collision population.

**Resolution:** preserve the full key/digest and verify it on every read/upsert. A numeric-ID collision must fail loudly instead of merging. Prefer a HydraDB transport/storage change supporting lossless 64-bit or string IDs. Add adversarial forced-collision tests via an injectable hash.

**Acceptance evidence:** forced collisions return a typed integrity error and never expose or merge another tenant's data.

## Phase 4 — storage boundary, consistency, and receipt v2

### F-17 — `packages/hydra` leaks the storage language

**Problem:** raw `query`, `renderMsPathsQuery`, MSPaths configuration, rows, paths, and scalar types are application-facing. Palimpsest code and eval maintenance depend on raw Cypher.

**Resolution:** create domain-level ports such as:

- `commitSourceRevision` / `commitIndexDelta`;
- `readManifest` / `activateGeneration` / `reconcileUser`;
- `findCandidateClaims` / `expandSlotGroups`;
- `hydrateSourceSpans`;
- opaque `ExecutionPlan` plus Hydra-specific diagnostic rendering.

Move unrestricted raw query access into an admin/test-only package. Keep engine limits, pagination, typed errors, retries, and collision checks inside the adapter.

**Acceptance evidence:** production packages do not import Cypher renderer/raw result types or call raw query; adapter contract tests cover all engine-specific behaviour.

### F-18 — One global bookmark over-synchronises users and fails across processes

**Problem:** the server keeps one last-write bookmark in one process. It gives local-demo read-your-writes but couples unrelated users and cannot survive multiple server instances.

**Resolution:** make causal context request/session scoped. Ingest returns a causal token; ask accepts it or reads an explicit committed manifest version. Define behaviour for no token, stale token, and cross-replica requests.

**Acceptance evidence:** two users and two server processes can ingest/read concurrently; each sees its requested commit without waiting for or inheriting the other's causal floor.

### F-19 — Current receipt is a trace, not proof

**Problem:** it lacks graph/read epoch, commit/generation IDs, source hashes, cap/completeness status, candidate exclusions, model/index versions, and integrity protection.

**Resolution:** define a versioned Receipt v2 containing:

- tenant/user scope and authorisation decision;
- graph/database, read epoch/bookmark, source commit, User manifest version;
- source/extraction/index/prompt/model/schema/tokenizer generation IDs;
- literal and expanded terms, routing decision, and opaque plan plus rendered query;
- Query 1 and Query 2 parameters;
- candidate arms, fusion/rerank scores, exclusions and reason codes;
- valid-time and recorded-time cuts;
- cursor/path/candidate/token/deadline limits and exhaustive/truncated flags;
- selected span IDs with source-revision and excerpt hashes;
- sufficiency/premise decision, calibration version and threshold;
- per-stage latency/tokens/cache/degraded state;
- final citations and support-check result;
- canonical receipt digest/signature.

Call it a `replayable decision trace` until completeness and integrity guarantees are validated.

**Acceptance evidence:** a receipt replays to identical candidates/spans against its declared immutable versions; tampering is detected; an incomplete/capped search cannot claim absence.

### F-20 — HTTP receipt omits Query 1 parameters

**Problem:** internal `query1Params` are dropped by `packages/server/src/Handlers.ts`, contradicting current rerun claims.

**Resolution:** include parameters in the versioned API schema or replace raw query/params with a canonical opaque plan plus optional Hydra rendering. Ensure all rerun inputs are serialisable.

**Acceptance evidence:** contract test round-trips the complete plan/query parameters from retrieval through HTTP and successfully replays it.

### F-21 — Receipt tables and hashes are incomplete

**Problem:** convergence is truncated to top-k; path count is pre-as-of while convergence is post-as-of; the determinism hash covers only selected Claim keys.

**Resolution:** distinguish `rawPaths`, `eligiblePaths`, `candidateCount`, `returnedCandidates`, and `truncated`. Hash the canonical plan, versions, complete eligible candidate digest, selected source revision IDs, and excerpt hashes. Do not imply a top-k table is exhaustive.

**Acceptance evidence:** tests cover as-of filtering, pagination, top-k, slot cap, and changed source bytes; every boundary changes the expected receipt fields/hash.

### F-22 — As-of ranking uses future corpus statistics

**Problem:** claims are cut by `sessionOrd`, but IDF uses current `Token.df` and `User.totalClaims`. `log(1 + N/df)` does not change by one common factor when future data changes.

**Resolution:** version DF/N with the recorded-time manifest and select the as-of statistics snapshot, or use a scoring formulation whose historical inputs are explicitly materialised. Apply temporal scope before expensive traversal where possible.

**Acceptance evidence:** adding future sessions does not change an earlier as-of candidate order/hash unless the declared historical scoring policy says it should.

## Phase 5 — evaluation validity and reproducibility

### F-23 — Result prose has the wrong denominator

**Problem:** docs say 42 answerable/18 abstention; committed JSON contains 54 answerable/6 abstention. The 79.6% and 75.9% figures use denominator 54.

**Resolution:** generate every table, prose denominator, cost, and manifest from result JSON. Add an assertion that table counts equal source rows and requested/actual population metadata.

**Acceptance evidence:** CI regeneration produces 54/6 for current artefacts; hand-edited inconsistent counts fail a snapshot/invariant test.

### F-24 — The 60-row result is completion-conditioned

**Problem:** the intended 100 slice is 70 answerable/30 abstention. `--skip-missing` retained the 60 users that completed before failure, yielding 54/6. Completion may correlate with history size or complexity.

**Resolution:** label current results exploratory. For a final run, predeclare the exact IDs and require all to reach one committed generation/watermark before evaluation. Never silently filter missing users; report infrastructure failures separately.

**Acceptance evidence:** the final manifest contains the predeclared ID set, zero missing committed users, category counts, ingest readiness, and failure accounting.

### F-25 — Palimpsest versus BM25 is not an index-only comparison

**Problem:** Palimpsest receives LLM-expanded anchors, LLM write-time claims/keywords/entities, different evidence units, more reader tokens, slot histories, and CURRENT/SUPERSEDED labels. BM25 receives literal stems over raw turns.

**Resolution:** retain the current comparison as an end-to-end baseline and add controlled ablations:

1. graph with literal stems only;
2. BM25 with identical expanded anchors;
3. graph/BM25/hybrid at equal selected characters or reader tokens;
4. top-k/token-budget curves;
5. graph without slot expansion and group-budgeted slot expansion;
6. graph + BM25 reciprocal-rank fusion;
7. oracle answer-session and answer-span readers.

**Acceptance evidence:** claims distinguish whole-system effects from graph/index effects; every primary comparison shares the declared budget and query representation.

### F-26 — Local judge is not the exact upstream protocol

**Problem:** local code uses moving `gpt-4o`, Effect/OpenAI Responses, and no explicit temperature or 10-token cap. Upstream pins `gpt-4o-2024-08-06`, Chat Completions, temperature 0, and `max_tokens=10`.

**Resolution:** run the exact upstream evaluator/configuration over cached answers for the official score. Record upstream commit and parser. Improved/secondary judges are separate analyses. Build a confusion table between old and official labels and blind-human-adjudicate every Palimpsest/BM25 discordance.

**Acceptance evidence:** official-protocol command and immutable configuration are checked in; rerun produces the same labels; deviations are named in the result manifest.

### F-27 — The +3.70-point BM25 gap is not statistically established

**Problem:** answerable paired outcomes are 38 both correct, 5 Palimpsest-only, 3 BM25-only, and 8 both wrong. Exact McNemar p is 0.7265625; approximate paired 95% difference interval is −6.61 to +14.02 points.

**Resolution:** stop claiming a win. Predeclare a minimum meaningful effect and power/sample plan. Always publish paired discordances, exact McNemar, paired bootstrap/CI, and blind human review. Treat the full 500 as one benchmark estimate, not universal product proof.

**Acceptance evidence:** README/write-up/product pitch use uncertainty-aware language; final report includes paired tables/CIs and no unsupported superiority statement.

### F-28 — Latency is not reproducible or phase-specific

**Problem:** committed/replay p50 values changed sharply (BM25 2.60 s to 0.11 s; full context 3.42 s to 0.01 s). The timer mixes retrieval, local work, and live/cached reader state while excluding judge time.

**Resolution:** instrument anchor generation, manifest read, graph traversal 1, candidate fold/rerank, slot traversal, supersession, hydration, reader, support check, and judge separately. Record cache hit/miss and cold/warm/post-write conditions. Report p50/p95/p99 and concurrency.

**Acceptance evidence:** latency artefacts declare environment and cache state; repeated runs within one condition meet a variance target; no aggregate mixes cache hits and misses.

### F-29 — Cost language mixes incremental spend and clean rebuild cost

**Problem:** the logged $1.02 was incremental session spend with existing cache; committed reader artefacts alone total roughly $1.52, and a clean four-system rebuild including anchors/judge is about $1.58–$1.60 at recorded pricing.

**Resolution:** report incremental shell-session spend, clean-cache reproducibility cost, marginal online read cost, amortised ingest cost, and cache-hit/miss cost separately. Generate values from cache/result usage manifests.

**Acceptance evidence:** one script regenerates all cost tables from usage and versioned prices; docs name the cost definition beside every dollar value.

### F-30 — Public benchmark contamination and judge bias are unmeasured

**Problem:** LongMemEval has been public for years; a 2026 model may have seen it. One LLM judge may exhibit style/verbosity/self-preference biases.

**Resolution:** add a private rolling holdout with new facts, corrections, false premises, paraphrases, and post-model-release items. Use two blinded human reviewers for discordances and a second judge family as sensitivity analysis.

**Acceptance evidence:** final claims reproduce on the private holdout or explicitly remain benchmark-only; judge/human agreement and adjudication are published.

## Phase 6 — accuracy, evidence quality, and honest abstention

### F-31 — Structural A1/A2 measures reachability, not answerability

**Problem:** A1/A2 never fired on the populated graph. With broad read/write expansion and thousands of claims, topical convergence is common even when evidence is insufficient or the premise is false.

**Resolution:** keep A1/A2 as `NO_CANDIDATES`/`NO_CONVERGENCE` diagnostics. Add separately calibrated states:

- `INSUFFICIENT_EVIDENCE`;
- `CONTRADICTED_PREMISE`;
- `ANSWERED`;
- optionally `INCOMPLETE_MEMORY` when the watermark/caps prevent a decision.

Extract explicit premises, retrieve premise and answer evidence, score support/contradiction/unknown against source spans, and calibrate using retrieval margins/entropy, reader confidence, completeness flags, and premise scores.

**Acceptance evidence:** held-out risk-coverage/AURC, selective accuracy, false-answer, false-abstention, ECE/Brier, and per-state confusion meet predeclared targets. A1/A2 is no longer the primary product abstention claim.

### F-32 — Current premise prompt trades too much answer accuracy for abstention

**Problem:** the measured premise variant improved abstention but reduced answer accuracy and increased false abstention. A stricter instruction alone is not a calibrated decision system.

**Resolution:** separate premise extraction/evidence classification from answer generation; calibrate thresholds on held-out data; permit `unknown` rather than forcing unsupported/contradicted into one boolean.

**Acceptance evidence:** the new mechanism improves the chosen risk-coverage target without exceeding the declared answer-accuracy or false-abstention regression budget.

### F-33 — Retrieval recall is high but evidence selection/reading remains weak

**Problem:** current SessionRecall@25 is 98.1% while answer accuracy is 79.6%; preference accuracy is 45.5%. More initial graph fan-out is unlikely to address the dominant loss.

**Resolution:** first run oracle experiments using cached/source data:

- answer-bearing session/turn only;
- current selected evidence;
- reranked current evidence;
- full context.

Then add a bounded answer-utility reranker over current candidates and group-aware evidence budgeting.

**Acceptance evidence:** an error decomposition attributes loss to retrieval, selection, packing, or reader; each change improves the targeted stage at fixed budget and is ablated independently.

### F-34 — Slot expansion fetches broadly and assigns zero-score claims a fixed budget

**Problem:** Query 2 fetches every claim in candidate slots, then the client keeps up to 40 newest slot mates with zero retrieval score. A broad slot can consume engine/network work and reader budget.

**Resolution:** rank slot histories as groups, apply server-side/bounded time and generation filters, allocate a query-dependent group budget, and rerank members for answer utility. Record dropped groups/members in the receipt.

**Acceptance evidence:** broad-slot stress tests bound paths/bytes/tokens/latency; knowledge-update recall does not regress beyond the predeclared margin.

### F-35 — Fixed retrieval shape ignores question complexity

**Problem:** every question gets one claim granularity, top-25 cut, and the same slot-expansion policy despite different needs for simple facts, preferences, counts, updates, and multi-session synthesis.

**Resolution:** support claim-span, whole-turn, and session/slot-history group granularity. Use a cheap deterministic-first router based on count/time/update cues, entity count, first-pass entropy/margin, and completeness. Allow one bounded second pass only when justified.

**Acceptance evidence:** per-route accuracy/token/latency curves show the router beats one fixed policy at the chosen Pareto point; route choice is in the receipt.

### F-36 — Lexical graph join can miss vocabulary mismatch

**Problem:** LLM expansion reduces but does not eliminate vocabulary mismatch and increases graph degree/accidental convergence.

**Resolution:** add a rebuildable semantic or late-interaction sidecar keyed by immutable source span/Claim ID. Compare graph, BM25, semantic, and fused candidates at fixed budgets; use reciprocal-rank fusion or a learned ranker only if held-out evidence supports it.

**Acceptance evidence:** hard-miss recall/accuracy improves without unacceptable latency/storage/false-convergence cost; source lineage remains exact; negative results are retained.

### F-37 — Reading/packing is unstructured

**Problem:** the reader receives chronological excerpts but no explicit per-span assessment of relevance, support, contradiction, temporal relation, or premise coverage.

**Resolution:** test a Chain-of-Note-style structured assessment linked to each verbatim span, followed by synthesis. Deduplicate overlapping excerpts and optimise marginal evidence utility per token. Compression must remain extractive and preserve offsets unless a separate derived summary is clearly labelled.

**Acceptance evidence:** identical-span A/B isolates reading strategy; citation precision/recall, unsupported-answer rate, accuracy, tokens, and latency are reported.

### F-38 — Temporal model is recorded-time-only, not bitemporal

**Problem:** `sessionOrd` supports “known by session k”; extracted `t_event` is not a complete valid-time interval model. Late arrivals, uncertain time, and recorded-versus-valid queries are underspecified.

**Resolution:** model recorded/transaction time, valid-time interval with precision/uncertainty, source revision, and supersession effective time. Questions declare recorded-time, valid-time, or bitemporal perspective. Time-filter before expensive graph expansion and use typed date arithmetic.

**Acceptance evidence:** tests cover multiple corrections, late-arriving facts, uncertain dates, conflicting sources, current truth, valid-time history, recorded-time history, and future-data isolation.

## Phase 7 — product safety, retention, and scale

### F-39 — No authentication or enforceable tenancy

**Problem:** caller-controlled `uid` is the only boundary. One user can address another user's graph; one ID collision can merge data. One graph/client creates noisy-neighbour risk.

**Resolution:** add authenticated tenant/user identity, authorisation below every query/domain operation, source ACL propagation, quotas/rate limits, and a documented database/shard isolation model. Never trust path UID as authority.

**Acceptance evidence:** cross-tenant read/write/fusion/collision tests fail closed; receipts include the authorisation scope/decision without leaking sensitive data.

### F-40 — No deletion, erasure, retention, or generation lifecycle

**Problem:** `DETACH DELETE` is unavailable beyond engine admission limits, while prompts/generations and user histories accumulate indefinitely.

**Resolution:** design active-generation pointers, immutable archived generations, tenant erasure/tombstone policy, export/rebuild/compaction, retention windows, and proof of deletion at every replica/index/cache. If physical erasure cannot be guaranteed, do not claim it.

**Acceptance evidence:** deletion/retention TCK covers source, graph, semantic sidecar, caches, backups and receipts; SLA and limitations are documented.

### F-41 — Scale projection ignores store-global effects

**Problem:** indexed User-root paths avoid label scans, but indexes, page/cache eviction, manifests, compaction, checkpoints, writer state, disk, and recovery remain store-size dependent.

**Resolution:** run a two-dimensional scale matrix varying target-user history size and unrelated-store size independently. Measure cold/warm/post-write reads, ingest throughput, RSS/disk, cache drops, compaction backlog, and recovery time.

**Acceptance evidence:** capacity envelope and SLOs identify safe maximum history/users for the pinned profile; the node remains writable/recoverable at and after the limit.

### F-42 — High-degree path expansion is cut too late

**Problem:** common Tokens and broad Slots may generate/fetch many paths before client top-k/caps apply.

**Resolution:** push generation/time/tenant/candidate limits into source-scoped engine queries or materialised projections; add per-stage hard caps and completeness flags. Use adaptive routing to avoid graph expansion for simple/high-confidence cases.

**Acceptance evidence:** adversarial high-DF/high-slot-degree tests bound CPU, paths, response bytes, memory and latency; capped results are never reported as exhaustive.

### F-43 — No production freshness/readiness contract

**Problem:** query latency is measured, but the user also experiences time from posting a session until it is safely searchable. Extraction and supersession are LLM-dependent.

**Resolution:** expose source-durable, indexed, enriched, consolidated and committed watermarks. Reads specify minimum readiness and can degrade to deterministic lexical source retrieval while enrichment is pending.

**Acceptance evidence:** freshness p50/p95/p99 and failure/retry behaviour are measured; source is never temporarily invisible because enrichment is delayed.

## Phase 8 — final evidence and claims

### F-44 — Current competitive claim is broader than evidence

**Problem:** source-grounded derived indexing is architecturally valuable but publicly overlaps with Supermemory and temporal graph systems. Current data does not establish a BM25 accuracy win or structural abstention.

**Resolution:** differentiate on enforceable bitemporal semantics, immutable lineage, calibrated insufficiency, and completeness-aware replay. Compare public contracts and reproducible protocols, not incomparable vendor headline percentages.

**Acceptance evidence:** pitch language maps each claim to a test/result/receipt field; unsupported claims are removed or labelled future work.

### F-45 — One benchmark/model/judge cannot support a product claim

**Problem:** even a completed 500-question run remains one public dataset with one reader/judge configuration.

**Resolution:** after protocol and runtime repair, evaluate:

- complete LongMemEval-S;
- LongMemEval-M for larger histories;
- LongMemEval-V2 for premise awareness, multimodality and latency;
- MemoryAgentBench for test-time learning/forgetting;
- private rolling holdout;
- adversarial temporal, concurrency, restart, collision, tenancy and deletion suites;
- opt-in de-identified product traces with user usefulness/correction/regret metrics.

**Acceptance evidence:** final report separates benchmark, private-holdout, synthetic TCK, and real-product evidence; no result is generalised beyond its population.

## Required metric set

| Axis | Minimum required metrics |
|---|---|
| Answer quality | paired accuracy difference and CI; exact McNemar; per-type and human-adjudicated correctness |
| Retrieval | answer-session/span Recall@k; MRR/nDCG; evidence precision; oracle-reader accuracy; recall at fixed tokens |
| Grounding | citation precision/recall; unsupported-answer rate; source-span coverage/hash validity |
| Abstention | selective accuracy; coverage; false answers/abstentions; risk-coverage/AURC; ECE/Brier |
| Temporal | current, update, valid-time, recorded-time, late-arrival, contradiction accuracy |
| Efficiency | stage and end-to-end p50/p95/p99; cold/warm/post-write; tokens, calls and cost |
| Freshness | source-durable, indexed, enriched, consolidated and committed latency |
| Reliability | idempotency; partial-commit recovery; counter drift; restart recovery; RPO/RTO |
| Scale | vertices/edges/disk/RSS; compaction backlog; cache drops; unrelated-store sensitivity |
| Product trust | receipt replay; citation opens; correction/regret; deletion SLA; user-rated usefulness |

## P0 acceptance gate

The next extraction/100-user/500-user spend remains blocked until all conditions below are evidenced:

- [ ] pinned HydraDB digest tied to reviewed source;
- [ ] conditional-update/local persistence defect resolved or supported backend selected;
- [ ] clean and forced restart matrices pass without lease surgery;
- [ ] GC/compaction succeeds and cache drops are within declared limit;
- [ ] session ingest state machine resumes every injected partial failure;
- [ ] per-user concurrent commit tests pass with exact counts and unique ordinals;
- [ ] immutable source revisions and explicit active index generation exist;
- [ ] projection reconciliation and full-digest collision detection pass;
- [ ] result denominator/protocol generation is automated;
- [ ] exact upstream judge path is available for final scoring;
- [ ] staged capacity monitor and stop thresholds are configured;
- [ ] `.cache/llm` remains intact.

## Definition of done for the overall remediation

The work is complete only when:

1. every finding F-01 through F-45 is closed with linked code/tests/evidence or an explicitly approved non-goal;
2. no P0/P1 issue is waived solely for hackathon timing without being stated in the product claim;
3. the live suite, restart/fault/concurrency TCK, reconciliation, tenancy and receipt-replay tests pass on the pinned runtime;
4. evaluation manifests reproduce population, answers, tokens, costs and official judge labels;
5. accuracy comparisons include paired uncertainty and fair ablations;
6. abstention is reported as a calibrated risk-coverage trade-off;
7. scale claims remain inside the measured capacity envelope;
8. README, write-up, demo labels and video script use the final evidence-backed claim.

