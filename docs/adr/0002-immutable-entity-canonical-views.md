# Preserve Entity identities; select canonical views

## Status

Accepted

Palimpsest keeps Entity identities immutable and records versioned `SAME_AS`
edges in a content-addressed Entity Canonical View. One view is selected per
user and can be switched or rolled back atomically; this was selected over
in-place migration because a bridge must not rewrite historical Claim, Slot,
or source lineage.

## Considered Options

- Transactional migration into a new index generation — deferred for derived
  graph activation; it is not needed to preserve the identity-level lineage.
- In-place Entity mutation — rejected because old references would silently
  change meaning and cannot provide an as-of/rollback view.
