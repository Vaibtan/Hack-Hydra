# Palimpsest

Agent memory layer for cross-session continuity, built on [HydraDB](https://github.com/hydra-db/hydradb).

The graph is an *index over verbatim transcript*, not a replacement for it. Every extracted **Claim**
points at a `(session, turn, char_start, char_end)` **Span**. Chronology is two indexed integers.
Supersession is an explicit `SUPERSEDED_BY {at_session}` edge chain, so "current" is structural.
Retrieval is one bounded `algo.MSpaths` call from question **anchors** to Claims, and relevance is
**convergence** — how many distinct question anchors reach a Claim. Abstention is a structural
verdict backed by the exact query and its empty result.

Design documents:

- [`docs/spec-palimpsest.md`](docs/spec-palimpsest.md) — thesis, glossary, schema, ingest, retrieval, eval
- [`docs/review-2026-08-17-palimpsest-plan.md`](docs/review-2026-08-17-palimpsest-plan.md) — the review that corrected the plan, plus the live-node probe table
- [`CONTEXT.md`](CONTEXT.md) — the domain vocabulary used in code, tests and UI
- [`docs/writeup.md`](docs/writeup.md) — the submission writeup: thesis, HydraDB findings, results, positioning, limitations
- [`docs/run-log.md`](docs/run-log.md) — what each expensive run projected and what it actually cost
- [`docs/video-script.md`](docs/video-script.md) — the sub-5-minute demo run-through

## Layout

```
packages/hydra        HydraDB HTTP client — a deep module over the Cypher subset
packages/dataset      LongMemEval loader — typed questions, sessions, turns
packages/palimpsest   the memory layer itself — keys, transcript ingest, claim extraction
packages/llm          OpenAI wrapper: schema-validated output, disk cache, cost accounting
packages/eval         measurement — slices, gates, the LongMemEval judge, baselines
packages/server       HTTP API over the library (@effect/platform HttpApi)
apps/demo             Vite + React demo: receipt, evidence, scrubber, live ingest
```

The LongMemEval files live in the gitignored `data/` (`longmemeval_oracle.json`, 15 MB;
`longmemeval_s_cleaned.json`, 265 MB). `PALIMPSEST_DATA_DIR` overrides where they are looked for.

## Prerequisites

- Node ≥ 22 and pnpm 11
- A local HydraDB node in Docker. From **PowerShell** (never Git Bash — MSYS rewrites paths inside
  `-e`/`-v` values):

  ```powershell
  docker start hydradb
  ```

  Bolt on 7687, HTTP query API on 8443, readiness and metrics on 9090.

Client configuration, all with working local defaults: `HYDRA_URL` (`http://127.0.0.1:8443`),
`HYDRA_TOKEN`, `HYDRA_GRAPH` (`default`), `HYDRA_CELL` (`cell-0`).

## Commands

```bash
pnpm install
pnpm test         # every project: hermetic unit tests + the live probe suite
pnpm test:unit    # unit tests only — no network, runs anywhere
pnpm probe        # the live probe suite against the HydraDB node on :8443
pnpm typecheck    # tsc --build across the workspace

# one benchmark user's verbatim transcript into HydraDB, then read a turn back
pnpm ingest-transcript --uid gpt4_2655b836 --dataset oracle --reset
pnpm turn --uid gpt4_2655b836 --sid answer_4be1b6b4_1 --idx 0

# the day-1 gate: extraction recall vs has_answer on a stratified oracle slice
pnpm extract --slice 20 --concurrency 8 [--misses]

# a whole benchmark user: transcript, claims, entities, slots, tokens, edges
pnpm ingest --uid 37d43f65 --dataset s
pnpm stats  --uid 37d43f65 --slots

# supersession chains, with CURRENT / SUPERSEDED labels, optionally as of session k
pnpm slots --uid 852ce960 [--as-of 4] [--all]

# the whole read path: verdict, receipt, evidence, answer
pnpm ask --uid 852ce960 --date "2023/05/20 (Sat) 02:21" --question "..." [--as-of 4] [--full]

# what the memory believed at every session, for one question
pnpm trajectory --uid 852ce960 --question "..." --date "2023/12/20 (Wed) 12:00"

# the day-3 gate over a stratified slice of real haystacks
pnpm ingest-slice --slice 20 --dataset s --users 4 --prefix g2
pnpm retrieval-metrics --slice 20 --prefix g2 [--misses]

# give users ingested before the User vertex existed their counts and HAS_* edges
pnpm backfill-user --prefix g2 --slice 20 --uid 852ce960,37d43f65

# answer accuracy: ask -> reader -> the official LongMemEval judge, per system
PALIMPSEST_LLM_CONCURRENCY=48 pnpm ingest-slice --slice 100 --dataset s --users 3 --prefix g2
pnpm eval --slice 100 --system palimpsest|palimpsest-premise|bm25|fullctx|all --prefix g2

# the API, and a smoke run of ingest -> ask -> slots on a fresh user
pnpm serve                       # :8787
pnpm smoke                       # against a running server

# the demo — needs `pnpm serve` in another terminal
pnpm demo                        # http://localhost:5173
```

`--slice N` means the same N questions to ingest, to the retrieval gate and to the answer harness.
Below 30 it is the stratified slice the day-1/day-3 gates were measured with, unchanged; at 30 and
above it is all thirty `_abs` questions plus a stratified remainder, because abstention is what this
benchmark is for and a stratified 100 picks up only whichever `_abs` ids sort early.

`pnpm probe` needs the Docker node running; `pnpm test:unit` does not. The live suites and
`pnpm extract` read `OPENAI_API_KEY` from the gitignored `.env` at the workspace root.

## `packages/hydra`

Seven operations, and nothing about the Cypher subset leaks past them:

| Operation | What it hides |
|---|---|
| `query(cypher, params?, opts?)` | typed-cell decoding, bookmark threading, typed errors |
| `batchMerge(label, rows)` | `UNWIND … MERGE`-by-id + `SET`, grouping rows by property signature, 1 MB body chunking |
| `batchRel(relType, rows)` | `UNWIND MATCH,MATCH MERGE`, edge-id derivation, the "cannot update relationship id" rule |
| `msPaths(config)` | inlining string lists as escaped literals while scalars stay `$params`, the `maxLen ≤ 16` cap |
| `getById(label, key, props)` | key→id hashing, and the fact that this is the only cheap per-vertex read |
| `deleteByKeys(keys)` | batched `DETACH DELETE` |
| `lastBookmark` | the causal floor from the last write, replayed into the next read |

It also hides the **1024-row wall**. HydraDB returns at most 1024 rows per response and hands back a
`next_cursor` when there are more — including from `algo.MSpaths`, which cannot take `SKIP`/`LIMIT`
at all. Ignoring that cursor does not fail; it silently truncates, which for a retrieval system means
recall quietly capped with no error anywhere. Every read here follows the cursor to exhaustion, and
continuing needs **both** the cursor and the originating `query_id` — the cursor alone answers
`result cursor does not belong to this query request`.

It hides two more caps of the same shape, both found by measurement rather than by an error.
**`MATCH (n:Label) WHERE n.prop = $value` is a full label scan** — the engine indexes vertex ids and
`MSpaths` source values, and nothing else — so it costs ~100 µs for every vertex of that label in the
*whole store*, however few of them belong to the user asking. Counting one user's Claims took 4.4 s
at 58 k Claims and one user's Tokens 9.5 s, against ~100 ms to read the same vertex by id; at the
500-user scale those sit past the engine's 30 s cap. And a **source-only `algo.MSpaths` walk returns
one path per source** unless `pathCount` is raised: the walk from the `User` root over `HAS_SESSION`
returned 1 of 39 sessions and reported nothing wrong. A constant-valued target selector is exempt
from that — which is what `Claim.kind` is for — *and* is the faster plan, so the client raises
`pathCount` on source-only walks only. `packages/hydra/test/live/byid.probe.test.ts` pins both.

Vertex ids are content-addressed from the key string: the top 53 bits of `SHA-256(key)`. The spec
says `xxhash64`; the width is narrower because HydraDB node ids travel as JSON numbers, which cannot
carry a full u64. Same property (stable id per key), ~5e-5 birthday collision probability at 10^6
vertices.

The probe suite in `packages/hydra/test/live` is the executable version of the probe table in the
review: the `pathCount`-per-source recall trap, the constant-property target selector, unknown
anchors being skipped silently, edge-property `WHERE` for as-of reads, `STARTS WITH $param`, and
parse errors carrying the engine's own reason text.

## `packages/dataset`

`parseQuestion` turns a raw LongMemEval record into typed sessions and turns, and assigns
`session_ord` **by timestamp** — 211 of the 500 `_s_cleaned` questions and 34 of the 500 oracle
questions list their sessions out of chronological order, and ties keep file order so the ranking is
reproducible. `has_answer` is preserved (absent means false, which is how the S file encodes it), as
is `answer_session_ids`, because the eval harness scores retrieval against them without a judge.

## `packages/palimpsest`

`Transcript` writes `Session`, `Turn` and `HAS_TURN` under one user's key prefix and reads turns
back. Two things it hides:

- **Key prefixing.** Every key starts `uid|`, because the local token is scoped to one graph, so all
  500 benchmark users share it. `Keys.ts` is the only place a key is built.
- **Turn chunking.** HydraDB stores at most **32 743 UTF-8 bytes** in a string property (measured by
  bisection; over that the write fails with an opaque 500). Four of the 246 750 turns in
  `longmemeval_s_cleaned.json` are longer — and they are exactly the long assistant outputs the
  `single-session-assistant` questions ask about. A long turn keeps its first chunk on the `Turn`
  vertex and hangs the rest off `HAS_CHUNK`; `readTurn` reassembles it, so Span offsets stay
  absolute and no caller learns this happened.

`Extract` turns one session into Claims with one LLM call. The model is **not** asked for character
offsets — it is asked to copy the supporting words verbatim, and the Span is located here. Three
tiers, each reported rather than hidden: exact `indexOf`, then whitespace-normalised, then
markdown-normalised (models reliably drop `**bold**` when quoting; adding that tier cut dropped
spans from 128 to 15 on the dev slice). A quote that still cannot be located is dropped and counted,
never written with a guessed offset.

## `packages/llm`

One operation: `generateObject({kind, system, prompt, schema, objectName})` returns a
schema-validated value. Every call is cached on disk under `.cache/llm` keyed by
`sha256(model + system + prompt + jsonSchema)`, so re-running any experiment makes zero API calls
and produces exactly the same graph — a prompt edit is a cache miss by construction. Usage is
accumulated so every run can print its own cost. Default model `gpt-5.6-luna`
(`PALIMPSEST_MODEL` overrides); concurrency is gated by one process-wide semaphore
(`PALIMPSEST_LLM_CONCURRENCY`, default 8).

## `packages/eval`

`stratifiedSlice` takes questions round-robin across the six question types in `question_id` order,
so a slice is deterministic and never misses a type. `questionRecall` measures **extraction recall
vs `has_answer`**: the fraction of answer-bearing turns that at least one Claim's Span points into,
micro-averaged over turns. A turn no Claim points at can never be surfaced whatever retrieval does,
so this number is the ceiling on everything downstream.

### Day-1 gate result

`pnpm extract --slice 20` on the oracle file, `gpt-5.6-luna`, 20 questions / 33 sessions:

| question type | recall | answer turns | covered |
|---|---|---|---|
| knowledge-update | 100.0 % | 6 | 6 |
| multi-session | 100.0 % | 9 | 9 |
| single-session-assistant | 100.0 % | 3 | 3 |
| single-session-preference | 83.3 % | 6 | 5 |
| single-session-user | 100.0 % | 2 | 2 |
| temporal-reasoning | 100.0 % | 7 | 7 |
| **ALL** | **97.0 %** | **33** | **32** |

Gate is ≥ 90 %: **pass**. 1 676 claims (1 213 from assistant turns, 441 filling a slot), 15 dropped
spans, $0.31 of tokens for the whole slice. A second run makes zero API calls and prints the same
numbers in 0.1 s.

### Claim graph writes

`ClaimGraph` turns a session's Claims into `Claim`, `Entity`, `Slot` and `Token` vertices and the
`EVIDENCE`, `MENTIONS`, `FILLS`, `HITS` and `NAMES` edges. `Ingest` drives a whole user:

- **Extraction fans out; writes are ordered.** A session is extracted knowing nothing about the
  user, so its LLM call is keyed purely by its own content and is shared by every user whose
  haystack contains it. That is the session-hash cache — LongMemEval_S references 23 867 sessions of
  which 19 195 are distinct — and it is also why a 48-session haystack takes ~5 minutes instead of
  ~30: the 48 calls go out at once.
- **Canons are decided once, for the whole ingest**, by grouping entities into connected components
  over their match keys (stems of the canon and every alias, sorted). It has to be a fixpoint:
  a re-ingest reconciles the same claims against what the last one wrote, and a sequential
  "first canon to claim a key wins" pass is not one — an entity registered late can introduce a key
  an earlier entity would have matched, leaving one entity's alias standing as another's canon,
  which the next run then merges.
- **Derived counts are computed while writing, not read back.** `Token.df` and `Slot.n_claims` would
  otherwise need `MATCH (t:Token)-[:HITS]->(c:Claim) … count(*)`, which joins every token against
  every claim in the store and exceeds the engine's 30 s cap as soon as a few users share the graph.
- **Every per-user read is id-keyed.** There is a `User` vertex per history, keyed `uid|user`,
  carrying the counts (`n_claims`, `n_entities`, …) and rooting `HAS_ENTITY`, `HAS_SLOT` and
  `HAS_SESSION`. `stats` is one ~100 ms read of that vertex instead of six label scans; the entity
  list an ingest reconciles against, the contested slots, and the session list the as-of scrubber
  walks are one `MSpaths` hop each. The counts are written at the end of the ingest that produced
  them — nothing derived is ever recomputed by joining the store. `pnpm backfill-user` gives the
  vertex and its edges to a user ingested before it existed, by running the old scans exactly once.

Measured on a 49-session, 533-turn haystack (`37d43f65`): **cold 295 s, warm 33 s** against budgets
of 10 and 3 minutes; 1 985 claims, 1 806 entities, 325 slots, 4 414 tokens, 51 slots holding ≥ 2
claims. A second ingest reproduces **every count exactly** and makes zero API calls.

One engine characteristic worth knowing before building on it: `DETACH DELETE` retires about
**2.3 vertices per second**, flat in vertex degree, so the 30 s cap allows ~65 vertices per
statement and deleting a whole user is an hours-long operation. Every write here is
content-addressed and idempotent precisely so that re-ingest never needs a reset.

### Supersession

`Supersede` runs after a user's claims are written, over the slots that ended up holding more than
one claim. One LLM call per slot sees the whole *ordered* history and returns which claims
**replace** which — never pairwise as claims arrive, because whether a claim replaces another is only
decidable against the slot's history: two hobbies in one slot are additive, two addresses are not.
Edges are only ever added, so the as-of scrubber can walk the chain backwards and a re-run writes the
same content-addressed edges over themselves.

The model works in 1-based positions, not claim keys, so the prompt carries no `uid` and an identical
slot history is **one cache entry shared by every user that has it**. Structural rules are enforced
here, not asked of the model: an edge must point forward in the slot's history, `at_session` is the
newer claim's session, and a slot with one claim is never sent.

On `852ce960`, a `knowledge-update` question asking what the user was pre-approved for:

```
mortgage | price
  SUPERSEDED@37   s 3  The user was pre-approved for a $350,000 loan from Wells Fargo.
  CURRENT         s 3  The assistant assumed the user would finance $300,000 …
  CURRENT         s37  The user was pre-approved for a $400,000 mortgage from Wells Fargo.
```

`--as-of 4` replays the same slot as the memory held it at session 4, before the second amount
existed. That is data-level: two integer comparisons, no snapshot and no bookmark.

Slots are the one place the extraction prompt has to be strict. A first version let every preference
become `me | preference`, which collected 100+ unrelated claims in one slot and made both
supersession and slot expansion useless. A preference now belongs to the thing it is about
(`headspace | preference`), and only genuine properties of the person (`residence`, `employer`, …)
use `me`.

### A note on regenerating a graph

The graph is additive and `DETACH DELETE` is impractical here, so **changing the extraction prompt
does not replace the old claims — it adds a second generation beside them**, and `Token.df`, counted
for the current generation, then disagrees with the edges actually present. The supported way to get
a clean graph is a fresh key prefix: `pnpm ingest --uid <question_id> --as <new-prefix>`. Extraction
is content-addressed, so the LLM calls are served from cache and a re-key costs cents.

## Retrieval and reading

A question becomes anchors — the deterministic stems of the question, unioned with the LLM's
synonyms and hypernyms, because the write side expands too and the exact-match join in the middle
only happens if both do. Then two bounded round trips:

**Query 1** walks `Token -[HITS|NAMES|MENTIONS]-> … -> Claim` from those anchors to every Claim of
the user, with the constant `kind` target selector so every source→claim pair comes back rather than
one path per source. Relevance is **convergence** — how many *distinct* anchors reached the same
claim — tie-broken by Σ idf, where `idf = log(1 + N/df)` and `df` came off the hydrated path.

**Query 2** walks from the candidates' Slots back down `FILLS`, so a knowledge-update question sees
the value that was replaced as well as the one that replaced it. Nothing is queried per claim.

The verdict is structural: `A1` no anchor of the question exists in this user's graph, `A2` anchors
exist but no claim is reached by at least `min(2, |anchors|)` of them — one named threshold, printed
in every receipt. The receipt also carries the exact query text and parameters, which anchors
resolved and which reached nothing, the path counts, and the convergence table, which is enough to
re-run the read by hand and get the same paths.

The **reader never sees a Claim's text.** A Claim is an index entry — a paraphrase produced by an
earlier model — and answering from it would make the system a summary of a summary. What the reader
gets is the verbatim turn text around each Span (± 300 chars), labelled CURRENT or SUPERSEDED, in
event-date order. It answers only from that, does date arithmetic explicitly, and returns exactly
`NOT_IN_MEMORY` when the spans do not hold the answer — reported distinctly from the structural
A1/A2, because they mean different things: nothing was reachable, versus the right spans were
reached and did not contain it.

Worked example on `852ce960`, a knowledge-update question:

```
$ pnpm ask --uid 852ce960 --question "What was the amount I was pre-approved for …?"
VERDICT        ANSWER
ANSWER         $400,000
cited          7d6fafd1
...
  threshold    convergence >= 2
  anchors      13 asked, 11 reached a claim
    unresolved preapproval wf
  query 1      162 paths      query 2  15 paths

$ pnpm ask --uid 852ce960 --as-of 4 --question "…"
ANSWER         $350,000
```

Same graph, same question, two different answers — because as-of is a filter over `session_ord` and
`at_session`, not a database snapshot.

### Day-3 gate result

`pnpm retrieval-metrics --slice 20 --prefix g2` — the stratified 20-question slice of
**LongMemEval_S**, i.e. real haystacks with 46–57 sessions each and ~40 000 claims across the 20
users, not the oracle file:

| question type | n | SessionRecall@25 | false-abstention |
|---|---|---|---|
| knowledge-update | 3 | 100.0 % | 0.0 % |
| multi-session | 4 | 100.0 % | 0.0 % |
| single-session-assistant | 3 | 100.0 % | 0.0 % |
| single-session-preference | 3 | 100.0 % | 0.0 % |
| single-session-user | 2 | 100.0 % | 0.0 % |
| temporal-reasoning | 3 | 100.0 % | 0.0 % |
| **ALL answerable** | **18** | **100.0 %** | **0.0 %** |

Gates are ≥ 85 % and ≤ 10 %: **both pass**, and no widening lever was needed. 14.7 of 16.4 anchors
resolve per question, 24.9 evidence claims per question, median latency **0.12 s** — 20 questions
end to end in 0.6 s. A second run reproduces every number for $0.00.

That latency is the id-keyed reads. It was **5.8 s** when the same 100 % / 0 % was first measured,
and essentially all of it was one `MATCH (c:Claim) WHERE c.uid = $uid RETURN count(*)` per user —
the idf denominator, scanning every Claim in the store for a number the ingest already knew. The
first ask against a user after the node has been idle still costs ~14 s at the median while HydraDB
faults the traversal into its page cache; that is the engine's cache, not our read path, and it is
the number the demo warms up before recording.

**Where it is weak, stated plainly.** Structural abstention (`A1`/`A2`) fired on **neither** of the
two `_abs` questions in the slice. With ~2 000 claims per user and ~15 resolved anchors, something
always converges, so the structural verdict does not carry abstention on a well-populated graph —
it carries *proof of what was searched*. Abstention is caught one layer later, by the reader:

- `0862e8bf_abs` — *"What is the name of my hamster?"* (the user has a cat) → retrieval reached 2
  claims, reader returned **NOT_IN_MEMORY**. Correct.
- `031748ae_abs` — *"How many engineers do I lead as Software Engineer Manager?"* (the user is a
  Senior Software Engineer, never a manager) → answered **"5"**. Wrong: the count is real, the
  premise is not.

So on this slice abstention recall is 1/2 from the reader and 0/2 from the structure. The honest
claim is not "we abstain better", it is "we can show exactly what was searched and what was found" —
and false-premise questions are the open problem.

### The as-of trajectory

`pnpm trajectory` asks one question as of every session in turn. One graph, no re-ingest, no
database snapshot — as-of is nothing but `session_ord ≤ k` and `at_session ≤ k`:

```
> as of s 1  20230712   0 ev   NOT_IN_MEMORY
  as of s 2  20230802   0 ev   NOT_IN_MEMORY
> as of s 3  20230811  15 ev   $350,000
  …                            $350,000
> as of s37  20231130  17 ev   $400,000
  as of s38  20231211  17 ev   $400,000
  as of s39  20231214  17 ev   $400,000

distinct answers   3
  from session  1: NOT_IN_MEMORY
  from session  3: $350,000
  from session 37: $400,000
```

Before the fact was ever stated the memory says so, rather than leaking a value it will only learn
later. That is the property a snapshot-free as-of has to earn, and it is the one the scrubber shows.

## `packages/server`

Five endpoints over `@effect/platform` `HttpApi`, with request and response schemas defined once so
the demo shares the types rather than re-declaring them:

| Endpoint | What it does |
|---|---|
| `POST /users/:uid/sessions` | ingest one session — claims written, supersessions, bookmark |
| `POST /users/:uid/ask` | `{question, questionDate?, asOf?, historical?, premiseCheck?}` → verdict, answer, evidence with spans, receipt, hash |
| `GET /users/:uid/sessions` | the session list the as-of scrubber runs over |
| `GET /users/:uid/slots/:skey` | one slot's supersession chain, optionally as of session *k* |
| `GET /users/:uid/stats` | the counts, and the slots holding ≥ 2 claims |

Errors are structured: `GraphError` (503) carries HydraDB's own reason text, which is precise enough
to act on; `NotFound` (404); `BadRequest` (400).

`Ingest.ingestSession` is the path this needed and `ingestUser` could not provide. A whole-user
ingest *overwrites* `Token.df` and `Slot.n_claims` with the counts of its own run, which is correct
precisely because its run is the whole history; one session arriving later has to add to counts the
rest of the history already contributed to. Two decisions fall out of that:

- **Append-only `session_ord`** (`User.n_sessions + 1`). Inserting into the middle would renumber
  every later session and invalidate every `at_session` on every supersession edge — and edges here
  are only ever added. A backdated import needs a re-ingest under a fresh prefix.
- **Idempotent by session.** The vertex writes are content-addressed and would be idempotent
  anyway; the *counts* are not, so the Session vertex is checked by id first. Without that, posting
  the same session twice would inflate every `df` it touched and quietly change the idf of every
  later question.

```
$ pnpm smoke
  ok    ingest session 1                   ord 1, 9 claims, 0 dropped
  ok    ask sees the new claims            9 evidence, 24 paths
  ok    reader answers from the span       Nibbles
  ok    ingest session 2                   ord 2, 6 claims, 1 supersessions
  ok    re-posting a session is a no-op    claims still 15
  ok    answer follows the newer claim     Pretzel
  ok    as-of 1 replays the old belief     Nibbles
  ok    same question, same hash           4181cb60fc7323f786fbfeca…
  ok    slot chain                         hamster | pet_name — 3 claims, 1 superseded
SMOKE PASSED
```

The ask after each ingest has no sleep and no retry. One `HydraClient` in the process holds the
bookmark from the last write and replays it into the next read, so ingest→ask is read-your-writes
without either endpoint knowing.

## `apps/demo`

Vite + React, opening on `852ce960` and its mortgage question so the first frame already has a
three-step chain to scrub. Run `pnpm serve` first; the dev server proxies `/api` to it.

The panels exist to make the design's claims checkable rather than to summarise them. The receipt
shows the actual `algo.MSpaths` statement, the anchors that reached a claim beside the ones that
reached nothing, the path counts and the convergence table. The evidence list renders verbatim turn
text with the span marked — never a Claim's text, because a Claim is an index entry and showing it
would make the demo a summary of a summary. The chain strikes through whatever a `SUPERSEDED_BY`
edge points out of, and the as-of slider changes which edges are visible without touching the graph.

Three presets, because they land in three different places on this user and the difference is the
point:

| Question | Outcome |
|---|---|
| *"What was I pre-approved for…?"* | **ANSWER $400,000** — 29 spans, 13/15 anchors, 287 paths |
| *"What breed is my Bernese mountain dog?"* | **ABSENT A2** — 0 spans, 3/7 anchors: structural, with the receipt as proof |
| *"How many engineers do I manage?"* | **reader NOT_IN_MEMORY** — 65 spans, 15/16 anchors: the right text was reached and did not contain it |

`docs/video-script.md` is the sub-5-minute run-through.

