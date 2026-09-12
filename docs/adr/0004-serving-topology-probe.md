# D2: Serving topology is undecided; single-node HydraDB is benchmark-only

## Status

Accepted (maintainer decision packet, 2026-09-11). Prototype path agreed;
no topology selected yet.

## Decision

The current single-node HydraDB deployment is declared **benchmark-only**,
not a production serving contract. Measured blockers
(`ops/hydradb/step-load-2026-08.md`): ~750 MiB resident read working set per
user (~7 users per 5.5 GiB node lifetime), 65–86 s cold first-ask priming,
object-store-cache evictor deaths under read load, per-phase cache/cap
switches with restarts between phases.

Prototype in this order, time-boxed, behind the same S05B domain contract
(`QueryContext` in, bounded candidates + span hydration out) and the same
caller workload:

1. Physical partitioning that prevents one node from intermingling every
   user's working set (preserves graph semantics; smallest credible change).
2. A separate bounded candidate index for serving, HydraDB retained for
   required graph semantics.
3. A corrected or newer HydraDB runtime with bounded cold-read residency.
4. A different persistence/read engine for the serving path.

Accept only a topology that passes the restart, concurrency, residency, and
latency gates. Record rejection evidence for every candidate, including the
incumbent. A warm p50 is not sufficient if the required warm set cannot fit
the supported memory envelope. Any candidate that forces storage-specific
branching into retrieval callers records that cost in the comparison.

## Consequences

- S10 and S17–S18 are blocked until a candidate passes the gates.
- S07 live probes run against the benchmark deployment only as ingest/write
  evidence, never as serving proof.
- No further long benchmark before the runtime contract passes (P0-D3).

## Acceptance evidence

D2 comparison record with per-candidate measurements, the selected topology's
restart matrix (20 clean + 10 forced-kill cycles), cache-off and cache-on
load profiles, and declared bounds for queue depth, drops, latency, and RSS.
