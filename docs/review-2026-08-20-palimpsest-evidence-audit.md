# Palimpsest evidence audit

**Audit cut:** 2026-08-20  
**Application commit:** `bbfe01518f8474c24ed6d9cd88a63fb09374ddf1`  
**HydraDB submodule:** `6a2fbb192f37f51a93690a2ae2d2f5e27e6e4219` (`v0.1.1-2-g6a2fbb1`)  
**Runtime observed:** container image `ghcr.io/hydra-db/hydradb:latest`, reporting HydraDB `0.1.0`  
**Dataset:** `data/longmemeval_s_cleaned.json`, 277,383,467 bytes, SHA-256 `D6F21EA9D60A0D56F34A05B609C79C88A451D2AE03597821EA3D5A9678C3A442`

This review treats code, result JSON, cached replay, runtime behaviour, and primary sources as evidence. Project prose is treated as a claim to verify, not as evidence about the implementation that produced it.

## Executive verdict

Palimpsest is a serious and unusually well-instrumented prototype. Its answer path really does use the graph to locate verbatim transcript spans, it found and worked around several HydraDB engine limits, and it reduces median reader input from 111,057 to 3,658 tokens on the current partial run. Those are meaningful engineering results.

It has not yet demonstrated a better memory system than BM25, Supermemory, or other product comparators:

- The reported Palimpsest-versus-BM25 difference is **43/54 versus 41/54**, or two net questions. The paired exact McNemar test is **p = 0.7265625**; an approximate paired 95% interval for the +3.70-point difference is **−6.61 to +14.02 points**. This run does not establish an accuracy improvement.
- The prose says 42 answerable and 18 abstention questions, but every committed 60-row JSON contains **54 answerable and 6 abstention** questions. The table percentages are calculated over the JSON, not the prose denominator.
- The intended 100-question slice contains all 30 abstention questions. `--skip-missing` kept the 60 users whose ingest happened to finish before the node failed, leaving only six abstention questions. This is a completion-conditioned partial result, not the predeclared stratified sample.
- A1/A2 structural abstention fired zero times. It tests lexical graph reachability, not evidence sufficiency or premise truth. The original differentiating hypothesis failed on the populated graph.
- The receipt is useful observability, but it is not “proof of what was searched”: it lacks a graph epoch/generation, completeness and truncation flags, source-span hashes, index/model versions, and an integrity mechanism. The HTTP form even omits Query 1 parameters.
- `ingestSession` is not atomic. It writes the Session before claims, counts, supersession, and User stats, then treats Session existence as the retry commit marker. Any later failure becomes a permanent partial ingest because the retry returns `alreadyPresent` without repair.
- At 60 users the current node uses about **5.50 GiB of 7.76 GiB**, has already failed twice during ingest, and now reproduces a third write outage: reads pass but all writes fail because the local SlateDB store needs an unimplemented `PutMode::Update`. A 500-user run on this runtime is not responsible yet.

The right product direction is narrower and stronger than “memory with a graph”: **source-grounded bitemporal context reconstruction, calibrated evidence sufficiency, and a completeness-aware receipt tied to an immutable memory version**.

## Findings by severity

| Severity | Finding | Consequence |
|---|---|---|
| P0 | Session existence is used as a commit marker before the ingest is complete | A transient extraction, graph, supersession, or final-stats failure can permanently mark incomplete data as already ingested |
| P0 | All writes currently fail after restart on the persisted local store | The present Docker volume is read-only in practice; another ingest should not be started |
| P0 | User, Token, and Slot counts use unversioned read-modify-write | Concurrent sessions can reuse ordinals, lose increments, double count, or silently disagree with reachable graph state |
| P1 | Evaluation prose has the wrong denominator and the 60 are completion-selected | The headline is not a result on the stated 42/18 or planned 70/30 population |
| P1 | Judge is not an exact upstream port | Local paired comparisons share a judge, but the score is not an official-protocol reproduction |
| P1 | Receipt is called proof without snapshot/completeness/integrity | It can replay a decision under assumptions; it cannot prove exhaustive search or absence |
| P1 | No authentication or tenancy enforcement below caller-controlled `uid` | One user can read or write another user's memory; one hash collision can merge tenant data |
| P1 | Runtime is an unpinned `latest` image and differs from the vendored source version | Code review and runtime behaviour are not tied to the same HydraDB build |
| P2 | Raw Cypher/MSPaths representation escapes `packages/hydra` | The adapter is a good client seam but not a deep domain module |
| P2 | Generated Claim text is exposed by CLI and slot API/demo | “The answer reader uses only transcript” is true; “the derived graph never reaches the UI” is false |
| P2 | 53-bit content hashes have no collision check | At a linear 500-user estimate of 4.78M vertices, vertex collision probability is about 0.127%—roughly 1 in 790 stores |

## 1. Architecture

### 1.1 Is the graph consistently an index over verbatim transcript?

