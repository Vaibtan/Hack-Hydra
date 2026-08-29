# Spec: Retrieval v2 — select, scope, route and read

**Status:** ready-for-agent · **Revision:** 2 (2026-08-29, after the validation review) · **Tracker:** GitHub issue #22 (https://github.com/Vaibtan/Hack-Hydra/issues/22) · **Research:** [`research-retrieval-accuracy-2026-08-29.md`](research-retrieval-accuracy-2026-08-29.md) · **Vocabulary:** [`CONTEXT.md`](../CONTEXT.md) — Claim, Span, Entity, Slot, Anchor/Token, Convergence, Supersession, As-of, Verdict, Receipt.

**Dependencies.** None on #15–#17. This spec *consumes* the Compose runtime under `ops/hydradb/` (MinIO sidecar — the only write path proven crash-safe, F-03) and ingests through the **legacy, query-visible** path (`pnpm ingest-slice`). The transactional/generation ingest (`pnpm index-source`, `IndexGeneration`) is `queryVisible: false` and retrieval does not filter by generation (F-14), so it is *not* used here; the extraction generation id is recorded as provenance only (see *Population*). #18 and #19 describe the remediation view of this area; this spec satisfies F-33, F-34, F-35, F-37 and most of F-31/F-32, and **defers F-36** (semantic sidecar) with the reason in the research doc §3.6/§4.

**What changed in revision 2.** The validation review (code audit against `Retrieve.ts`, `Reader.ts`, `Scoring.ts`, `packages/eval`, `ops/`) found: the harness has none of the systems/flags the first draft named as existing; the local object store is documented *not* crash-safe; the generation machinery is not on the read path; there is no tokenizer; Turn keys use `session.key`, not `sid`; the 30 `_abs` questions span only 4 of 6 types; and a retrieval latency target of 1.5 s cannot include LLM calls. Decisions taken with the maintainer on 2026-08-29 are marked **[decided]** below.

---

## Problem Statement

Palimpsest finds the right sessions (SessionRecall@25 = 98.1 %) but answers 79.6 % of answerable questions — below full context (83.3 %) and not significantly above a literal BM25 baseline (75.9 %), while being the slowest system (15 s p50 cold). Twelve of the thirteen misses on the 60-question slice happen *after* candidate generation: the reader is handed 25 convergence-ranked claim windows plus up to 40 unranked slot-mates, cut at ±300 characters, in one fixed shape for every question type, with a prompt that asks for the shortest possible answer. That shape

- gives generic answers on preference questions (5/11 correct) because the reader never states the personal facts it used, which is exactly what the preference rubric rewards;
- picks the older of two CURRENT values on knowledge updates when the supersession chain is incomplete;
- misses the second fact of a two-fact question (grandma 75 vs me 32) because nothing lexical reaches it, even though the `(me, age)` Slot is one read away;
- under-counts additive items across sessions because near-duplicate claims crowd out distinct ones;
- ignores `time_ref` on temporal questions (already extracted by `Anchors`, never consumed), so "two months ago" selects the wrong museum visit;
- loses a 25-character assistant answer among eighteen near-identical chess-move windows.

Separately, the read path is **seven sequential HydraDB round trips with no concurrency** (`getById(User)` → Query 1 → slot keys → Query 2 → supersession edges → hydrate → chunk tail), which is why it is the slowest system even though every individual read is by id.

On the full LongMemEval-S set, multi-session (133) and temporal-reasoning (133) are 53 % of the score; those two are where the current shape loses most.

## Solution

Keep HydraDB as the *only* candidate index (locked decision) and rebuild everything between Query 1 and the reader as a **retrieval plan** with explicit stages, each a pure function where possible, each visible in the receipt:

1. **Understand** the question once (extend the existing anchor call): primary route, independent flags, resolved time interval, sub-questions *with their own anchor terms*, `(entity, attribute)` probes.
2. **Generate candidates from several deterministic arms, concurrently** — convergence walk (wider, top-60), Slot probes, sub-question walks, and one optional discovery hop — and union them by Claim.
3. **Scope by time** before any cut when the question carries a time reference.
4. **Select with one listwise LLM call** over the candidate table (ids + index text + dates + speaker + status), keeping only what helps answer, under a token budget; deduplicate by turn.
5. **Hydrate by route granularity** — claim span for facts, whole turn plus neighbours for assistant-output and preference — and pack chronologically with `CURRENT / EARLIER STATEMENT / SUPERSEDED` labels where the route calls for adjudication.
6. **Check sufficiency** (EXACT / INFERRABLE / PARTIAL + what is missing); on PARTIAL run **one** targeted second pass, then answer or abstain with `INSUFFICIENT_EVIDENCE`.
7. **Read with a route-specific prompt**: preference answers name the personal facts they use; knowledge-update answers give the latest value; count answers enumerate; temporal answers do explicit date arithmetic; assistant-output answers quote.

