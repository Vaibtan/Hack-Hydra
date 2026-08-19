# Palimpsest

**An agent memory layer where every answer points at a character span in a real transcript, every
abstention shows the query that found nothing, and "what did I believe last March" is a filter
rather than a snapshot.**

Built on HydraDB 0.1.0. TypeScript + Effect. Evaluated on LongMemEval_S with the official judge
against two baselines.

---

## 1. The thesis

Most memory layers extract facts and then answer from the extraction. That has a failure mode which
is hard to see and impossible to check: the system becomes a summary of a summary, and when it is
wrong there is no artefact to inspect. You get a confident sentence and a similarity score.

Palimpsest inverts the relationship. **The transcript is the data; the graph is an index over it.**
Every extracted Claim carries a `(session, turn, char_start, char_end)` Span, and the reader is
never shown a Claim's text — it is shown the verbatim turn text around the Span. A Claim is a
routing decision, not evidence. That single constraint is what makes everything else in the system
inspectable:

- **Relevance is structural.** A question becomes anchor Tokens; retrieval is one bounded
  `algo.MSpaths` walk from those anchors to the user's Claims; and the score is **convergence** —
  how many *distinct* question anchors reach the same Claim. Not a cosine distance you have to take
  on faith, but a count you can re-derive from the query result.
- **Chronology is two indexed integers.** `session_ord` (when it was said) and `t_event` (when it
  happened), which is what makes temporal questions answerable at all.
- **Supersession is an edge.** `(older)-[:SUPERSEDED_BY {at_session}]->(newer)`. "Current" is not a
  flag anyone sets; it is the *absence* of an outgoing edge as of session *k*.
- **As-of is a filter, not a snapshot.** `session_ord ≤ k` on Claims, `at_session ≤ k` on edges.
  Two integer comparisons. No branch, no second copy of the graph, no database time travel.
- **Abstention has two distinct kinds, and they are labelled differently.** More on this in §6,
  because it is where the honest story is most interesting.

## 2. Why a graph database, and what HydraDB actually gave us

The bet was that a graph store could carry the *whole* retrieval path — no vector index, no BM25, no
external inverted index anywhere in the read path. What made that plausible is that HydraDB exposes
`algo.MSpaths`: a multi-source bounded path walk, driven from an explicit list of source values.

### 2.1 MSpaths as an inverted index with convergence

Ingest attaches normalised Tokens to Claims (`HITS`) and to Entities (`NAMES`). A question is
turned into Tokens the same way — deterministic stems of the question, unioned with an LLM's
synonyms and hypernyms. Both sides expand, because the exact-match join in the middle only happens
if both do.

Retrieval is then two round trips, regardless of how many anchors or candidates there are:

```cypher
CALL algo.MSpaths({sourceLabel:'Token', sourceProperty:'tkey', sourceValues:[…anchors…],
  targetLabel:'Claim', targetProperty:'kind', targetValues:['<uid>|claim'],
  relTypes:['HITS','NAMES','MENTIONS'], relDirection:'outgoing', maxLen:2})
YIELD path RETURN path
```

Paths are `Token→Claim` or `Token→Entity→Claim`, fully hydrated. Client-side, convergence is the
number of distinct *first* nodes that reached the same *last* node — one fold over the result, no
per-claim queries. Query 2 walks from the candidates' Slots back down `FILLS`, so a
knowledge-update question sees the value that was replaced as well as the one that replaced it.

The `kind = uid|claim` property is load-bearing and not obvious. `MSpaths` returns **one path per
source value** unless told otherwise; a constant-valued *target* selector makes every source→target
pair come back instead. Without it, retrieval silently returns one claim per anchor.

### 2.2 The engine facts that changed the design

Every one of these was measured against the live node, not read from documentation, and each one
changed a decision. They are the most interesting page in the repository.

