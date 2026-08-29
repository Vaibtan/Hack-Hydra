# Memory and context retrieval: primary-source landscape and Palimpsest experiment agenda

**Research cut:** 2026-08-20  
**Scope:** conversational/agent memory, hybrid graph-and-text retrieval, temporal validity, routing and abstention, reranking, compression, scaling, and evaluation validity  
**Evidence policy:** primary sources only: project-owned code/docs, authors' papers, official benchmark repositories, and conference proceedings. Product-authored benchmarks are labelled as such and are not treated as independent validation.

## Evidence labels used here

- **Repository-observed** means the statement comes from Palimpsest's code or checked-in result artefacts at commit `bbfe01518f8474c24ed6d9cd88a63fb09374ddf1`.
- **Source-reported** means the cited authors or vendor report the result. It is not a reproduction by this review.
- **Proposed** means an experiment or design change for Palimpsest. It is not a measured improvement.

## Bottom line

1. **Palimpsest's source-of-truth choice is good, but no longer unique.** The code uses extracted claims only to locate evidence and gives the reader verbatim transcript spans. Supermemory's May 2026 product-authored report now describes essentially the same pattern: search over atomic contextual memories, then inject the original source chunk. It also reports relation types for update/extension/derivation and separate document/event dates. Raw-source grounding should remain a non-negotiable invariant, but it cannot carry the competitive pitch by itself.

2. **The next accuracy work belongs mostly after initial retrieval.** The current artefact reports 98.1% `SessionRecall@25` but only 79.6% answer accuracy, and preference accuracy is 45.5%. That is evidence that candidate-session recall is nearly saturated on this slice while evidence selection, evidence packing, premise handling, and reading remain weak. Increasing graph fan-out blindly is more likely to add noise than fix the dominant error.

3. **Fixed graph convergence is relevance, not sufficiency.** Google Research's ICLR 2025 work formalises this exact distinction: context can be relevant yet insufficient, and adding insufficient context can increase hallucination. A calibrated sufficiency decision offers a research-backed replacement for A1/A2 as the primary abstention mechanism. A1/A2 can remain useful, honest diagnostic states for empty or thin graphs.

4. **The strongest read architecture is a cascade, not a single retriever.** Keep the deterministic graph route, add a semantic/late-interaction route for vocabulary mismatch, fuse candidates, rerank against the question plus temporal state, and permit bounded second-hop reconstruction only for multi-session/count/update queries. This preserves a fast path for simple questions and spends computation only where the query or first-pass evidence justifies it.

5. **The current 60-question claim has an internal denominator error in the prose and no statistically established BM25 win.** The current JSON contains 54 answerable and 6 abstention questions, not 42 and 18. Palimpsest is correct on 43/54 answerable questions and BM25 on 41/54. Their paired discordances are 5 Palimpsest-only wins and 3 BM25-only wins; the two-sided exact McNemar p-value is 0.7265625. The observed +3.70 percentage points is two net questions and is compatible with chance.

6. **The receipt can earn its place, but the present receipt is a trace, not a proof.** Query text, parameters, anchors, convergence, and an evidence hash are valuable. They do not establish that the engine returned a complete, untruncated result set; identify the exact graph epoch/model versions; or explain which candidates were dropped by every stage. A product-grade receipt should make those boundaries explicit.

## What Palimpsest actually implements

The following is based on code, not the project write-up.

### Write path

- [`Extract.ts`](../packages/palimpsest/src/Extract.ts) asks an LLM to create claims, entities, attributes, keywords, event time, and a verbatim evidence quote from each session.
- [`ClaimGraph.ts`](../packages/palimpsest/src/ClaimGraph.ts) creates content-keyed `Claim`, `Entity`, `Slot`, and `Token` vertices. Claims point to transcript turns through `EVIDENCE`; token/entity/slot edges create the retrieval graph.
- [`Transcript.ts`](../packages/palimpsest/src/Transcript.ts) stores the verbatim turns. Long turns are chunked because of the engine's string-size limit.
- [`Supersede.ts`](../packages/palimpsest/src/Supersede.ts) asks an LLM to infer replacement relationships among claims sharing a slot.
- [`User.ts`](../packages/palimpsest/src/User.ts) stores denormalised counts and root edges on a per-user vertex so product reads avoid global label scans.

### Read path