Alongside the plan, **parallelise the read path** (both v1 and v2 — it changes no evidence bytes, so the paired comparison is unaffected and the latency comparison is like-for-like) **[decided]**.

The old pipeline stays runnable as system `palimpsest` (it is not renamed) so every change is a paired comparison on the same graph.

## User Stories

### Retrieval quality
1. As a user asking a **preference** question, I want the answer to build on the facts I told the assistant (my Suica card, my basil and cherry tomatoes), so that the suggestion is personal rather than generic.
2. As a user asking where something **currently** is, I want the most recent statement to win when I have said two different things over time, so that a stale value is never presented as current.
3. As a user asking a **comparison or count across sessions** ("how many years older is my grandma", "how many items to pick up"), I want every contributing fact gathered before the answer is composed, so that the answer is not computed from half the evidence.
4. As a user asking about **"two months ago" / "last March"**, I want the memory to look inside that time window first, so that the right one of several similar events is used.
5. As a user asking what the assistant **said or listed** earlier, I want the whole turn (and the turn before it) shown to the reader, so that short or list-structured answers are not lost in fragments.
6. As a user, I want near-duplicate excerpts collapsed, so that the reader's budget is spent on distinct evidence.
7. As a user whose question rests on a **false premise**, I want the memory to say the premise is not supported rather than invent a number, without the memory becoming timid on ordinary questions.
8. As a user, I want a one-word question ("Nibbles?") to still be answered, so that routing never makes simple questions worse.

