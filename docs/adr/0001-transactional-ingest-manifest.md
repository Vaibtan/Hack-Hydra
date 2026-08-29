# Transactional ingest manifest is the write authority

## Status

Accepted

HydraDB remains the retrieval data plane, but a durable SQLite manifest is the
transactional authority for source-revision state, per-user ordering, commit
ids, and projection activation. HydraDB's graph writes have no suitable
per-user compare-and-swap primitive, so treating a Session vertex or materialised
count as a commit marker would make retries and multi-process writers unsafe.

## Considered Options

- Use HydraDB Session existence as the marker — rejected because source rows
  can survive a failed later stage and graph read-modify-write projections race.
- Add a global in-process mutex — rejected because it cannot serialize multiple
  server processes or survive a restart.
- Use a small transactional manifest store — selected because SQLite gives
  durable per-user transactions while keeping HydraDB focused on indexed reads.

## Consequences

Both batch and incremental ingest must resume the same SourceRevision state
machine. A source is successful only at `COMMITTED`; retries re-run idempotent
incomplete stages, and every derived projection delta is tied to an Ingest
Commit rather than a mutable total.

The manifest also records an immutable, canonical Extraction Generation
descriptor before it accepts a SourceRevision. The descriptor carries the
extractor/model/tokenizer identifiers and revisions plus hashes of the exact
prompt template and output schema. Reusing a generation ID with a different
descriptor is rejected. Benchmark-only answer labels and a UserManifest's
allocated ordinal are deliberately excluded from canonical source bytes.
