# HydraDB benchmark runtime

This is the only durable local benchmark profile. It runs the reviewed HydraDB
source revision against a separate, S3-compatible MinIO volume. It never
attaches to the existing `hydradb-data` Docker volume and never uses `latest`.
The optional SlateDB disk cache is deliberately disabled in this profile: its
evictor queue previously reported dropped cache events and does not expose the
bounded drop/depth telemetry required for a benchmark claim. This affects only
an optimization; the S3-compatible object store remains the durable source.

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
