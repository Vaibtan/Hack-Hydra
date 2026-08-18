# Palimpsest — build spec (v1, 2026-08-17)

Agent memory layer for cross-session continuity on HydraDB. Track: *Context & Memory Systems*.
Supersedes the day plan in the handoff; incorporates `docs/review-2026-08-17-palimpsest-plan.md`.

Locked decisions: TypeScript + Effect only · HydraDB-only retrieval (no external index) · ~7 days ·
repo + writeup + recorded video · demo = benchmark replay **and** live ingestion · users partitioned
by key prefix in the single default graph · LLM = OpenAI `gpt-5.6-luna` unless stated.

---

## 0. One-paragraph thesis

The graph is an *index over verbatim transcript*, not a replacement for it. Every extracted claim
points at a `(session, turn, char_start, char_end)` span. Chronology is two indexed integers
(`session_ord`, `t_event`). Supersession is an explicit `SUPERSEDED_BY {at_session}` edge chain, so
"current" is structural (no outgoing edge as of session *k*). Retrieval is one bounded
`algo.MSpaths` call from question anchors to claims; relevance is **anchor convergence** (how many
distinct question anchors reach a claim within 2 hops), which is a structural, showable score.
Abstention is a structural verdict — no anchor resolves, or no claim is reached by enough anchors —
backed by the exact query and its empty/thin result. Given a fixed graph, retrieval is deterministic.

## 1. Glossary (use these words everywhere: code, tests, UI, writeup)

| Term | Meaning |
|---|---|
| **User** (`uid`) | One independent history. Benchmark: `question_id`. Live demo: a chosen id. All keys are prefixed `uid|`. |
| **Session** | One conversation, with a timestamp. `session_ord` = 1-based rank of the session by timestamp within the user (ties → input order). |
| **Turn** | One message in a session: `role`, `text`, `turn_idx`. Stored verbatim in HydraDB. |
| **Span** | `(sid, turn_idx, char_start, char_end)` into a Turn's text. The only thing a reader ever sees. |
| **Entity** | A canonical thing the user talks about (`hamster`, `charity 5k run`, `moma`). Key `ekey = uid|e|<canon>`. `me` is an entity but never an anchor. |
| **Slot** | `(entity, attribute)` that can hold a value over time, e.g. `me|residence`, `hamster|name`. Key `skey = uid|s|<entity canon>|<attr>`. |
| **Claim** | One extracted assertion: `text`, `speaker`, `ctype`, both clocks, one Span, fills ≤ 1 Slot, mentions ≥ 1 Entity. `kind = uid|claim` (constant, used as the MSpaths target selector). |
| **Anchor / Token** | A normalised content term (`tkey = uid|t|<stem>`) attached at ingest to Claims (`HITS`) and Entities (`NAMES`). Question anchors are Tokens too. |
| **Convergence** | Number of distinct question anchors that reach a Claim within `maxLen` hops. The relevance score. |
| **Supersession** | `(older)-[:SUPERSEDED_BY {at_session}]->(newer)` between two Claims in the same Slot. **Current** = no outgoing SUPERSEDED_BY with `at_session ≤ k`. |
| **As-of k** | A read that ignores Claims with `session_ord > k` and SUPERSEDED_BY edges with `at_session > k`. Data-level; not a HydraDB snapshot. |
| **Verdict** | `ANSWER` (evidence set + reader answer) or `ABSENT` (structural reason + the receipt). |
| **Receipt** | The exact MSpaths query text, resolved anchors (found/unknown), path count, and the convergence table — enough for a judge to re-run it. |
| **Bookmark** | HydraDB causal token returned by every write; passed on the next read so ingest→ask is read-your-writes. Not time-travel. |

## 2. Non-goals
BEAM / >1 M-token histories · multi-node HydraDB · Bolt driver (HTTP suffices; optional later) ·
auth/multi-tenant · full LoCoMo/other benchmarks · vector/BM25 anywhere in *our* read path (a BM25
baseline exists for comparison only) · beating the LongMemEval leaderboard.

## 3. Architecture

```
apps/demo (Vite + React)  ──HTTP──▶  packages/server (@effect/platform HttpApi)
                                            │
        packages/eval ─────────────▶  packages/palimpsest  (library: ingest · retrieve · read)
                                            │                    │
                                     packages/hydra          packages/llm
                                  (HydraDB HTTP client)   (@effect/ai-openai, disk cache)
                                            │
                                     HydraDB 0.1.0 (Docker, :8443)
```

pnpm workspace, TypeScript strict, Effect ≥ 3.x, Vitest. One `Layer` per external dependency
(`HydraClient`, `Llm`, `Clock`, `Config`) so tests swap them. Verify current package names/APIs with
`ctx7` before scaffolding (`effect`, `@effect/platform`, `@effect/ai`, `@effect/ai-openai`,
`@effect/schema` if still separate, `@effect/vitest`).

