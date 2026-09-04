# Review of the Palimpsest proposal & handoff (2026-08-17)

Reviewed: the proposal artifact (claude.ai/code/artifact/65bb7b99…), the handoff at
`%TEMP%\palimpsest-handoff.md`, the three project memory files, and — independently — HydraDB's
`cypher-compat.md`, `architecture.md`, `src/client/http.rs`, `src/client/service.rs`,
`src/query/path_procedure.rs`, `src/core/config.rs` (submodule at `6a2fbb1`, 2026-08-13), plus the
two local LongMemEval files.

**Verdict.** The thesis (a bitemporal claim graph over verbatim spans, with supersession as edges and
abstention as an empty path result) is sound and its HydraDB primitives were genuinely verified.
But one load-bearing claim is wrong and it is the demo centrepiece; the cost "risk" is a non-issue
and mis-prioritises day 1; anchor resolution is under-weighted (it *is* the retrieval problem, not a
soft spot); three question categories are not covered by the data model; and the competitive
framing has a prior-art hole (CogCanvas) that a judge who clicks the citation will find.

---

## 1. Verified as correct (against source, not docs)

| Claim in handoff | Status | Note |
|---|---|---|
| Property types `Integer/SignedInteger/Bool/Float/String`, no lists | ✅ | `cypher-compat.md` §Values |
| No `IN`/`CONTAINS`/`ENDS WITH`/`IS NULL`/`min`/`max`; `WITH` pass-through; `RETURN *` rejected | ✅ | |
| Var-length paths need bounded max | ✅ | server cap `max_traversal_hops = 16` (`core/config.rs`) |
| One rel type per pattern, directed, one statement per request | ✅ | |
| `UNWIND` batches only via client transport | ✅ | HTTP body has `parameters: BTreeMap<String, Value>` (`http.rs:288`) so HTTP should work — **probe it** |
| `MSpaths` `sourceValues` must be an inlined string list | ✅ | `config_string_list` only accepts `ConfigValue::List` of literal strings; scalar keys (`maxLen`, `relDirection`…) *do* accept `$params` via `config_u64`/`config_string` |
| Empty result on unreachable/nonexistent anchor; hydrated paths | ✅ (their probe) | trusted from the memory file; re-probe cheaply in day 1 |

**Omitted but useful:** `WHERE … STARTS WITH <literal|$param>` **is supported**. That is a cheap
prefix index over `ekey`/alias keys and belongs in the anchor-resolution design.

Other server limits worth knowing: `max_query_runtime_ms = 30 000`, `max_query_result_vertices =
100 000`, `max_query_intermediate_rows = 250 000`.

## 2. Errors

### 2.1 Snapshot time-travel does not exist — the centrepiece demo as written is impossible

The proposal: *"pin the bookmark taken after ingesting session 12 and replay what the memory
believed"*; handoff day 5: *"Snapshot bookmarks per session; 'as of session k' API"*.

`architecture.md` §Read Consistency: *"If the caller supplies a bookmark, the reader refreshes
**until the bookmark's storage sequence is visible** before pinning the query snapshot."* A bookmark
is a causal **floor** (read-your-writes), not a historical selector. The service rejects the only
knob that looks like one:

```
src/client/service.rs:1256, 1386
  "historical graph epochs are not client query snapshots; use a bookmark for causal reads"
src/client/http.rs:512
  "read_epoch is not a storage snapshot selector; use bookmark for causal reads"
```

**Fix (cheap, and arguably a better story):** make as-of a property of the *data model*, which is
what "bitemporal" is supposed to mean anyway. Every claim already carries `session_ord`; give every
`SUPERSEDED_BY` edge an `at_session` property. "As of session k" = filter the hydrated paths
client-side: keep claims with `session_ord ≤ k`, ignore supersession edges with `at_session > k`.
Deterministic, no extra round trip, scrubber survives. What we lose is the sentence "HydraDB
snapshots give this for free". What we keep, truthfully: pinned-snapshot reads + bookmarks give
read-your-writes across the ingest→query boundary and byte-identical evidence for a fixed graph.

### 2.2 Cost is not a risk; day 1's stated deliverable is the wrong one

Measured on the local files: LongMemEval_S has 23 867 session references, **19 195 unique** (~20 %
overlap, not "heavy"); ~197 M chars ≈ **49 M tokens** to extract once with session-hash caching.
`gpt-5.6-luna` is $0.20/M in, $1.20/M out (1 M context) → **≈ $10 input + ~$6 output for the entire
benchmark**. Even a mid-tier model is < $100. Full-context Luna over all 500 haystacks (500 × 115 k)
is ≈ $12.