### Determinism, receipts, as-of
9. As a judge replaying an answer, I want the receipt to name the route and flags, every candidate arm with its counts, the time window applied, the selection decision (kept/dropped ids with the selector's reason codes), the hydration granularity, the sufficiency verdict and whether a second pass ran, so that I can re-derive the evidence set.
10. As a judge, I want the evidence hash to cover the selected source spans (session key, turn, offsets) rather than claim keys, so that "same evidence" means the same bytes.
11. As a judge, I want every LLM decision in the read path (understanding, selection, sufficiency, reading) cached by content hash **and the rendered prompt stored beside the cached value**, so that a replay costs $0, returns identical output, and "what the model saw" is recoverable.
12. As a user of the as-of scrubber, I want every arm and the selector to respect `session_ord ≤ k` and `at_session ≤ k` *before any cap is applied*, so that "what did I believe at session 12" stays a data-level filter.
13. As a demo viewer, I want the receipt panel to show the plan (route → arms → scope → select → read) as stages with timings, so that the "show your work" story survives the change.

### Latency and cost
14. As an API caller, I want the **graph stages** of an ask (all HydraDB reads: arms, edges, hydration) to complete in ≤ 1.5 s p50 on a warm node, reported separately from the LLM stages, so that the HydraDB story has an honest number.
15. As an API caller, I want a whole ask with the full plan (understand, select, sufficiency, read) to complete in ≤ 8 s p50 warm, and a `fast` profile (sufficiency skipped, no second pass) in ≤ 5 s p50 warm for the demo.
16. As an API caller, I want independent HydraDB reads to run concurrently in both pipelines, so that adding arms does not add round-trip latency.
17. As an operator, I want stage timings (understand, arms, scope, select, hydrate, sufficiency, read) in every receipt and results row, so that latency regressions are attributable.
18. As an operator, I want the selector and sufficiency calls to use a configurable, cheaper model than the reader, so that the extra calls cost less than the reader call they protect.
19. As an operator, I want reader input tokens per ask to stay ≤ 6 000 p50, so that the 1/30-of-full-context story holds.

### Evaluation
20. As the maintainer, I want `pnpm eval --system palimpsest-v2` to run beside `palimpsest`, `bm25` and `fullctx` on the same graph, so that every change is a paired comparison with McNemar reported.
21. As the maintainer, I want each stage switchable by flag (`--no-select`, `--no-time-scope`, `--no-decompose`, `--no-discovery`, `--no-sufficiency`, `--granularity=span|turn`, `--reader-route=off`), so that the contribution of each stage is measured, not assumed.
22. As the maintainer, I want an **oracle-reader** system (`--system oracle-session`: the answer sessions' turns only, same reader) so that the reading ceiling is known before tuning retrieval further.
23. As the maintainer, I want a per-question error-class table (retrieval miss / selection / packing / reader / premise) regenerated from results JSON by a standalone `pnpm table` command, so that the next iteration targets the dominant class.
24. As the maintainer, I want the predeclared dev/test id lists committed before the first v2 dev run, so that the test number cannot be tuned on.
25. As the maintainer, I want the v2 adoption gate declared before running (see *Gate*), and the test split read once, after the gate.
26. As the maintainer, I want the abstention decision evaluated as a risk–coverage curve on the dev split, so that thresholds are chosen against a target rather than eyeballed.
27. As an operator, I want exactly one HydraDB deployment on this machine, so that ingest is not competing with stale containers for memory and there is one graph to reason about.

## Implementation Decisions

### Population, split and runtime **[decided]**

- **Population: 200 questions, not 500.** The goal is a significant paired result on this machine, not a leaderboard number. `benchmarkSlice(questions, 200)` (existing `Slice.ts`) yields all 30 `_abs` questions plus 170 answerable questions stratified across the six types. One user per question.
- **Split.** `dev` = the 60 questions already cached from the `g2` run (54 answerable + 6 `_abs`; their `results/*-60.json` rows identify them) — used for iteration, ablations and threshold tuning. `test` = the other 140 (116 answerable + 24 `_abs`), read **once** after the gate. Write both id lists to `data/splits/retrieval-v2.json` (`{ dev: [...], test: [...] }`) and commit it before any v2 dev run. The implementer must verify the 60 are a subset of the 200 selection (`stratifiedSlice` round-robins by `question_id`, so a smaller slice should be a prefix of a larger one); if not, pin the 200 as an explicit id list in the same file instead of relying on `--slice`.
- **Capacity fallback, declared now:** if the capacity gate (`scripts/p0-hydradb-capacity-gate.ps1`) trips during ingest, the population is every user fully ingested at that point; the split is recomputed by the same rule (cached 60 = dev, rest = test) and the fact is recorded in `data/splits/retrieval-v2.json` and the writeup. Do not push through a tripped gate.
- **Runtime:** exactly one deployment — the Compose project `ops/hydradb/compose.benchmark.yaml` (HydraDB + MinIO sidecar). Before `compose up`: stop and delete the containers `hydradb`, `palimpsest-p0-hydradb`, `palimpsest-p0-minio` and the volume `hydradb-data` (the old `g2` graph is re-ingested, not migrated — its extractions replay from `.cache/llm/extract` at $0). Raise `.wslconfig` `memory` from 8 GB to 12 GB (host has 15.3 GB) and restart WSL first; the compose limits (6 GB HydraDB + 0.75 GB MinIO) must fit with headroom. Run `scripts/p0-hydradb-preflight.ps1` before ingest.
- **Memory profile [decided 2026-08-29]:** the 6 GB container limit was never measured — the audit's 5.5 GiB was the old unlimited node with the buggy disk-cache evictor. The engine uses glibc malloc (no jemalloc) and its `low_memory()` preset is not selectable by name, only through individual env vars. Add a `memory` block to the `hydradb` service in `compose.benchmark.yaml`, in two tiers:
  - **Tier A — free, always on:** `MALLOC_ARENA_MAX=2`, `MALLOC_TRIM_THRESHOLD_=67108864`, `GRAPH_TRIM_MEMORY_AFTER_HYDRATION=true` (calls `malloc_trim(0)` after hydration; `src/engine.rs`). These reduce RSS fragmentation and cost no measurable latency.
  - **Tier B — RAM-for-latency trade, applied only if the step load below needs it:** `GRAPH_L0_SST_SIZE_BYTES=4194304`, `GRAPH_MAX_UNFLUSHED_BYTES=16777216` (the engine's `low_memory` storage preset), `GRAPH_READER_WAL_REPLAY_CONCURRENCY=4`, `GRAPH_MAX_GRAPHBLAS_BYTES=33554432`, `GRAPH_MAX_RELATIONSHIP_ROWS_BYTES=2097152`, `GRAPH_MAX_SOURCE_RELATIONSHIP_ROWS_BYTES=2097152`, `GRAPH_MAX_RELATIONSHIP_PROPERTY_ROWS_BYTES=4194304`. Smaller matrix/row caches mean more MSpaths recompilation and object-store reads, which works against `graphMs ≤ 1.5 s`; do not apply them blind.
  - **Step load, recorded:** ingest the 200 in steps (20 → 60 → 100 → 140 → 200 users) and after each step record `docker stats` RSS, vertex/edge counts (`pnpm stats`), and the warm `graphMs` of five dev asks, into `ops/hydradb/step-load-2026-08.md`. Set the final `mem_limit` (and `benchmark-profile.v1.json`'s `memory_bytes`, which the capacity gate checks) from that curve with ≥ 25 % headroom, instead of the current guess. Any env change alters `runtime_config_sha256` in the result manifest — record it, do not hide it. The image itself (ubuntu base + two stripped binaries) is disk, not RAM, and is not worth optimising.
- **Ingest:** `pnpm ingest-slice --slice 200 --prefix g3 --users 3` (the concurrency that completed 60 users with 0 failures), with the capacity gate running beside it. Fresh prefix `g3` so "one fresh graph" is unambiguous in every results envelope; LLM cache hits are prefix-independent. Expected: ~140 new users × ≈ $0.45 ≈ $65, wall-clock 1–2 h; spend is not a constraint.
- **Provenance instead of a manifest generation:** compute `createRuntimeExtractionGeneration()` (`Extract.ts`) at ingest and at eval time; write its `id` into every results envelope (`extractionGeneration`) and refuse to eval if the live id differs from the one recorded for the prefix in `data/splits/retrieval-v2.json`. This is the "frozen generation" guarantee the harness can actually enforce today.

### Scope of the pipeline change
- The read path becomes `understand → candidates → scope → select → hydrate/pack → sufficiency → read`. Each stage is a named module under `packages/palimpsest/src/` (`Understand.ts`, `Arms.ts`, `TimeScope.ts`, `Select.ts`, `Pack.ts`, `Sufficiency.ts`; `Reader.ts` gains routes). `Retrieve.ask` orchestrates and returns the existing `AskResult` shape (`verdict, reason, evidence, receipt, hash, anchors`) plus `plan`. Selected behind a new `AskOptions.pipeline: "v1" | "v2"` (default `v1` until the gate passes); today's `AskOptions` are `questionDate, asOf, historical, topK, maxLen`.
- Hydration and reading stay outside `ask` (as today, `Reader.hydrate`/`Reader.read` are called by `bin/ask.ts`, `Handlers.ts`, `eval.ts`), but v2's `plan` carries what the reader needs (granularity, route, interval sentence), and `Reader.read` accepts it.
- No new HydraDB read shapes beyond what exists: `MSpaths` from Token keys (Query 1), from Slot keys over `FILLS` incoming (Query 2 shape), from Claim keys over `EVIDENCE` (hydrate), plus **whole-turn hydration by Turn key** using the existing `Transcript.readTurn` (`getById("Turn", turnKey(uid, sessionKey, idx))`, chunk-reassembling) and neighbour keys `turn_idx ± 1`. **Turn keys are built from `source_session_id` (= `session.key`, which carries the `#n` suffix on the 13 questions with repeated sids), never from `Claim.sid`.** `ReachedClaim` must read `source_session_id` and `HydratedSpan` must carry `sessionKey` and `turnIdx`. A missing neighbour (`turn_idx + 1` past the last turn) is `None`, not an error.
- HydraDB remains the only candidate index. No embeddings, no BM25 in the product read path (locked decision; F-36 deferred). **No Go service, no second runtime [decided]:** every bottleneck is behind a socket (OpenAI latency, HydraDB's single writer lease, HydraDB memory); Effect's structured concurrency is sufficient.

### Read-path concurrency (v1 and v2) **[decided]**
Applied to both pipelines because it changes no evidence bytes:
1. `getById(User)` ∥ Query 1.
2. After Query 1: slot-key walk ∥ supersession edges for the top-K ∥ hydration of the top-K spans.
3. Query 2 ∥ hydration of returned slot-mates; a second supersession read only for slot-mates not in the first batch.
4. v2 arms in one `Effect.all(..., { concurrency: 6 })`.
5. `Effect.timeout` per HydraDB call, ceiling below the node's 30 s runtime; a timed-out arm is reported in the receipt as `armTimeout`, not thrown.
6. The `User` stats read (idf denominator, whole-history by design) memoised per uid for the process lifetime.
7. `pnpm warm --uid` touches the User root and its Token/Slot fan-out so the demo's first ask is not a page-cache fault.
All concurrent reads pass the same causal token (as `ask` does today) so a mid-ingest user is never read half-written. Target: 7 sequential round trips → 3 dependency levels. Evidence bytes and `hash` for v1 must be byte-identical before and after (pinned by the live probe suite on the dev users).

### Understand (extends `Anchors`)
- One structured call, same `kind: "anchors"` cache family (the schema change alters the cache key, so old entries are not reused; also bump the system prompt with a `v2` marker). It returns today's fields (`anchor_terms, historical, wants_count, time_ref`) plus:
  - `route` ∈ {`fact`, `preference`, `assistant_output`, `update`, `count`, `temporal`, `multi_fact`} — the *primary* route, which drives the reader prompt and hydration granularity;
  - independent **flags** that each gate their own stage **[decided]**: `wants_count` (exists), `has_time_ref` (derived in code from `time_ref`), `needs_decomposition` (true when `sub_questions` is non-empty). A count question with a time phrase gets both the count reader and time scope.
  - `sub_questions`: 0–4 self-contained sub-questions, **each with its own `anchor_terms`** so the sub-question arms start without a second LLM round trip **[decided]**;
  - `probes`: 0–6 `(entity_canon, attr)` pairs drawn from the question and the attribute vocabulary, e.g. `(me, age)`, `(grandma, birthday)`.
- `time_interval` is computed **in code** from `time_ref` + question date by a deterministic resolver for the supported phrases (`N days/weeks/months/years ago`, `last <month|weekday|week|month|year>`, `in <Month> [year]`, `this weekend`, explicit dates) as closed-open `[start, end)` at day precision, or `null`; the model only supplies the phrase.
- Deterministic cues override the model where unambiguous (`how many` → `count`; `currently|now|still` + slot-like noun → `update`; `did I ... with` + time phrase → `temporal`). The final route and reason (`model` | `cue:<name>`) go in the receipt.
- Historical/as-of semantics unchanged.

### Candidate arms (concurrent, each bounded, each reported)
- **Convergence arm**: today's Query 1 with `topK = 60` for the selector (the structural verdict still uses `convergenceThreshold`; A1/A2 remain the structural abstention reasons).
- **Slot-probe arm**: for each probe, resolve the entity through the existing Entity canon keys and read the Slot's claims (Query 2 shape by `skey`). Missing slot ⇒ empty arm, not an error.
- **Sub-question arms**: for each sub-question, a convergence walk from its own anchor terms. Cap 4.
- **Discovery arm** (flag-gated: `needs_decomposition` or `has_time_ref` or `wants_count`): entities and highest-idf tokens (idf from the Token `df` already read in `Scoring.ts`) from the top-10 convergence candidates that are not already anchors seed one more convergence walk. Deterministic; no LLM. Cap 20 seed tokens.
- **Slot-mate expansion** (existing Query 2) stays but is **grouped**: each Slot contributes at most its latest 5 *as-of-visible* claims, labelled as one history.
- **As-of before every cap [decided]:** every arm filters `session_ord ≤ k` before its own cap and before the union cap. This also fixes the existing v1 defect where Query-2 slot-mates are cut to `MAX_SLOT_EXPANSION = 40` *before* `applyAsOf` (`Retrieve.ts:219-226`), so post-`k` claims consume the budget and are then discarded. **v1 is left as is** so the paired comparison is against the shipped behaviour; the defect is noted in the writeup.
- Union by claim key; per-claim provenance (`arms: ["convergence", "probe:me|age", …]`, convergence, score, hops). Cap the union at 120 claims by provenance priority (probe > sub-question > convergence > discovery > slot-mate) then score.

### Time scope
- If `time_interval` is set: a claim is *in scope* when `t_event` at its `t_prec` intersects the interval, or `t_event = 0` and `session_date` is within the interval widened by 7 days. In-scope claims are boosted ahead of all others; out-of-scope claims are kept only if fewer than 10 are in scope. Applied before the union cap. Reported as `timeScope: {interval, inScope, outOfScope, applied}`.
- When `has_time_ref`, the interval is passed to the reader prompt as a sentence ("The question refers to the period …") regardless of route.

### Select (pure module + one LLM call)
- Input: the candidate table with, per row: short id, index text (the derived Claim `text` — allowed here because it never reaches the reader), speaker, session date, `t_event`, status (`CURRENT` / `SUPERSEDED`), slot group id, arms, in-scope flag.
- One listwise structured call ("keep the rows that help answer; prefer distinct facts; keep every row needed for a count or comparison; keep both old and new values for an update question") returns kept ids with a one-word reason each; `kind: "select"`, cached by content hash. Rows are ordered deterministically before the call so the prompt is stable.
- Guarantees enforced in code: keep-set ≤ 30 turns; always include the top-3 convergence claims and every probe hit; on call failure fall back to the deterministic top-25 ordering (v1 behaviour) and flag `selectorFallback: true`.
- Deduplicate by `(sessionKey, turnIdx)` after selection; a turn selected through several claims is hydrated once with the union of its spans highlighted.
- If dev results show the selector prefers assistant-sourced rows (72 % of claims are assistant-sourced), add the speaker prior (research §4 #9) as a deterministic pre-sort, not a prompt tweak.

### Hydrate and pack
- Granularity by route: `fact`/`update`/`temporal`/`count` → claim span ± 300 chars (today's `SPAN_CONTEXT`); `assistant_output` → the whole turn plus the previous turn; `preference` → the whole user turn plus the previous assistant turn; `multi_fact` → span, but whole turn when the turn is < 600 chars. `--granularity` overrides for ablation.
- Packing order: chronological by event time then session (today's `orderEvidence` rule).
- **Read-side adjudication, route-scoped [decided]:** on routes `update` and `fact` only, the latest CURRENT claim of each Slot is labelled `CURRENT`, earlier CURRENT claims in the same Slot `EARLIER STATEMENT`, and superseded ones `SUPERSEDED (at session k)`. On `count`, `multi_fact`, `preference`, `temporal`, `assistant_output` every CURRENT claim stays `CURRENT` — slots such as `(me, hobby)` or items-to-return are multi-valued and the label would tell the reader to discard valid facts. Ablation: a declared single-valued attribute list, if `count` regresses. This changes no graph data.
- **Budget:** reader input ≤ 6 000 tokens by default, estimated as `chars / 4` **calibrated once on dev** against provider-reported `readerInputTokens`; the ratio is a constant in `Pack.ts` with its measurement in a comment and is echoed in the receipt **[decided]** (no tokenizer dependency; Luna's tokenizer is unverified anyway). Drop from the tail of the selector's ranking, never a probe hit; the receipt records dropped ids with reason `budget`.

### Sufficiency and second pass
- After packing, one small structured call (`kind: "sufficiency"`) classifies the packed evidence for the question: `EXACT` / `INFERRABLE` / `PARTIAL`, `missing` (≤ 30 words), `unsupported_premise` (nullable: the premise phrase). Skipped when route is `fact`/`assistant_output` and the top convergence candidate has convergence ≥ 3; reported as `sufficiency: skipped`. Always skipped in the `fast` profile.
- On `PARTIAL`: exactly one refined pass — anchors from `missing` plus the original question (dual path), the same arms, then select again over the union of both passes. On still-`PARTIAL`, verdict `ABSENT` with reason `INSUFFICIENT_EVIDENCE`; the reader is not called.
- **`CONTRADICTED_PREMISE` is evidence-backed, not model-only [decided]:** verdict `ABSENT` with that reason only when the sufficiency call names a premise *and* a CURRENT claim in the packed set contradicts it (same Slot, different value; or a probe hit on the premise's `(entity, attr)` with a different value). A named premise with no contradicting claim proceeds to the reader as normal. This is the guard against repeating the `palimpsest-premise` result (−11 pp accuracy for +17 pp abstention).
- Both reasons are new `Verdict.reason` values beside `A1_no_anchors` and `A2_no_convergence` (`NOT_IN_MEMORY` is the reader's answer string, not a `Verdict.reason`, and stays that way).
- Thresholds (whether `INFERRABLE` answers or triggers the pass; whether temporal routes require `EXACT`) are constants in one module with their dev justification in a comment; tuned against the risk–coverage curve on dev, not per question. Both stages default **on**.

### Reader
- One system prompt with a route-specific rules block appended. Route rules: `preference` — "Begin by stating, in one clause, the personal facts from the excerpts you are building on, then give the suggestion; do not answer generically"; `update` — "When a CURRENT and an EARLIER STATEMENT excerpt give different values, the CURRENT one is current; answer with it and may add 'previously …'"; `count` — "List each distinct item in plain words, then the total"; `temporal` — the existing date-arithmetic rule plus the interval sentence; `assistant_output` — "Quote the assistant's words verbatim where the question asks what was said"; `fact` — today's concise rule. Remove "as few words as the question allows" from every route except `fact`.
- **Excerpt ids never appear in `answer` [decided]** — they go in `cited_ids` only, so the gpt-4o judge never sees `[a1b2c3d4]` tags. The reader still never sees Claim text.
- Citation validation: `cited_ids` are checked against the packed set; an answer citing nothing that exists is re-asked once with the note "cite at least one excerpt id"; still nothing ⇒ treated as `NOT_IN_MEMORY`. (Today `citedIds` are passed through unchecked.)
- Message formatting: one blank line between excerpts, a stable header line per excerpt (`[id] session n · date · speaker · status`), no nested markdown. The existing "CURRENT first and then superseded, each group oldest first" ordering line and its unit test stay; the test gains an `EARLIER STATEMENT` case.
- Rendered prompts are stored beside the cached value for every read-path call (story 11) — a new optional `prompt` field in the cache entry, written on miss only.

### Models **[decided]**
- **The reader model is frozen at `gpt-5.6-luna` for the whole v1-vs-v2 comparison, dev and test.** Model exploration ("a stronger sibling for the reader") is a separate dev-only experiment *after* the gate, in which `palimpsest`, `palimpsest-v2`, `bm25` and `fullctx` all get the candidate reader; if a different configuration is chosen for the writeup, it is declared in `data/splits/retrieval-v2.json` before test is read, and test is still read once.
- `PALIMPSEST_MODEL` stays the reader/anchors/extraction model. New `PALIMPSEST_SELECT_MODEL` and `PALIMPSEST_SUFFICIENCY_MODEL` default to it when unset. All three are verified against the provider's models endpoint at startup (fail closed on an unknown id) and recorded in every results envelope and receipt. The judge stays `gpt-4o` with the official templates.

### Receipt, hash and determinism wording
- Receipt gains `plan` (route, routeReason, flags, timeScope, arms with counts/queries/timeouts, selection {kept, dropped[reason], fallback}, granularity, budget {estimate, ratio, dropped}, sufficiency {tier, missing, premise, secondPass}, models, stageTimingsMs) and keeps all 17 current fields. HTTP projection updated through `ReceiptProjection.ts`.
- `hash` becomes sha256 over the sorted `(sessionKey, turnIdx, cs, ce)` tuples actually hydrated; the claim-key hash is retained as `claimHash` for continuity with v1 results. Baselines keep the claim-key form.
- **CONTEXT.md sentence [decided]:** replace "Retrieval is deterministic given a fixed graph" with "Retrieval is *replay-deterministic*: given a fixed graph and a fixed LLM cache it is byte-identical; every LLM decision on the read path is cached by content hash with its model id in the receipt. First-run selection is model-dependent." Extraction remains non-deterministic; say exactly that.

### Latency **[decided]**
- Two numbers, both p50 on a warm node, both in every results row: `graphMs` (all HydraDB stages) with target ≤ 1.5 s, and `askMs` (whole ask) with target ≤ 8 s for the full plan and ≤ 5 s for the `fast` profile (`AskOptions.profile: "full" | "fast"`; `fast` = no sufficiency, no second pass). Cold numbers are reported separately and are not a target. The demo server uses `fast` by default and `pnpm warm --uid` on user select.

### Eval harness
- Systems: `palimpsest` (unchanged v1), **`palimpsest-v2`**, **`oracle-session`**, `palimpsest-premise`, `bm25`, `fullctx`. `--system` values are validated (an unknown name is an error, not silently `fullctx`).
- New flags: `--split dev|test` (reads `data/splits/retrieval-v2.json`; `--split test` refuses to run unless a gate record for dev exists in the same file), `--profile full|fast`, and the ablation flags of story 21.
- Results rows gain `route`, `flags`, `graphMs`, `askMs`, `stageTimingsMs`, `sufficiencyTier`, `secondPass`, `selectorFallback`, `claimHash`, `errorClass` (derived: `retrieval_miss` if no answer session in the union; `selection` if in union but not kept; `packing` if kept but dropped by budget; `reader` otherwise; `premise` for `_abs`). Envelopes gain `extractionGeneration`, `readerModel`, `selectModel`, `sufficiencyModel`, `split`, `profile`.
- **`pnpm table`** — a standalone command that regenerates the per-type table, the error-class table, and the paired 2×2 vs `palimpsest` and `bm25` with exact McNemar and a 95 % CI on the paired difference, from results JSON only (today the table is rendered inline by `eval.ts` and cannot be rebuilt without a graph).
- Statistical honesty: with 116 answerable test questions, paired McNemar reliably detects ≈ +8–10 pp; a +5 pp true effect is a coin-flip at p < 0.05. Report the paired effect, its CI, and the per-type table; treat p < 0.05 as a bonus, not the claim.

### Gate **[decided]**
Read on `dev` (54 answerable + 6 `_abs`), deliberately a sanity gate because n is small; the 140-question `test` is the number that counts:
- `palimpsest-v2` ≥ `palimpsest` + 3 correct on the 54 answerable (≈ +5 pp);
- no question type worse than −1;
- false-abstention ≤ 10 % on the 54; abstention accuracy on the 6 `_abs` ≥ v1's;
- `graphMs` p50 warm ≤ 1.5 s; reader tokens p50 ≤ 6 000.
Record the gate result in `data/splits/retrieval-v2.json` (`gate: { readAt, passed, numbers }`); `--split test` reads it. Test is read once with the configuration that passed.

## Testing Decisions

Good tests here assert **external behaviour at the highest seam that does not need a live node**: given paths/claims, this evidence set and this receipt come out; given a results JSON, this table comes out. They do not assert prompt wording.

Seams, highest first:

1. **Eval harness on `--split dev`** (existing `pnpm eval` seam, extended). Every stage and every ablation is judged here with the existing judge and `pnpm table`; this is where the gate is read. New LLM prompts cost once, then replay.
2. **Pure stage modules with fixture inputs** (existing pattern: `scoring.test.ts`, the span-window tests). Time-interval resolver (table of phrase × question date → interval, including month/year precision and `null`); time-scope filter; union/provenance/cap with as-of before cap; selection guarantees (probe hits kept, fallback on failure, dedupe by turn); packing labels (`EARLIER STATEMENT` on `update`, *not* on `count`); budget drops with reasons; receipt/hash construction incl. `sessionKey` with a `#n` suffix; error-class derivation; McNemar arithmetic against the 38/5/3/8 table from the audit; `Verdict.reason` for the two new abstention reasons; `CONTRADICTED_PREMISE` requires a contradicting claim.
3. **Live probe suite** (`pnpm probe`, vitest `live` project, serial) on the dev users of the new graph: whole-turn-by-key with neighbour keys including a repeated-sid user; Slot-key probes from canon keys; and **v1 evidence + `hash` byte-identical before and after the concurrency change** for every dev question.
4. **Reader route A/B** on identical packed evidence (existing `readSpans` seam): the same spans through `fact` vs route-specific rules on the 11 preference and 14 knowledge-update dev questions, judged by the official templates.

## Work order **[decided]**

1. **Day 0, first:** `.wslconfig` → 12 GB, WSL restart; delete `hydradb`, `palimpsest-p0-*`, `hydradb-data`; add the Tier A memory env block; `compose up` the benchmark project; preflight; start the **step-load** ingest (`--slice 20`, then 60, 100, 140, 200). `ingest-slice` does not skip users already in the graph — a re-run re-extracts from cache at $0 but re-`MERGE`s every earlier user's vertices — so first add a `--skip-existing` flag that skips a uid whose `User.n_sessions` (via `readUserStats`) already equals the question's session count, and run every step with it with the capacity gate in the background (wall-clock bound, ~1–2 h), recording RSS/counts/graphMs per step. Commit `data/splits/retrieval-v2.json` with the id lists and the extraction generation id.
2. While it runs: the pure stage modules + fixture tests (seam 2), the read-path concurrency change, `pnpm table`, harness flags. Nothing here needs the node.
3. When ingest finishes: live probes (seam 3) — first the v1 byte-identity check, then `pnpm eval --system palimpsest,bm25,fullctx,oracle-session --split dev` to re-baseline on the new graph.
4. `palimpsest-v2` on dev; ablations; thresholds from the risk–coverage curve; reader A/B (seam 4); read the gate.
5. Only after the gate: `--split test`, once, all systems; `pnpm table`; results committed as JSON + tables.

## Out of Scope

- Semantic / late-interaction / BM25 sidecars in the product read path (F-36) — revisit only if the post-v2 error table shows retrieval misses > 5 %.
- A Go (or any second-runtime) service; write-path extraction/write pipelining (the ingest is a one-off and LLM-bound).
- The full 500-question population; LongMemEval-V2.
- Changes to extraction, claim keys, or supersession inference (a new extraction generation would confound every comparison; the graph is frozen for this work).
- Making the transactional/generation ingest query-visible (#15, F-14) and receipt v2 integrity fields beyond `plan` (#17).
- The writeup and video — #13; the 140-question test read here is the number it reports.
- Multi-turn conversation memory (follow-up questions) and the live-ingest demo path — unchanged, except that the demo uses the `fast` profile.

## Further Notes

- Estimated gains, per the research doc §4: selection + packing +3–5; time scope +2–4; reader routes +1.5–3; granularity +1–2; decomposition/probes +2–3; discovery +1–3; current-state readout +1–2; sufficiency +1–2 on abstention. These overlap; the gate is modest and the ablation flags exist so the sum is measured.
- Source-reported numbers the estimates lean on, verified against the papers on 2026-08-29: SmartSearch query expansion +9.2 pp on LME-S (largest on multi-session and temporal), reranker quality +6.0 and rank fusion +1.2 (LoCoMo ablation); MemMachine retrieval depth +4.2, formatting +2.0, search prompt +1.8, "user:" prefix +1.4, GPT-5-mini reader +2.6; TSM temporal +22.6 / multi-session +20.3 *over a 62.6 % A-MEM baseline* — direction, not magnitude, for us.
- Cost: one selector call and, on non-trivial routes, one sufficiency call per ask, both on a small model and both cached; expect ≈ 1.3–1.6× v1's per-ask LLM spend and the same reader spend. Ingest ≈ $65; a full six-system dev+test evaluation is on the order of $20–40 and may be repeated.
- Negative results to remember while implementing: three-way fusion and embedding-MMR diversity did not help elsewhere; more candidates without a selector hurt a strong reader; a stricter one-shot premise instruction cost 11 points here. Keep the selector and the sufficiency check separate calls with separate cache families so each can be ablated.
- Tracker: #18 and #19 are partly superseded by this spec (F-36 deferred); they are commented and de-flagged so a fresh agent does not build the sidecar.