### 3.1 `packages/hydra` — deep module over the Cypher subset
Public surface (small on purpose):
```ts
query(cypher, params?, opts?: {bookmark?, timeoutMs?}) : Effect<Rows>
batchMerge(label, rows: {id, ...props}[])            // UNWIND MERGE by id + SET, chunked < 1 MB body
batchRel(relType, rows: {id, src, dst, ...props}[])   // UNWIND MATCH,MATCH CREATE, chunked
msPaths(cfg: {sourceLabel, sourceProperty, sourceValues[], targetLabel?, targetProperty?, targetValues?[],
              relTypes[], relDirection, maxLen, pathCount?, resultLimit?}) : Effect<Path[]>
lastBookmark(): Option<string>                        // threaded automatically into subsequent reads
```
Rules it hides: string lists in `MSpaths` are inlined into the query text (escaped); scalar config
uses `$params`; vertex ids are u64 = `xxhash64(key)`; every property is `Integer|SignedInteger|
Bool|Float|String` (dates as `YYYYMMDD` ints); one statement per call; body ≤ 1 MB; server caps
(`maxLen ≤ 16`, 30 s, 100 k result vertices). Decodes the typed response (`{"String":…}`,
`{"Integer":…}`, `type:"path"`) into plain TS. Errors: `HydraParseError` (surface the server's
reason verbatim — it is precise), `HydraLimitError`, `HydraUnavailable`.

### 3.2 Graph schema (all vertex ids = xxhash64 of the key string)

