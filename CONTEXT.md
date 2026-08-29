# Palimpsest — domain vocabulary

These are the words the code, tests, issue comments and UI use. They come from
`docs/spec-palimpsest.md` §1; this file is the copy engineering skills read. Don't drift to
synonyms — "memory", "fact", "node" and "hit" are *not* substitutes for Claim, Span, Entity and
convergence.

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
| Rows per response | **1024**, with a `next_cursor` | Every read follows the cursor. Ignoring it silently truncates — including `algo.MSpaths`, which cannot take `SKIP`/`LIMIT`. Continuing needs the cursor **and** the `query_id`. |
| String property | **32 743 UTF-8 bytes** | Long turns spill into `HAS_CHUNK` vertices, reassembled on read. |
| `UNWIND` batch | **1024 rows** (admission control) | Write batches are chunked at 1000. |
| Query runtime | **30 s**, and configurable by `GRAPH_MAX_QUERY_RUNTIME_MS` | Arrives as a **408** with code `query_timeout` (`client/http.rs`), and admission control as a **429** — not the 500 recorded earlier. The client still classifies by message, so the classification survives a status the engine changes. The cap is relaxed to 120 s for the ingest phase only; the eval runs at 30 s. |
| Vertex ids | JSON numbers | Ids are the top 53 bits of SHA-256(key), not a full u64. |
| `DETACH DELETE` | **~2.3 vertices/s**, then **refused entirely** past ~1M edges (`delete_vertex_scan_edges … exceeds limit 1000000`) | Deletion is not available on a working graph, at any batch size. Every write is content-addressed so re-ingest never needs a reset; a prompt change gets a fresh key prefix instead. |
| `MATCH (n:L) WHERE n.p = $v` | **full label scan**, ~75–115 µs per vertex of that label **store-wide** | The only index-driven reads are `{id: …}` and an `MSpaths` source list. One user's Claim count cost 4.4 s at 58 k Claims and one Token count 9.5 s; by id the same vertex is ~100 ms at any store size. Every per-user read hangs off the `User` vertex instead. |
| Label scan past **250 000 vertices** of that label | **refused outright** (`cypher_vertex_label_index_candidates rejected by admission control: actual 250001 exceeds limit 250000`) | The label scan does not merely get slow — it stops working. Reached at 60 ingested users, on `Token`. Nothing on the product path scans a label, so nothing broke; two *tests* did, and the spec's `STARTS WITH` prefix-fallback widening lever is retired because it was a Token scan. |
| Batched read by id | **not available** | `UNWIND $rows AS row MATCH (n {id: row.id}) RETURN …` is refused (*"UNWIND batch supports one-hop relationships only"* — `UNWIND` is a write form here) and so is `WHERE n.id IN [...]`. Many vertices at once go through `MSpaths`. |
| Source-only `MSpaths` | **one path per source** unless `pathCount` is raised | Silent, like the row cap: the walk from `User` over `HAS_SESSION` returned 1 of 39 sessions. A constant-valued target selector (`Claim.kind`) is exempt *and* faster — raising `pathCount` on the convergence query took its median from 0.12 s to 14 s for byte-identical evidence. So the client raises it on source-only walks only. |
| `MATCH` joins | evaluated store-wide | Per-user aggregates are denormalised at write time or read through `MSpaths`, which is driven from source values and stays fast. |
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

Retrieval is deterministic **given a fixed graph**. Extraction is not. Say exactly that.