| Fact | Consequence |
|---|---|
| **1024 rows per response**, with a `next_cursor` | Ignoring it does not fail, it silently truncates — including from `MSpaths`, which cannot take `SKIP`/`LIMIT`. Every recall number taken before this was found would have been wrong in the same invisible direction. Continuing needs **both** the cursor and the originating `query_id`. |
| **`MATCH (n:L) WHERE n.p = $v` is a full label scan**, ~100 µs per vertex of that label *store-wide* | The blocker for scale. One user's Claim count cost 4.4 s at 58 k Claims, one Token count 9.5 s, `readSessions` 19.2 s — for numbers belonging to one user out of a hundred. Fixed by §2.3. |
| **No batched read by id** | `UNWIND $rows AS row MATCH (n {id: row.id}) RETURN …` is refused ("UNWIND batch supports one-hop relationships only" — `UNWIND` is a write form here), and so is `WHERE n.id IN [...]`. Many vertices at once must go through `MSpaths`. |
| **Source-only `MSpaths` returns one path per source** unless `pathCount` is raised | Silent, like the row cap. The walk from `User` over `HAS_SESSION` returned 1 of 39 sessions. A constant target selector is exempt *and* faster — raising `pathCount` on the convergence query took its median from 0.12 s to 14 s for byte-identical evidence — so the client raises it on source-only walks only. |
| **32 743-byte string property cap** | Four of 246 750 turns are longer, and they are exactly the long assistant outputs the `single-session-assistant` questions ask about. They spill into `HAS_CHUNK` vertices and reassemble on read, so Span offsets stay absolute. |
| **`DETACH DELETE` ~2.3 vertices/s, then refused entirely past ~1 M edges** | Deletion is not available on a working graph at any batch size. Every write is content-addressed and idempotent so re-ingest never needs a reset; a prompt change takes a fresh key prefix instead. |
| **Write `query_id` is the idempotency key, and the server's own counter restarts with the node** | After a restart, the n-th relationship merge collides with an unrelated one from the previous run and *every* write fails with a bare 500, indefinitely, with nothing wrong in the graph. The client now sends a UUID per statement. |
| **A writer lease cannot be reclaimed after an unclean stop** | Taking over an existing `_writer_leases/v2/<cell>` file needs `put_opts` with `PutMode::Update`, unimplemented by the LocalFileSystem object store, so a node killed mid-write comes back permanently **read-only**. Recovery is to move the stale lease file aside. |
| **30 s query cap, arriving as a 500** | Classified by message, not status, because "your statement was too big" is retryable by splitting and "the engine is down" is not. |
| **Second graph id 403s with the local token** | All users share `default`, partitioned by key prefix. |

The last two rows cost an evening between them and are written up in `docs/run-log.md`.

### 2.3 The label-scan finding, and the `User` vertex

This is the one finding worth generalising from. HydraDB indexes exactly two things: a vertex by
`{id: …}`, and the source values an `MSpaths` walk is driven from. Everything else — including the
natural-looking `MATCH (c:Claim) WHERE c.uid = $uid RETURN count(*)` — reads every vertex of that
label in the whole store.

At one user this is invisible. At twenty-six it was already 4.4 s per ask. At five hundred it is past
the engine's own 30 s cap, on a read that exists only to describe a user the ingest had just
finished writing. Eleven such reads were on the product path.

The fix is structural rather than clever: a `User` vertex per history (`uid|user`) carrying the
counts, and `HAS_ENTITY` / `HAS_SLOT` / `HAS_SESSION` edges rooting the vertex sets. Then

- `stats`, `claimCount` and the idf denominator are one ~100 ms read by id;
- the entity list, the contested slots and the session list are one indexed `MSpaths` hop;
- **the counts are written by the ingest that produced them.** Nothing derived is ever recomputed
  by joining the store — an ingest that ends by *counting* the graph it just wrote is both slow and
  able to fail a user that was written perfectly.

Measured effect on the day-3 gate: **median ask latency 5.8 s → 0.12 s**, twenty questions end to
end in 0.6 s, with every gate number byte-identical. The first ask against an idle node still costs
~10–15 s while HydraDB faults the traversal into its page cache; that is the engine's cache and not
the read path, and it is stated rather than hidden.

### 2.4 Cursor paging, bookmarks, determinism

**Paging** is exhaustive everywhere. The 1024-row wall was found by accident — `readEntities`
returned exactly 1024 rows for a user with 1 987 entities — and it is the single most consequential
bug in the project's history, because it capped recall with no error anywhere. The page-following
loop now also *errors* rather than stopping at its own 200-page ceiling, which was the same failure
shape one order of magnitude up.

