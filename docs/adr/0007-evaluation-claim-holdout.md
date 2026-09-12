# D5: Release quality claims require a new private blind holdout

## Status

Accepted (maintainer decision packet, 2026-09-11). Stronger than the plan's
recommended "held-out but not blind" wording: the maintainer selected a new
blind holdout now.

## Decision

- The LongMemEval-S 200-question split (dev 60 / test 140, S00-eligible dev
  60 / test 104 under legacy prefix `g3`) is **tainted for blind claims**:
  both halves observed, BM25 / full-context / oracle-session test baselines
  already read at `422f021`, dev gate passed pre-cleanup. It is held-out but
  not blind, and is labelled exactly that wherever it appears.
- A **new private holdout** is required before any release quality claim:
  fresh slice definition, dataset/split hashes committed before any run,
  frozen retrieval/eval contract, pinned judge, versioned price manifest,
  predeclared systems/metrics/thresholds/invalid-run rules.
- The legacy lane (S14–S16) continues **only** as evidence closure and
  regression evidence on the frozen `g3` contract: 104-row baseline views
  derived byte-preserving from the immutable 140-row artifacts with all 36
  exclusions recorded; exactly one Palimpsest-v2 arm on the 104 S00-eligible
  test users; no re-ingest of the 36 excluded users; no overwrite of originals.
  Its outcome must never be presented as the blind result.
- Retired v1 is never silently revived as a live comparator; its authority is
  the `pre-cleanup-v1` tag plus committed artifacts.
- Post-cleanup dev semantic replay must still prove byte-identical evidence
  and model outputs before the pre-cleanup gate qualifies current code.

## Consequences

- S14 must encode both the frozen legacy membership and the new-holdout
  protocol; S15–S16 legacy runs need runtime/spend authorization and are
  explicitly non-blind.
- The new holdout's dataset selection, ingestion, and provider spend need a
  separate authorization; S16B follows the new-holdout protocol for
  production-path qualification, never known-test replay.
- S18B predeclares its full matrix before observing any new result.

## Acceptance evidence

Evaluation manifest(s) with split/dataset hashes, exclusion records,
already-read arm declarations, freeze + invalidation rules, and maintainer
sign-off before any new provider spend.
