# D3: Tenant and user scope derive from a verified server-side principal

## Status

Accepted (maintainer decision packet, 2026-09-11).

## Decision

`tenantId` and `uid` are derived from a verified server-side principal and
never trusted from body/query scope:

- One middleware/layer verifies credentials and produces a typed principal.
- Principal claims map to allowed tenant/user/resource scopes.
- Conflicting caller-supplied tenant/user IDs are ignored or rejected.
- `MemoryScope` is passed explicitly into every ingest, query, receipt, and
  administrative service.
- Credential forms: OIDC/JWT for human callers, scoped API keys for service
  callers, behind the single principal type.
- CORS becomes an environment-specific allowlist with safe defaults.
- Public errors are stable codes with correlation IDs; internal causes stay in
  server logs.
- Auth-disabled local development exists only as an explicitly selected,
  non-production configuration that cannot be chosen accidentally.

## Alternatives considered

- **API keys only:** simpler, but leaves human SSO unanswered; deferred, not
  rejected, if OIDC integration stalls.
- **Defer D3:** rejected as a default; S11–S12 stay blocked and no tenant
  claim may be made.

## Consequences

- S11–S12 (authenticated API scope, tenant isolation, quotas) build on this;
  S09 receipt binds principal and authorization decision (with D6).
- No handler may construct `tenantId: "default"` or trust body/query scope
  after S11.

## Acceptance evidence

Unauthenticated, wrong-tenant, wrong-user, expired, and malformed credential
tests fail closed; responses expose no provider, graph, filesystem, or stack
details.