**Bookmarks** are HydraDB's causal token, returned by every write and replayed into the next read,
so ingest→ask is read-your-writes inside one client. They are worth being precise about: a bookmark
is a *causal floor*, not time travel. As-of could not be built on it, which is exactly why as-of is
data-level.

**Determinism** is claimed narrowly and truthfully. Retrieval is deterministic *given a fixed
graph*: two bounded `MSpaths` calls and pure scoring, no sampling, with an evidence hash of
`sha256` over the sorted claim keys — N runs, one hash. **Extraction is not deterministic**; it is
a model call. What makes a whole benchmark run reproducible is the on-disk LLM cache keyed by
`sha256(model + system + prompt + schema)`, not the graph. Both halves of that are said out loud in
the demo and here.

## 3. The receipt

Every verdict carries the artefacts that produced it: the exact `MSpaths` statement and parameters,
which anchors reached a Claim and which reached nothing, the path counts for both queries, the
convergence threshold as a single named number, and the convergence table behind the ranking.

It is not logging. It is the product claim: **you can re-run the read by hand and get the same
paths.** A judge, a user, or a future maintainer debugging a bad answer all get the same handle. In
a field where "why did it say that" is usually answered with an embedding distance, being able to
point at a Cypher statement and a path count is the differentiator — and, as §6 explains, it is a
better differentiator than the one originally planned.

## 4. What was measured

### Day 1 — extraction recall vs `has_answer` — **97.0 %** (bar 90 %)

20 oracle questions / 33 sessions. 32 of 33 answer-bearing turns are pointed at by at least one
Claim's Span. 100 % on five of six question types; the single miss is `single-session-preference`
(5/6). 1 676 claims, 1 213 from **assistant** turns, 441 filling a slot, 15 dropped spans. This is
the ceiling on everything downstream: a turn no Claim points at can never be surfaced whatever
retrieval does.

### Day 3 — SessionRecall@25 and false-abstention — **100.0 % / 0.0 %** (bars 85 % / 10 %)

The stratified 20-question slice of LongMemEval_S — real haystacks, 46–57 sessions per user, ~40 000
claims across the 20 users.

| question type | n | SessionRecall@25 | false-abstention |
|---|---|---|---|
| knowledge-update | 3 | 100.0 % | 0.0 % |
| multi-session | 4 | 100.0 % | 0.0 % |
| single-session-assistant | 3 | 100.0 % | 0.0 % |
| single-session-preference | 3 | 100.0 % | 0.0 % |
| single-session-user | 2 | 100.0 % | 0.0 % |
| temporal-reasoning | 3 | 100.0 % | 0.0 % |
| **ALL answerable** | **18** | **100.0 %** | **0.0 %** |

No widening lever was needed — plain `maxLen 2`, top-K 25. 14.7 of 16.4 anchors resolve per
question; 24.9 evidence claims per question; median latency 0.12 s. A re-run reproduces every
number for $0.00.

### Answer accuracy — see `results/table-100.md`

Ask → reader → the official LongMemEval judge (`gpt-4o`, temperature 0, five templates copied
verbatim from upstream's `evaluate_qa.py`, upstream's `'yes' in response.lower()` scoring inherited
quirk and all). Three systems, the same reader prompt and the same judge, differing in exactly one
thing — how the text handed to the reader was chosen:

- **Palimpsest** — anchor convergence over the claim graph;
- **B1, BM25 top-10 turns** — k1 1.5, b 0.75, over the user's turns using the *same* `stems()`
  tokenizer, so the comparison is about index structure and not tokenisation;
- **B2, full context** — the whole haystack, dropping the **oldest** sessions when it does not fit
  and recording how many, because dropping the newest would flatter it on exactly the
  knowledge-update questions it should find hard.

## 5. Positioning

