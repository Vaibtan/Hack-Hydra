# Palimpsest P0 runtime acceptance — 2026-08-20

This record covers the supported benchmark runtime only. It does not modify,
delete, mount read-write, or make any claim about the pre-existing
`hydradb-data` Docker volume.

## Provenance and configuration

- HydraDB source: `vendor/hydradb` at
  `6a2fbb192f37f51a93690a2ae2d2f5e27e6e4219`
  (`v0.1.1-2-g6a2fbb1`).
- Local remediation patch fingerprint: `6c711ec5c63b42b99620600f8bd09c146e6b9e83d670562e331a6610ebac6638`.
  This binds the image to the reviewed vendored remediation worktree in the
  worktree; the base source revision alone is not presented as the complete
  build identity.
- Built local runtime image ID after the stable HTTP-code, pinned-toolchain,
  SlateDB maintenance-observability, and fail-closed maintenance-readiness
  remediation:
  `sha256:514349a17890bf2a35e5e5eb81b41c09b771b07e497fa3f51eb22e7727d66081`.
- Required OCI source/revision/patch labels and the durable S3-compatible
  storage contract are recorded in
  [`ops/hydradb/runtime-manifest.v1.json`](../ops/hydradb/runtime-manifest.v1.json).
- The versioned benchmark resource profile is
  [`ops/hydradb/benchmark-profile.v1.json`](../ops/hydradb/benchmark-profile.v1.json)
  and the runnable Compose profile is
  [`ops/hydradb/compose.benchmark.yaml`](../ops/hydradb/compose.benchmark.yaml).
- The object-store and client helper images are digest-pinned. The HydraDB
  runtime is a local image built from the reviewed source and rejected by
  preflight unless its image ID and OCI labels match this manifest.

## Restart matrix

Command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p0-hydradb-restart-matrix.ps1
```

The command created an isolated Docker network, two ephemeral fresh
provenance containers, a tmpfs-backed MinIO store, and one HydraDB container.
Every generated resource was removed on success. No existing Docker volume or
cache was attached.

Result:

```json
{
  "status": "passed",
  "hydra_image_id": "sha256:514349a17890bf2a35e5e5eb81b41c09b771b07e497fa3f51eb22e7727d66081",
  "fresh_container_image_ids": [
    "sha256:514349a17890bf2a35e5e5eb81b41c09b771b07e497fa3f51eb22e7727d66081",
    "sha256:514349a17890bf2a35e5e5eb81b41c09b771b07e497fa3f51eb22e7727d66081"
  ],
  "source_revision": "6a2fbb192f37f51a93690a2ae2d2f5e27e6e4219",
  "source_patch_sha256": "6c711ec5c63b42b99620600f8bd09c146e6b9e83d670562e331a6610ebac6638",
  "minio_image": "minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e",
  "clean_restart_cycles": 20,
  "forced_restart_cycles": 10,
  "writer_lease_ms": 3000,
  "writes": 31
}
```

Each clean cycle committed a new write after a normal stop/start. Each forced
cycle killed the process, allowed the short writer lease to expire, and then
committed a new write through S3-compatible conditional update. The harness
fails if a write stays read-only, if the writer cannot take over, or if its
base-source, remediation-patch, or image provenance differs.

On initial start and after every restart, the harness also requires these
Prometheus cache samples:

```text
graph_object_store_cache_enabled 0
graph_object_store_cache_event_queue_depth 0
graph_object_store_cache_events_dropped_total 0
```

It also requires the following storage-maintenance metric families from the
live `/metrics` endpoint:

```text
# TYPE graph_storage_l0_sst_backlog gauge
# TYPE graph_storage_compaction_in_progress_bytes gauge
# TYPE graph_storage_compaction_last_success_timestamp_seconds gauge
# TYPE graph_storage_gc_cycles_total counter
# TYPE graph_storage_gc_deleted_objects_total counter
# TYPE graph_storage_maintenance_object_store_failures_total counter
```

The wired SlateDB recorder supplies the L0 count, bytes in active compactions,
last successful compaction timestamp, GC cycle/deletion counters, and
compactor/GC object-store error count. It does **not** supply total queued
compaction debt or a last-successful-GC timestamp.

The pinned-container targeted test command also passed for the mapping and
endpoint-rendering boundaries:

```powershell
docker run --rm --mount "type=bind,src=<vendor-source>,dst=/workspace" -w /workspace palimpsest/hydradb-build-base cargo test --locked --features server-runtime,indexer-runtime,otlp storage_maintenance -- --nocapture
```

It ran `storage_maintenance_snapshot_uses_only_the_pinned_slatedb_maintenance_series`,
`storage_maintenance_metrics_are_aggregated_by_cell_without_scope_labels`, and
`a_storage_maintenance_failure_withdraws_a_serving_node`.

The supported profile deliberately disables SlateDB's optional disk-cache
evictor. It therefore has no event queue to overflow; the S3-compatible object
store remains the durable source. An enabled cache is not accepted by this
profile until it supplies real bounded depth/drop telemetry and a load SLO.

## Profile validation

Using temporary ignored test credentials, `docker compose up --wait` reached:

1. healthy object store;
2. successful bucket initialization; and
3. healthy HydraDB service.

The authoritative preflight then passed with 8,328,429,568 Docker memory bytes
against an 8,053,063,680-byte profile requirement, and `/readyz` returned 200.
The temporary Compose project and only the volume it created
(`palimpsest-hydradb-benchmark-object-store-v1`) were removed afterwards.

The credential-independent `-SkipReadiness` preflight also passes after local
credentials are removed. Its tracked example values are used only to validate
the Compose shape; no service is started. The capacity gate was fault-injected
against an isolated 6 GiB-limited container at a 0% test threshold and produced
`stopped_new_ingestion`, exit code 2, and an exited container. The operational
profile retains its 90% threshold and 30-second graceful-stop window.

## Safe engine-error contract

The reviewed source maps idempotency and write conflicts to 409 and writer-lease
or object-store unavailability to 503, using stable safe codes. The TypeScript
client maps those exact code/status pairs to `HydraEngineError` with explicit
retryability and discards unknown 5xx bodies. Unit coverage proves that a raw
backend message cannot enter the typed error reason.

## Scope boundary

This closes the reproducible supported-runtime acceptance for F-01, the restart
portion of F-03, the supported-profile cache queue control in F-05, the
resource/capacity control in F-06, and the stable client/server error contract
in F-07. The old local-object-store data is deliberately not treated as a
durable benchmark source; a read-only migration/reconciliation path is still
required before it can support new benchmark claims.

F-04 remains open: the selected object store supports the conditional update
that blocked SlateDB maintenance, and the pinned recorder now exposes the
available maintenance signals across restarts. A recorder error now also
withdraws the same shared readiness/heartbeat signal in a focused test. A
sustained fault-injected compaction/GC soak, a live injected verification of
that readiness transition, total queued-compaction debt, and a
last-successful-GC signal still have not been produced. No benchmark claim is
unblocked by this record alone.