So the day-1 question is not cost, it is **extraction recall**, and the oracle file gives the label
for free: every turn has `has_answer: true|false`. Metric: fraction of answer-bearing turns that at
least one extracted claim's span points into. That is a number by end of day 1.

### 2.3 Factual slips in the competitive table

- Emergence AI on LongMemEval is **94.87**, not 86 (86 is Zep/Graphiti's number).
- supermemory's headline is an 8-variant ensemble; single-pass ≈ 85.9.
- Mastra "Observational Memory" scores ~95 (gpt-5-mini) with **no vector retrieval at all**
  (append-only text observations, three dates per observation). This weakens "every incumbent is
  cosine similarity" — say "similarity-based retrievers" and name Mastra as the non-vector exception
  that still gives no proof of absence and no supersession structure.
- All 95-ish systems are scored on all 500 questions *including* the 30 abstention ones, so by
  arithmetic they can't be catastrophically bad at abstention (≤ 25 misses total). "They omit the
  column because it's embarrassing" is speculation — drop it. The honest, still-strong claim is:
  nobody publishes it, none of them can *show* why they abstained, and we can.

### 2.4 Prior art the proposal cites without recognising it

arXiv 2601.00821 is not only the ablation — the paper's own contribution is **CogCanvas: "Verbatim-
Grounded Artifact Extraction … retrieved via temporal-aware graph."** That is the nearest published
relative of this design and a judge who opens the link will see it. Read it (v3) before writing the
pitch and position explicitly: what CogCanvas lacks (structural supersession chains, abstention as
an empty bounded-path result, per-session as-of replay, an engine with no ANN in the read path).

## 3. Under-weighted risks and gaps

### 3.1 Anchor resolution is the retrieval problem, not a "soft spot"
Almost every LongMemEval question is about the user ("my hamster", "my car's first service"). The
`me` entity is connected to everything, so it cannot be an anchor; the useful anchors are the objects
and events. Exact match on LLM-canonicalised `ekey`s means two *independent* LLM normalisations
(ingest, query) must agree on the same string — this will under-recall and it will be the reason the
system fails on day 3 if it is deferred. Plan lexical candidate generation from the start:

- **(a) Safe:** small in-process lexical index (BM25/trigram) over entity names + aliases + claim
  text, used only to produce anchor keys; everything downstream exact in HydraDB.
- **(b) HydraDB-native, unmeasured:** `Token` nodes with `(Token)-[:IN]->(Claim)`; `MSpaths` from
  question tokens to claims turns the graph into an inverted index and path counts into an overlap
  score. Strong "best use of HydraDB" story if it works. Spike it on day 3 with (a) as fallback.

Also use `STARTS WITH` for cheap prefix/plural normalisation. Be honest that once anchors are fuzzy,
*some* decision rule exists ("no claim reachable from ≥ N content anchors"); the design's real
contribution is that the evidence set is exact and the decision is inspectable, not that no
threshold exists anywhere.

### 3.2 Question categories the claim/slot model does not cover
- `single-session-assistant` (56 q): the answer is in **assistant** turns (long generated content:
  schedules, code, lists). Extraction must cover assistant turns; verbatim spans help here.
- `single-session-preference` (30 q): the answer is a *style* preference; the correct output is the
  user's own turn quoted back. Claim = "preference" polarity pointing at the span.
- `temporal-reasoning` (133 q, largest tie): needs `t_event` resolved from relative expressions
  ("last week", "March 15th") **against the session timestamp**, stored as integer `YYYYMMDD` plus a
  precision flag; the reader must be given `question_date`. Arithmetic ("how many days between") is
  the reader's job over *ordered* evidence.
- `multi-session` counting ("how many items to return" = 3): fits well — count claims in a slot.

### 3.3 Graph partitioning across 500 independent haystacks
Each question is a different synthetic user, but distractor sessions are shared. Claims from a shared
session must not leak between users. Options: HydraDB namespaces/graph ids per question (real
multi-tenancy — probe whether graphs can be created via the API on the single-node image) vs. a
`qid` prefix in every key and vertex-id hash. Default to prefixing; use per-graph only if the API
makes it trivial.

### 3.4 Supersession detection needs the slot's history
Detect per `(user, slot)` over the **ordered** claim list at end-of-ingest (one LLM call per slot with
≥ 2 claims), not pairwise as claims arrive. The slot vocabulary must be constrained (closed
attribute taxonomy + free-form fallback) or claims won't collide in the same slot at all. Write
`SUPERSEDED_BY {at_session}` edges; keep both claims.

### 3.5 "Deterministic" — state it precisely
Retrieval is deterministic *given a fixed graph*. Extraction is not. Say exactly that.

### 3.6 Eval harness must reuse the official judge
LongMemEval's `evaluate_qa.py` uses a GPT-4o judge with type-specific prompts (abstention judged
separately). Port those prompts or call the script; use the same judge for baselines and ours.
Baselines: (i) BM25 top-k verbatim chunks + same reader; (ii) full-context Luna (1 M ctx, ~$12
total). Baseline (ii) also tells us early whether the brief's "30–60 % drop" premise still holds
for a mid-2026 model — the pitch should not depend on it.

