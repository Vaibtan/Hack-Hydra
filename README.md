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

## Layout

```
packages/hydra        HydraDB HTTP client — a deep module over the Cypher subset
packages/dataset      LongMemEval loader — typed questions, sessions, turns
packages/palimpsest   the memory layer itself — keys, transcript ingest, claim extraction
packages/llm          OpenAI wrapper: schema-validated output, disk cache, cost accounting
packages/eval         measurement — slices and the extraction-recall metric
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
```

`pnpm probe` needs the Docker node running; `pnpm test:unit` does not. The live suites and
`pnpm extract` read `OPENAI_API_KEY` from the gitignored `.env` at the workspace root.

## `packages/hydra`

Six operations, and nothing about the Cypher subset leaks past them:

| Operation | What it hides |
|---|---|
| `query(cypher, params?, opts?)` | typed-cell decoding, bookmark threading, typed errors |
| `batchMerge(label, rows)` | `UNWIND … MERGE`-by-id + `SET`, grouping rows by property signature, 1 MB body chunking |
| `batchRel(relType, rows)` | `UNWIND MATCH,MATCH MERGE`, edge-id derivation, the "cannot update relationship id" rule |
| `msPaths(config)` | inlining string lists as escaped literals while scalars stay `$params`, the `maxLen ≤ 16` cap |
| `deleteByKeys(keys)` | batched `DETACH DELETE` |
| `lastBookmark` | the causal floor from the last write, replayed into the next read |

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