**Zep / Graphiti** is the closest neighbour and the fairest comparison. It is a temporal knowledge
graph with bi-temporal edge validity and an explicit invalidation model, and it is a more mature
system than this one. The difference is where the evidence lives: Graphiti's retrieval returns
facts and episodes as the answer surface, and combines semantic, keyword and graph search. Palimpsest
returns *spans of the original transcript* and nothing else, and does not have an embedding index at
all. That is a narrower bet — it fails on paraphrase where a vector index would not — and in
exchange every answer is checkable against the source and the retrieval is one showable structural
query.

**mem0** optimises for token cost and latency with an extract-and-consolidate memory that rewrites
what it stores. It is the right shape for a product that wants a small, fast, self-maintaining
memory. It is the opposite of the bet here: consolidation is exactly the step that makes an answer
uncheckable, and rewriting is exactly what an append-only supersession chain refuses to do so that
"what did I believe in March" stays answerable.

**Mastra** is an agent framework with memory as a component — working memory, semantic recall,
threads. The comparison is not really like-for-like: Mastra is where you would *put* something like
this, not a competitor to it. A useful framing is that Palimpsest is a memory *substrate* with an
opinion, and a framework is where it would be mounted.

**CogCanvas** is the closest in spirit on the "show your work" axis — the shared instinct is that a
memory system should expose structure rather than a score. The difference here is the insistence
that the exposed structure be *the retrieval itself*: not a visualisation derived from the answer,
but the literal query text, path counts and convergence table that produced it.

Common to all four: none of them can be asked "what did you believe as of session 12" and answer it
without a snapshot, a fork, or a rebuild. Data-level as-of over an append-only supersession chain is
the thing this design does that the others structurally cannot, and it costs two integer
comparisons.

**What this is not.** It is not state of the art on LongMemEval and does not try to be. It has no
vector index, so vocabulary mismatch that survives both write-time and read-time expansion is a
hard miss. It is single-node. Extraction costs a model call per session.

## 6. The abstention result, stated honestly

The original pitch was: **abstention is a structural verdict** — no anchor resolves (`A1`), or no
Claim is reached by enough anchors (`A2`) — backed by the exact query and its empty result. That is
a good story and it is **not what the measurement shows** on a populated graph.

With ~2 000 claims per user and ~15 resolved anchors, *something always converges*. On the day-3
slice, `A1`/`A2` fired on **neither** of the two `_abs` questions. The structural verdict does not
carry abstention when the graph is well populated.

What the structure actually delivers is **proof of what was searched** — the exact query, the
resolved and unresolved anchors, the path counts, the convergence table. That is a real and
defensible differentiator, and it is a different claim from "we abstain better".

Abstention lands one layer later, on the **reader**, which is given the spans and returns exactly
`NOT_IN_MEMORY` when they do not contain the answer. The demo labels the three outcomes in three
colours on purpose, because they are three different claims:

| Outcome | Meaning |
|---|---|
| `ANSWER` | claims converged and the reader read them |
| `ABSENT · A1/A2` | **structural** — nothing was reachable, and here is the query that reached nothing |
| `ABSENT · NOT_IN_MEMORY` | the right spans *were* reached and did not contain the answer |

**False-premise questions are the open problem.** A question can presuppose something untrue and
still overlap the evidence heavily — *"how many engineers do I lead as Software Engineer Manager?"*
asked by a senior engineer who never became a manager. Retrieval converges hard on real claims about
engineers and counts, and the reader answers a number. The count is real; the premise is not.

The cheapest plausible fix is to make the reader test the question's presuppositions before
answering. It is implemented as an A/B (`--system palimpsest-premise`) rather than adopted, because
it can only trade abstention recall against false abstention on answerable questions, and that trade
has to be measured before it is taken. Both variants are in `results/table-100.md`.

There is one place where structural abstention *does* fire, and it is worth showing: **under
as-of**. Asked as of session 2, the graph really is thin, and the demo user's mortgage question
returns `ABSENT A2` — where before the as-of fix it returned a reader-level `NOT_IN_MEMORY` over
evidence from session 37 that the memory was not supposed to have yet. A1/A2 are verdicts about a
small graph, and as-of is how a large graph becomes small.

## 7. Known limitations

1. **No vector index anywhere in the read path.** Vocabulary mismatch that survives write-time
   keyword expansion *and* read-time synonym expansion is a hard miss. This is the design's central
   bet and its main risk.