**For final answer generation: yes. For the whole product surface and lifecycle: no.**

The core read path carries the invariant well:

1. Claim vertices retain derived text and source offsets.
2. Each Claim gets an `EVIDENCE` edge to its Turn with `cs`/`ce` offsets ([`ClaimGraph.ts` lines 144–168 and 224–232](../packages/palimpsest/src/ClaimGraph.ts)).
3. `Reader.hydrate` walks `Claim -> EVIDENCE -> Turn`, reconstructs overflow chunks, and cuts the excerpt from Turn text ([`Reader.ts` lines 183–269](../packages/palimpsest/src/Reader.ts)).
4. `readSpans` gives the model only those hydrated excerpts ([`Reader.ts` lines 272–369](../packages/palimpsest/src/Reader.ts)). It does not pass `Claim.text` into the answer prompt.

That is the most important positive architectural result in this audit. Derived claims are candidate-generation metadata; source text is the evidence plane.

There are three leaks or lifecycle failures around that invariant:

- The `ask` CLI labels generated `claim.text` as `EVIDENCE` ([`ask.ts` line 103](../packages/palimpsest/bin/ask.ts)), and the slot-chain API returns it directly ([`Handlers.ts` lines 191–211](../packages/server/src/Handlers.ts)); the demo renders it as a claim. Those views are useful debugging views, but they must be labelled **derived index assertion**, not evidence.
- Transcript writes are `MERGE ... SET`, not immutable inserts. A whole-user re-ingest can overwrite Turn text for the same key ([`Transcript.ts` lines 80–115](../packages/palimpsest/src/Transcript.ts)) while old Claim vertices and offsets remain. A changed source under an existing session key can therefore make a Claim point at the wrong bytes.
- The claim identity includes generated claim text and span. A prompt/model change can create a second claim generation while old vertices and edges remain. The code comment says reruns after a prompt change need no reset ([`ClaimGraph.ts` lines 11–17](../packages/palimpsest/src/ClaimGraph.ts)); the README correctly admits that this makes counts disagree and requires a fresh prefix. There is no active-generation pointer or graph-level enforcement preventing mixed generations.

The production invariant should be stronger and testable:

> A committed source revision is immutable and content-hashed. Every derived vertex names its source revision, extraction generation, and exact span hash. Readers reject derived nodes whose lineage does not resolve to the selected source revision.

### 1.2 Is `packages/hydra` a deep module?

**It is a competent HydraDB client, not yet a deep Palimpsest storage module.**

It successfully hides several difficult engine details: authentication, typed response decoding, one UUID per write statement, one-megabyte body chunking, 1,024-row cursor exhaustion, content-key hashing, bookmark threading, and MSPaths syntax generation ([`Client.ts` lines 204–327](../packages/hydra/src/Client.ts)). Those are real benefits behind a small operational surface.

The abstraction leaks in both API and callers:

- The public package exports `renderMsPathsQuery`, `MsPathsConfig`, `RenderedQuery`, raw `QueryResult`, paths, rows, and scalar cells ([`packages/hydra/src/index.ts`](../packages/hydra/src/index.ts)).
- `HydraClient.query(cypher, parameters)` is public ([`Client.ts` lines 330–335](../packages/hydra/src/Client.ts)).
- Palimpsest removal paths and eval maintenance scripts write raw Cypher and depend on the engine's scan semantics ([`ClaimGraph.ts` lines 493–509](../packages/palimpsest/src/ClaimGraph.ts), [`Transcript.ts` lines 242–257](../packages/palimpsest/src/Transcript.ts), [`backfill-user.ts`](../packages/eval/bin/backfill-user.ts)).
- Core retrieval imports `renderMsPathsQuery` so the storage-language query can be put into a receipt ([`Retrieve.ts` lines 147–185](../packages/palimpsest/src/Retrieve.ts)). This is understandable, but it couples the product receipt schema to one engine/query syntax.

A deeper boundary would expose domain operations such as `commitSession`, `findCandidateClaims`, `expandSlotHistories`, `hydrateSourceSpans`, `readManifest(version)`, and `reconcileManifest`, plus an opaque execution-plan representation. A Hydra-specific adapter can render that plan as Cypher for diagnostics. Raw query access can remain in a separate admin/testing package, not the application dependency.

### 1.3 Is User-vertex denormalisation sound?

**The decision is sound; the update protocol is not.**

The User root avoids proven store-wide scans. `readUserVertices` starts an indexed MSPaths walk from one User key ([`User.ts` lines 190–210](../packages/palimpsest/src/User.ts)), and materialised counts replace label scans that already took seconds ([`User.ts` lines 5–26](../packages/palimpsest/src/User.ts)). Given this HydraDB subset, that is a sensible projection.

The projection currently behaves as truth without the machinery required to keep it true:

#### Permanent partial commit

`ingestSession` does the following:

1. reads User stats;
2. returns early if the Session exists;
3. assigns `sessionOrd = before.sessions + 1`;
4. writes Session/Turns;
5. calls extraction;
6. writes claims/edges;
7. reads and overwrites Token/Slot counts;
8. computes supersession;
9. overwrites User stats last.

The decisive lines are the existence guard at [`Ingest.ts` 206–227](../packages/palimpsest/src/Ingest.ts), the early transcript write at lines 229–240, and the final User write at lines 294–306. If any step after line 230 fails, retry sees the Session and returns `alreadyPresent`. Missing Turns, Claims, counts, supersession edges, or User stats are never repaired. The current live write outage makes this a demonstrated risk, not a theoretical one.

#### Concurrent lost updates and duplicate ordinals

Two sessions for one user can both read the same `before` value, both receive the same `sessionOrd`, both read the same Token/Slot counts, and then overwrite one another's increments. Two concurrent posts of the same session can both pass the existence check before either Session write is visible. There is no per-user serialization, compare-and-swap version, transaction, uniqueness check on ordinal, or idempotent delta ledger.

`User.bumpUserStats` documents and implements the same unguarded read-modify-write shape ([`User.ts` lines 135–160](../packages/palimpsest/src/User.ts)), although `ingestSession` constructs the overwrite inline.

#### Canon bridge drift

Reconciliation allows an incoming alias to union entity components and gives an existing canon precedence ([`Canon.ts` lines 83–165](../packages/palimpsest/src/Canon.ts)). It only returns a rename map for new writes. If an incoming entity bridges two already-written canons, existing Entity vertices, Claim edges, Slot keys, and User edges are not migrated or retired. The logical entity count can diverge from physical graph state, and later reads may retain two histories.

#### Required replacement

Treat User/Token/Slot values as rebuildable, versioned projections:

- create an immutable `SessionSource` revision keyed by a source digest;
- append an `IngestAttempt`/`IngestCommit` keyed by `(tenant, user, sourceDigest, extractionGeneration)`;
- keep explicit states such as `SOURCE_DURABLE`, `INDEXED`, `ENRICHED`, `CONSOLIDATED`, `FAILED`;
- serialize commits per user or use manifest-version compare-and-swap;
- apply idempotent deltas keyed by commit ID, rather than read-modify-write totals;
- publish a manifest watermark and consistency status to reads;
- provide a per-user reconciliation operation that walks User-root edges and rebuilds projections;
- fault-inject after every write stage and concurrently ingest same/different sessions in tests.

Without a HydraDB transaction or conditional update primitive, the safest near-term implementation is a single-writer queue per user plus an external transactional manifest store. The graph can remain the retrieval data plane while the manifest establishes commit authority.

### 1.4 Other architectural risks

#### Global bookmark state

The server intentionally creates one process-wide `HydraClient` whose last-write bookmark becomes the causal floor for the next read ([`Server.ts` lines 12–28](../packages/server/src/Server.ts)). That makes a local demo read its own writes, but it over-synchronises unrelated users and does not scale across processes. The API returns a bookmark after ingest but ask does not accept one. Production needs request/session-scoped causal tokens, not one mutable global token.

#### Hash IDs

HydraDB IDs travel as JSON numbers, so keys are reduced to the top 53 bits of SHA-256 with no collision detection ([`Ids.ts`](../packages/hydra/src/Ids.ts)). The observed 60-user graph has roughly 573,000 counted vertices before chunks/probes. Linear extrapolation gives about 4.78 million at 500 users, for a birthday collision probability of approximately:

`1 - exp(-n(n-1)/(2 * 2^53)) ≈ 0.001266`, or **0.127%**.

That is already too high for silent cross-user merging. Store the full digest as a property and reject any by-ID read/write whose digest/key does not match; better, have HydraDB accept lossless 64-bit or string identifiers.

#### Tenancy and deletion

The server explicitly has no authentication and treats the caller-controlled `uid` as the only boundary ([`Handlers.ts` lines 17–27](../packages/server/src/Handlers.ts)). UID-prefixing keys is namespacing, not access control. Deletion is unavailable once edge-scan admission is exceeded, so there is also no credible user-erasure or retention story. Both are acceptable hackathon constraints only if the product claim says local single-tenant prototype.

## 2. Results and statistical validity

### 2.1 What reproduced

The committed table was replayed with:

```text
pnpm eval --slice 100 --system all --prefix g2 --concurrency 4 --skip-missing \
  --out C:\Users\hp\AppData\Local\Temp\palimpsest-audit-replay-20260820
```

The replay made **0 live calls**: 360 cached `gpt-5.6-luna` calls and 240 cached `gpt-4o` calls. Accuracy, answers, reader-token usage, and evidence hashes reproduced for $0.00. The `.cache/llm` directory was not modified or deleted.

Latency did **not** reproduce:

| System | Committed p50 | Audit replay p50 |
|---|---:|---:|
| Palimpsest | 15.15 s | 13.61 s |
| Palimpsest + premise | 17.48 s | 10.86 s |
| BM25 | 2.60 s | 0.11 s |
| Full context | 3.42 s | 0.01 s |

The harness starts timing before retrieval/evidence selection and stops before judging ([`eval.ts` lines 190–258](../packages/eval/bin/eval.ts)). It therefore mixes graph work, local indexing, cache I/O, and either a live or cached reader call. The committed and replay numbers do not measure the same system state. “Every number replays” is false for latency.

Reader token counts are stable provider-reported usage. They show a real evidence-budget difference, not a latency result.

### 2.2 The denominator is 54, not 42

All four committed JSON files contain 60 rows: **54 answerable and 6 abstention**. The answerable counts are:

| System | Correct | Accuracy |
|---|---:|---:|
| Palimpsest | 43/54 | 79.63% |
| BM25 | 41/54 | 75.93% |
| Full context | 45/54 | 83.33% |
| Palimpsest + premise | 37/54 | 68.52% |

The 42/18 statement in `docs/run-log.md`, `docs/writeup.md`, and the handoff is incompatible with both the JSON and the percentage arithmetic. One result among 42 changes accuracy by 2.38 points; 79.6% cannot be a raw fraction with denominator 42.

The cause is visible in the harness. `benchmarkSlice(100)` selects 30 abstention plus 70 stratified answerable questions ([`Slice.ts` lines 40–89](../packages/eval/src/Slice.ts)). `--skip-missing` then filters out whichever users lack Claims ([`eval.ts` lines 157–177](../packages/eval/bin/eval.ts)). The 60 completions contained 6 abstention and 54 answerable users. A node failure decided the evaluated mixture.

This does not prove the completed users are easier, but it creates plausible informative missingness: histories that ingest more quickly or survive resource pressure can differ in size and complexity. The result must be labelled **completion-conditioned exploratory analysis**.

### 2.3 Palimpsest versus BM25 significance

The paired answerable outcomes are:

| Outcome | Questions |
|---|---:|
| Both correct | 38 |
| Palimpsest only | 5 |
| BM25 only | 3 |
| Both wrong | 8 |

Only the eight discordant pairs inform a paired test. Under the null, either system wins each discordant pair with probability 0.5. The exact two-sided McNemar/binomial result is:

`2 * P(Binomial(8, 0.5) <= 3) = 0.7265625`.

The observed paired difference is +3.70 percentage points. Treating per-question paired differences as `{-1, 0, +1}` gives an approximate 95% interval of **−6.61 to +14.02 points**. The individual Wilson intervals are also broad: approximately 67.1–88.2% for Palimpsest and 63.1–85.4% for BM25.

Conclusion: **the run neither demonstrates a Palimpsest improvement nor demonstrates equivalence**. “Palimpsest beat BM25” is not a supported claim.

For completeness, full context beats Palimpsest by the same two net questions: four full-context-only wins, two Palimpsest-only wins, exact p = 0.6875. “Full context wins” is an observed point estimate, not an established accuracy superiority. The roughly 30.4x token ratio is the much stronger descriptive result.

At the observed discordance rate, detecting a true 3.7-point paired difference with roughly 80% two-sided power would require on the order of **840 answerable pairs**. The complete 500-question LongMemEval-S set is valuable, but even it may be underpowered for a delta this small and remains one public benchmark with one reader/judge configuration.

### 2.4 Is the comparison fair?

It is fair as a **local end-to-end system comparison** in several ways:

- systems use the same `Reader.readSpans` prompt/model path;
- systems use the same local judge code/model alias;
- literal lexical terms use the same `stems()` implementation;
- provider usage supplies token counts for all reader calls;
- full context did not drop sessions at the configured 520,000-character cap.

It is not fair as evidence that **graph structure itself** beats BM25:

| Dimension | Palimpsest | BM25 |
|---|---|---|
| Query | Literal stems plus LLM synonyms/hypernyms and time/count flags | Literal stems only |
| Write-time representation | LLM-extracted claims, entities, keywords and slots | Raw turns |
| Selection | Top 25 converged claims plus up to 40 slot mates | Top 10 turns |
| Reader budget, p50 | 3,658 tokens | 2,787 tokens |
| Temporal label | CURRENT/SUPERSEDED | Every span marked CURRENT |
| Evidence unit | ±300-character source excerpt | Whole turn |

`Anchors.ts` explicitly says LLM expansion is the half that matters for recall ([lines 6–14 and 57–90](../packages/palimpsest/src/Anchors.ts)); `Bm25.topSpans` searches only `stems(question)` ([`Bm25.ts` lines 88–126](../packages/eval/src/Bm25.ts)). The BM25 comment claiming only index structure differs is therefore false.

Necessary ablations are:

