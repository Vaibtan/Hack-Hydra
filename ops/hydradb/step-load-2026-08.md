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
| 5 | Throughput far below the spec's 1–2 h estimate | The object store, not the engine, is the bottleneck, and structurally so: the engine hard-codes SlateDB's WAL flush interval at **1 ms** with `await_durable_writes` (`GraphDurabilityConfig::default()` in `src/bin/graph_node/config.rs`, no env override), so a write-heavy ingest is a stream of tiny durable PUTs. At `cpus: 1` MinIO pinned at 99.9 % with HydraDB at 38 %; at `cpus: 3` it pinned at 301 % with HydraDB at 106 %. | `.wslconfig` `processors` 4 → 8 and `memory` 8 GB → 12 GB; object store `mem_limit` 768m → 3g and `cpus` 1 → 6, in the Compose file and in `benchmark-profile.v1.json`. |
| 6 | A whole batch of four users lost at once to `client_query_runtime exceeded 30000 ms`, at the ninth user | Not one expensive statement — four unrelated users stalled together, which is a shared resource. The store held **2.0 GB of objects for eight users** at the engine's default storage buffers (64 MiB `max_unflushed_bytes`, 16 MiB L0 SSTs, one flush at a time). `max_unflushed_bytes` is backpressure: when the flush behind it is an object-store round trip, every writer waits for it, and a statement crosses 30 s. | Raised `GRAPH_MAX_UNFLUSHED_BYTES` to 256 MiB, `GRAPH_L0_SST_SIZE_BYTES` to 64 MiB and `GRAPH_L0_FLUSH_PARALLELISM` to 4 — the *opposite* direction from the spec's tier B, spending RAM the curve says is free. The client also halves an `UNWIND` write batch on a limit refusal and keeps the smaller size, as `deleteByKeys` already did, and reports the refused statement so the next one is diagnosable. |

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

Ingested with `pnpm ingest-slice --slice N --prefix g3 --users 3
--skip-existing` (step 1 was run at `--users 4`; see the re-measurement below),
with `scripts/p0-hydradb-capacity-gate.ps1` sampling alongside. Step 1's
`--users 4` rather than the spec's 3: the spec pinned 3 because it
was the concurrency that completed 60 users with 0 failures *on the previous
runtime*, which had a local-file object store and none of the round trips this
one makes. Ingest concurrency does not change the resulting graph — every write
is content-addressed and every user's canon decisions are made from that user's
own extractions — so the criterion that matters is the one the ticket states:
0 failed users.

`graphMs` is the HydraDB stages of an ask and nothing else — it starts after the
anchors call returns — measured over the first five dev users of the step, each
asked twice: the first ask is the **cold** number and the second the **warm**
one. `pnpm warm` runs first and does not change the cold number, because it
touches the `User` fan-out and the cost is in the convergence walk.

HydraDB RSS is the **peak** the capacity gate sampled during that step's ingest,
not the figure after it settles; the container limit has to cover the peak.

| step | users | sessions | vertices | claims | HydraDB RSS peak | MinIO RSS | object store | warm `graphMs` p50 | cold `graphMs` p50 | wall clock |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 20 | 978 | ≥ 192 700 | 41 083 | 1.52 GiB | 1.90 GiB | 2.7 GB | **68 ms** | 11 397 ms | 24.4 min (12 users; 8 were already in) |

**Correction.** An earlier version of this table carried an edge count of
`~142 900`, and it was wrong by roughly an order of magnitude: the formula in
`step-load.ts` charged two edges per claim, when `ClaimGraph.writeSession`
writes one `EVIDENCE`, one `FILLS`, one `MENTIONS` per distinct mentioned
entity, **one `HITS` per token** — up to `MAX_TOKENS_PER_CLAIM` = 24 — and one
`NAMES` per entity-name token, on top of `Transcript`'s `HAS_TURN` and
`HAS_CHUNK`. Counting edges properly needs either a store-wide scan (which the
engine refuses past 250 000 candidates of a label) or a counter at write time
(which `UserStats` does not keep), so no edge count is reported. The vertex
figure is a floor: `TurnChunk` vertices, written only for turns over the
32 743-byte string cap, are not counted anywhere.

### The read cache belongs to the read phase, and only to it

This one cost two false starts, and both halves of it are worth writing down.