- [`Anchors.ts`](../packages/palimpsest/src/Anchors.ts) always includes deterministic question stems and adds LLM-generated synonyms/hypernyms plus coarse flags for historical/count questions.
- [`Retrieve.ts`](../packages/palimpsest/src/Retrieve.ts) runs a bounded `Token -> Claim` or `Token -> Entity -> Claim` traversal. It then expands histories for slots filled by top candidates.
- [`Scoring.ts`](../packages/palimpsest/src/Scoring.ts) ranks by distinct-anchor convergence, summed token IDF, recency, and a deterministic key tie-break. The default candidate cap is 25 and the convergence threshold is effectively one or two anchors.
- Slot expansion adds up to 40 claims, assigns those added claims zero retrieval score, and orders the resulting current/superseded evidence rather than reranking it against the question.
- [`Reader.ts`](../packages/palimpsest/src/Reader.ts) hydrates each claim through its `EVIDENCE` edge, cuts a 300-character window around the claim span, and gives only those verbatim excerpts to the shared reader.

This is a legitimate implementation of “the graph is an index over verbatim transcript.” The most important leak to avoid in future work is answering from an abstractive memory, generated note, or graph property when the corresponding source span is unavailable. Derived representations should generate candidates or reading hints; the final answer and citations should remain grounded in immutable source bytes.

## The current result artefacts: research-relevant audit notes

### Denominator and paired comparison

**Repository-observed:** [`results/palimpsest-60.json`](../results/palimpsest-60.json) contains 54 answerable questions and 6 `_abs` questions. On the 54 answerable questions:

| paired outcome | questions |
|---|---:|
| both correct | 38 |
| Palimpsest correct, BM25 wrong | 5 |
| BM25 correct, Palimpsest wrong | 3 |
| both wrong | 8 |

Therefore:

- Palimpsest: 43/54 = **79.63%**.
- BM25: 41/54 = **75.93%**.
- Difference: **+3.70 percentage points**, or two net questions.
- Exact two-sided McNemar test over the eight discordant pairs: **p = 0.7265625**.

This does not show that the systems are equivalent. It shows that this slice does not establish that Palimpsest is more accurate. Marginal percentages are insufficient for paired systems; always publish the discordance table and a confidence interval or paired bootstrap distribution.

The prose statement “18 abstention / 42 answerable” must be corrected or its selection rule explained. Those counts do not describe the current 60-row JSON and are mathematically incompatible with 79.6% raw micro-accuracy: one item out of 42 is 2.38 percentage points.

### Fairness of the local comparison

**Repository-observed:** the comparison is reasonably controlled in three ways:

- [`Bm25.ts`](../packages/eval/src/Bm25.ts) and Palimpsest share the same deterministic `stems()` tokenizer for their literal lexical terms.
- [`Reader.ts`](../packages/palimpsest/src/Reader.ts) exposes `readSpans`, so Palimpsest, BM25, and full context use the same answer model and reader instructions.
- [`Judge.ts`](../packages/eval/src/Judge.ts) applies the same question-type-specific judge prompt to each system.

It is **not** an isolated graph-versus-BM25 comparison. [`Anchors.ts`](../packages/palimpsest/src/Anchors.ts) augments Palimpsest's literal stems with question-dependent LLM-generated synonyms and hypernyms; the BM25 baseline searches only the literal stems. The systems also select evidence by top-k rather than an identical retrieved-token budget. Those differences are legitimate parts of a whole-system comparison, but they prevent attributing any delta specifically to graph convergence. Add `BM25 + identical anchor expansion`, `graph + literal stems only`, and fixed-token-budget variants before claiming that the graph beats lexical retrieval.

It is not an exact upstream judge port. The official [LongMemEval evaluator](https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/src/evaluation/evaluate_qa.py) maps `gpt-4o` to the immutable `gpt-4o-2024-08-06` snapshot, sets temperature 0, caps output at 10 tokens, and labels with `'yes' in response.lower()`. Palimpsest asks the mutable `gpt-4o` alias and does not apply the 10-token cap. Caching stabilises this run after the fact; it does not make the first run equivalent to upstream or protect a future experiment from alias drift.

The official LongMemEval paper reports strong meta-evaluation agreement for its prompt-engineered GPT-4o judge, but that validates the authors' tested configuration, not every later alias or a two-question system difference ([ICLR 2025 paper and reviews](https://openreview.net/forum?id=wIonk5yTDq)).

### Evaluation leakage and judge risk

