# Palimpsest — domain vocabulary

These are the words the code, tests, issue comments and UI use. They come from
`docs/spec-palimpsest.md` §1; this file is the copy engineering skills read. Don't drift to
synonyms — "memory", "fact", "node" and "hit" are *not* substitutes for Claim, Span, Entity and
convergence.

| Term | Meaning | Where it lives |
|---|---|---|
| **User** (`uid`) | One independent history. Benchmark: the LongMemEval `question_id`. All keys start `uid\|`. Users share the single `default` graph and are separated by key prefix. | key prefix |
| **Session** | One conversation with a timestamp. `session_ord` is its 1-based rank by timestamp within the user; ties keep input order. | `Session` vertex |
| **Turn** | One message: `role`, `text`, `turn_idx`. Stored verbatim, because the graph indexes the transcript rather than replacing it. | `Turn` vertex |
| **Span** | `(sid, turn_idx, char_start, char_end)` into a Turn's text. The only thing a reader ever sees. | properties on `Claim`, duplicated on `EVIDENCE` |
| **Entity** | A canonical thing the user talks about. `me` is an Entity but never an anchor — it connects to everything. | `Entity` vertex, key `uid\|e\|<canon>` |
| **Slot** | An `(entity, attribute)` pair that holds a value over time, e.g. `me\|residence`. | `Slot` vertex, key `uid\|s\|<canon>\|<attr>` |
| **Claim** | One extracted assertion with a speaker, a type, both clocks and one Span. Fills at most one Slot, mentions at least one Entity. | `Claim` vertex, key `uid\|c\|<sha1>` |
| **Anchor** / **Token** | A normalised content term attached at ingest to Claims (`HITS`) and Entities (`NAMES`). Question anchors are Tokens too — that symmetry is what makes the graph an inverted index. | `Token` vertex, key `uid\|t\|<stem>` |
| **Convergence** | How many *distinct* question anchors reach a Claim within `maxLen` hops. The relevance score, and a structural one — it can be shown. | computed client-side from `msPaths` |
| **Supersession** | `(older)-[:SUPERSEDED_BY {at_session}]->(newer)` between two Claims in the same Slot. **Current** = no outgoing edge with `at_session ≤ k`. Edges are only ever added. | edge |
| **As-of k** | A read that ignores Claims with `session_ord > k` and supersession edges with `at_session > k`. Data-level, not a HydraDB snapshot — bookmarks are causal floors, not time travel. | filter |
| **Verdict** | `ANSWER` (evidence set + reader answer) or `ABSENT` (structural reason + receipt). Abstention reasons: `A1` no anchor resolves, `A2` no claim converges, `NOT_IN_MEMORY` from the reader. | retrieval result |
| **Receipt** | The exact MSpaths query text, which anchors resolved and which didn't, the path count, and the convergence table. Enough for a judge to re-run it. | attached to every verdict |
| **Bookmark** | HydraDB's causal token, returned by every write and replayed on the next read so ingest→ask is read-your-writes. | `HydraClient.lastBookmark` |

## Decisions that are settled

TypeScript + Effect only · HydraDB-only retrieval, no vector or BM25 in *our* read path · as-of is
data-level · users partitioned by key prefix in the single `default` graph · LLM is OpenAI
`gpt-5.6-luna` · every LLM call cached on disk by `sha256(model + prompt + schema)`.

Retrieval is deterministic **given a fixed graph**. Extraction is not. Say exactly that.
