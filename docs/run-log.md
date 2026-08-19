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

**Actual cost:** *(filled in when the run finishes)*
