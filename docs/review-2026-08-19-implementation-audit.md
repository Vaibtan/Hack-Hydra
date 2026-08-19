# Palimpsest — implementation audit (2026-08-19, after the overnight session)

Scope: tickets #1–#7, #9 as implemented on `main` at `65bf5d1`, reviewed against
`docs/spec-palimpsest.md`, the handoff note, and the live HydraDB node. Read this before starting
#8; the first finding changes how #8 has to be run.

## 0. Verdict in three lines

- The *design* is implemented and honest: verbatim spans, content-addressed idempotent writes, cursor
  paging, convergence verdict, data-level as-of, a reader that never sees claim text. Typecheck and
  the 96 unit tests pass. The handoff's numbers reproduce where I could reproduce them.
- **One blocker for scaling past ~30 users.** Every `MATCH (n:Label) WHERE n.uid = $uid` read is a
  store-wide label scan (~75 µs per vertex of that label in the *whole* store), not an indexed
  lookup. There are eleven of them on the product path. At today's graph (26 users, 58 k claims)
  `retrieval-metrics` already **fails its pre-flight with a 30 s timeout** (§1), every `ask` pays
  ~4 s for the idf claim count, and `readSessions` takes 19 s. At 100 users they exceed the cap
  outright. Fix is mechanical (§2.1) and must land before the #8 ingest.
- Four correctness/design issues worth fixing now (§2.2–2.5), several #8/#10 gaps the tickets don't
  spell out (§3), and a short list of things that look wrong but must be left alone because touching
  them invalidates the $10 extraction cache (§4).

