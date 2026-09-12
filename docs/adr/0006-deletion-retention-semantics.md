# D4: Deletion means rebuild-and-swap; tombstones are suppression, not erasure

## Status

Accepted (maintainer decision packet, 2026-09-11).

## Decision

The HydraDB graph cannot support in-place `DETACH DELETE` at the observed
edge scale (refused past ~1 M edges), so:

- **Physical erasure path:** rebuild-and-swap into a fresh physical
  namespace/store, excluding deleted revisions, then activate the rebuilt
  snapshot before claiming query deletion. Tenant-isolated store destruction
  is the equivalent path where a tenant owns its store.
- **Logical tombstone:** an explicitly limited suppression mechanism only. A
  tombstone or loss of query visibility is **not** physical erasure and must
  never be described as such.
- The product contract states the purge order (graph, manifest artifacts,
  caches, receipts, backups) and the promised SLA boundary. Stores or backups
  that cannot be purged within the SLA are named in the contract, not
  footnoted away.
- Scoped export, source tombstone intent (durable, idempotent), snapshot
  rebuild, physical purge, legal-hold/audit preservation without
  query-visibility, resumable partial purge, and retention sweeps (dry-run +
  bounded batches) are defined together in S13.

## Alternatives considered

- **Tombstone-only interim:** permitted only as a disclosed non-erasure
  posture; S13/S18 cannot claim purge under it.
- **Serving engine with bounded deletion:** remains a D2 input; if the
  selected topology changes the primitive, this record is revised, not
  silently redefined.

## Consequences

- S13 builds on this; S09 receipt retention and S16B qualification must match
  the approved policy.
- A failure that reactivates a snapshot containing committed-deleted data is
  a stop condition, not a retry.

## Acceptance evidence

Authorized export completeness + integrity checks, post-boundary absence from
newly bound queries, no-reactivation under injected failures, scope-safe
audit records for every purge/retention action.
