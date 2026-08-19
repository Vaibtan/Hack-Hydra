# Run log

What each expensive run cost, decided *before* it started, and what it actually cost. Every
measurement in this repo replays from `.cache/llm` for $0.00; this file is the record of what it took
to fill that cache the first time.

## 2026-08-19 — ingest the 100-question slice (`--prefix g2`)

```
PALIMPSEST_LLM_CONCURRENCY=48 pnpm ingest-slice --slice 100 --dataset s --users 7 --prefix g2
```

**Slice.** `benchmarkSlice(questions, 100)` — all 30 `_abs` questions plus a stratified 70
answerable, which is the same 100 the eval harness and the retrieval gate use. 100 users,
**4 750 session references**. The 20 users of the day-3 gate are all inside it and re-ingest as
cache hits.

**Projected cost: ~$40.** The overnight session spent **$10.65** for the 20-user slice (978 sessions)
plus the oracle slice, extraction dominating at roughly **$0.010 per session**. 4 750 sessions at
that rate is ~$47, less the ~$10 already paid and less whatever the session-hash cache covers —
LongMemEval_S references 23 867 sessions of which 19 195 are distinct, so shared distractors are
extracted once and only re-keyed per user. Projection: **$35–45**, 3–4 h at concurrency 48.

**This cannot be undone.** The graph passes **one million edges** during this run, and past that
`DETACH DELETE` is refused outright by admission control (`delete_vertex_scan_edges … exceeds limit
1000000`) — it is not slow, it is unavailable. Every write is content-addressed and idempotent so
re-ingest never needs a reset, and a prompt change takes a fresh `--prefix` rather than a delete. If
the graph ever has to be reset, the Docker volume has to be recreated.

**What actually happened — two engine failures, in sequence.**

*Attempt 1, `--users 7`:* after ~35 minutes not one user had completed and not one new
`extract` cache entry had been written. `ingestUser` writes the transcript **before** it extracts,
so all 7 users were stuck in the write phase. The node had stopped answering even a by-id read
inside 120 s, and `docker` itself began returning 500s.

The cause was **not** HydraDB. The WSL2 VM was capped at 4 GB by `~/.wslconfig`, and absorbing
4 750 sessions of verbatim transcript exhausted it. A wedged WSL VM makes `wsl.exe -l -v --all`
hang forever — and that is the command Docker Desktop polls, which is why Docker reported
`DockerDesktop/Wsl/CommandTimedOut` and looked like the broken component. Recovery: kill the stale
`wslrelay.exe`, `Restart-Service WslService`, force-kill it out of `StopPending`, relaunch Docker
Desktop. **Never `wsl --shutdown` first** — that is what strands the relay. The VM cap is now 8 GB
with 8 GB of swap, and ingest runs at `--users 3`.

*Attempt 2, after the restart:* every user failed instantly with `internal query execution error`.
Reads worked; **writes did not**, and `read_epoch` was frozen. Two distinct engine faults, one
behind the other:

1. **A stale writer lease.** `_writer_leases/v2/cell-0` was last renewed at 11:48, before the kill.
   Taking over an existing lease file needs `put_opts` with `PutMode::Update`, which the
   `LocalFileSystem` object store does not implement, so the node came up **permanently
   read-only** — a state it reports only as a bare 500. Fixed by stopping the node and moving the
   stale lease aside so it is created fresh. (The same `PutMode::Update` gap had been in the logs
   for days as harmless GC noise, which is what made it easy to miss.)

2. **Request-id collision.** With the lease fixed, writes still failed:
   `idempotency key conflict for relationship-import request key
   http-query-129.unwind-relationship-merge: this key already stored a result for a different
   payload`. HydraDB derives a write's idempotency key from its `query_id`, and the server's own
   `http-query-<n>` counter **restarts at 1 with the node** while the stored results do not — so
   the new run's 129th relationship merge collided with an unrelated one from the old. The server
   honours a client-supplied id, so `HydraClient` now sends a UUID per statement. Deduplication is
   not lost: every write here is content-addressed and idempotent by MERGE.

Both are now rows in `CONTEXT.md` and a live probe in
`packages/hydra/test/live/idempotency.probe.test.ts`. The volume was backed up (2.62 GB) before
the lease surgery; the graph came through intact and the day-3 gate reproduced at
**100.0 % / 0.0 %** for $0.00 afterwards.

*Attempt 3, `--users 3`, after both faults were fixed:* ran cleanly to **60 of 100 users, 0
failures**, then the WSL VM collapsed a second time — `vmmemWSL` down to 0.72 GB with the host
still holding 3.1 GB free, so this was **not** host memory pressure. The node came back read-only
with the same stale writer lease, and the same recovery worked: kill `wslrelay`/`wslhost`, restart
`WslService` (force-killing it out of `StopPending`), relaunch Docker Desktop, move the lease file
aside, start. Under five minutes end to end, and the 60 ingested users were durable — sessions in
the graph went 1 350 → 3 551 and every gate still reproduced.

That is **two node failures in one run**, which is the agreed stop-and-report line, so the run was
stopped at 60/100 rather than pushed further. The graph, the cache and the results are all intact;
what is missing is the other 40 users' ingest.

**Actual cost of the 100-slice ingest so far:** ~4 200 new extraction calls (cache went 2 892 →
8 032 entries), which at the measured ~$0.010/session is roughly **$26** of the projected $35–45,
for 60 % of the users. The remaining 40 would land the projection close to target.

## 2026-08-19 — answer accuracy on the indexed 60

```
pnpm eval --slice 100 --system all --prefix g2 --concurrency 4 --skip-missing
```

**$1.02**, four systems × 60 questions (18 abstention, 42 answerable), judged by `gpt-4o`. The
40 un-indexed users are excluded rather than counted as retrieval failures, and every file says so.
Re-runs are $0.00.

## Session total, 2026-08-19

Priced from the cache itself (`inputTokens`/`outputTokens` on every entry, at $0.20/$1.20 per M for
`gpt-5.6-luna` and $2.50/$10.00 for `gpt-4o`):

| model | calls | input | output | cost |
|---|---:|---:|---:|---:|
| `gpt-5.6-luna` | 8 183 | 23 713 835 | 21 378 005 | $30.40 |
| `gpt-4o` (judge) | 135 | 22 143 | 330 | $0.06 |
| **cache total** | **8 318** | | | **$30.46** |

The overnight session before this one accounted for $10.65 of that, so **this session spent about
$19.81** — roughly $18 of it the 60-user ingest, ~$1.02 the four-system eval, and the rest reader
and anchor calls during development.

By kind: 4 384 `supersede`, 3 428 `extract`, 283 `read`, 135 `judge`, 88 `anchors`.

**Deleting `.cache/llm` costs $30.46 to rebuild.** Every measurement in the repository replays from
it for $0.00.