1. graph with literal stems only;
2. BM25 with the identical expanded anchors;
3. both at fixed selected-character or reader-token budgets;
4. top-k/budget curves, not one k per system;
5. graph without slot expansion and group-budgeted slot expansion;
6. hybrid BM25 + graph with reciprocal-rank fusion;
7. oracle answer-session and oracle source-span readers.

The current result can be described as “Palimpsest end to end versus a simple literal BM25 baseline,” not “the graph index beats BM25.”

### 2.5 Is the judge an upstream port?

**The prompt templates and `yes` parser are close; the execution protocol is not.**

The [official evaluator at the inspected upstream commit](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py) pins `gpt-4o-2024-08-06`, uses Chat Completions, temperature 0, `max_tokens=10`, and checks whether `yes` appears in the lowercased reply. The local code uses the moving `gpt-4o` alias ([`Judge.ts` lines 19–27](../packages/eval/src/Judge.ts)), calls Effect AI's OpenAI Responses-backed language model with only `{model}` ([`Provider.ts` lines 21–27](../packages/llm/src/Provider.ts)), and passes no temperature or output-token cap to `generateText` ([`Llm.ts` lines 209–245](../packages/llm/src/Llm.ts)).

The cache freezes this run's sampled labels after the fact. It does not make the first run upstream-equivalent, and a mutable alias remains unreproducible before cache fill.

Implications:

- The same local judge is applied to each system, so the paired comparison is internally controlled.
- The result should not be called an **official LongMemEval score** or exact official-judge reproduction.
- Re-evaluate cached system answers with the exact pinned upstream configuration; report a label-confusion table and manually adjudicate the eight Palimpsest/BM25 discordances blind to system identity.
- Record upstream commit, dataset digest, exact reader and judge snapshots, prompts, API, sampling settings, and cache-generation ID in every result manifest.

### 2.6 Cost accounting

The full cache inventory reproduces the handoff's approximately $30.46 sunk cost. The $1.02 logged for the four-system evaluation is incremental session spend, not a clean-cache rebuild cost. Summing usage in the committed 60-row reader artefacts gives roughly $1.52 for readers alone at the repository's pricing, before anchors and judging; the clean rebuild is approximately $1.58–$1.60. Existing cache entries made the later session cheaper.

Future reports should separate:

- incremental cash spent in that shell session;
- clean-cache reproducibility cost;
- marginal per-query online cost;
- amortised write-time extraction/consolidation cost;
- cache-hit and cache-miss latency/cost.

## 3. Claims versus evidence

### 3.1 Structural abstention

A1/A2 are deterministic and inspectable, but they answer this question:

> Did at least one/two lexical anchors reach a Claim within the bounded graph traversal?

They do not answer:

> Does the retrieved source evidence contain enough information to answer, and are the question's premises supported?

The threshold is at most two anchors ([`Scoring.ts` lines 144–174](../packages/palimpsest/src/Scoring.ts)). On a history with roughly 2,000 generated claims, LLM-expanded query terms, write-time keywords, and entity hops, accidental or merely topical convergence is expected. Zero A1/A2 decisions on the populated graph are therefore consistent with the mechanism, not surprising bad luck.

The project did the scientifically correct thing by measuring the premise prompt, reporting that it improved abstention while damaging answer accuracy, and not enabling it. The write-up also openly says A1/A2 failed on the populated graph. **That part of the pivot is honest.**

What is not yet honest enough is replacing the failed headline with “proof of what was searched.” That is a new, unmeasured value claim. No task measured receipt correctness, replay success, debugging time, user trust, or decision quality. Calling the current object “proof” upgrades logging into an assurance claim without the integrity and completeness fields assurance requires.

Recommended positioning:

- Keep A1/A2 as `NO_CANDIDATES`/`NO_CONVERGENCE` diagnostic reason codes.
- Add `INSUFFICIENT_EVIDENCE`, `CONTRADICTED_PREMISE`, and `ANSWERED` as separately calibrated decisions.
- Measure selective risk versus coverage, false-answer rate, false-abstention rate, AURC, and calibration—not one fixed abstention accuracy.
- State the original structural-abstention hypothesis as rejected on this workload.

### 3.2 Does the receipt earn its place?

**Yes as a replayable decision trace and debugging surface. No as current proof.**

Useful present fields include query text, anchor outcomes, path counts, convergence threshold/table, as-of cut, candidate count, and selected claim-key hash. Those made this audit substantially easier.

The gaps are material:

