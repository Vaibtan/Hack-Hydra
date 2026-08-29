# Benchmark runtime: step load for the 200-user population

Ticket #23 (parent #22). This is the record the memory profile is set from —
`mem_limit` and `benchmark-profile.v1.json`'s `memory_bytes` come from the curve
below with ≥ 25 % headroom, not from a guess. Every runtime change that altered
`runtime_config_sha256` is listed, including the ones that went against the
plan.

Host: AMD Ryzen 5 5600H, 6 cores / 12 logical processors, 15.35 GiB RAM,
Windows 11, Docker Desktop 29.7.2 on WSL 2.

## Runtime as it was found, and what had to change before a step could run

The Compose benchmark profile had never carried an ingest. Bringing one up
against it surfaced five things; all five are fixed in this ticket and all five
changed either the container profile or the client.

| # | What happened | Cause | Change |
|---|---|---|---|
| 1 | Every write failed at the first statement: `HydraIdentityIntegrityError: missingFullKey` | The client verified a vertex's stored full key with an **unlabelled** `MATCH (n {id: $id})`. Measured against `palimpsest/hydradb:6a2fbb1`, that returns **one row of nulls for an id that does not exist**, and echoes the requested id back as `n.id`; only a *labelled* match returns zero rows. `RETURN n`, `labels(n)`, `id(n)` and `count(n)` are all rejected — `RETURN` supports `<binding>.<property>` and `count(*)`, and `count(*)` counts the synthetic row. So nothing in the response separates "absent" from "present without a full key". | Write-side verification is now the process-local id→key registry only; the persisted key is still verified on every **read** (`getById` projects it; `verifyPathIdentity` checks every node and edge an `MSpaths` walk returns). The remote probe was also one sequential round trip per vertex and three per relationship — ~8 × 10⁶ round trips for this ingest. |
| 2 | Every relationship write would have failed | `verifyRelationshipIdentity` sent `MATCH ()-[r {id: $id}]->()`, which the engine rejects outright: *"relationship pattern must have exactly one type in Query engine"*. | Removed with #1. |
| 3 | Every path read failed: `numericMismatch for numeric id 19995` | A relationship has two ids and only one is ours. `MSpaths` returns the engine's own sequential relationship identity (`1145` for the first `HAS_TURN` of a fresh graph); the content-addressed `edgeId` is in the `id` **property**, because the engine refuses `SET r.id`. The check compared a counter with a hash. Vertices are fine — `node.id` **is** the content-addressed id (verified: `2364642823230` for a Session key). | `verifyPathIdentity` now verifies the `id` property. Regression test: `packages/hydra/test/unit/path-identity.test.ts`. |
| 4 | Users lost to `object_store_unavailable` and `writer_unavailable` inside the first minute | `GRAPH_WRITER_LEASE_MS` was pinned at `3000`, the engine's *minimum* (its default is 30 000). Under load MinIO drops pooled connections often enough that lease renewal misses its window. The client classified these errors as `retryable` and then did not retry. | Lease restored to the engine default `30000`. The client now retries declared-retryable engine failures with jittered exponential backoff (7 attempts, ~6 s, inside the 30 s runtime cap); replay is safe because every write is a content-addressed `MERGE` with a fresh `query_id`. |
| 5 | Throughput far below the spec's 1–2 h estimate | The object store, not the engine, is the bottleneck, and structurally so: the engine hard-codes SlateDB's WAL flush interval at **1 ms** with `await_durable_writes` (`GraphDurabilityConfig::default()` in `src/bin/graph_node/config.rs`, no env override), so a write-heavy ingest is a stream of tiny durable PUTs. At `cpus: 1` MinIO pinned at 99.9 % with HydraDB at 38 %; at `cpus: 3` it pinned at 301 % with HydraDB at 106 %. | `.wslconfig` `processors` 4 → 8 and `memory` 8 GB → 12 GB; object store `mem_limit` 768m → 2g and `cpus` 1 → 6, in the Compose file and in `benchmark-profile.v1.json`. |

Two further notes, both about measurement rather than the runtime:

- **Do not run a label scan while an ingest is running.** `MATCH (n:Token)
  RETURN count(*)` took 15.8 s of engine time at 27 k Tokens, and the four
  concurrent users in flight at that moment all died on the 30 s
  `client_query_runtime` cap. Progress is watched with `docker stats` and the
  ingest log, never with a store-wide scan.
- The host also runs an unrelated `feather-lite-langfuse` Compose stack with
  `restart: always`, which comes back after every WSL restart and holds ~2.4 GiB
  and ~0.4 CPU. It is left running — it is not this project's to stop — and its
  presence is part of every number below.

## Memory environment

Tier A, always on, added to the `hydradb` service:

```
MALLOC_ARENA_MAX=2
MALLOC_TRIM_THRESHOLD_=67108864
GRAPH_TRIM_MEMORY_AFTER_HYDRATION=true
```

Tier B (the engine's `low_memory` storage preset, expressed as individual
`GRAPH_*` knobs) is **not** applied: it buys RAM with MSpaths recompilation and
extra object-store reads, and the curve below does not need it. Applying it
would work against `graphMs ≤ 1.5 s` on a runtime whose object store is already
the bottleneck.

## Step load

Ingested with `pnpm ingest-slice --slice N --prefix g3 --users 4
--skip-existing`, with `scripts/p0-hydradb-capacity-gate.ps1` sampling
alongside. `--users 4` rather than the spec's 3: the spec pinned 3 because it
was the concurrency that completed 60 users with 0 failures *on the previous
runtime*, which had a local-file object store and none of the round trips this
one makes. Ingest concurrency does not change the resulting graph — every write
is content-addressed and every user's canon decisions are made from that user's
own extractions — so the criterion that matters is the one the ticket states:
0 failed users.

<!-- filled in per step -->

| step | users | sessions | HydraDB RSS | MinIO RSS | vertices/edges | warm ask p50 | wall clock |
|---:|---:|---:|---:|---:|---|---:|---:|

## Final profile

<!-- set from the curve above with >= 25 % headroom -->
