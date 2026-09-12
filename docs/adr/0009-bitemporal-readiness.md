# D7: Bitemporal time model with watermark-gated reads

## Status

Accepted (maintainer decision packet, 2026-09-11). Full bitemporal option.

## Decision

- **Recorded time** (source acceptance / ingest-transaction time) is modelled
  separately from a **precision-aware valid-time interval** plus uncertainty,
  source revision, and supersession-effective time.
- Every API operation declares its perspective — recorded-time, valid-time,
  or bitemporal — including the exact meaning of `asOf`. Backward
  compatibility, if needed, goes through an explicit adapter, never an
  ambiguous default.
- Late-arriving and conflicting facts, corrections (which become current
  without rewriting history), and future-data isolation are defined in one
  place.
- Ranking uses **immutable per-snapshot `N`/`df` statistics** (or another
  reviewed scoring state) bound to the query context, so future sessions
  cannot change an earlier result.
- Reads carry lifecycle watermarks (`SOURCE_DURABLE`, `INDEXED`, `ENRICHED`,
  `CONSOLIDATED`, `COMMITTED`). Each read declares its minimum readiness; a
  query below its watermark waits, returns a typed not-ready result, or uses
  a declared source-only fallback — never a silent absence.
- Incomplete or capped memory produces `INCOMPLETE_MEMORY` (or another
  explicit non-answer), never an absence claim.

## Alternatives considered

- **Watermark-only minimum:** less work, temporal queries stay approximate;
  F-22/F-38 stay open. Rejected.
- **Defer D7:** S05A and the temporal parts of S09/S13/S17–S18 stay blocked.
  Rejected.

## Consequences

- S05A implements the contract; S08–S09 carry watermark/completeness into
  traces and receipts; S13/S17–S18 enforce readiness minimums.
- Closes the query-side half of F-43 and all of F-22/F-38 when S05A lands.

## Acceptance evidence

Recorded-vs-valid divergence fixtures, future-session non-retroactivity
properties, per-answer snapshot/perspective/watermark/caps/completeness
statements, source-to-visible freshness measurements.