## 1. What was verified, and how

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:unit` | 12 files, 96 tests green |
| `pnpm test:live` | 11 files, 37 tests green — in **711 s** (the suites pay the label scans of §2.1 on every `stats`/`readEntities`/`readSessions` call) |
| `pnpm retrieval-metrics --slice 20 --prefix g2` (the day-3 gate, from cache) | **fails before measuring**: `HydraLimitError … client_query_runtime exceeded query timeout after 30000 ms` from the pre-flight `claimCount` loop (20 users × `MATCH (n:Claim) WHERE n.uid = $uid RETURN count(*)` at concurrency 4) |
| Timed by hand with `curl` against the node (warm, quiescent) | `MATCH (n:Claim) WHERE n.uid = '…' RETURN count(*)` **4.4 s** (58 211 Claims in store) · same on `Token` **8.7 s** · on `Entity` **4.9 s** · `MATCH (n:Slot) WHERE n.uid AND n.n_claims >= 2` 0.9 s · `readSessions` join **19.2 s** · `MATCH (n {id: <n>}) RETURN …` **80–110 ms** · Query-1 `MSpaths`, 7 anchors, maxLen 2: 8.6 s cold, **110 ms warm** |

So: **MSpaths is fast; the label scans are the latency.** The handoff's "median 5.8 s per ask" is
almost entirely the `totalClaims` scan that `Retrieve.ask` runs once per uid per process. The
real retrieval cost is ~0.1–2 s. That is good news for the pitch and must be re-measured after the
fix.

## 2. Findings, ranked

### 2.1 BLOCKER — per-user reads are store-wide label scans

**Where** (every line is a scan proportional to the label's *store-wide* population):

| File:line | Statement | Called from |
|---|---|---|
| `Retrieve.ts:97` | `MATCH (c:Claim) WHERE c.uid … count(*)` | every `ask` (memoised per uid per process) — the idf denominator |
| `ClaimGraph.ts:352` `claimCount` | same | `retrieval-metrics` pre-flight, 20–100× per run |
| `ClaimGraph.ts:359` `stats` | six label counts + two Slot scans | **end of every `ingestUser`** — a timeout here marks a fully written user as FAILED in `ingest-slice` |
| `ClaimGraph.ts:71` `readEntities` | `MATCH (e:Entity) WHERE e.uid` | **start of every `ingestUser`** (canon reconciliation) |
| `Supersede.ts:263` `contestedSlots` | `MATCH (s:Slot) WHERE s.uid AND n_claims >= 2` | `slots` CLI, future #10 slot endpoint |
| `Transcript.ts:194` `readSessions` | `MATCH (s:Session)-[:HAS_TURN]->(t:Turn) WHERE s.uid` (a join) | `trajectory`, `ingest-transcript`; #10 list-sessions; #12 scrubber |
| `Transcript.ts:164` `readTurn` | `MATCH (t:Turn) WHERE t.turn = $key` | `turn` CLI, tests |
| `bin/stats.ts:39,50` | Token top-df, Claim→Slot join | diagnostics only |

**Why it matters now.** #8 ingests ~100 users (→ ~250 k Claims, ~500 k Tokens, ~200 k Entities).
At 75 µs/vertex that is ~19 s per Claim count, ~40 s per Token count, ~15 s per Entity read — every
ingest will fail at `stats`, every ask will time out at `totalClaims`. The 500-user run (#13) is 5×
worse. This is the same class of bug as the 1024-row wall: silent until the graph is big enough, then
total.

**Fix — make every per-user read an id-keyed read.** The engine resolves `{id: …}` in ~80 ms
regardless of store size (measured), and `MSpaths` from an explicit source list is index-driven.
Add one vertex and three edge types:

- `User` vertex, key `uid|user` (add `userKey(uid)` to `Keys.ts`), properties
  `uid, n_claims, n_entities, n_slots, n_tokens, n_sessions, n_turns, n_contested, n_supersessions`,
  written (MERGE by id + SET) at the end of `Ingest.ingestUser` from the counts the ingest already
  accumulates in memory (`tokenDf`, `slotClaims`, `extractions`, `supersessions.edges`). Nothing new
  is counted; the numbers that `stats` scans for are all already known at write time.
- Edges `(User)-[:HAS_ENTITY]->(Entity)`, `(User)-[:HAS_SLOT]->(Slot)`, `(User)-[:HAS_SESSION]->(Session)`,
  written in `writeSession` / `Transcript.ingest` alongside the vertices they point at (idempotent,
  same `batchRel`).
- Then: `claimCount`, `totalClaims`, `stats` → `MATCH (u:User {id: $id}) RETURN u.*` (one call;
  `vertexId(userKey(uid))` computed client-side — add a `getById(label, key)`/`readByKeys` helper to
  `HydraClient` so callers never hash). `readEntities` → `msPaths({sourceLabel:'User', sourceProperty:'ukey',
  sourceValues:[userKey(uid)], relTypes:['HAS_ENTITY'], relDirection:'outgoing', maxLen:1})`.
  `contestedSlots` → same over `HAS_SLOT`, filter `n_claims >= 2` client-side. `readSessions` →
  `HAS_SESSION` maxLen 1 for the session rows (carry `turns` as a Session property written at
  ingest — `n_turns` — instead of `count(*)` over the join). `readTurn` → `MATCH (t:Turn {id: $id})`.
- **Incremental counts** (needed by #10's single-session ingest): `n_claims` etc. on `User` become
  read-modify-write by id, which is cheap. `Token.df` is the one derived count that a single-session
  ingest cannot recompute from memory — see §3.2.
- **Backfill the existing `g2` slice** rather than re-ingesting: a one-off `pnpm backfill-user --prefix g2`
  that runs the slow scans *once* per user (they still work at 26 users) and writes the `User` vertex
  and the three edge types. ~2 min per user, no LLM calls. Re-keying to `g3` is the alternative and
  costs the same wall clock with zero LLM spend (extraction is content-addressed); pick backfill
  so the handoff's numbers stay attached to the same keys.
- Add a live probe to `packages/hydra/test/live` that asserts a by-id read and a `WHERE uid` count
  over the same vertex differ by >10× — so this engine fact is executable, and add the row to the
  engine-limit table in `CONTEXT.md`: *`MATCH (n:Label) WHERE n.prop = $v` is a full label scan
  (~75 µs/vertex store-wide); only `{id: …}` and `MSpaths` source lists are index-driven.*

**Re-measure after the fix**: latency in `retrieval-metrics` should drop from ~5.8 s median to
well under 2 s; record the new number in README §"Day-3 gate result".

### 2.2 HIGH — as-of is applied *after* the verdict and the top-K cut

`Retrieve.ask`: `decide(reached, …)` and `rank(reached).slice(0, topK)` run over **all** claims,
including those with `session_ord > asOf`; only `applyAsOf` (after slot expansion) drops them. Three
consequences: (a) the receipt of an as-of ask — convergence table, `anchorsResolved`, A1/A2 — is
computed on claims the memory is supposed not to have yet, so the receipt lies for every scrubber
position; (b) top-K is consumed by future claims, so as-of recall degrades for early `k` (the
trajectory still showed `NOT_IN_MEMORY → $350k → $400k` only because evidence happened to survive
the cut); (c) the idf denominator is the full-history count. The spec §3.4 lists as-of as step 5,
so the code follows the spec; the spec is wrong here.

**Fix** (three lines plus a unit test): in `ask`, when `options.asOf` is set, filter `reached` to
`sessionOrd <= asOf` *before* `decide`/`rank`, and compute `resolved` from the filtered set. Keep
`applyAsOf` for the supersession-edge visibility and slot-mates. Add a `Scoring` unit test: a future
claim with convergence 5 must not appear in the as-of-3 candidates or receipt. Then re-run `pnpm
trajectory` on `852ce960` and confirm the same three answers. Write the correction into the spec §3.4
as a one-line erratum.

### 2.3 HIGH — #8's 100-question slice will not contain the 30 `_abs` questions

`stratifiedSlice` round-robins the six `question_type`s in `question_id` order; `_abs` questions
share their base type, so a 100-slice picks up whichever `_abs` ids sort early (the 20-slice got 2).
#8's acceptance criterion is "all 30 `_abs`". Add `evalSlice(questions, {answerable: 70, allAbstention: true})`
to `Slice.ts`: all `isAbstention` questions + a stratified 70 of the rest, stable order. Keep
`stratifiedSlice` for the day-1/day-3 gates (their numbers depend on it). Unit-test the count and
determinism.

### 2.4 MEDIUM — the reader is the only abstention that works, and it has no premise check

Confirmed from the handoff and the code: `A1`/`A2` never fire on a populated graph (≥ 2 anchors
always converge somewhere), and the reader prompt has no instruction to test the question's premise
against the evidence, so `031748ae_abs` answers "5" to a manager question for a non-manager. Cheapest
plausible fix, untested: add `premise_supported: boolean` + `premise_note: string` to the `Answer`
schema and a rule in `SYSTEM` — *"Before answering, check every presupposition of the question (that
the person has the thing, holds the role, did the event) against the excerpts; if one is contradicted
or absent, answer NOT_IN_MEMORY and say which"*. Changing the reader prompt only invalidates the
`read` cache (cents). **Measure it as an A/B on the 30 `_abs` + 70 answerable before adopting**:
abstention recall must rise without false-abstention on answerable questions rising above the 10 %
gate. Report both variants in the #8 table.

### 2.5 MEDIUM — `MAX_RESULT_PAGES = 200` is a silent cap

`Client.send` stops following the cursor after 200 pages (204 800 rows) and returns what it has —
the same silent-truncation shape as the 1024-row bug, just higher. Per-user Query 1 cannot reach it
today (≤ anchors × claims ≈ 40 k paths), but `stats`/`backfill`-style reads can. Make it an error:
`HydraLimitError({reason: "result exceeded 200 pages"})`. One-line change, one unit test on a faked
cursor.

### 2.6 LOW — smaller correctness notes (fix while passing)

- `Reader.renderPrompt` labels the excerpts "oldest first", but `orderEvidence` puts CURRENT before
  SUPERSEDED for non-historical questions, so the label is wrong exactly when it matters. Say
  "CURRENT first, then superseded; each group oldest first" (or sort purely by time and let the
  status label do the work). Reader-cache invalidation only.
- `Supersede.readEdges` does `byOlder.set(older, …)` per path; if the model ever returns `1→2` and
  `1→3` for the same slot (the prompt forbids it; the code does not), the label depends on path
  order. Keep the edge with the smallest `at_session`.
- `questionAnchors(question)` is called without the question date although it accepts one and asks
  the model for `time_ref`. Thread `question.questionDate.raw` through `AskOptions` → `Anchors`
  (changes the anchors cache key → ~$0.05 to rebuild for 100 questions; do it together with the
  reader change so both invalidations happen once).
- `A1` as implemented is "no anchor reached a claim", the spec's A1 is "no anchor token exists".
  The code comment acknowledges it; make the receipt field name say what it measures
  (`anchorsReachingClaims`) or split the two counts — the writeup will quote this.
- Extraction still renders `KNOWN ENTITIES FOR THIS USER: (none yet — this is the first session)` on
  every session and the system prompt says "the entities already known about this user". Stale
  after deviation #2. **Do not fix** — see §4.
- 53-bit ids: at the 500-user scale (~5 M vertices) the birthday bound is ~1e-3, not 5e-5. Acceptable;
  state the scale-correct number in README/CONTEXT.

## 3. Gaps the open tickets do not spell out

### 3.1 #8 eval harness

- The judge prompts must be copied **verbatim** from `evaluate_qa.py` in `github.com/xiaowu0162/LongMemEval`
  (fetch the file; do not type them from memory). Five templates: the default for
  `single-session-user|single-session-assistant|multi-session`, `temporal-reasoning` (off-by-one
  tolerance on day counts), `knowledge-update` (previous + updated value counts as correct),
  `single-session-preference` (rubric), and the abstention template for `_abs`. Upstream scores
  `'yes' in response.lower()`, judge `gpt-4o`, temperature 0. Add `gpt-4o` to the `judge` cache kind
  so re-runs are $0.
- `retrieval-metrics` never runs the `Reader`; the #8 harness must: `ask` → `reader.read(question,
  question.questionDate.raw, evidence)` → judge. Reader latency and *reader tokens* (the prompt
  size) are required columns; count prompt characters/4 or use the provider's usage per call — the
  `Llm` layer only aggregates usage, so add per-call usage to `Generated<A>`.
- **B1 BM25 top-10 turns**: implement BM25 in `packages/eval` over the user's turns (k1 = 1.5,
  b = 0.75, same `stems()` tokenizer so the comparison is about the index structure, not the
  tokenizer); feed the 10 turns to the *same* reader prompt. Dependency-free.
- **B2 full context**: a LongMemEval_S haystack is ~115 k tokens. Verify `gpt-5.6-luna`'s context
  window before assuming it fits; if it does not, the documented policy is "most recent sessions
  that fit, oldest dropped" and the table says so. B2 is ~100 × 115 k ≈ 11.5 M input tokens ≈ $2.3
  at current pricing for the 100-slice, ~$12 for 500.
- One `LlmLive(model)` layer per process: the harness needs luna (reader) and gpt-4o (judge) in the
  same run. `generateObject` takes the model from the layer; add an optional `model` override to
  `GenerateOptions` (it is already part of the cache key) or build two `Llm` layers and provide
  both under different tags. The first is less code.
- Output: `results/<system>-<slice>.json` (per question: id, type, verdict, reason, answer,
  judge verdict, evidence sessions, session hit, reader tokens, latency) + `results/table-<slice>.md`
  with the abstention column first, as #13 wants. Commit both.
- Ingest at `PALIMPSEST_LLM_CONCURRENCY=48`, `--users 7`, fresh prefix only if the extraction prompt
  changed (it has not). Budget ~$40 / 3–4 h for the 100-slice; the graph passes 1 M edges during it
  and cannot be reset without recreating the Docker volume — *say that in the run log*.

### 3.2 #10 HTTP API — the single-session ingest path does not exist yet

`Ingest.ingestUser` is whole-user: it extracts all sessions, reconciles all canons, writes, then
overwrites `Token.df` and `Slot.n_claims` with the counts of *this run*. A `POST /users/:uid/sessions`
that ingests one session needs `Ingest.ingestSession(uid, session)`:

1. `session_ord = (User.n_sessions) + 1` (from the `User` vertex, §2.1) unless the caller passes a
   date that sorts earlier — for the demo, append-only is fine and should be stated.
2. `transcript.ingest(uid, [session])`, `extractSession`, `reconcile(readEntities(uid), claims)`,
   `writeSession`.
3. `Token.df` **increment**: read the touched tokens by id (`UNWIND $rows AS row MATCH (t:Token {id: row.id}) RETURN t.tkey, t.df`),
   add this session's hits, MERGE back. `Slot.n_claims` likewise. `User.n_*` likewise.
4. `supersede.run(uid, touchedSlots)` — already supports a subset of slots.
5. Return `{claims, supersessions, bookmark}`; the `Retrieve` instance must **invalidate
   `claimCounts.get(uid)`** (or read the `User` vertex each time — 80 ms, simpler, do that).

Also: `bookmark` is threaded automatically inside one `HydraClient` instance, so read-your-writes
holds inside the server process without the client passing it; the API still returns it.

### 3.3 #12 scrubber / #13 scale

The scrubber needs `readSessions` (19 s today, §2.1) and `ask` per position; after §2.1 both are
sub-second. The determinism widget is already backed by `hash`. The 500-user run needs §2.1 and
the `MAX_RESULT_PAGES` error (§2.5); nothing else in the read path is store-size dependent.

## 4. Leave alone — cache-protected

Changing any of these invalidates the `extract` cache kind: **$10.65 and ~3 h to rebuild**, and a
second generation of claims beside the first (deletes are unavailable). Not worth it for the
remaining days:

- the extraction `SYSTEM` prompt and `renderPrompt` (including the stale "known entities" block);
- `ATTRIBUTE_VOCABULARY`, `ENTITY_TYPES`, the `RawClaim` schema;
- `claimTokens` / `stems` (changes every `tkey` — the whole graph would need a re-key, and the
  stemmer is shared with the question side, so a change is not a cache issue but a re-ingest).

The `supersede`, `anchors` and `read` cache kinds are cheap (cents) and may be changed freely.

## 5. Order of work for the next session

1. §2.1 (id-keyed reads + backfill + probe + CONTEXT row) — then re-run `retrieval-metrics --slice 20`
   and record the new latency. Nothing else is safe to scale before this.
2. §2.2, §2.3, §2.5 — small, test-covered.
3. #8 harness per §3.1, with §2.4 as an A/B inside it. 100-slice run. Table committed.
4. #10 per §3.2, #11, #12, #13 in ticket order.
