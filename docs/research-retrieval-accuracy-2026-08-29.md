# Retrieval accuracy research — what moves LongMemEval, and what is wrong with our misses

**Research cut:** 2026-08-29
**Inputs:** the three review docs (`review-2026-08-17`, `-19`, `-20`), `results/*-60.json` replayed per question against `data/longmemeval_s_cleaned.json` and `.cache/llm/extract`, and the papers below (fetched through `pwc` / arXiv).
**Companion:** the 2026-08-20 landscape doc (`research-memory-context-landscape-2026-08-20.md`) covers product neighbours and evaluation validity; this document is narrower — *which algorithmic changes are most likely to raise accuracy, quality and latency on our actual failure modes*, and it ends in the spec for the next build (`spec-retrieval-v2.md`, GitHub issue #22).

Evidence labels: **repo-observed** (our code/artefacts), **source-reported** (the paper's own number, not reproduced here), **proposed** (an experiment for us).

---

## 1. Where we are, in one table

Repo-observed, 60-question completion-conditioned slice, reader `gpt-5.6-luna`, local `gpt-4o` judge:

| | Palimpsest | BM25 top-10 | Full context |
|---|---:|---:|---:|
| Answerable accuracy (n=54) | 43 = 79.6 % | 41 = 75.9 % | 45 = 83.3 % |
| SessionRecall@25 | 98.1 % | 94.4 % | 100 % |
| Reader tokens p50 | 3 658 | 2 787 | 111 057 |
| Latency p50 (cold node) | 15.2 s | 2.6 s | 3.4 s |

Per type (Palimpsest, correct/n): single-session-user 9/9 · knowledge-update 12/14 · multi-session 10/13 · single-session-assistant 7/8 · temporal-reasoning 4/5 · **single-session-preference 5/11**.

Two facts frame everything below:

1. **Recall is not the bottleneck.** 98.1 % of answer sessions are already in the top-25 candidate set; only one of the 13 misses (`1c0ddc50`) had `sessionHit=false`. The loss is in *selection, packing and reading* — exactly the "compilation bottleneck" SmartSearch names (§3).
2. **The 60-slice is not the 500.** The full set is multi-session 133, temporal-reasoning 133, knowledge-update 78, single-session-user 70, single-session-assistant 56, single-session-preference 30. Our slice over-weights preference (11/60 vs 6 %) and under-weights temporal (5/60 vs 27 %). Multi-session and temporal are 53 % of the final score; anything that only fixes preference is worth ≤ 6 points at most.

## 2. Diagnosis of every miss on the 60 slice

Each row was checked against the gold answer, the answer-bearing turns in the dataset, and the claims the extractor actually produced for those sessions (from `.cache/llm/extract`). Reader calls *are* cached (`kind: "read"`), but the cache stores only the key hash and the response, never the rendered prompt, so "what the reader saw" is inferred from the retrieval rules, not observed. (Corrected 2026-08-29; the v2 spec stores the rendered prompt beside the cached value.)

| qid | type | P / B / F | What went wrong | Failure class |
|---|---|---|---|---|
| `06f04340` | preference | ✗ ✗ ✓ | Gold wants "use your homegrown cherry tomatoes, basil and mint". Answer session (`answer_92d5f7cd`) is a gardening chat; the user's turn 4 says exactly that. We answered generic grilled chicken. The prompt says *"answer in as few words as the question allows"* and never asks the reader to **name the personal facts it is using** — the preference judge rubric scores exactly that ("correct as long as it recalls and utilizes the user's personal information"). | **Reader style** (preference) |
| `09d032c9` `0a34ad58` `1c0ddc50` `1da05512` `0edc2aef` | preference | ✗ ✗ ✗ (all three systems) | Same pattern: answers are generic tips; the personal hook (power bank already bought; Suica + TripIt; podcasts beyond true-crime; NAS vs current external drives; rooftop-pool hotel taste) is not surfaced or not *stated*. `0edc2aef` all three said NOT_IN_MEMORY. `1c0ddc50` is the one true retrieval miss (`sessionHit=false`). | **Reader style** + 1 retrieval miss |
| `07741c45` | knowledge-update | ✗ ✓ ✓ | "Where do I currently keep my old sneakers?" Session 05/25: *under my bed*; session 05/29: *in a shoe rack in my closet*. Both claims extracted with slot `(sneaker, location)`. We answered "under your bed" — either no `SUPERSEDED_BY` edge was inferred (the 05/29 sentence is oblique: "get rid of some of my old sneakers in a shoe rack in it") or both were CURRENT and the reader, told "oldest first", took the first. Nothing in the reader says *the later-dated CURRENT statement wins*. | **Current-state adjudication** |
| `157a136e` | multi-session | ✗ ✗ ✓ | "How many years older is my grandma than me?" needs `grandma's 75th birthday` (session _2) **and** `do you think 32 is young` (session _1). Anchors {grandma, older, year, age…} reach the birthday claims; nothing lexical reaches "32". Slot `(me, age)` almost certainly exists in the graph and was never consulted. | **Multi-fact decomposition / slot lookup** |
| `0a995998` | multi-session | ✗ ✓ ✗ | "How many items of clothing do I need to pick up or return?" — dry-cleaned blazer, boots at Zara (mentioned twice), green sweater lent to sister. Answer 1 (BM25: 3). Count questions need *all* additive items across sessions; top-25 by convergence plus 40 slot-mates is not a coverage-oriented selection, and near-duplicate boots claims crowd out the sweater. | **Coverage / dedup for aggregation** |
| `0bc8ad93` | temporal | ✗ ✗ ✗ | "Museum two months ago — with a friend or not?" Three museum visits in the history; the one two months before 2023-03-11 was solo. We (and full context) picked the one with the chemistry-professor friend. No time-scoped filtering: `time_ref` is extracted but never used to prefer claims whose `t_event`/session date fall in the window. | **Temporal scoping** |
| `1568498a` | assistant | ✗ ✓ ✓ | Chess: the answer turn is 25 characters ("28. Kg3 would be my move.") and *was* extracted as a claim. We answered "29. Rd3". The session has ~18 near-identical move claims; ±300-char excerpts of a move list are indistinguishable, and the reader lost the thread. Whole-turn hydration with surrounding turns (the user's move list ends in "27. Kg2 Bd5+", the next assistant turn is the answer) makes this trivial. | **Granularity / contextualisation** |
| `031748ae_abs` `09ba9854_abs` | abstention (false premise / missing fact) | ✗ ✓ ✗ / ✗ ✗ ✗ | "…as Software Engineer Manager" (user is a Senior SWE); "bus from airport" (only taxi/train discussed). Retrieval converges on the topic, the reader answers a number. Full context makes the same mistake. The premise-check prompt fixes these but costs −11 pp elsewhere (`results/table-60.md`). | **Sufficiency / premise** |

Aggregated: **6 reader-style (preference)**, **1 adjudication**, **1 decomposition**, **1 coverage**, **1 temporal**, **1 granularity**, **2 sufficiency**, **1 pure retrieval miss**. Twelve of thirteen misses are *after* candidate generation.

Extrapolating to the 500 with the type weights: temporal scoping, coverage/decomposition for multi-session, and adjudication for knowledge-update are the levers that matter most; preference style is cheap and certain but small.

## 3. What the literature says moves LongMemEval-S (2025-11 → 2026-08)

Scores are source-reported and **not comparable across papers** (judges, readers and prompts differ — SmartSearch §7.2 documents a 14-pp swing from protocol alone). What transfers is *which stage each ablation moved*.

### 3.1 Ranking beats structure — three independent confirmations

- **SmartSearch** (Derehag, 2603.15599). Deterministic grep over raw turns + CrossEncoder/ColBERT RRF, **88.4 % LME-S** (gpt-4.1-mini). Oracle analysis (LoCoMo): recall 98.6 %, but only 22.5 % of gold survives truncation without a reranker — *"the compilation bottleneck"*; the same pattern holds on LME-S. Reranker quality is +6.0 pp and rank fusion +1.2 pp in the 27-configuration LoCoMo ablation (7.2 pp is the whole baseline→final delta, not the reranker alone — corrected 2026-08-29); **query expansion (entity discovery from retrieved passages + pseudo-relevance feedback) is +9.2 pp on LME-S, +12.8 on temporal, and largest on multi-session**; score-adaptive truncation (`τ = 0.03·maxCE`, top-K 60, ceiling 4 000 words) replaces per-dataset budget tuning. Final failure split: 59 % reader inference, 24 % rank/budget, 12 % search miss. Morphological expansion was *rejected* as noisy. SSP 96.7 %, temporal weakest.
- **True Memory** (Adler & Zehavi, 2605.04897). Verbatim events in one SQLite file, FTS5 BM25 + dense RRF, temporal boost ×1.3 when the query has temporal intent, cross-encoder rerank top-100 → 10, HyDE. **87.8 % LME-S**; plain BM25 81.6 %, ChromaDB RAG 87.0 % under the same harness. 56-config grid: embedder × reranker choice moves accuracy by ≤ 3.2 pp; *having* the multi-stage pipeline is the ~20-pp difference. Retrieval-bottleneck diagnostic: 92 % of an early build's misses were recovered by full context.
- **MemMachine** (2604.04853). Sentence-indexed raw episodes, nucleus + neighbours (1 before, 2 after) → cross-encoder. Six-dimension LME-S ablation, **93.0 %**: retrieval depth k 20→30 **+4.2** (k=50 *worse* for GPT-5, monotone for GPT-5-mini), context formatting (clear message boundaries) **+2.0**, search-prompt design **+1.8**, removing CoT scaffolding **+1.6**, prefixing "user:" to the search query to counter the assistant-message bias **+1.4**, sentence chunking +0.8. **GPT-5-mini beat GPT-5 as reader by +2.6** with a direct prompt. SSP went 0.700 → 0.933 from retrieval + reader changes alone.

Read together with **Does Memory Need Graphs?** (ACL 2026, 2601.01280): entity activation + ranking sessions by (query–entity similarity, *number of activated keys pointing at the value*) is a strong baseline; 1-hop expansion is marginal unless the reranker is good; similarity-edge graphs *hurt*; entity **descriptions** beat triples; *Value = whole session* beats *Value = key* for reading. Our convergence score is precisely their `Score_g`; what we lack is the `Score_e` half and any reranking.

### 3.2 Temporal — filter by time before ranking

- **TSM** (2601.07468): semantic timeline (event time, not dialogue time) + temporal intent parsing of the query into a date range (SpaCy), temporal filtering/reranking of candidates. **+22.6 temporal, +20.3 multi-session** over their A-MEM baseline on LME-S (62.6 % → 74.8 % overall with GPT-4o-mini — a weak baseline, so read the deltas as direction, not magnitude for us). Ablation: removing temporal rerank costs more than removing summaries.
- **AssoMem** (ICLR 2026, 2510.10397): score = relevance + PPR importance + explicit temporal match, weights chosen per question type by conditional mutual information; gains concentrated on preference and temporal.
- **EviMem** (2604.27695): temporal questions get stricter sufficiency thresholds; temporal 73.3 → 81.6 on LoCoMo.
- LongMemEval's own paper: time-aware query expansion +7–11 temporal recall.

Transfer: we already extract `time_ref`, `t_event`, `t_prec`, `session_date`. Resolving `time_ref` to a closed interval deterministically and using it as a **pre-rank filter/boost** is the single most reusable idea for our 133 temporal questions.

### 3.3 Multi-fact and multi-hop — decompose, don't fan out

- **MemMachine Retrieval Agent**: one routing call → `direct` / `SplitQuery` (2–6 independent sub-queries, parallel) / `ChainOfQuery` (≤ 3 iterations, each: retrieve, one combined sufficiency-judgement + rewrite call, early stop at confidence ≥ 0.8). Multi-query reranking against the union of all queries. +5.2 on noisy multi-hop; direct route costs one extra call.
- **EviMem IRIS**: after each pass an LLM classifies the *accumulated* evidence as EXACT / INFERRABLE / PARTIAL and names what is missing; the diagnosis (not a draft answer) drives the refined query; dual-path retrieval (original + refined) prevents drift; per-entity fact buffers catch "one entity has no evidence". Abstains explicitly if still PARTIAL.
- **SmartSearch** entity discovery: rule-based NER over retrieved passages seeds the second hop; 97 % of questions resolve in one hop.

Transfer: `157a136e` is the SplitQuery case; our Slot vertices make the sub-lookups *cheaper than anything in these papers* — `(me, age)` is one MSpaths read from a Slot key.

### 3.4 Knowledge updates and stale premises

- **STALE** (2605.06527): even frontier models accept a stale premise embedded in the question; memory frameworks retrieve the update in 77 % of cases but only 3 % adjudicate it. Their CUPMem prototype (write-side KEEP/STALE/REPLACE/UNKNOWN adjudication + constrained readout where stale items are "historical context") goes 8.7 → 68 % overall and 0 → 78 % on premise resistance.
- Our supersession edge *is* write-side adjudication. What is missing is the **readout rule**: when the chain is incomplete (no edge inferred) two CURRENT values coexist and nothing prefers the later one; and the reader is never told that a question premise may be stale.

### 3.5 Reading and packing

- LongMemEval: Chain-of-Note + structured (JSON) formatting improves reading; round-level values beat session-level; reading strategy is worth up to 10 points *under oracle retrieval*.
- **Back to Basics / Nano-Memory** (COLM 2026, 2604.11628): Turn-Isolation Retrieval (session score = max over turns, never mean) and Query-Driven Pruning (an LLM keeps only query-relevant fragments across the retrieved sessions) — QDP beats even "gold session only" because filler hurts the generator.
- **EMem** (2511.17208): dense top-K → *recall-oriented LLM filter* that selects the relevant items in one call; the lightweight variant matches the graph variant. For LME-S long assistant answers they index a 2–3-sentence summary and hand the **full chunk** to the reader.
- MemMachine: answer prompt without CoT scaffolding +1.6; smaller reader with the right prompt beats the larger one.

Transfer: one **listwise LLM relevance filter** over ~60–100 claim candidates (keeping ids only) is the TS/Effect-native substitute for a cross-encoder, adds one cheap call, and directly attacks the 24 % rank/budget and part of the 59 % reader-inference failures. Hand the reader **turns** (or claim ± neighbouring turns) rather than ±300-char windows for assistant-output and preference questions.

### 3.6 What *not* to do (negative results we can reuse)

- Three-way rank fusion and score-based fusion did not beat two-way RRF (SmartSearch App. A). MMR diversity on embeddings failed. Cumulative-score pruning hurt.
- Similarity-edge graphs reduce recall (Does Memory Need Graphs, Table 4).
- Retrieval depth is non-monotone for a strong reader (MemMachine k=50 < k=30 for GPT-5); "more candidates" without a reranker is a loss.
- Training-free BM25 + late-interaction fusion gave a non-significant +0.67 on LME-S (landscape doc, 2606.04194) — lexical overlap is high on this benchmark; a dense sidecar is not where the points are.
- A stricter one-shot premise instruction trades −11 pp accuracy for +17 pp abstention (our own `palimpsest-premise` A/B).

## 4. Implications for Palimpsest, ranked by expected gain per unit of work

Expected gains are *our estimates* from the failure classes in §2 weighted by the 500-question type mix, sanity-checked against the source-reported ablations; they are hypotheses to be measured, not promises.

| # | Change | Targets | Evidence | Est. gain (500) | Cost |
|---|---|---|---|---|---|
| 1 | **Listwise LLM relevance filter + token-budgeted, deduplicated, chronologically ordered packing** over a wider candidate union (Query 1 top-60 ∪ slot mates ∪ decomposition arms) | rank/budget failures; count/coverage; chess-style confusion | SmartSearch +6.0 (reranker) +1.2 (fusion), MemMachine +4.2 (depth), EMem filter, Nano-Memory QDP | +3 to +5 | one LLM call/ask (cacheable), pure selection module |
| 2 | **Time-scoped retrieval**: resolve `time_ref` → interval; boost/filter claims by `t_event`/session date before top-K; temporal route in reader | temporal-reasoning (133 q) | TSM +22.6 temporal; True Memory ×1.3 boost; LongMemEval +7–11 | +2 to +4 | deterministic, no new calls |
| 3 | **Question-type routing of the reader prompt** (preference → "state the personal facts you used", knowledge-update → "latest CURRENT wins; give previous + updated", count → enumerate with citations, assistant-output → verbatim) and drop CoT scaffolding where not needed | preference (6/11 misses), knowledge-update adjudication | judge rubrics; MemMachine +1.6/+1.8; STALE readout | +1.5 to +3 | prompt work, A/B on cache |
| 4 | **Granularity by route**: whole turn + neighbouring turns for assistant-output/preference; claim span for facts | chess-type, preference context | MemMachine contextualisation; LongMemEval round-level; EMem full chunk | +1 to +2 | hydration change, more tokens on those routes |
| 5 | **Decomposition + slot probe**: cheap router (deterministic cues + one small LLM call already in `Anchors`) → for multi-entity/comparison/count questions run 2–4 sub-asks in parallel and a direct `Slot` lookup for `(entity, attr)` pairs; union before #1 | multi-session (133 q) | MemMachine SplitQuery; EviMem entity buffers; our Slot graph | +2 to +3 | one extra MSpaths per sub-query |
| 6 | **Bounded second hop by entity discovery / PRF** (entities and high-idf tokens from the top-10 candidates seed one more MSpaths call, deterministic) | multi-session, temporal chronology | SmartSearch +9.2 LME-S (super-additive with PRF) | +1 to +3 | one MSpaths call, only when route asks |
| 7 | **Current-state readout rule**: among CURRENT claims of one slot prefer the latest; label older ones `EARLIER STATEMENT`; reader told the premise may be stale | knowledge-update (78 q), false-premise abstention | STALE/CUPMem | +1 to +2 | pure ordering + prompt |
| 8 | **Sufficiency loop instead of premise flag**: after #1, one call classifies accumulated evidence EXACT/INFERRABLE/PARTIAL + missing-info diagnosis; PARTIAL triggers one refined pass (#5/#6); still PARTIAL → abstain with reason `INSUFFICIENT_EVIDENCE`; calibrate thresholds on a dev split | abstention (30 q) without the −11 pp | EviMem IRIS; Google sufficient-context | +1 to +2 on abstention, ≈0 on answerable | one call, only on non-EXACT |
| 9 | Speaker prior: down-weight `assistant_output` claims for user-fact questions (`single-session-user`, preference, knowledge-update) | user-fact precision | MemMachine "user:" prefix +1.4; our claims are 72 % assistant-sourced | +0.5 to +1 | scoring feature |
| 10 | Latency: warm the page cache on user select; run Query 1, slot probe and decomposition arms concurrently; small model for filter/sufficiency; stage timers in the receipt | p50 | True Memory 1.5–3 s retrieval; MemMachine GPT-5-mini | — | engineering |

Not proposed now: a dense/late-interaction sidecar (F-36). Session recall is 98 % and the one LME-S fusion study found +0.67 n.s.; revisit only if the post-#1 error decomposition shows > 5 % search misses.

## 5. Sources

- SmartSearch: How Ranking Beats Structure for Conversational Memory Retrieval — arXiv 2603.15599
- Storage Is Not Memory: A Retrieval-Centered Architecture for Agent Recall (True Memory) — arXiv 2605.04897
- MemMachine: A Ground-Truth-Preserving Memory System for Personalized AI Agents — arXiv 2604.04853
- Does Memory Need Graphs? A Unified Framework and Empirical Analysis for Long-Term Dialog Memory — ACL 2026, arXiv 2601.01280
- Beyond Dialogue Time: Temporal Semantic Memory for Personalized LLM Agents (TSM) — arXiv 2601.07468
- AssoMem: Scalable Memory QA with Multi-Signal Associative Retrieval — ICLR 2026, arXiv 2510.10397
- EviMem: Evidence-Gap-Driven Iterative Retrieval for Long-Term Conversational Memory — arXiv 2604.27695
- STALE: Can LLM Agents Know When Their Memories Are No Longer Valid? — arXiv 2605.06527
- Back to Basics: Let Conversational Agents Remember with Just Retrieval and Generation (Nano-Memory) — COLM 2026, arXiv 2604.11628
- A Simple Yet Strong Baseline for Long-Term Conversational Memory of LLM Agents (EMem) — arXiv 2511.17208
- APEX-MEM: Agentic Semi-Structured Memory with Temporal Reasoning — ACL 2026, arXiv 2604.14362 (86.2 % LME-S with a tool-using agent; ablation: hybrid search tool +7.6, structured graph queries +2.3)
- Hindsight is 20/20 — arXiv 2512.12818 (four-way parallel retrieval → RRF → cross-encoder → token budget; 91.4 % LME-S)
- LongMemEval — ICLR 2025, arXiv 2410.10813; LongMemEval-V2 — arXiv 2605.12493
- Anatomy of Agentic Memory (judge sensitivity, benchmark saturation) — arXiv 2602.19320