- no graph/database ID, read epoch, bookmark, commit, or per-user manifest version;
- no transcript, extraction, index, prompt, model, schema, or tokenizer generation;
- no flag saying pagination reached exhaustion, a path/candidate cap fired, a deadline expired, or a degraded route was used;
- no immutable hash of source transcript revisions or hydrated excerpt bytes;
- no full candidate list and exclusion/rerank reason codes;
- no receipt digest/signature or engine attestation;
- `determinismHash` hashes only sorted selected Claim keys ([`Retrieve.ts` lines 99–107](../packages/palimpsest/src/Retrieve.ts)); it is not an evidence-content or query-result hash;
- the convergence table is truncated to `topK` ([`Retrieve.ts` lines 181–193](../packages/palimpsest/src/Retrieve.ts));
- `query1Paths` counts raw paths before the as-of cut while the convergence table is after the cut;
- the server's receipt omits `query1Params` even though the internal receipt carries them ([`Handlers.ts` lines 124–141](../packages/server/src/Handlers.ts));
- as-of scoring uses current-history `Token.df` and `User.totalClaims`. Since `idf = log(1 + N/df)`, changing `N` is not one common scale factor across tokens. A historical replay can be influenced by future corpus statistics even when future Claims are later filtered.

A product-grade receipt should identify the exact memory version and plan, state all completeness limits, hash source spans, list candidate origins and exclusions, record per-stage timings/cache state, attach the calibrated sufficiency decision, and make the whole object tamper-evident. Until then, use this phrase:

> Replayable retrieval decision trace against a declared graph state; not proof of exhaustive absence.

## 4. What breaks at 500 users?

### 4.1 Already broken at 60

After Docker Desktop was started and the persisted `hydradb` container resumed, `pnpm typecheck` and all 144 unit tests passed. The cached four-system evaluation also completed. The live suite did not:

- 13 live files: **5 passed, 8 failed**;
- 45 tests: **19 passed, 9 failed, 17 skipped**;
- every write-oriented failure returned `HydraUnavailable: internal query execution error`;
- read-oriented paths continued to work.

A focused idempotency write probe failed twice in 46–48 ms with fresh statement IDs. HydraDB's log exposed the suppressed internal error:

```text
object store error: Operation `put_opts` with mode `PutMode::Update`
not yet implemented by LocalFileSystem(file:///data/store)
```

The same operation repeatedly breaks manifest/compaction garbage collection. After restart, the cache evictor also reported dropping tens to hundreds of thousands of cache write/access events per 30-second interval. Container state during the audit was approximately **5.50 GiB / 7.76 GiB (71%)**, 56 PIDs, no container memory limit, and restart policy `no`.

This confirms the handoff's stale-writer-lease diagnosis, but also changes the operational conclusion: the claimed recovery was not durable. An ordinary subsequent restart returned the volume to the same read-only state. This is the third reproducible failure state around the 60-user load.

No lease file or volume was changed during this audit. Recovery would be a separate, explicitly authorised operation.

### 4.2 Store-size-dependent failure modes not yet measured

#### Persistence and compaction

The local object-store backend cannot perform the conditional update used for writer leases and garbage collection. More data increases manifests, compactions, cache pressure, restart time, and the cost of discovering this only after a crash. Fix or replace the backend before adding users.

#### Memory and edge amplification

The counted graph already contains about 573k User/Session/Turn/Claim/Entity/Slot/Token vertices, excluding chunks and probes, and has crossed one million edges. A linear vertex estimate at 500 users is 4.78M; edge count grows much faster than sessions because every claim can have many HITS/MENTIONS/NAMES plus evidence, slot, user-root, and supersession edges. Current memory headroom cannot support an 8.3x scale assumption.

#### Hidden global work

Product paths avoid the known label scans, but store-global effects remain in indexes, page/cache eviction, manifests, compaction/GC, checkpointing, delete admission, and placement/writer state. Scale tests must hold one target user's history fixed while increasing unrelated users; otherwise per-user traversal tests cannot expose them.

#### High-degree traversal and slot fan-out

User-prefixed Token keys prevent other tenants' edges from joining a retrieval, but common per-user terms can still have thousands of HITS edges. MSPaths must produce/fold those paths before the client top-k cut. Slot Query 2 fetches all slot claims and only then slices additions to 40 ([`Retrieve.ts` lines 207–238](../packages/palimpsest/src/Retrieve.ts)), so one broad slot consumes engine and network work even when most claims are discarded.

#### Multi-process consistency

One global in-process bookmark provides neither horizontally scalable read-your-writes nor user-level concurrency control. Adding server replicas will expose stale reads; keeping one replica makes it a throughput and failure bottleneck.

#### Retention and generation growth

Prompt/model/index experiments require new prefixes because delete is unavailable. Without active-generation pointers, export/compaction, and erasure policy, storage cost grows with every experiment and tenant lifetime.

#### Identifier collisions

The 53-bit collision probability reaches a non-negligible level at the expected vertex count, and edge hashes have their own larger collision population. A collision is silent overwrite/merge, not a clean error.

#### Security and noisy neighbours

No auth, one graph, one client, one writer, and caller-controlled UID make 500 external users impossible regardless of raw query speed. Rate limits, quotas, tenant isolation, prompt-injection handling, source ACL propagation, and per-user deletion are absent.

### 4.3 Required scale gate