## 4. Re-cut plan (still ~7 days)

| Day | Work | Retires |
|---|---|---|
| 1 | Skeleton; HydraDB client (HTTP first); probes: `UNWIND` over HTTP, multi-graph API; extraction prompt on ~20 oracle questions; **recall vs `has_answer`** | extraction quality |
| 2 | Deterministic ids, batch writes, alias/token nodes, per-slot supersession pass; ingest ~20 full S haystacks | write path, slot vocabulary |
| 3 | Anchor resolution spike (lexical vs token-graph), `MSpaths` builder, abstention rule, unit tests | **anchor recall** |
| 4 | Reader prompt, official-judge harness, BM25 + full-context baselines on a 100-q slice incl. all 30 `_abs` | measurable claims |
| 5 | As-of-session filtering (data-level), scrubber API, determinism hash | centrepiece |
| 6 | Demo UI: proof-of-absence, scrubber, evidence receipts | — |
| 7 | Full 500 run (cheap now), writeup, buffer | — |

## 5. Implementation language & models (recommendation)

- **TypeScript + Effect for everything** (ingest pipeline, HydraDB client, retrieval, eval harness,
  demo backend + UI). One language for a one-week build; Effect's structured concurrency, retry and
  Schema are exactly what an LLM extraction pipeline and a graph client want; the demo UI shares the
  domain types. Go is a perfectly good choice for the service, but a second language is a week's
  worth of glue and duplicated types. If Go is preferred, make Go the memory service and keep TS to
  the UI only.
- **Models:** `gpt-5.6-luna` for extraction, supersession and reading (cost is irrelevant at this
  size, 1 M context, cheap enough to run the full 500). Judge: whatever the official harness uses,
  held constant across systems. Verify current model ids/pricing with `ctx7` when writing the spec.

## 6. Open decisions for the user
1. Language: TS/Effect only (recommended) · Go core + TS UI · Go only.
2. Anchor resolution: allow a small external lexical index for anchor generation (recommended) or
   HydraDB-only purism (token-graph, riskier).
3. Exact deadline and submission format (video / live demo / repo + writeup)?
4. Demo scope: replay a LongMemEval user only, or also live "chat with the memory" ingestion?

## 7. Probes run during this review (live node, HTTP API)

| Probe | Result |
|---|---|
| `UNWIND $rows … MERGE … SET` and `UNWIND … MATCH … CREATE` over **HTTP** with `parameters` | ✅ works |
| `WHERE n.ekey STARTS WITH $p` | ✅ works, param accepted |
| `MSpaths` with `maxLen: $m` parameter, inline `sourceValues` | ✅ |
| Relationship property filter `WHERE r.at_session <= 4` | ✅ (as-of filtering can also be pushed to `MATCH` reads) |
| `ORDER BY so DESC LIMIT 1` | ✅ |
| Query a second graph id (`/v1/graphs/palimpsest-q1`) | ❌ 403 — local token scoped to `default/default` → partition users by key prefix |
| `MSpaths` source-only, default `pathCount` | ⚠️ **one path per source** (recall trap) |
| `MSpaths` source-only, `pathCount:10` | all paths |
| `MSpaths` with constant-property target selector `kind='claim'` | ✅ all source→claim pairs with default pathCount — **the retrieval query shape** |
| Unknown source value mixed with known | unknown silently skipped; all-unknown → empty |

## 8. Decisions taken after review (2026-08-17)
- Language: **TypeScript + Effect only.**
- Anchor resolution: **HydraDB-only** (no external lexical index). Token→Claim graph is the primary
  mechanism, with a measured go/no-go on day 3.
- Deadline/format: ~7 days; repo + writeup + recorded video.
- Demo: replay a benchmark user **and** live "chat with memory" ingestion.
- Partitioning: key-prefix per user/haystack in the single default graph.
