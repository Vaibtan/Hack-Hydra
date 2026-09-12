# D6: Receipt authenticity is an asymmetric signature, not a self-hash

## Status

Accepted (maintainer decision packet, 2026-09-11). Recommended direction
from `docs/palimpsest-implementation-plan.md` §D6.

## Decision

Receipt v2 authenticity uses an **asymmetric signature** (e.g. Ed25519) over
the canonical receipt payload. The design names attacker, verifier, key
owner, rotation/revocation behavior, and verification lifetime. The canonical
self-hash remains as an internal checksum only; recomputing a checksum after
modification must never produce a receipt the authenticity verifier accepts.

Covered in S09: versioned schema + canonical serialization with explicitly
excluded volatile fields; key ID, algorithm, issuance time,
rotation/revocation metadata, and verification policy on every signed
receipt; structural, checksum, wrong-key, revoked-key, and tamper-negative
tests; verify-only/cache-only replay without provider spend.

## Alternatives considered

- **HMAC or externally anchored digest:** permitted only if its narrower
  trust model (shared secret / external anchor availability) is documented as
  intentional.
- **Defer D6:** receipts stay replayable traces, never audit artifacts; S09
  authenticity items stay open.

## Consequences

- S09 is blocked on this record; audit/replay claims depend on the verifier
  trust anchor.
- Key custody and rotation become operational requirements (S17 runbooks).

## Acceptance evidence

Any change to bound evidence, model, prompt, snapshot, or completeness
fields invalidates verification; fixed graph + complete cache replays
selected evidence and model outputs byte-for-byte; missing artifacts fail
closed without calling a provider.