Vertices
| Label | key property (indexed) | other properties |
|---|---|---|
| `Session` | `sess = uid\|sess\|<sid>` | `uid, session_ord, date (int YYYYMMDD), ts (int epoch s)` |
| `Turn` | `turn = uid\|turn\|<sid>\|<idx>` | `uid, sid, session_ord, turn_idx, role, text` |
| `Entity` | `ekey` | `uid, name, etype ('person'\|'pet'\|'place'\|'org'\|'thing'\|'event'\|'topic'\|'self')` |
| `Slot` | `skey` | `uid, entity_ekey, attr` |
| `Claim` | `ckey = uid\|c\|<sha1(text+span)>` | `kind = uid\|claim`, `uid, text, speaker, ctype ('fact'\|'event'\|'preference'\|'assistant_output'), session_ord, t_event (int, 0 = unknown), t_prec ('day'\|'month'\|'year'\|'none'), sid, turn_idx, cs, ce, session_date` |
| `Token` | `tkey` | `uid, df` (document frequency = #claims it hits; rewritten each ingest) |

Edges (all directed; property `id` = xxhash64 of `src|type|dst`)
| Edge | Meaning |
|---|---|
| `(Session)-[:HAS_TURN]->(Turn)` | transcript structure (demo) |
| `(Claim)-[:EVIDENCE]->(Turn)` | span lives in this turn (`cs`,`ce` duplicated on edge) |
| `(Entity)-[:MENTIONS]->(Claim)` | claim is about entity |
| `(Claim)-[:FILLS]->(Slot)` | claim gives the slot a value |
| `(Token)-[:HITS]->(Claim)` | anchor term appears in claim text/keywords |
| `(Token)-[:NAMES]->(Entity)` | anchor term appears in entity name/aliases |
| `(Claim)-[:SUPERSEDED_BY {at_session}]->(Claim)` | newer claim replaces older in same slot |

Why `Turn` text lives in HydraDB: keeps the "HydraDB-only" property honest — hydration is an
`UNWIND $rows AS row MATCH (t:Turn {id: row.id}) RETURN t.text, t.role, …` batch read.

### 3.3 Ingest (per user, sessions in `session_ord` order; users in parallel)

For each session:
1. **Write transcript**: `Session`, `Turn`s, `HAS_TURN` (batched).
2. **Extract** (LLM, one call per session, structured output via Schema): input = session date,
   turns (both roles, with turn indices and char offsets), **the user's current entity list**
   (`name`, `etype`, aliases — read from graph; this is what keeps canon keys stable across
   sessions) and the attribute vocabulary. Output per claim:
   `{text, speaker, ctype, entities:[{canon, etype, aliases[]}], slot?: {entity_canon, attr},
     t_event?: 'YYYY-MM-DD'|'YYYY-MM'|'YYYY', span:{turn_idx, cs, ce}, keywords:[…]}`
   Rules baked into the prompt: extract from **assistant** turns too when the assistant produced
   content the user might later ask about (schedules, lists, code, recommendations); one claim per
   atomic fact; preferences are claims with `ctype='preference'`; `keywords` must include
   hypernyms/synonyms (jacket → clothing, apparel) — write-time query expansion; spans must be
   exact substrings (validate; on mismatch, fuzzy-locate or drop and log).
3. **Normalise**: entity canon = lowercase, singular, ASCII; `attr` snake_case from the vocabulary
   (`residence, employer, job_title, pet_name, weight, phone, email, plan, deadline, preference,
   count, …`) or free-form; tokens = stems of content words from `text ∪ keywords ∪ entity names ∪
   aliases`, stopwords removed, ≤ 24 per claim.
4. **Write** claims, entities, slots, tokens, edges (batched, idempotent by key). Update `Token.df`.
5. **Supersession pass** for every slot touched in this session with ≥ 2 claims: LLM gets the
   ordered claim list `(session_ord, t_event, text)` and returns `[{older_ckey, newer_ckey}]` for
   *replacement* relations only (not additive). Write `SUPERSEDED_BY {at_session = newer.session_ord}`.
   Deterministic under caching; edges are never deleted, only added.
6. Return the bookmark; ingest of session *n+1* reads at ≥ that bookmark.

Idempotency: every LLM call is cached on disk by `sha256(model + prompt + schema)`; every graph
write is `MERGE`-by-id + `SET`, so re-running ingest is a no-op. Session-hash caching means shared
distractor sessions across users are extracted once and only *re-keyed* per user.

### 3.4 Retrieve → verdict → read (per question)

1. **Anchor terms**: LLM (cheap call) turns the question into `{anchor_terms:[…] (content words +
   synonyms/hypernyms), historical:bool, wants_count:bool, time_ref?}`; plus deterministic stems of
   the question. Union → `tkeys`.
2. **Query 1 — convergence** (one round trip):
   ```
   CALL algo.MSpaths({sourceLabel:'Token', sourceProperty:'tkey', sourceValues:[<tkeys…>],
     targetLabel:'Claim', targetProperty:'kind', targetValues:['<uid>|claim'],
     relTypes:['HITS','NAMES','MENTIONS'], relDirection:'outgoing', maxLen:2, resultLimit:5000})
   YIELD path RETURN path
   ```
   Paths are Token→Claim or Token→Entity→Claim, fully hydrated (claim clocks, text, span; token
   `df`). Client-side: per claim, `conv = |distinct source tokens|`, `score = Σ idf(token)`,
   `idf = log(1 + N_claims/df)`.
3. **Structural verdict**:
   - `A1` no source token exists in this user's graph → **ABSENT (no anchors)**.
   - `A2` no claim with `conv ≥ min(2, |resolved anchors|)` → **ABSENT (no convergence)**.
   - else candidates = top-K (K=25) by score, tie-break `t_event`, `session_ord`.
4. **Query 2 — slot expansion** (one round trip): sources = distinct `skey`s of candidates;
   `relTypes:['FILLS','SUPERSEDED_BY'], relDirection:'both', maxLen:3` → all claims in those slots
   plus their supersession chains. Merge into the candidate set.
5. **As-of filter** (if `k` given): drop claims with `session_ord > k`, ignore edges with
   `at_session > k`. Then label each claim `CURRENT` / `SUPERSEDED_BY <ckey>@<session>`.
   If the question is not `historical`, superseded claims are kept but demoted below current ones.
6. **Hydrate spans**: batch `UNWIND … MATCH (t:Turn {id: row.id}) RETURN …`; cut span ± 300 chars.
7. **Order** evidence by `t_event` (unknown last) then `session_ord`.
8. **Reader** (LLM): question, `question_date`, ordered evidence (verbatim text, session date,
   status label), instructions: answer only from evidence; do date arithmetic explicitly; if the
   evidence does not contain the answer, reply exactly `NOT_IN_MEMORY`. Output
   `{answer, cited_ckeys[]}`. A `NOT_IN_MEMORY` reply is the second abstention line, labelled
   distinctly from `A1/A2` in the receipt.
9. **Determinism hash** = `sha256(sorted ckeys of the evidence set)`; shown in the UI.

### 3.5 Server API (`packages/server`)
`POST /users/:uid/sessions` (ingest one session; returns claims written, supersessions, bookmark) ·
`POST /users/:uid/ask` `{question, asOf?, historical?}` → `{verdict, answer?, evidence[], receipt,
hash}` · `GET /users/:uid/slots/:skey` → chain · `GET /users/:uid/sessions` · `GET /users/:uid/stats`.

### 3.6 Demo (`apps/demo`)
Panels: (1) Ask → verdict card (green ANSWER / violet ABSENT with reason A1/A2/NOT_IN_MEMORY) and
the **receipt** (query text, anchors found/unknown, path count, convergence table); (2) evidence
list with the span highlighted inside verbatim turn text; (3) supersession chain for the answering
slot; (4) **as-of scrubber** — slider over sessions, re-asks, shows the answer trajectory
(NYC → Brooklyn → SF); (5) live ingest — paste/type a session, watch new claims/edges land, re-ask;
(6) determinism hash after N re-runs. Preload one benchmark user (a knowledge-update question with
a ≥ 3-step chain) so the video opens on the scrubber.

## 4. Evaluation (`packages/eval`)

- Loader for `longmemeval_oracle.json` / `longmemeval_s_cleaned.json`; sessions sorted by date.
- **Retrieval metrics without a judge** (use `answer_session_ids` and oracle `has_answer`):
  `SessionRecall@K` (an answer session appears among evidence sessions), extraction recall (some
  claim span lands in a `has_answer` turn), false-abstention rate on answerable questions,
  abstention precision/recall on the 30 `_abs`.
- **Answer accuracy** with the official LongMemEval judge prompts (port from the repo's
  `evaluate_qa.py`; per-type prompts, abstention judged separately). Judge model held constant
  across all systems (default `gpt-4o` as upstream; verify availability, else state the substitute).
- **Baselines**, same reader prompt and judge: (B1) BM25 top-10 turns; (B2) full-context
  `gpt-5.6-luna` over the whole haystack. B2 also tests whether the brief's "30–60 % drop" premise
  still holds for a mid-2026 model — the pitch must not depend on it.
- **Slices**: dev = 20 oracle questions (day 1–2) → 100 S questions incl. all 30 `_abs`, stratified
  by type (day 4) → full 500 (day 7, ~$20).
- Report per type: accuracy, abstention accuracy, false-abstention, SessionRecall@K, tokens sent to
  reader, p50 latency, and the number of ABSENT verdicts with an A1/A2 receipt.

## 5. Milestones and exit criteria

| Day | Deliverable | Exit criterion / risk retired |
|---|---|---|
| 1 | Workspace, `hydra` client with tests against the live node, dataset loader, extraction prompt on 20 oracle questions | **Extraction recall vs `has_answer` ≥ 90 %** on the slice; spans validate |
| 2 | Full ingest path (schema, batches, tokens/df, supersession pass), ingest 20 full S haystacks | Ingest a 48-session haystack in < 3 min; idempotent re-run is a no-op |
| 3 | Anchor terms, Query 1/2 builder, verdict, as-of filter, unit tests (pure, deterministic) | **Go/no-go: `SessionRecall@25 ≥ 85 %` on answerable dev questions and false-abstention ≤ 10 %**. If missed: widen (`maxLen 3` via Entity, more write-time keywords, `STARTS WITH` prefix anchors) — if still missed, the HydraDB-only decision is reopened with the numbers |
| 4 | Reader, judge port, B1/B2 baselines, 100-q run | First per-type table incl. abstention column |
| 5 | Server API, as-of scrubber endpoint, determinism hash, live-ingest path | Scrubber shows a real 3-step chain end to end |
| 6 | Demo UI, receipt panel, video script | Recorded dry run |
| 7 | Full 500 run, writeup (positions vs CogCanvas, Zep/Graphiti, Mastra, mem0), video | Submission |

## 6. Risks (ranked) and the plan for each
1. **Anchor recall under HydraDB-only purism** — the design's real bet. Mitigations: write-time
   keyword expansion, query-time synonym expansion, entity NAMES hop, `STARTS WITH` prefix
   fallback for unresolved anchors, and the day-3 gate above with an explicit reopen clause.
2. **False abstention** (A2 firing on a real question with unusual vocabulary). Track it as a
   first-class metric; the threshold `min(2,|anchors|)` is the one tunable and is printed in the
   receipt.
3. **Extraction misses / bad spans.** Measured day 1; spans validated at write; assistant turns
   included; `keywords` required.
4. **Slot collisions never happen** (LLM invents attrs) → supersession never fires. Constrained
   attr vocabulary + entity list in the prompt; report #slots with ≥ 2 claims as a health metric.
5. **HydraDB parser/limit surprises.** Its errors are precise — read them; `EXPLAIN` is not
   exposed over HTTP, so keep a `probe` script and the review's probe table current.
6. **Live-ingest latency in the demo** (one extraction + supersession call per session, a few
   seconds) — show a progress state; keep sessions short in the live segment.

## 7. Open items to settle while scaffolding (not blocking)
- Bolt via `neo4j-driver` (TS) as an alternative transport — only if HTTP shows a limit.
- Whether `Turn.text` for very long assistant turns (max ≈ 31 k chars) should be chunked into
  multiple `Turn` vertices (HTTP body ≤ 1 MB per request; a single turn is fine, batches chunked).
- Judge model availability (`gpt-4o`) on the account; substitute must be documented.
- Read CogCanvas v3 fully before day 7 writeup.