Do not infer 500-user readiness from the 60-user accuracy table. Before spending on the remaining ingest:

1. pin a HydraDB image digest that matches reviewed source and fix the local-store update path;
2. prove clean stop, forced kill, restart, write, checkpoint, and recovery repeatedly on a copy of the volume;
3. make session commit and per-user manifest updates atomic/versioned;
4. add consistency reconciliation and collision detection;
5. load in measured steps while recording vertices, edges, disk, RSS, cache drops, compaction backlog, write/read p50/p95/p99, and recovery time;
6. vary unrelated-store size and target-user history size independently;
7. stop on a declared memory, write-error, cache-drop, or recovery-SLO threshold.

## 5. Improvement programme

The companion [primary-source landscape](research-memory-context-landscape-2026-08-20.md) distinguishes source-reported research results from proposed Palimpsest experiments. The sequence below is ordered by expected information gain, not novelty.

### P0 — integrity and measurement before new extraction spend

1. **Fix the runtime contract.** Pin the HydraDB image by digest, record build metadata, and validate local persistence/restart. The checked-out submodule and running image currently differ.
2. **Replace ingest's existence guard with a commit state machine.** Make immutable source durability distinct from derived-index completion; retries resume incomplete stages.
3. **Version the User manifest and rebuildable counts.** Add commit IDs, idempotent deltas, reconciliation, and per-user writer serialization/CAS.
4. **Correct generated documentation.** Derive every table and denominator from JSON; never hand-copy 42/18.
5. **Freeze evaluation.** Pin dataset hash, code commit, graph/extraction generation, reader snapshot, exact upstream judge snapshot/settings, prompts, and tokenizer.
6. **Instrument stages.** Separate anchor generation, manifest read, Query 1, candidate fold/rerank, Query 2, supersession read, hydration, reader, and judge. Report cold/warm/post-write p50/p95/p99 and cache state.
7. **Run oracle readers on existing data.** Compare answer-bearing session/turn only, current evidence, reranked current evidence, and full context. This locates loss without paying for a new extraction generation.

### P1 — improve accuracy where the evidence says it is weak

SessionRecall@25 is 98.1% while answer accuracy is 79.6%; preference accuracy is 45.5%. Candidate-session discovery is nearly saturated on this partial slice. The next work should improve selection, packing, and reading before increasing graph fan-out.

1. **Group-aware reranking.** Union 50–100 current candidates, rank claim/turn/slot-history groups for downstream answer utility, then hydrate only selected source spans. Do not let 40 zero-score slot mates displace evidence automatically.
2. **Structured source reading.** For each selected span, ask the reader to mark relevance, support/contradiction, temporal relation, and premise ID before synthesis. These notes remain derived aids linked to source offsets, never evidence.
3. **Fixed-budget evidence packing.** Optimise marginal utility per token, deduplicate overlapping excerpts, preserve multi-session coverage, and test token-budget curves.
4. **Adaptive granularity.** Route simple fact questions to claim spans; use whole turns for references/preferences; use bounded slot/session reconstruction for updates, counts, temporal, and multi-session questions.
5. **Hybrid candidate generation only for hard misses.** Add literal BM25 and a semantic/late-interaction sidecar keyed by immutable span ID, fuse with graph candidates, and rerank. Because current session recall is already high, measure whether this improves hard categories rather than assuming embeddings help.
6. **Typed temporal operations.** Filter by time before expensive expansion; represent exact/uncertain intervals; use a deterministic date-arithmetic tool for temporal questions.

Relevant primary sources and caveats are linked in the companion report: LongMemEval and Chain-of-Note for reading strategy, BGE-M3/ColBERTv2 for hybrid retrieval, RankRAG for answer-aware ranking, Adaptive-RAG/MemGAS for routing, and temporal-memory work for bitemporal selection. These are experiment generators, not promises of a Palimpsest gain.

### P2 — replace structural abstention with calibrated sufficiency

1. Extract explicit question premises.
2. Retrieve answer evidence and evidence for each premise.
3. Label support, contradiction, or unknown against verbatim spans.
4. Combine sufficiency score, reader confidence, top-candidate margin, retrieval entropy, contradiction signal, cap/completeness flags, and memory watermark.
5. Calibrate thresholds on a development set against a declared false-answer or coverage target.
6. Evaluate on held-out false premises and LongMemEval-V2 premise-awareness tasks.

Report the full risk-coverage curve, AURC, selective accuracy, coverage, false answers, false abstentions, and calibration error. A1/A2 remain low-level diagnostic inputs.

### P3 — make the receipt a defensible differentiator

Receipt v2 should contain:

