# Palimpsest — domain vocabulary

This file is the authoritative vocabulary used by code, tests, issue comments and UI. It defines
terms and measured engine constraints, not implementation order or completion; those live only in
`docs/palimpsest-implementation-plan.md`. Don't drift to synonyms — "memory", "fact", "node" and
"hit" are *not* substitutes for Claim, Span, Entity and convergence.

| Term | Meaning | Where it lives |
|---|---|---|
| **User** (`uid`) | One independent history. Benchmark: the LongMemEval `question_id`. All keys start `uid\|`. Users share the single `default` graph and are separated by key prefix. The `User` vertex (`uid\|user`) carries every per-user count and roots legacy projections plus immutable `HAS_SOURCE_REVISION` source records, because the engine indexes ids and `MSpaths` sources and nothing else. | key prefix, `User` vertex |
| **Session** | A logical conversation identifier with a timestamp. Its verbatim bytes belong to a SourceRevision; `session_ord` is allocated once by the UserManifest and never renumbered. | `Session` projection |
| **Turn** | One message: `role`, `text`, `turn_idx`. Stored verbatim, because the graph indexes the transcript rather than replacing it. | `Turn` vertex |
| **SourceRevision** | An immutable, content-addressed set of source bytes for one logical Session. Reusing a logical session identifier with different bytes creates a new revision; it never overwrites the old source. `SourceSession` / `SourceTurn` / `SourceTurnChunk` keys include the full digest and are the transactional source plane; legacy `Session` / `Turn` labels are a separate, not-yet-migrated projection. | ingest manifest, `Source*` vertices |
| **Ingest State** | The durable readiness of one SourceRevision: `RECEIVED`, `SOURCE_DURABLE`, `INDEXED`, `ENRICHED`, `CONSOLIDATED`, or `COMMITTED`, with terminal or retryable failure metadata. | ingest manifest |
| **Ingest Commit** | The one logical commit that advances a SourceRevision to `COMMITTED` and names its projection deltas. It is the idempotency authority; source existence alone is not a commit. | ingest manifest, projection deltas |
| **UserManifest** | The transactional per-user authority that allocates session order, serializes projection activation, and records the current manifest version. It is not a retrieval index. | ingest manifest |
| **Extraction Generation** | The immutable identity of the extractor/model/tokenizer IDs and revisions plus hashes of the exact prompt template and output schema used to derive claims from a SourceRevision. Its canonical descriptor is content-address-verified before a SourceRevision is accepted. | ingest manifest, extraction artifacts, derived graph |
| **Index Generation** | An immutable descriptor of one Extraction Generation plus the graph writer and graph schema revisions. The manifest stores it by content address and atomically selects one active generation per user. `Index*` vertices and `INDEX_*` edges carry both this ID and their full source digest; legacy graph labels are not selected by this pointer. | ingest manifest, `Index*` graph |
| **Span** | `(sid, turn_idx, char_start, char_end)` into a Turn's text. The only thing a reader ever sees. | properties on `Claim`, duplicated on `EVIDENCE` |
| **Entity** | An immutable observed thing the user talks about. Its semantic identity is content-addressed from canon, type, and aliases; `me` is an Entity but never an anchor. Canonical resolution is deliberately separate. | legacy `Entity` projection; isolated `IndexEntity` records |
| **Entity Canonical View** | An immutable, selected resolution of Entity identities for one User. Selecting a later view changes query-visible identity resolution without rewriting an earlier Entity or its source lineage. The manifest already persists it; retrieval has not yet consumed it. | ingest manifest, future retrieval receipts |
| **SAME_AS** | A versioned edge from one immutable Entity identity to the selected canonical identity in an Entity Canonical View. It is never an in-place Entity rename. | Entity Canonical View |
| **Slot** | An `(entity, attribute)` pair that holds a value over time, e.g. `me\|residence`. | `Slot` vertex, key `uid\|s\|<canon>\|<attr>` |
| **Claim** | One extracted assertion with a speaker, a type, both clocks and one Span. Fills at most one Slot, mentions at least one Entity. | `Claim` vertex, key `uid\|c\|<sha1>` |
| **Anchor** / **Token** | A normalised content term attached at ingest to Claims (`HITS`) and Entities (`NAMES`). Question anchors are Tokens too — that symmetry is what makes the graph an inverted index. | `Token` vertex, key `uid\|t\|<stem>` |
| **Convergence** | How many *distinct* question anchors reach a Claim within `maxLen` hops. The relevance score, and a structural one — it can be shown. | computed client-side from `msPaths` |
| **Supersession** | `(older)-[:SUPERSEDED_BY {at_session}]->(newer)` between two Claims in the same Slot. **Current** = no outgoing edge with `at_session ≤ k`. Edges are only ever added. | edge |
| **As-of k** | A read that ignores Claims with `session_ord > k` and supersession edges with `at_session > k`. Data-level, not a HydraDB snapshot — bookmarks are causal floors, not time travel. | filter |
| **Verdict** | `ANSWER` (evidence set + reader answer) or `ABSENT` (structural reason + receipt). Abstention reasons: `A1` no anchor resolves, `A2` no claim converges, `NOT_IN_MEMORY` from the reader. | retrieval result |
| **Receipt** | A versioned replayable decision trace. It names the selected source, manifest and generation versions, candidate boundaries, source spans, and integrity digest; it must not call derived claim text evidence. | attached to every verdict |
| **Causal Token** | A request/session-scoped HydraDB causal floor returned by ingestion and optionally supplied to a read. It is never a process-global bookmark. | ingest and ask contracts |