- LongMemEval has been public since 2024. It is plausible that a mid-2026 reader or judge has seen benchmark material. This review does not claim contamination, because it has not been tested. The primary-source literature shows that public-test contamination can be detected in some black-box models and can inflate benchmark estimates ([Oren et al., ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/46e624c244cff669223d488defd4e835-Abstract-Conference.html)).
- The official repository notes that the cleaned dataset was updated in September 2025 to prevent answer interference ([LongMemEval repository](https://github.com/xiaowu0162/LongMemEval)). Pin and record the dataset digest, not merely the split name.
- LLM judges can exhibit position, verbosity, self-preference, limited-reasoning, and style biases. These are measured properties, not hypothetical objections ([Zheng et al., NeurIPS 2023](https://proceedings.neurips.cc/paper_files/paper/2023/file/91f18a1287b398d378ef22505bf41832-Paper-Datasets_and_Benchmarks.pdf); [Feuer et al., ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/1eb36d07ebb13be16ddbda679a95018b-Abstract-Conference.html)).
- Palimpsest's answers are often longer than BM25's, especially on preference questions. A binary single-answer judge may therefore confound memory quality with answer style. A blinded human audit of every discordant pair is cheap at n=8 and more informative than another aggregate percentage.

## Product and research neighbours

### Supermemory: now the most important direct comparator

Supermemory's public repository describes a memory/context engine with automatic fact extraction, knowledge updates, forgetting, profiles, and hybrid retrieval ([official repository](https://github.com/supermemoryai/supermemory)). Its public API documents semantic or hybrid search, score thresholds, metadata filters, and direct memory creation with generated embeddings ([official API reference](https://github.com/supermemoryai/supermemory/blob/main/skills/supermemory/references/api-reference.md)).

More importantly, its May 2026 product-authored LongMemEval report says it:

- creates atomic contextual memories while retaining raw chunks;
- models `updates`, `extends`, and `derives` relations;
- separates `documentDate` from `eventDate`;
- performs semantic search over atomic memories and injects the source chunk for final reading;
- reports 95% overall on 500 LongMemEval-S questions with about 720 mean context tokens at Recall@15 with aggregation.

Source: [Supermemory LongMemEval report](https://supermemory.ai/research/longmembench/).

These are **source-reported**, product-owned measurements. The report uses GPT-4o for the primary 95% result, and its public table/protocol is not the same as Palimpsest's GPT-5.6-Luna run. The numbers are not directly comparable. However, the architectural overlap is unambiguous and invalidates any pitch that “derived index plus original text” is unique to Palimpsest.

The public Supermemory sources reviewed here do not document a point-in-time/as-of query, an engine-replay receipt, or a completeness certificate. That is a public-contract observation, not a claim about private internals. Palimpsest can differentiate on those guarantees if it makes them real and measurable.

### Memory Store: a distribution/UX comparator, not a technical benchmark

Memory Store's public guide documents MCP-based `Checkin`, `Record`, and `Recall`, cross-application memory, active threads/entities, and semantic search ([official user guide](https://memory.store/guides/memory-store-user-guide)). The public material reviewed does not specify its storage architecture, temporal conflict semantics, retrieval algorithm, benchmark protocol, or provenance guarantees. Treat it as evidence of a desired product surface—shared memory across tools—not as a technical baseline until a reproducible API/evaluation contract exists.

### Zep / Graphiti

The Zep paper describes Graphiti as a temporal knowledge graph combining conversational and structured business data. It reports 94.8% on DMR versus 93.4% for MemGPT, and up to 18.5% accuracy improvement plus 90% lower latency against its stated LongMemEval baselines ([Rasmussen et al., 2025](https://arxiv.org/abs/2501.13956)). These are author-reported measurements.

The transferable design is bitemporal validity: distinguish when the system learned a fact from when the fact was valid in the world. Palimpsest currently carries `session_ord`, `session_date`, and extracted `t_event`, but its public as-of operation filters by session order. That is recorded-time travel, not a complete bitemporal query model.

### Mem0

Mem0 extracts and consolidates salient conversational memories and includes a graph variant. Its paper reports a 26% relative LLM-judge improvement over OpenAI's memory baseline, about 2% additional overall score from graph memory, 91% lower p95 latency, and more than 90% token savings versus full context on its LOCOMO setup ([Chhikara et al., 2025](https://arxiv.org/abs/2504.19413)). These are author-reported and not a Palimpsest head-to-head.

Mem0 is evidence that memory consolidation can be fast and product-shaped. It is not evidence that rewriting source memories is acceptable for Palimpsest's auditability goal. A useful synthesis is to consolidate only derived indexes and retain immutable evidence plus lineage.

### HydraDB itself

HydraDB's own report describes a sliding-window enrichment pipeline and a Git-style versioned temporal graph, evaluated over 500 LongMemEval-S stacks ([HydraDB paper](https://research.hydradb.com/hydradb.pdf)). Current official docs describe metadata filtering, hybrid retrieval, graph traversal, and personalised ranking as stages of the managed service ([HydraDB memory documentation](https://docs.hydradb.com/essentials/memories)).

Palimpsest is using the local graph engine as a lower-level substrate and implements its own extraction, lexical graph, ranking, temporal labels, and reader. The submission must distinguish “implemented by Palimpsest” from “available in HydraDB's managed memory product.” Otherwise the product contribution is impossible to evaluate.

## Primary-source ideas worth testing

### 1. Hybrid candidate generation, while preserving verbatim evidence

**Problem in Palimpsest:** the join in the middle is lexical. LLM key expansion helps, but a vocabulary mismatch surviving both write-time keywords and read-time synonyms is a hard miss. Increasing LLM-generated keywords also raises graph degree and makes accidental convergence more likely.

Relevant findings:

- LongMemEval reports that fact-augmented multi-key indexing improved recall@k by 4 points and downstream accuracy by 5 points, and time-aware query expansion improved temporal recall by 7–11 points ([Wu et al., ICLR 2025](https://arxiv.org/abs/2410.10813)).
- Anthropic's product research reports that contextual embeddings plus contextual BM25 reduced top-20 retrieval failure from 5.7% to 2.9%, and adding a reranker reduced it to 1.9% across its test domains ([Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)). These are vendor-reported results, not LongMemEval results.
- BGE-M3 supports dense, sparse, and multi-vector retrieval in one model across more than 100 languages and up to 8192 tokens ([Chen et al., Findings of ACL 2024](https://aclanthology.org/2024.findings-acl.137/)).
- ColBERTv2 uses token-level late interaction and residual compression, reporting a 6–10x storage reduction over earlier late-interaction representations while preserving strong retrieval quality ([Santhanam et al., NAACL 2022](https://aclanthology.org/2022.naacl-main.272/)). PLAID reports tens to hundreds of milliseconds at large passage scales and up to 7x GPU / 45x CPU speedups over vanilla ColBERTv2 in its evaluated settings ([PLAID paper](https://arxiv.org/abs/2205.09707)).
- A June 2026 preprint tests training-free BM25 plus late-interaction fusion specifically for conversational memory. It reports large Hit@1 gains on LoCoMo, but only a 0.67-point, non-significant gain over BM25 on the high-lexical-overlap LongMemEval-S setting; an off-the-shelf web cross-encoder also hurt one configuration ([Training-Free Lexical-Dense Fusion](https://arxiv.org/abs/2606.04194)). This is source-reported and not yet peer reviewed, but its negative result is directly relevant: fusion and reranking must be validated on Palimpsest's target distribution rather than assumed to help.

**Proposed Palimpsest experiment:** add a sidecar semantic candidate index keyed by immutable `ckey`/span id. Union its top candidates with current graph candidates, record the origin and score of every candidate, then apply reciprocal-rank fusion or a small learned ranker. HydraDB remains the authoritative graph and transcript store; the semantic index is a rebuildable projection. Never give the reader embedding text that cannot be traced to a source span.

Start with an offline ablation over the existing graph and cached benchmark. Compare:

1. graph convergence only;
2. semantic only;
3. graph + BM25;
4. graph + semantic;
5. graph + BM25 + semantic;
6. each union with and without reranking.

Measure answer-session recall, evidence precision, answer accuracy, context tokens, and stage latency at fixed budgets. Do not change extraction prompts for this experiment; that would create a new claim generation and confound the comparison.

### 2. Rerank for answer utility, not merely graph convergence

**Problem in Palimpsest:** all claims crossing one fixed convergence threshold are ranked mostly by anchor count and IDF. Slot mates receive zero score but may consume up to 40 evidence positions. Relevance to terms does not capture whether a claim resolves the question's entity, time, premise, or required composition.

Relevant findings:

- RankRAG jointly trains a model for context ranking and answer generation and reports gains over expert rankers and GPT-4 baselines on its tested RAG benchmarks ([Yu et al., NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/db93ccb6cf392f352570dd5af0a223d3-Paper-Conference.pdf)).
- Recent IR work argues that passages should be ranked by their marginal utility to the downstream generator rather than relevance alone ([Beyond Relevance, 2026](https://arxiv.org/abs/2604.08920)). This is a framework paper, not proof of a Palimpsest gain.

**Proposed Palimpsest experiment:** rerank a bounded union (for example 50–100 claims) using features available without transcript leakage: question, claim index text, entity/slot, current/superseded state, event and record time, graph convergence, lexical score, semantic score, and source role. Only after selection should the system hydrate verbatim spans. Train or calibrate on a development split; never use test labels or question IDs in ranking logic.

For slot histories, rank the history as a group and allocate a group budget. A fixed `MAX_SLOT_EXPANSION=40` makes one noisy slot capable of displacing unrelated but necessary multi-session evidence.

### 3. Route across granularity and retrieval depth

**Problem in Palimpsest:** every question gets the same fixed claim granularity, top-25 convergence cut, and slot expansion shape. A name lookup, a preference synthesis, a count, and a multi-session causal question do not have the same information need.

Relevant findings:

- LongMemEval found round-level values stronger than whole sessions for reading, while compressing all the way to facts can lose detail; even with oracle retrieval, reading strategy caused up to a 10-point absolute difference ([Wu et al.](https://arxiv.org/abs/2410.10813)).
- MemGAS builds multiple memory granularities and uses an entropy-based router plus LLM filtering. Its ICLR 2026 paper reports gains across four memory benchmarks and different top-k settings ([Xu et al., ICLR 2026](https://openreview.net/forum?id=i2yIvZARnG)).
- HippoRAG 2 combines deeper passage integration with personalised PageRank and reports a 7% gain on associative-memory tasks over its stated state-of-the-art embedding baseline while retaining factual and sense-making performance ([Gutiérrez et al., 2025](https://arxiv.org/abs/2502.14802)).
- AssoMem retains utterance-level memories, adds derived clue/topic nodes, and fuses relevance, importance, and temporal alignment through personalised PageRank. Its ICLR 2026 paper reports 80.87% R@6, 64.01% answer accuracy, 1,846 generation tokens/query, 1.30-second mean latency, and 0.01-second incremental update per node on its LongMemEval-M configuration ([AssoMem, ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/file/a921f335253add9996d5175ad30896ec-Paper-Conference.pdf)). These are author-reported, and the compared systems/configurations must not be transplanted as Palimpsest expectations.
- MRAgent represents memory as a cue-tag-content graph and performs bounded iterative exploration/pruning based on intermediate evidence; its ICML 2026 paper reports up to 23% improvements over its tested baselines with lower token/runtime cost ([Ji et al., ICML 2026](https://openreview.net/pdf?id=xRVWftS3ES)).
- Adaptive-RAG trains a small classifier to route questions among no-retrieval, one-step, and multi-step strategies based on predicted complexity ([Jeong et al., NAACL 2024](https://aclanthology.org/2024.naacl-long.389/)).
- GraphRAG-Bench begins from a useful negative result: graph retrieval can underperform vanilla RAG, so graph use should be justified by query structure rather than applied unconditionally ([When to Use Graphs in RAG, ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/hash/6c9e01d6cefbbf4cdd265032550e767f-Abstract-Conference.html)).

**Proposed Palimpsest experiment:** retain three evidence granularities with the same immutable lineage:

- claim span for precise facts;
- whole turn/round for ambiguous references and preferences;
- session or slot-history group for multi-session synthesis and updates.

Use a cheap router from deterministic features first: number/count language, explicit date range, update/history cue, number of entities, and first-pass score entropy. Route simple questions to one pass; route uncertain, count, preference, temporal, and multi-session questions to one bounded reconstruction pass. The router's decision and budget belong in the receipt.

### 4. Replace “structural abstention” with calibrated evidence sufficiency

**Problem in Palimpsest:** on a populated graph, broad lexical overlap almost guarantees that something reaches a claim. A1/A2 measure graph reachability, not whether the returned evidence entails the answer or satisfies the question's presuppositions.

Google Research defines context as sufficient only when it contains all information required for a definitive answer. Its ICLR 2025 study reports at least 93% agreement between its best prompted sufficiency autorater and 115 human-labelled query-context pairs; it also reports that adding insufficient context can sharply increase hallucination. Combining a sufficiency signal with self-confidence improved the selective accuracy/coverage trade-off by up to 10 points in some tested settings ([Joren et al. / Google Research](https://research.google/blog/deeper-insights-into-retrieval-augmented-generation-the-role-of-sufficient-context/)). These figures are not LongMemEval results.

**Proposed Palimpsest experiment:** separate four states:

1. `NO_CANDIDATES` — current A1/A2 diagnostic;
2. `INSUFFICIENT_EVIDENCE` — candidates are relevant but do not jointly answer;
3. `CONTRADICTED_PREMISE` — a named presupposition conflicts with current evidence;
4. `ANSWERED` — evidence is sufficient and the answer is source-supported.

Do not implement this as one stricter reader instruction; the existing premise A/B already shows that prompt-only strictness raises false abstention. Instead:

- extract explicit premises from the question;
- retrieve evidence for the answer and for each premise;
- score support/contradiction/unknown per premise;
- combine sufficiency, candidate-margin, contradiction, retrieval entropy, and reader confidence in a calibrated model;
- choose a threshold against a declared coverage or false-answer target on held-out data.

Report a risk-coverage curve and area under that curve, not one “abstention accuracy” point. Keep A1/A2 in the receipt as causal diagnostics, not as the main product claim.

LongMemEval-V2 makes this a direct product test: it includes “premise awareness” as one of five abilities and withholds question IDs/types/gold answers from memory backends at query time ([official LongMemEval-V2 repository](https://github.com/xiaowu0162/LongMemEval-V2)).

### 5. Improve reading before compressing evidence aggressively

**Problem in Palimpsest:** answer-session recall is high but answer accuracy is materially lower. This indicates that the reader often fails to select or compose the right facts from retrieved evidence.

Relevant findings:

- LongMemEval reports that Chain-of-Note plus structured formatting improves reader performance, and that a poor reading strategy can cost up to ten points even under oracle retrieval ([LongMemEval paper](https://arxiv.org/abs/2410.10813)).
- Chain-of-Note asks the reader to write a relevance/reliability note per retrieved item before answering, targeting noisy and irrelevant retrieval ([Yu et al., 2023](https://arxiv.org/abs/2311.09210)).
- RECOMP trains extractive or abstractive compressors for downstream utility and can emit an empty string for irrelevant retrieval; it reports compression to 6% with minimal loss on its tested language modelling/open-domain QA tasks ([Xu et al., ICLR 2024](https://openreview.net/pdf?id=mlJLVigNHp)).
- LLMLingua-2 formulates compression as extractive token classification and reports 1.6–2.9x end-to-end speedups at 2–5x compression in its tested tasks ([Pan et al., Findings of ACL 2024](https://aclanthology.org/2024.findings-acl.57/)).

**Proposed Palimpsest experiment:** first test a structured evidence table and a short note per span containing `relevant`, `supports`, `contradicts`, `time_relation`, and `premise_id`. The note is a reading aid, not evidence; every field must link to the verbatim span. Compare against the current prompt with identical spans and model.

Only then test extractive compression, and only above a token budget. Preserve original character offsets and an “expand to source” link. Avoid abstractive compression in the evidence plane because it weakens the very auditability Palimpsest is trying to sell.

### 6. Make memory freshness a first-class latency metric

**Problem in Palimpsest:** query-time latency is measured, but the user also experiences the delay from posting a session until it is safely searchable. Current extraction and supersession are LLM-dependent, and high ingest concurrency contributed to node failures.

Relevant findings:

- LightMem separates lightweight online filtering from offline “sleep-time” consolidation and reports up to 10.9% accuracy gains, 117x fewer tokens, 159x fewer API calls, and over 12x runtime reduction versus its tested baselines ([Fang et al., 2025](https://arxiv.org/abs/2510.18866)). These are author-reported and configuration-specific.
- MemForest parallelises independent extraction and refreshes only dirty paths in hierarchical temporal indexes. It reports 81.8% LongMemEval-S pass@1 with Qwen3-30B and a 6x input-normalised build rate over EverMemOS in its setup ([Chen et al., 2026](https://arxiv.org/abs/2605.23986)).

**Proposed Palimpsest design:** split ingestion readiness:

- `SOURCE_DURABLE`: transcript committed and retrievable lexically immediately;
- `INDEXED`: deterministic tokens/entities written;
- `ENRICHED`: claims/event time extracted;
- `CONSOLIDATED`: supersession and higher-level structures complete.

Reads should declare which level they require and receipts should state the memory completeness watermark. Parallelise independent extraction, but serialize/transactionally protect per-user manifest and supersession updates. Background consolidation must never make the raw session temporarily invisible.

## Temporal model: the meaningful product opportunity

Palimpsest's strongest product direction is not “we have a graph”; it is **source-grounded bitemporal memory with inspectable reconstruction**.

### Required time coordinates

- **Recorded time:** when the system learned or committed the statement. `session_ord` approximates this today.
- **Valid/event time:** when the statement was true in the user's world. `t_event` approximates one point, but uncertain dates and intervals need explicit representation.
- **Supersession effective time:** when a newer claim started replacing an older one.
- **Question perspective:** “as known by session 12” is different from “what was true in March.”

A robust derived claim should carry closed-open valid and transaction intervals plus precision/uncertainty. The immutable transcript remains the authority; intervals are revisable derived assertions with lineage. This follows the bitemporal principle described by Zep/Graphiti and a recent graph-native bitemporal memory design, which represents immutable memory identities linked to versioned content with valid-time and transaction-time intervals ([Niksarli and Baheti, 2026](https://arxiv.org/abs/2607.26520)).

Two further peer-reviewed results suggest how to operationalise temporal reasoning rather than merely store timestamps:

- Memory-T1 uses coarse temporal/relevance pruning followed by learned evidence selection and reports 67.0% on Time-Dialog, 10.2 points above its stated larger baseline; its ablation attributes 15 points to evidence-grounding and temporal-consistency rewards ([Memory-T1, ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/file/6010a57158b77359f5f531d9af69181c-Paper-Conference.pdf)).
- TReMu builds dated timeline summaries and delegates temporal arithmetic to generated symbolic code, reporting a 29.83 to 77.67 increase on its temporal benchmark ([TReMu, Findings of ACL 2025](https://aclanthology.org/2025.findings-acl.972/)).

These results are not evidence that Palimpsest should copy either model. They support two narrower experiments: time-filter before expensive graph expansion, and make date arithmetic a typed/tool operation rather than burying it in free-form reader reasoning.

### Proposed temporal evaluations

- current truth after one and multiple corrections;
- valid-time question before/after an event;
- recorded-time question before/after the system learned a correction;
- late-arriving fact whose event time predates its record time;
- uncertain month/year versus exact day;
- simultaneous conflicting sources;
- deletion/revocation and “what did the system know before deletion?” policy;
- as-of retrieval under a populated future graph, with proof that future candidates did not consume retrieval budget.

The last item matters because filtering paths after traversal can preserve semantic correctness on small stores while wasting work and candidate budget at scale. Prefer time-scoped candidate generation or a time-indexed projection over post-filter-only designs.

## Scaling beyond the 60-user run

The papers above do not validate Palimpsest's scale. The following are **proposed engineering requirements**, grounded in the observed implementation and failures.

### User vertex and derived counts

The `User` vertex removes catastrophic global scans, but it introduces a per-user manifest with read-modify-write updates. At concurrent ingest, two writers can read the same old count and each overwrite the other's increment. A retry after partial graph success can also make counters disagree with reachable vertices. Token `df` and slot `n_claims` are likewise derived values.

Treat these as rebuildable projections, not truth:

- append an idempotent ingest-commit record keyed by session digest;
- update counters with atomic increments or compare-and-swap against a manifest version;
- record the source session digest and delta behind every counter update;
- run a scoped reconciliation check from `User` roots, never a global label scan;
- fail reads closed or mark the receipt `stats_consistency=unknown` when manifest version and graph watermark disagree;
- test concurrent ingest of the same and different sessions for one user.

### Store partitioning and lifecycle

- One shared graph with UID-prefixed keys is logical isolation, not an access-control boundary. Production needs tenant/database isolation or an enforced authorization filter below every query.
- Append-only claim generations need a lifecycle plan: active generation pointer, immutable old generations, background compaction/export, and a documented erasure policy. “Use a new prefix forever” is a benchmark workaround, not a product retention policy.
- Store-size tests must vary total unrelated users while holding one target user's history fixed. That exposes hidden global scans and cache effects that a per-user history-growth test misses.
- Separate cold, warm, and post-write reads. A median that mixes them is not an actionable SLO.
- Test hard caps explicitly: path count, pagination, query timeout, candidate admission, response bytes, outstanding writes, and disk/page-cache pressure. Every cap needs a receipt flag showing whether it affected completeness.

## What a receipt must contain to be a product, not decorative logging

The current receipt is useful because it contains the rendered traversal, parameters, anchor outcomes, convergence, and evidence hash. To substantiate “proof of what was searched,” add:

- tenant/user scope and authorization decision;
- graph/database ID, commit/bookmark/epoch, and per-user manifest version;
- transcript/index/extraction generation IDs and prompt/model/schema hashes;
- raw query plus deterministic and LLM-expanded query terms;
- retrieval plan and why the router chose it;
- all candidate sources, scores, and fusion/reranking decisions;
- valid-time and recorded-time cuts;
- candidate/path/page limits, deadlines, and whether each stage completed exhaustively;
- selected evidence span IDs plus immutable source hashes;
- excluded candidates and a compact reason code;
- sufficiency/premise decision, threshold, calibration version, and coverage target;
- per-stage latency, tokens, cache state, and degraded-mode flags;
- final answer citations and a post-generation support check.

Without a graph epoch and completeness/cap status, re-running the printed query later may produce different paths, and an empty result cannot prove absence. The honest phrase for the current artefact is **replayable decision trace against a fixed graph**, not proof of global non-existence.

## Evaluation programme that can support a product claim

### Freeze the protocol

- Pin dataset file SHA-256, reader snapshot, judge snapshot, prompts, tokenizer, extraction generation, graph generation, and code commit.
- Match upstream exactly for the official score: `gpt-4o-2024-08-06`, temperature 0, `max_tokens=10`, and the official parser. Run improved judges as secondary analyses, not silent replacements.
- Keep question ID/type/gold answer inaccessible to retrieval code. LongMemEval-V2 explicitly enforces this boundary.
- Publish per-question outputs and candidate/evidence IDs, not just tables.
- Predeclare primary endpoint and subgroup analyses before a final run.

### Use paired uncertainty

- For binary answer correctness, report paired discordances and exact McNemar p-values against each baseline.
- Add paired bootstrap confidence intervals for accuracy difference and token/latency trade-offs.
- Audit every discordant answer blind to system identity with at least two humans and adjudicate disagreements.
- Rejudge with a second model family and compare labels; do not average silently when judges disagree.
- The NLP significance-testing literature recommends selecting tests based on the data and experimental design rather than applying an arbitrary default ([Dror et al., ACL 2018](https://aclanthology.org/P18-1128/)).

### Expand beyond one benchmark

1. **LongMemEval-S, all 500:** closes the present sample-size and category-balance gap.
2. **LongMemEval-M:** stresses roughly 500 sessions/history rather than the S split's roughly 40–80.
3. **LongMemEval-V2:** 451 manually curated questions, up to 500 multimodal trajectories and 115M tokens, premise awareness, fixed reader in the public protocol, and accuracy plus query latency ([official repository](https://github.com/xiaowu0162/LongMemEval-V2)).
4. **MemoryAgentBench:** 2,071 questions and histories from about 103k to 1.44M tokens, adding test-time learning, long-range understanding, and selective forgetting beyond static QA recall ([official ICLR 2026 paper](https://proceedings.iclr.cc/paper_files/paper/2026/file/fd1eff9dd295df50a41f2521942fa31d-Paper-Conference.pdf)).
5. **Private rolling holdout:** new users, paraphrased questions, late corrections, and false premises created after the tested models' release dates.
6. **Adversarial temporal/concurrency suite:** the bitemporal and manifest-race cases listed above.
7. **Product traces:** opt-in, de-identified real workloads with user-rated usefulness, correction rate, citation opening, and regret after wrong recall.

### Metrics

| Axis | Minimum metrics |
|---|---|
| Answer quality | exact/human correctness; official judge; per-type paired differences |
| Retrieval | answer-session Recall@k, span Recall@k, MRR/nDCG, evidence precision, oracle-reader accuracy |
| Grounding | citation precision/recall, unsupported-answer rate, source-span coverage |
| Abstention | selective accuracy, coverage, false-answer rate, false abstention, risk-coverage curve/AURC |
| Temporal | current, valid-time, recorded-time, update, late-arrival, contradiction accuracy |
| Efficiency | retrieval and end-to-end p50/p95/p99; cold/warm/post-write; input/output tokens; API calls; cost |
| Freshness | source-durable, indexed, enriched, consolidated latency |
| Scale/reliability | ingest throughput, failure/retry rate, counter-drift incidents, recovery time, memory/disk growth |
| Product trust | citation-open rate, correction rate, deletion SLA, receipt replay success |

Do not collapse these into one score. Accuracy, latency, token cost, coverage, and freshness are a Pareto frontier, not interchangeable units.

## Prioritised experiments

### P0 — no new extraction spend

1. Correct the 60-row denominator in docs and regenerate all summaries from JSON.
2. Run the exact upstream judge snapshot/cap over cached system answers; compare labels with the current cached alias judge.
3. Publish the 5-versus-3 discordant-pair audit and exact McNemar result.
4. Split latency into anchor generation, user-stat read, graph traversal(s), hydration, reader, and judge; report cold/warm/post-write distributions.
5. Build oracle-reader experiments: answer-bearing session only, current retrieved evidence, reranked evidence, and full context. This locates the remaining loss between retrieval and reading.

### P1 — highest expected accuracy return

1. Add a bounded cross-encoder or LLM reranker over current graph candidates; no new write generation.
2. Test structured Chain-of-Note-style span assessment with identical evidence.
3. Group and budget slot histories rather than appending 40 zero-score claims.
4. Add a semantic/late-interaction sidecar candidate arm and fusion; preserve exact span lineage.
5. Introduce adaptive granularity and one bounded second-pass retrieval for preference, count, temporal, and multi-session questions.

### P2 — honest abstention

1. Label evidence sufficiency and premise support on a development set, including current false-premise failures.
2. Fit and calibrate a cheap selective classifier from receipt features plus sufficiency/premise scores.
3. Select thresholds against explicit false-answer and coverage targets.
4. Validate on held-out LongMemEval and newly authored private false premises.

### P3 — scale and product credibility

1. Replace per-user counter read-modify-write with atomic/versioned manifest commits and add reconciliation.
2. Add completeness watermarks and cap/deadline flags to receipts.
3. Run a scale matrix over target-history size and unrelated-user/store size, with cold/warm/post-write conditions.
4. Implement dual valid/record time and test late-arriving corrections.
5. Run LongMemEval-V2 and a private rolling holdout.

## Recommended product claim after the current evidence

Avoid:

> Palimpsest improves answer accuracy over BM25 and provides structural abstention.

The current sample does not establish the accuracy win, and populated-graph A1/A2 do not deliver the abstention pitch.

A defensible current claim is narrower:

> Palimpsest uses HydraDB as a deterministic graph index into immutable transcript evidence, supports recorded-time replay over an append-only supersession history, and exposes the retrieval trace behind each answer. On the current 60-question partial LongMemEval-S run, it retained near-full answer-session recall with roughly 1/30 of full-context reader tokens, but did not significantly outperform the same-reader BM25 baseline and remains materially slower.

A meaningful future product claim—if the proposed evaluations support it—is:

> Palimpsest is a source-grounded, bitemporal context layer that reconstructs only sufficient evidence, knows when that evidence is incomplete, and produces a completeness-aware receipt that can replay every retrieval and citation against a declared memory version.

That claim is harder than “memory with a graph,” but it is also more useful and more defensible.