- tenant/user scope plus source ACL decision;
- graph/database ID, read epoch/bookmark, commit and User-manifest versions;
- source, extraction, index, prompt/model/schema/tokenizer generations;
- literal and expanded query terms;
- chosen retrieval plan/router rationale;
- all candidate arms, scores, fusion and rerank decisions;
- valid-time and recorded-time cuts;
- pagination/path/candidate/token/deadline limits and exhaustive/truncated status;
- selected span IDs plus source-revision and excerpt hashes;
- exclusion reason codes;
- sufficiency/premise score, calibration version and threshold;
- per-stage latency, tokens, cache state and degraded-mode flags;
- final citations and a post-generation entailment/support check;
- a canonical receipt digest/signature.

Then measure whether it earns its cost: replay success, debugging time, incorrect-answer investigation time, citation-open rate, correction rate, and user trust/decision quality.

### P4 — bitemporal product model

The most defensible competitive opportunity is dual time:

- **recorded/transaction time:** when this system learned and committed a source;
- **valid/event time:** when the fact was true in the user's world;
- valid and transaction intervals with precision/uncertainty;
- supersession effective time;
- question perspective: “known by session k” versus “true during March.”

The transcript stays immutable authority; temporal facts and intervals are revisable derived assertions with lineage. Test late arrivals, multiple corrections, uncertain dates, conflicting sources, as-of under a populated future graph, and deletion/revocation policy.

## 6. Evaluation programme and metrics

### Benchmarks and controls

- Complete the predeclared LongMemEval-S protocol only after the persistence/commit fixes.
- Add LongMemEval-M for larger histories, LongMemEval-V2 for premise awareness/multimodality/latency, and MemoryAgentBench for test-time learning and forgetting.
- Maintain a private rolling holdout with paraphrases, late corrections, false premises, new post-model-release facts, and concurrency/fault cases.
- Blindly human-audit every baseline discordance with two reviewers and adjudication.
- Rejudge with a second model family and publish agreement/confusion, not a silent averaged score.
- Predeclare primary endpoint, categories, budgets, and stopping rule before the final run.

### Minimum dashboard

| Axis | Metrics |
|---|---|
| Answer quality | paired accuracy difference with CI; per-type accuracy; human correctness |
| Retrieval | answer-session/span Recall@k; MRR/nDCG; evidence precision; oracle-reader accuracy; recall at fixed tokens |
| Grounding | citation precision/recall; unsupported-answer rate; source-span coverage; source hash validity |
| Abstention | selective accuracy; coverage; false-answer/false-abstention; risk-coverage/AURC; ECE/Brier |
| Temporal | current, valid-time, recorded-time, update, late-arrival, contradiction accuracy |
| Efficiency | per-stage and end-to-end p50/p95/p99; cold/warm/post-write; tokens, calls and dollars |
| Freshness | source-durable, indexed, enriched and consolidated latency |
| Reliability | ingest throughput; partial-commit recovery; idempotency; manifest drift; restart recovery; RPO/RTO |
| Scale | vertices/edges/disk/RSS per source and user; compaction backlog; cache drops; unrelated-store sensitivity |
| Product trust | citation opens; corrections; receipt replay success; erasure SLA; user-rated usefulness/regret |

Accuracy, latency, cost, coverage, freshness, and trust form a Pareto frontier. Do not collapse them into one hackathon score.

## 7. Defensible claim today

Avoid:

> Palimpsest beats BM25 and provides structural abstention with proof of what was searched.

A claim supported by the current artefacts is:

> Palimpsest uses HydraDB as a deterministic derived graph to retrieve verbatim transcript evidence and exposes a detailed retrieval trace. On a completion-conditioned 60-question partial LongMemEval-S run, it achieved 43/54 answerable questions versus 41/54 for a simpler literal BM25 baseline while using about 1/30 of full-context reader tokens; that two-question difference was not statistically significant, structural A1/A2 abstention did not fire, and the current local persistence path is not ready to scale.

The product claim worth earning is:

> Palimpsest is a source-grounded bitemporal context layer that reconstructs sufficient evidence, knows when the available evidence is incomplete, and returns a completeness-aware receipt that replays every retrieval and citation against a declared immutable memory version.

## 8. Verification performed

| Check | Outcome |
|---|---|
| Repository state | commit and submodule recorded; unrelated work preserved |
| Dataset digest | reproduced |
| `pnpm typecheck` | passed |
| `pnpm test:unit` | 16 files, 144 tests passed |
| Cached four-system replay | 60 rows/system; accuracy, answers, hashes and token counts reproduced for $0.00 |
| Paired result extraction | 38 both, 5 Palimpsest-only, 3 BM25-only, 8 neither on 54 answerable |
| Exact McNemar | p = 0.7265625 |
| Upstream judge comparison | local prompt/parser close; model/API/temperature/output cap not equivalent |
| `pnpm test:live` | failed: all write-oriented tests unavailable, reads continued |
| Focused write probe | failed twice with fresh IDs in under 50 ms |
| HydraDB logs | `LocalFileSystem` `PutMode::Update` error; GC failures and severe cache-event drops |
| Volume mutation | none; `.cache/llm` preserved |