## Engine facts the design is shaped by

Measured against HydraDB 0.1.0, not read from docs. Each one changed a design decision.

| Limit | Value | Consequence |
|---|---|---|
| Rows per response | **1024**, with a `next_cursor` | Every read follows the cursor. Ignoring it silently truncates — including `algo.MSpaths`, which cannot take `SKIP`/`LIMIT`. Continuing needs the cursor **and** the `query_id`; the cursor alone answers `result cursor does not belong to this query request`. The engine also caps a result at 100 k vertices; the client's 200-page (204 800-row) ceiling is an *error*, not a stopping point. |
| String property | **32 743 UTF-8 bytes** (bisected: 32 744 fails; bytes, not code points — 16 371 two-byte characters is the same boundary) | Over it the write is a bare 500 `internal query execution error`, so the client checks before sending. Long turns spill into `HAS_CHUNK` vertices, reassembled on read. |
| `UNWIND` batch | **1024 rows** (admission control: `client_query_batch_items rejected … actual 2000 exceeds limit 1024`) | Write batches are chunked at 1000, and halved-and-kept on a limit refusal. Writes themselves are fast on a local store — 500 vertex upserts ~55 ms, 1 000 edge upserts ~40 ms at a million edges — so the cap, not throughput, sets the size. |
| HTTP request body | **1 MB** | Chunks are cut by bytes *and* rows; 150 × 8 KB in one statement is refused. |
| Property types | scalars only — **no list type** | Entity aliases are one string joined by `` (`ALIAS_SEPARATOR`). |
| Query runtime | **30 s**, and configurable by `GRAPH_MAX_QUERY_RUNTIME_MS` | Arrives as a **408** with code `query_timeout` (`client/http.rs`), and admission control as a **429** — not the 500 recorded earlier. The client still classifies by message, so the classification survives a status the engine changes. Both benchmark phases run at 120 s (`scripts/phase.ps1` sets and verifies it; `runtime_config_sha256` records it): the ingest needs it for its write bursts and the eval because a cold ask primes ~750 MiB of per-user state in 65–86 s. Every reported latency is a warm second pass two orders of magnitude below the cap; the writeup says so. |
| Vertex ids | JSON numbers | Ids are the top 53 bits of SHA-256(key), not a full u64. |
| `DETACH DELETE` | **~2.3 vertices/s**, flat in degree (5 → 2.3 s, 20 → 10 s, 50 → 21.6 s; ~65 per 30 s statement, fewer for a high-`df` Token), then **refused entirely** past ~1M edges (`delete_vertex_scan_edges … exceeds limit 1000000`) | Deletion is not available on a working graph, at any batch size. Every write is content-addressed so re-ingest never needs a reset; a prompt change gets a fresh key prefix instead. |
| `MATCH (n:L) WHERE n.p = $v` | **full label scan**, ~75–115 µs per vertex of that label **store-wide** | The only index-driven reads are `{id: …}` and an `MSpaths` source list. One user's Claim count cost 4.4 s at 58 k Claims and one Token count 9.5 s; by id the same vertex is ~100 ms at any store size. Every per-user read hangs off the `User` vertex instead. |
| Label scan past **250 000 vertices** of that label | **refused outright** (`cypher_vertex_label_index_candidates rejected by admission control: actual 250001 exceeds limit 250000`) | The label scan does not merely get slow — it stops working. Reached at 60 ingested users, on `Token`. Nothing on the product path scans a label, so nothing broke; two *tests* did, and the former `STARTS WITH` prefix-fallback widening idea is retired because it was a Token scan. |
| Batched read by id | **not available** | `UNWIND $rows AS row MATCH (n {id: row.id}) RETURN …` is refused (*"UNWIND batch supports one-hop relationships only"* — `UNWIND` is a write form here) and so is `WHERE n.id IN [...]` (*"WHERE currently supports boolean combinations of property comparisons"*). Many vertices at once go through `MSpaths`. |
| Source-only `MSpaths` | **one path per source** unless `pathCount` is raised | Silent, like the row cap: the walk from `User` over `HAS_SESSION` returned 1 of 39 sessions. A constant-valued target selector (`Claim.kind`) is exempt *and* faster — raising `pathCount` on the convergence query took its median from 0.12 s to 14 s for byte-identical evidence. So the client raises it on source-only walks only. |
| `MATCH` joins | evaluated store-wide: `(Session)-[:HAS_TURN]->(Turn) WHERE s.uid` 19.2 s and `(e:Entity) WHERE e.uid` 4.9 s at 26 users, `(a:Claim)-[:SUPERSEDED_BY]->(b) WHERE a.uid` 24.7 s, one Token count 8.7 s at 26 users and 15.8 s at 27 k Tokens (killing four concurrent ingest users on the 30 s cap) | Per-user aggregates are denormalised at write time (`Session.n_turns`, `User.n_*`, `Token.df`, `Slot.n_claims`) or read through `MSpaths`, which is driven from source values and stays fast. Never run a label scan beside an ingest. |
| `MSpaths` source list | a walk from **2 292** source keys fails outright (limit exceeded, no rows); 5 keys → 12 paths in 573 ms, 50 → 112 in 5.8 s | Source lists are chunked at 200 (`WARM_SOURCES_PER_WALK`). A failed walk must be reported, not returned as empty. |
| Missing key | a source key, Slot key or neighbour Turn key that does not exist contributes **no path and no error** | The probe arm (model-proposed Slots), whole-turn hydration at turn 0, and unresolved anchors all rest on it. The flip side: a probe built with the wrong key shape is indistinguishable from an absent Slot. |
| Read concurrency | degrades the same way write concurrency does (measured, not assumed) | v2's arms run **four** at a time; eleven simultaneous walks are slower in wall clock than four. |
| Admin surface | `/livez`, `/readyz`, `/metrics` only — **no configuration endpoint** | The effective runtime (`runtime_config_sha256`) is read from `docker inspect` of the running container, never from the Compose file. |
| Write `query_id` | the idempotency key of a write, and the server's own is a counter that **restarts at 1 with the node** | The stored results outlive the counter, so after a restart the n-th relationship merge collides with an unrelated one from the previous run (`idempotency key conflict for relationship-import request key http-query-129…`) and *every* write fails with a bare 500, indefinitely, with nothing wrong in the graph. The server honours a client-supplied id, so the client sends a UUID per statement. |
| Writer lease | `_writer_leases/v2/<cell>`, 30 s TTL, **not reclaimable after an unclean stop** | Taking over an existing lease file needs `put_opts` with `PutMode::Update`, which the `LocalFileSystem` object store does not implement — so a node killed mid-write comes back permanently **read-only** (reads fine, every write 500s, `read_epoch` frozen). Recovery is to stop the node and move the stale lease file aside so it is created fresh. |
| Second graph id | 403 with the local token | All users share `default`, partitioned by key prefix. |
| Unlabelled `MATCH (n {id: $id})` | returns **one row of nulls** for an id that does not exist, echoing the requested id back as `n.id` | Nothing in the response separates "absent" from "present without this property". Only a **labelled** match returns zero rows — and the label is what a cross-label collision would differ in. So a pre-write existence probe is not expressible, and the identity guard on the write path is the process-local id→key registry; the persisted full key is verified on **read**, where `getById` and every `MSpaths` path already carry it. |
| `RETURN` expressions | only `<binding>.<property>` and `count(*)` | `RETURN n`, `labels(n)`, `id(n)`, `count(n)` are all refused, and `count(*)` counts the synthetic row above — so it cannot witness existence either. |
| Relationship pattern | must name **exactly one type** | `MATCH ()-[r {id: $id}]->()` is a 400. Any relationship read names its type. |
| Relationship id | the engine's own **sequential** id (`1145` for a fresh graph's first `HAS_TURN`), not ours | `SET r.id` is refused, so the content-addressed `edgeId` lives in the `id` *property* the `MERGE` pattern sets. A path's `relationship.id` and its `id` property are different numbers; identity is verified against the property. Vertices do not have the problem — `node.id` **is** the content-addressed id. |
| Durability | WAL flush interval hard-coded at **1 ms** with `await_durable_writes` (`GraphDurabilityConfig::default()`, no env override) | On the durable profile every write waits on an object-store PUT, so a bulk ingest is a stream of tiny durable objects and the *object store* is the bottleneck, not the engine: 2.0 GB of objects for eight users at the default buffers, MinIO CPU-pinned while HydraDB idled. `GRAPH_MAX_UNFLUSHED_BYTES` is backpressure — when the flush behind it is a round trip, every writer waits, and statements cross the 30 s cap. Buffers are raised, not lowered. |

## Decisions that are settled

TypeScript + Effect only · HydraDB-only retrieval, no vector or BM25 in *our* read path · as-of is
data-level · users partitioned by key prefix in the single `default` graph · LLM is OpenAI
`gpt-5.6-luna` · every LLM call cached on disk by `sha256(model + prompt + schema)`.

Retrieval is **replay-deterministic**: given a fixed graph and a fixed LLM cache it is
byte-identical. Every LLM decision on the read path — understand, select, sufficiency, read — is
cached by content hash, with the rendered prompt stored beside the value and the model id in the
receipt (`Receipt.models`). **First-run selection is model-dependent.** Extraction is not deterministic either. Say
exactly that; do not say "deterministic given a fixed graph", which was true of v1 and stopped
being true the moment a model chose what the reader sees.

Why each constant has its value and each invariant exists — `ARM_CAP`, `ABSTAIN_TIERS`,
`CHARS_PER_TOKEN`, the as-of-before-cap rule, the session-key rule, and the rest — is
[`docs/design-rationale.md`](docs/design-rationale.md), organised by package.
