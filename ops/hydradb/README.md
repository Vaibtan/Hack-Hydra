# HydraDB benchmark runtime

This is the only durable local benchmark profile. It runs the reviewed HydraDB
source revision against a separate, S3-compatible MinIO volume. It never
attaches to the existing `hydradb-data` Docker volume and never uses `latest`.
The optional SlateDB disk read cache is **enabled** in this profile, reversing
the P0 decision to disable it. That decision rested on two claims, and both were
retested on 2026-08-30 (#23): this build does expose the bounded telemetry —
`graph_object_store_cache_event_queue_depth` and
`graph_object_store_cache_events_dropped_total` are on `/metrics`, and both are
recorded with the benchmark result — and the cache is not "only an
optimization". With it off, the first convergence walk on a 20-user graph did
not finish inside a 25 s ceiling, because every block it reads is an HTTP GET to
the object store; warm, the same walk is 125 ms. The S3-compatible object store
remains the durable source; this is a read cache on local disk.

Build the source-labelled runtime before bringing the profile up:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-hydradb-runtime.ps1
```

Create `ops/hydradb/.env.benchmark` from the tracked example and put a
different 32-or-more-character token in
`ops/hydradb/secrets/hydradb-auth-token`. Both paths are ignored by Git.
Then verify the profile before any ingestion or benchmark run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p0-hydradb-preflight.ps1
```

The preflight verifies runtime provenance, storage configuration, resource
budgets, host headroom, and the authoritative HydraDB `/readyz` endpoint. Its
output must be retained with the benchmark result manifest fields named in
`runtime-manifest.v1.json`.

`-SkipReadiness` validates the image, profile, and Compose shape without local
credentials or running containers. It uses only the tracked non-secret example
files for Compose interpolation and never starts the benchmark services.

During an ingest or benchmark, run the capacity gate as a separate monitored
process. It samples the running Compose-labelled HydraDB container and, at the
profile's 90% memory threshold, gracefully stops that container before another
source revision can be claimed. It never removes the durable object-store
volume.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p0-hydradb-capacity-gate.ps1 -Samples 720
```

For a non-mutating threshold check, add `-DryRun`. A threshold breach exits
with code 2 so a runner can mark the benchmark as capacity-stopped rather than
successful.