**It is not "only an optimization".** The P0 profile disabled
`GRAPH_OBJECT_STORE_CACHE_ENABLED` on the grounds that the evictor "does not
expose the bounded drop/depth telemetry required for a benchmark claim" and that
it "affects only an optimization". Neither survives measurement. This build
*does* expose the telemetry — `graph_object_store_cache_event_queue_depth` and
`graph_object_store_cache_events_dropped_total` are on `/metrics` and are
recorded with every result — and with the cache off the **first** convergence
walk on the 20-user graph did not finish inside a 25 s ceiling, because every
block it reads is an HTTP GET to MinIO. Warm it was 125 ms. Enabled: warm
**68 ms**, cold **11.4 s**.

**And it must be off while ingesting.** SlateDB caches on *put* as well as on
get, so during an ingest — a stream of tiny durable objects at the engine's
hard-coded 1 ms flush interval — the cache's in-memory bookkeeping grows with
the object count rather than with the graph. Enabled, RSS went 1.79 → 2.74 GiB
in two minutes of a six-user ingest and the capacity gate stopped the node at
**91.8 % of its 6 GiB limit at about 25 users**. Disabled, the same ingest
peaked at 1.52 GiB at 20 users.

So the cache is chosen per phase — `PALIMPSEST_HYDRADB_READ_CACHE=false` for an
ingest, unset for an eval — and `runtime_config_sha256` records which phase a
result came from. It is a runtime setting, not graph state: it changes how a
read is served, never what is stored.

**Tier B was applied and then withdrawn.** When the gate first tripped, the
engine's `low_memory` storage preset went in on the theory that the matrix and
row caches were growing. They were not: with tier B in place RSS still climbed
1.79 → 2.74 GiB in two minutes. The cause was the cache-on-put above, and
fixing it cost nothing, while tier B would have spent `graphMs` on a symptom it
does not treat. It is not applied.

A cold ask is reported and is **not** a target (spec, *Latency*). Nothing in the
20-question smoke eval hit the 25 s read ceiling.

### Ingest concurrency does not buy throughput here; it costs it

Statements completed per second, measured off `/metrics` over 30 s windows on the
same graph:

| `--users` | statements/s |
|---:|---:|
| 3 | ~6.0 |
| 4 | ~3.8 |
| 8 | ~2.9 |

Every write waits on a durable object-store flush behind a single writer lease,
so extra concurrent users add queueing rather than parallelism, and the
per-statement latency rises faster than the concurrency helps. Total throughput
is `statements/s ÷ statements-per-user` and is therefore *worse* at 8 than at 4.

This is the opposite of the intuition `--users 3` was chosen under in the spec —
there it was picked as the highest concurrency that had completed 60 users
without failures, on a runtime with a local-file object store. Here it is the
low end that is fast, and the reason is structural rather than tuning.

`--users 4` is what the population is ingested at: the only setting with a clean
completed step behind it (12 users, 0 failures, 24.4 min), and within noise of
the best rate measured.

**Re-measured on 2026-08-31, and the table above does not hold on this
runtime.** Sampled off `graph_query_completed` over two-minute windows during
the population ingest, on the 5.5 GiB node with the read cache off, at about
55 users in the graph:

| `--users` | statements/s |
|---:|---:|
| 4 | 3.06 |
| 3 | 3.10 |

A 1 % difference, not a 58 % one. Concurrency is **not** the lever on this
configuration: the bottleneck is the object-store round trip behind a single
writer lease, and three writers saturate it as completely as four. The earlier
6.0-at-3 figure was measured on a smaller graph and a different container
profile and does not reproduce.

The population is therefore ingested at the spec's **`--users 3`**, not 4. Not
because it is faster — it is not, measurably — but because it is what the spec
says, it costs nothing, and it removes a deviation that would otherwise have had
to be argued for on the ticket.

### A first-touch eval row is a cold row

The `graphMs <= 1.5 s` target is a **warm** one, and an eval that reads each user
for the first time cannot measure it. Measured on the 20-user graph, at
`--concurrency 6`, every row cold:

| stage | p50 |
|---|---:|
| understand (anchors, from cache) | 17 ms |
| userStats | 11 ms |
| **convergence (Query 1)** | **15 979 ms** |
| slotKeys | 2 024 ms |
| candidateEdges | 3 161 ms |
| slotClaims (Query 2) | 4 648 ms |
| slotMateEdges | 1 304 ms |
| hydrate | 692 ms |
| read (from cache) | 18 ms |
| **`graphMs`** | **26 469 ms** |

Warm, the same graph gives `graphMs` p50 **68 ms**.

The fix costs nothing: an eval replays entirely from `.cache/llm`, so **running it
twice and taking the second run** gives warm `graphMs` at $0.00. Every latency
number reported for the gate comes from a second pass, and says so.

The table also sizes the concurrency change honestly. Level 1 pairs `userStats`
(11 ms) with the convergence walk (16 s) and saves 11 ms; level 2 pairs
`slotKeys` with `candidateEdges` and saves 2.0 s. Sequentially the stages sum to
~27.1 s against 26.5 s measured — about 2 s of 27. The structure is what the
ticket says it is; what it buys on a *cold* graph is small next to the
convergence walk.

### Two settings are chosen per phase, not once

`runtime_config_sha256` therefore differs between the ingest and the eval, and
that is deliberate rather than hidden. Both settings change how a read is
*served*, never what is stored, and the eval — the only phase that makes a
latency or accuracy claim — runs on the shipped values.

