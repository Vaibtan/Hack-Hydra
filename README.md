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
packages/palimpsest   the memory layer itself — keys, transcript ingest
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
```

`pnpm probe` needs the Docker node running; `pnpm test:unit` does not.

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