2. **Structural abstention does not fire on a populated graph** (§6). Abstention is the reader's,
   and false-premise questions are unsolved.
3. **Extraction is a model call per session** and is not deterministic. Reproducibility comes from
   the disk cache.
4. **Deletion is unavailable.** Past ~1 M edges HydraDB refuses `DETACH DELETE` outright. Nothing in
   the product path deletes, by design, but it means a prompt change adds a *second generation* of
   claims beside the first rather than replacing them — the supported reset is a fresh key prefix,
   and a truly clean graph means recreating the Docker volume.
5. **Single node, single graph.** A second graph id 403s with the local token, so all users share
   `default` and are separated by key prefix. There is no auth and no tenancy.
6. **53-bit vertex ids.** HydraDB node ids travel as JSON numbers, so ids are the top 53 bits of
   SHA-256(key). At the 500-user scale (~5 M vertices) the birthday collision probability is ~1e-3,
   not the ~5e-5 quoted at 10^6. Acceptable, and stated at the right scale.
7. **Slot expansion is capped at 40 claims**, and top-K at 25. A converged claim earned its place; a
   slot-mate did not.
8. **Append-only single-session ingest.** A session posted through the API always sorts last, because
   renumbering would invalidate every `at_session` on every supersession edge.
9. **The idf denominator under as-of is the whole-history claim count**, not the count as of *k*. It
   scales every score by one constant and changes no ordering, and the receipt reports it as the
   present rather than pretending.

## 8. Deviations from the spec

1. **Vertex ids are 53-bit, not `xxhash64`** — HydraDB node ids travel as JSON numbers.
2. **Extraction does not receive the user's entity list.** The spec asks for it, but that makes the
   prompt user-specific and destroys the session-hash cache the same ticket requires. Extraction is
   keyed purely by session content and shared across every user whose haystack contains that
   session; canon stability moved to deterministic union-find reconciliation over stem match keys.
   It also made extraction order-independent, which is the only reason a 48-session haystack ingests
   in ~5 minutes instead of ~30.
3. **The extractor returns a verbatim quote, not `cs`/`ce`.** Spans are located here, in three
   reported tiers (exact / whitespace / markdown). Models reliably strip `**bold**` when quoting;
   that tier alone recovered 125 claims and cut dropped spans from 128 to 15.
4. **`packages/dataset` is its own package** — ingest needs the loader and must not depend on eval.
5. **Turn text over 32 743 bytes spills into `HAS_CHUNK` vertices**, settling the open item in
   spec §7.
6. **A prompt change gets a fresh key prefix** rather than a reset, because deletion is unavailable.
7. **Slot expansion is capped at 40 claims.**
8. **As-of is applied before the verdict, not after it** (spec §3.4 step 5 is wrong and carries an
   erratum). Applied where the spec puts it, the receipt of an as-of ask is computed over claims the
   memory is not supposed to hold yet, and top-K is spent on them.
9. **`A1` as implemented is "no anchor reached a claim"**, where the spec's A1 is "no anchor token
   exists". The receipt field is named `anchorsReachingClaims` for what it measures. A Token vertex
   with no `HITS` edge is indistinguishable from a missing one for the verdict, and telling them
   apart would cost a second query.
10. **The judge is asked for free text, not a schema-constrained object**, so upstream's
    `'yes' in response.lower()` scoring is applied to the same kind of reply upstream scores.
    Upstream pins `gpt-4o-2024-08-06`; this asks for the account's `gpt-4o` alias and records the
    resolved model in every results row. Upstream also caps the reply at `max_tokens: 10`; here it
    is uncapped and scored identically.
11. **`--slice N` selects the same N questions for ingest, the retrieval gate and the answer
    harness.** Below 30 it is the original stratified slice, unchanged, so the day-1 and day-3
    numbers keep meaning what they meant; at 30 and above it is all thirty `_abs` questions plus a
    stratified remainder.

## 9. Reproducing any of it

Everything above replays from `.cache/llm` for **$0.00**; the cache is what the money bought.
`docs/run-log.md` records what each run cost and what it projected beforehand. `README.md` has the
setup end to end, and `CONTEXT.md` has the engine-limit table that every design decision here points
back at.