| setting | ingest | eval | why |
|---|---|---|---|
| `GRAPH_OBJECT_STORE_CACHE_ENABLED` | `false` | `true` | On, RSS climbs ~2 GiB/min during writes and the gate stops the node in three minutes; off, a cold convergence walk does not finish in 25 s. |
| `GRAPH_MAX_QUERY_RUNTIME_MS` | `120000` | `120000` | The same in both phases since 2026-08-31 (agreed on #22); the shipped default is 30 s and the product's per-call ceiling stays 25 s. The 30 s cap stops a runaway *plan*. An ingest has no runaway plan and neither does a cold read: it has 86 s of object-store round trips. Failing at 30 s costs the whole unit of work — a user's ingest, or the priming pass an eval's warm numbers depend on. |

**The eval's cap is 120 s, not the spec's 30 s [decided 2026-08-31].** On the
60-user graph a cold ask is **86.2 s** and the second ask on the same user is
**0.1 s**, so the entire cost is pulling a user's working set out of the object
store once. At a 30 s cap the *priming* pass cannot complete a single ask, and
without a priming pass there is no warm pass to measure. Chunking the priming
into small queries was tried — `warmUser` batches at 200 source keys — and works
for every level except `HITS`, which is the convergence walk's own edge set and
the one that matters.

What the change does **not** do is relax anything a reported number is measured
against. Every latency figure in the tables is a warm one, on the order of
0.1 s — two orders of magnitude below even the shipped 30 s cap — and no
measured ask comes near either value. The cap decides whether the first pass
finishes, not what the second pass reports. It is recorded in
`runtime_config_sha256` in every envelope, and the writeup says both passes ran
at 120 s rather than claiming the shipped cap.

The spec sentence this replaces is *"The eval runs at the shipped 30 s, so no
latency claim is made against a relaxed cap."* The replacement is: *both passes
ran at a 120 s cap; every reported number is a warm read two orders of magnitude
below the shipped cap, and no measured ask came within an order of magnitude of
either.*

Set them with `PALIMPSEST_HYDRADB_READ_CACHE=false
PALIMPSEST_HYDRADB_QUERY_RUNTIME_MS=120000 docker compose up -d hydradb` before an
ingest, and unset both before an eval.

### The limit was raised mid-ingest, and hydration is why

The 4 GiB HydraDB limit above was set on 2026-08-30 from a curve that had
HydraDB peaking at 1.94 GiB across 40 users while the object store ran out at
4 GiB. On 2026-08-31 the ingest was **resumed** against a graph that already
held 64 users, and the same limit was 82 % full inside eight minutes:

| minutes into the resumed ingest | HydraDB RSS | users written in this process |
|---:|---:|---:|
| 0 | 5 MiB | 0 |
| 2 | 376 MiB | 0 (still skipping) |
| 5 | 901 MiB | 0 |
| 8 | 2.36 GiB | 3 |
| 13 | 3.42 GiB | 4 |
| 15 | **3.55 GiB (plateau)** | 5 |

The difference from the 2026-08-30 curve is **hydration**, not the graph. A node
that grows a graph from empty in one process pays for it a user at a time; a
node restarted onto an existing graph pays for all of it at once, before it
writes anything — the first three rows above are the node reading 64 users back
out of the object store while `ingest-slice` was still doing by-id skip checks.
This profile restarts the node *between phases by design*, because the read
cache and the query cap are chosen per phase, so this is a cost the benchmark
pays every time and not an artefact of one interrupted session.

RSS plateaus at **3.55 GiB** and oscillates there while writing, which is the
number the limit is set from. With the ticket's ≥ 25 % headroom that is 4.44
GiB; the limit is **5.5 GiB (5632 MiB)**, the largest that fits once the object
store keeps 5 GiB and the profile keeps its 0.75 GiB of host headroom inside
Docker's 11.68 GiB. The object store came down from 6 GiB to 5 GiB to pay for
it: its RSS tracks the object count and was 3.19 GiB at 3.5 GB of objects, so it
had the gigabyte to give and HydraDB did not.

Both limits were changed with `docker update` on the running containers, not
with a recreate. A recreate would have cost the four users in flight *and* a
second hydration — the cost being measured — and `docker update` changes the
cgroup limit without touching the process. `benchmark-profile.v1.json` and the
Compose file were updated to match, the preflight re-run (required 12.08 GiB of
Docker's 12.54 GiB, passed), and the capacity gate restarted so that it
measures against the new limit rather than the one it read at startup.

`runtime_config_sha256` changes with the memory limit, which is deliberate: a
latency number measured under a 4 GiB limit is not the same measurement as one
measured under 5.5 GiB, and the hash is what says so.

### The memory grows with the *work*, not the graph — so the node is cycled

The rebalance above bought about twenty minutes. RSS then went past the new
5.5 GiB limit's 80 % at roughly 480 MB/min, which is far faster than users were
being written — about a gigabyte per user, when a user is a few thousand
vertices. That is not graph size, so it was worth finding out what it was before
spending the limit again.

**Every engine cache was empty.** At 5.06 GiB of RSS, `/metrics` reported:

| cache | entries | resident bytes |
|---|---:|---:|
| `matrix_artifacts` | 0 | — |
| `matrix_adjacencies` | 0 | 0 |
| `graphblas_matrices` | 0 | 0 |
| `relationship_rows` | 1 024 | 430 256 |
| `source_relationship_rows` | — | 0 |
| `relationship_property_rows` | 0 | 0 |

430 KB of caches inside 5.06 GiB of RSS. Tier B bounds exactly these caches, so
tier B could not have helped, and applying it would have bought `graphMs` for
nothing — the same conclusion the previous session reached for a different
reason.

**A restart took RSS from 5.06 GiB to 4.3 MiB, with the same graph underneath.**
So the memory is not the graph and not the engine's caches: it is allocator
growth under a sustained write-heavy workload, on a runtime that flushes SlateDB's
WAL every 1 ms and therefore makes an enormous number of small, short-lived
allocations. `MALLOC_ARENA_MAX=2` and `MALLOC_TRIM_THRESHOLD_=64 MiB` are
already set and do not reclaim it; `GRAPH_TRIM_MEMORY_AFTER_HYDRATION` trims
after a *hydration*, which is not the phase this happens in.

This is good news, because it means the 200-user population fits on a 15 GiB
host after all. It just cannot be ingested by one long-lived process.

**`scripts/ingest-cycling.ps1`** is the consequence: run `ingest-slice`, watch
the container, and at 70 % of the limit stop the ingest, `docker restart` the
node and run it again. Three properties make that safe and nearly free, and all
three are already true for other reasons:

- every write is a content-addressed `MERGE`, so a user interrupted mid-write
  completes on the next pass rather than being corrupted or duplicated;
- `--skip-existing` costs one ~100 ms read by id per completed user, so a
  resumed pass reaches the frontier in well under a minute;
- the ingest is killed *before* the node, so the node stops gracefully with no
  statement in flight and releases its writer lease — the failure mode
  `CONTEXT.md` records for an unclean stop is a node that comes back
  permanently read-only.

The cycle threshold is 70 %, deliberately below the capacity gate's 90 %: a
scheduled restart is cheaper than an incident, and the gate should stay a
backstop rather than become the mechanism.

The earlier reading of the same curve — "hydration is why" — was wrong about the
cause. It was the right decision from the evidence available at the time (the
limit was two minutes from tripping and 4 GiB was explicitly interim), and 5.5
GiB is still the right limit, but the growth was never hydration: the first
three rows of that table are a node that had just started, and a restarted node
now reaches 4.3 MiB and stays low until writes begin.

### The read cache stays off during an ingest, but not for the reason recorded

Cycling the node removes the original argument for disabling the read cache
during an ingest — RSS grew ~2 GiB/min with it on and the capacity gate stopped
the node in three minutes, and that is now a scheduled restart rather than an
incident. So it was worth re-testing, because the cost of leaving it off is
large and had not been quantified.

**What it costs.** During the population ingest, with the cache off:

| container | CPU | network out |
|---|---:|---:|
| object store | **450 %** of its 6 CPUs | 251 GB |
| HydraDB | 164 % of its 4 | 1.05 GB |

The WSL load average was 9.63 on 8 processors. The object store is not merely
the bottleneck, it is *CPU-saturated*, and a quarter of a terabyte of egress
during a write-only workload is compaction: with the cache off, every block
SlateDB rereads to compact an L0 SST is an HTTP GET.

**Turning it on does shift that work.** Measured on the same graph: object store
CPU fell 450 % -> 106 % and HydraDB's rose 164 % -> 303 %, exactly as the theory
predicts.

**And it is still not worth it.** With the cache on, the node reached the
cycling driver's 70 % ceiling in **about four minutes, before a single user
completed**. Partial writes carry over — every write is a content-addressed
`MERGE` — but each cycle then pays the skip-check pass again for no completed
user, and the skip pass grows with the population. With the cache off a cycle
runs for over an hour and completes a dozen users.

So the setting stays as the note had it, and the reason is now measured rather
than assumed: not "the cache is dangerous during writes" but "the memory it
costs buys shorter cycles than it saves round trips". `scripts/ingest-cycling.ps1`
takes `-ReadCache on|off` so the comparison can be re-run in one command.

**Throughput, and what it is not.** ~3.1 statements/s and ~4.6 minutes per user
on a graph of this size, which puts the remaining 140 users at roughly eleven
hours. The lever is not ingest concurrency (measured above: 3.06 vs 3.10
statements/s at 4 vs 3 writers) and not the read cache (above). It is host CPU:
WSL is running at a load average above its processor count, and both containers
want more than they can get. Raising `.wslconfig` `processors` from 8 is the
change that would move it; it is **not** made here, because it requires a WSL
restart and `docs/run-log.md` records what a wedged WSL costs, and a graph that
cannot be written to is a worse outcome than a slow one.

### The eval phase does not currently complete a cold ask — three node failures

Stopped here under the run rule, and recorded rather than worked around.

With the dev split complete (60/60 users, 0 failures) the node was switched to
eval settings — read cache on, 30 s query cap — and three things happened in
sequence.

**1. A cold convergence walk does not finish inside the product's ceiling.**

```
pnpm ask --uid g3-001be529 --question "Where do I live?" --no-read
HydraLimitError: retrieval stage convergence exceeded 25000 ms
```

`DEFAULT_READ_TIMEOUT_MS` is 25 s and the engine's eval-phase cap is 30 s. The
ops note recorded 15 979 ms for the same walk on the **20-user** graph; at 60
users it is past both. Warm it is 68 ms. So on this graph the first ask of a
user cannot complete at the shipped configuration, and an eval whose first pass
is all first-asks fails every row rather than producing slow ones.

**2. Warming enough to prevent that does not fit.** `pnpm warm` on one user —
its 51 sessions' turns, 455 slots' claims, 2 292 entities' tokens — took **28.8 s
and took RSS to 2.09 GiB**, and ran out of its budget before reaching the
Tokens. Sixty users of that does not fit in 5.5 GiB, and the graph is 60 of a
planned 200.

**3. The node stopped twice.**

- The capacity gate stopped it at **90.45 %** of the 5.5 GiB limit during the
  probe suite — a graceful stop; the graph is intact and writable, verified
  afterwards.
- A single subsequent cold ask killed the process outright: `RestartCount 1`,
  **not** an OOM kill (`State.OOMKilled: false`), no error in the log, and
  immediately before it:

  ```
  WARN slatedb::cached_object_store::storage_fs
  evictor queue skipped cache write/access event because it was full 1 times in the last 30s
  ```

That warning is the same evictor the P0 profile disabled this cache for, and the
same one the previous session cleared on the grounds that its telemetry exists.
The telemetry does exist. The evictor still falls over.

**Raising the disk cache was tried, and it is not the fix.**
`GRAPH_DATA_CACHE_BYTES` went from 512 MiB to 4 GiB — a *disk* cache, so it
costs disk and not RAM — against an object store holding ~3.5 GB. It moved one
thing and not the others: the convergence stage went from failing at 25 s to
passing, and the ask then failed one stage later, at `slotClaims`, and kept
failing there on every repeat.

**The numbers, measured under a relaxed cap so they are numbers rather than
timeouts.** With the read cache on and the query cap at 120 s:

| ask | `graphMs` |
|---|---:|
| first, on a cold user | **86.2 s** |
| second, same user, same node | **0.1 s** |

So nothing is hung and nothing is pathological. The whole problem is **priming**:
a user's working set has to come out of the object store once, over HTTP, and
that costs 86 s. Every stage of the read path is slow on its first touch and
instant afterwards. `graphMs <= 1.5 s p50 warm` is not in doubt; getting to warm
is.

**And priming does not fit inside the shipped 30 s cap.** A single ask is one
big query per stage, and the big ones exceed 30 s. `warmUser` chunks its walks
at 200 source keys precisely so each query is small, and that works for the
`NAMES`, `FILLS` and `HAS_TURN` levels — but the `HITS` level, which is the
convergence walk's own edge set and the one that matters, is thousands of claim
paths per 200-token batch and **all 13 batches failed at the cap**.

**Three node failures, and the same line before each one.**

| # | what happened | last log line before it |
|---|---|---|
| 1 | capacity gate stopped it at **90.45 %** of 5.5 GiB (graceful; graph verified intact and writable) | `evictor queue skipped cache write/access event because it was full 1 times in the last 30s` |
| 2 | process died on one cold ask — `RestartCount 1`, **not** an OOM kill, no error logged | the same warning |
| 3 | process died during `warm --deep` | `… full **4700 times** in the last 30s` |

The drop count scales with read volume and the death follows it. This is the
SlateDB object-store cache evictor, and it is exactly the component the P0
profile disabled this cache for — a decision #23 overturned on the grounds that
the evictor's telemetry exists. The telemetry does exist and is on `/metrics`.
The evictor still falls over, and raising the cache made the drop rate worse
rather than better.

**What is known to be stable.** The ingest phase — read cache **off** — ran for
hours with zero node failures. Every failure here is read-side and every one is
with the cache on.

**The decision this needs**, because it is a benchmark-validity trade and not an
engineering detail:

- *Cache on, 120 s cap.* The only configuration measured end to end: a cold ask
  completes in 86 s and the next is 0.1 s. Every **reported** number would still
  be a warm one, an order of magnitude below even the shipped cap — the cap
  decides whether the priming pass finishes, not what any latency claim says.
  Costs the sentence "the eval runs at the shipped 30 s, so no latency claim is
  made against a relaxed cap".
- *Cache off.* Known stable, and the phase that never failed. Unmeasured for
  reads at this graph size, and the ops note's own 20-user reading says a cold
  walk did not finish in 25 s with the cache off.
- *Persist the disk cache across a recreate* (a named volume on
  `GRAPH_DATA_CACHE_DIR`). Would allow priming at 120 s and then measuring at
  the shipped 30 s with the cache still warm — keeping both the letter and the
  point of the rule. Untested, and it does not address the evictor deaths.

No further runtime change is made here. Three node failures is well past the
point at which this project stops and reports (`docs/run-log.md`), and a runtime
change made while standing on a node that has died three times is how a
benchmark acquires a number nobody can explain.

**What is unaffected.** The graph: 60/60 dev users complete, 0 failures, verified
after both stops. The ingest path: it ran for hours at the ingest settings
without a single node failure, and the two failures here are both read-side and
both with the read cache on.

### What a read actually costs: ~750 MiB of RSS per user, and it does not bound

This is the number that decides how the eval phase can be run at all, so it was
measured directly: restart the node, then ask one question of each of four
different dev users in turn, sampling the container between each.

| ask | RSS before | `graphMs` |
|---|---:|---:|
| 1st user | 4.9 MiB | **85.7 s** |
| 2nd user | 1.232 GiB | 74.2 s |
| 3rd user | 2.007 GiB | 65.4 s |
| 4th user | 2.758 GiB | — |

**~750 MiB of resident memory per distinct user read, with no plateau**, and a
cold ask of 65–86 s that amortises only slightly. A second ask of a user already
read in the same node lifetime is **0.1 s**. So the read path is not slow; it is
that a user's working set has to come out of the object store once, and that the
node then holds three quarters of a gigabyte to show for it.

At that rate the 5.5 GiB limit holds about **seven users**. The dev split is 60.
The full population is 200. Sixty users would need roughly 45 GiB.

**Nothing exposed as a knob bounds it.** Two candidates were tested and both
ruled out:

| tried | result |
|---|---|
| `GRAPH_DATA_CACHE_BYTES` 512 MiB → 4 GiB | Convergence stopped failing at 25 s and the ask failed one stage later instead. Growth unchanged. The evictor's drop rate got **worse** (1 → 4 700 skips per 30 s) and the node died. |
| `GRAPH_MAX_CURSOR_BUFFER_BYTES` 64 MiB → 8 MiB, `GRAPH_CURSOR_TTL_MS` 60 s → 10 s | Byte for byte identical: 4.371 MiB → 1.233 GiB after one user, 86.0 s. Not cursors. |

And it is not any cache the engine reports: at a 5.06 GiB peak,
`graph_cache_resident_bytes` totalled **430 KB** across every cache on
`/metrics`. The memory is SlateDB's own — block cache, SST index and filter
blocks — for blocks scattered across a store that interleaves 60 users in one
`default` graph keyspace.

**The disk cache does not carry priming across a restart.** After ~15 minutes of
heavy reading, `/var/cache/slatedb/data` held **480 MB of its 4 GiB**, and the
first ask after a `docker start` of the *same container* was 85.7 s again — the
same as a cold one. The evictor is dropping the cache writes, so the only cache
that works is the in-memory one, and it lives and dies with the node.

Both cursor settings are now parameterised in the Compose file
(`PALIMPSEST_HYDRADB_CURSOR_BUFFER_BYTES`, `PALIMPSEST_HYDRADB_CURSOR_TTL_MS`)
and default to the engine's own values, so the experiment can be repeated in one
command and nothing is changed by leaving them alone.

### What this means for the eval, in wall clock

An eval run is one read per question. With ~7 users per node lifetime the dev
split needs the node restarted about every five questions, and each batch pays
its own priming because nothing survives the restart:

- ~5 cold asks per batch at ~70 s ≈ 6 min, plus a warm pass of seconds, plus a
  ~30 s restart → **~7 min per batch, ~12 batches, ~80 min per graph-touching
  system run**.
- Graph-touching runs in the dev programme: `palimpsest`, `palimpsest-v2` (full
  and fast), `palimpsest-premise`, and eight ablations — **twelve runs, ~16 h**.
  `bm25`, `fullctx` and `oracle-session` read the dataset rather than the graph
  and are not affected.
- The test half then needs its 140-user ingest (~11 h) and a single test read
  across four graph-touching systems (~5 h).

That is the honest figure: **roughly 32 hours of wall clock**, none of which is
LLM spend and none of which concurrency or caching can buy back. It is a
property of a 12 GB host holding a graph whose per-user read working set is
750 MiB.

### One stray vertex

A single `WriteCheck` vertex (`writecheck|after-gate-stop`) was written by hand
to prove the node was still writable after the capacity gate stopped it — it
was, which also shows the writer lease releases cleanly on a graceful stop, the
failure mode CONTEXT.md records for an *unclean* one. Deletes are impractical on
this engine, nothing scans labels, and it belongs to no user prefix, so it is
left in place and named here rather than quietly ignored.

## Driver scripts: what `scripts/*.ps1` rely on

The facts the drivers are built on, so a change to one of them can be checked
against the measurement it came from. `scripts/lib/hydra.psm1` holds the shared
pieces (`Set-HydraPhase`, `Invoke-EvalProcess`).

**Phase switch is verified by reading the container's env back**
(`Set-HydraPhase`). `docker compose up -d` on a service whose configuration
has not changed is a **no-op**, so a phase switch that silently did not happen
is the failure `scripts/phase.ps1` exists to make impossible: it reads
`GRAPH_OBJECT_STORE_CACHE_ENABLED` and `GRAPH_MAX_QUERY_RUNTIME_MS` off the
running container and reports them.

**`docker restart --time 30`, never a recreate.** Both are correct; a recreate
is slower, gives the container a **new id** — which the capacity gate resolved
once at startup — and reapplies the Compose `mem_limit` over any live
`docker update`. `--time 30` is SIGTERM-and-wait: the writer lease is released
only on a graceful stop (CONTEXT.md, writer lease). The ingest process is
killed before the node for the same reason.

**Cycling** (`scripts/ingest-cycling.ps1`). The first cycle takes the node as
it finds it; every later one restarts, because it is a cycle *because* the
previous one hit the ceiling. Completion is detected by `ingest-slice`'s last
line, `wall clock`; an exit without it is reported as "exited without a
summary". `-Split dev` runs first: the dev half is scattered through
`benchmarkSlice` order rather than a prefix of it, and ingesting it first turns
an eleven-hour wait for the first number into about ninety minutes.

**Batched eval** (`scripts/eval-batched.ps1`). Per batch: switch to the eval
phase with a restart, a **cold pass at `PALIMPSEST_READ_TIMEOUT_MS=115000`**
(above the product's 25 s so priming can finish, below the engine's 120 s cap;
`eval` records `pass: "cold"` from the override), then a **warm pass at the
shipped 25 s**, which is the results file — a warm read that needs more fails
here rather than being quietly reported. The warm pass is **retried once**: it
fired on batch 9 of the first v2 run, on `slotClaims`, and the likely cause is
eviction rather than a slow query — a v2 batch's working set sits near the
memory limit, so by the time the warm pass re-reads the first user's blocks the
node may have dropped them for the fourth user's. A transient eviction re-primes
and passes; a read genuinely over 25 s warm fails twice, and that is the
finding. `reader-ab-batched.ps1` runs at 115 s throughout (no latency claim, no
warm pass). `merge-batches` runs only when every batch is done.

**Fifteen batches of four users, not twelve of five** (`scripts/dev-programme.ps1`).
Measured: `palimpsest` peaked at 3.7 GiB per five-user batch and `palimpsest-v2`
at **5.19 GiB of 5.5** — v2 reads more per user (convergence, sub-question
walks, Slot probes, a discovery hop, the slot expansion) where v1 reads one
walk. Four users a batch keeps v2 near 4 GiB; the three extra restarts cost
about ninety seconds per run. Cold time is per question and does not change
with the batch size; only the restart count does. The test split runs at
`-Batches 35`.

**Run order.** `palimpsest` and `palimpsest-v2` first, because the adoption gate
is read from exactly those two and should fail before eight ablations have run
against it. The dataset-only baselines (`bm25`, `fullctx`, `oracle-session`)
need no node and no batching but still run **twice**: the second run replays
every LLM call from cache and is where their latency column comes from. The
v1 systems no longer exist in this checkout; `-V1Worktree` points the driver at
a checkout of tag `pre-cleanup-v1` and writes its results into this repo's
`results/`.

**Variant names must match what `eval` derives** or the merge finds no files.
`eval` inserts a hyphen after the leading `no` and lower-cases:

| flag | variant |
|---|---|
| `--profile fast` | `profile-fast` |
| `--no-select` | `no-select` |
| `--no-sufficiency` | `no-sufficiency` |
| `--no-time-scope` | `no-timescope` |
| `--no-decompose` | `no-decompose` |
| `--no-discovery` | `no-discovery` |
| `--reader-route off` | `no-readerroute` |
| `--granularity span\|turn` | `granularity-span`, `granularity-turn` |

**Node's stderr is redirected to a file** (`Invoke-EvalProcess`). Node prints
an `ExperimentalWarning` about SQLite on every start, and under
`$ErrorActionPreference = "Stop"` PowerShell turns native stderr into a
terminating `NativeCommandError` — the first run of the driver killed itself on
that warning *after* the eval had written its file.

## Final profile

<!-- set from the curve above with >= 25 % headroom -->
