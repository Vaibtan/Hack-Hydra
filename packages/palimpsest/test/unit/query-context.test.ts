import { ConfigProvider, Context, Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import { createEntityCanonicalView, type EntityCanonicalView } from "../../src/EntityCanonicalView.js"
import { createIndexGeneration } from "../../src/IndexGeneration.js"
import {
  IngestManifest,
  IngestManifestLayerMemory,
  type IngestManifestError,
  type SourceRevision
} from "../../src/IngestManifest.js"
import type { CanonicalViewOperations } from "../../src/IngestManifest/CanonicalView.js"

import type { GenerationOperations } from "../../src/IngestManifest/Generations.js"

import type { RevisionOperations } from "../../src/IngestManifest/Revisions.js"

import { MANIFEST_SCHEMA_VERSION } from "../../src/IngestManifest/Schema.js"
import type { SnapshotOperations } from "../../src/IngestManifest/Snapshots.js"
import { parseMemoryScope, type MemoryScope } from "../../src/MemoryScope.js"
import {
  ActiveSnapshotCorrupt,
  InvalidQueryPrincipal,
  layerQueryPrincipalFromConfig,
  layerStaticQueryPrincipal,
  MemoryScopeNotFound,
  NoActiveSnapshot,
  parseQueryPrincipal,
  QueryPrincipalProvider,
  resolveQueryContext,
  validateActiveSnapshot,
  type QueryPrincipal
} from "../../src/QueryContext.js"
import { createExtractionGeneration } from "../../src/SourceIdentity.js"
import { createUserIndexSnapshot } from "../../src/UserIndexSnapshot.js"

const extraction = createExtractionGeneration({
  extractor: { id: "test-extractor", revision: "git:test" },
  model: { id: "test-model", revision: "snapshot:test" },
  tokenizer: { id: "test-tokenizer", revision: "v1" },
  promptTemplate: "test extraction prompt",
  outputSchema: { type: "object", version: 1 }
})

const indexGeneration = createIndexGeneration({
  extractionGeneration: extraction,
  graphWriter: { id: "test-writer", revision: "git:writer-1" },
  graphSchema: { id: "test-graph-schema", revision: "v1" }
})

const scope = { tenant: "tenant-a", uid: "user-a" } as const

const memoryScope = (tenant: string, uid: string): MemoryScope =>
  Result.getOrThrow(parseMemoryScope(tenant, uid))

const viewOf = (identities: ReadonlyArray<{ id: string; canon: string }>): EntityCanonicalView =>
  Result.getOrThrow(
    createEntityCanonicalView({
      identities: identities.map((identity) => ({ ...identity, etype: "person" })),
      equivalences: []
    })
  )

const view = viewOf([{ id: "identity-alice", canon: "alice" }])

type ManifestOps = RevisionOperations & GenerationOperations & CanonicalViewOperations & SnapshotOperations

const digest = (marker: string): string => marker.repeat(64)

const verification = (sourceRevisions: number, marker = "f") => ({
  verificationDigest: digest(marker),
  graphRoots: ["t9:tenant-a|u6:user-a|snapshot|root-1"],
  counts: { sourceRevisions, vertices: 12, relationships: 7 }
})

const snapshotFor = (
  sourceCommitIds: ReadonlyArray<string>,
  overrides?: {
    readonly scope?: MemoryScope
    readonly canonicalViewId?: string
    readonly manifestSchemaVersion?: number
  }
) =>
  Result.getOrThrow(
    createUserIndexSnapshot({
      scope: overrides?.scope ?? memoryScope(scope.tenant, scope.uid),
      indexGenerationId: indexGeneration.id,
      canonicalViewId: overrides?.canonicalViewId ?? view.id,
      sourceCommitIds,
      manifestSchemaVersion: overrides?.manifestSchemaVersion ?? MANIFEST_SCHEMA_VERSION
    })
  )

const STAGE_PATH = [
  ["RECEIVED", "SOURCE_DURABLE"],
  ["SOURCE_DURABLE", "INDEXED"],
  ["INDEXED", "ENRICHED"],
  ["ENRICHED", "CONSOLIDATED"],
  ["CONSOLIDATED", "COMMITTED"]
] as const

const commitRevision = (
  manifest: Pick<ManifestOps, "begin" | "advance">,
  logicalSessionId: string,
  sourceDigest: string,
  targetScope: { readonly tenant: string; readonly uid: string } = scope
): Effect.Effect<SourceRevision, IngestManifestError> =>
  Effect.gen(function* () {
    let revision = (
      yield* manifest.begin({
        tenant: targetScope.tenant,
        uid: targetScope.uid,
        logicalSessionId,
        sourceDigest,
        sourceBytes: 100,
        extractionGeneration: { id: extraction.id, canonicalJson: extraction.canonicalJson }
      })
    ).revision
    for (const [from, to] of STAGE_PATH) {
      revision = yield* manifest.advance({ revision, from, to })
    }
    return revision
  })

const seedManifest = (
  manifest: ManifestOps,
  targetScope: { readonly tenant: string; readonly uid: string } = scope
): Effect.Effect<void, IngestManifestError> =>
  Effect.gen(function* () {
    yield* manifest.storeIndexGeneration({ generation: indexGeneration })
    yield* manifest.storeEntityCanonicalView({ ...targetScope, view })
  })

const activateCommitted = (
  manifest: ManifestOps,
  targetScope: { readonly tenant: string; readonly uid: string },
  snapshotId: string,
  expectedActiveSnapshotId: string | null
): Effect.Effect<{ readonly manifestVersion: number }, IngestManifestError> =>
  Effect.gen(function* () {
    const manifestVersion = yield* manifest.readManifestVersion(targetScope)
    yield* manifest.activateIndexSnapshot({
      ...targetScope,
      snapshotId,
      expectedManifestVersion: manifestVersion,
      expectedActiveSnapshotId
    })
    return { manifestVersion }
  })

const run = <A, E>(effect: Effect.Effect<A, E, IngestManifest>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(IngestManifestLayerMemory))))

const principalFor = (tenantId: string, subject = "test-caller"): QueryPrincipal =>
  Result.getOrThrow(parseQueryPrincipal(tenantId, subject))

describe("parseQueryPrincipal", () => {
  it("accepts an explicit tenant and subject", () => {
    expect(parseQueryPrincipal("tenant-a", "test-caller")).toMatchObject({
      _tag: "Success",
      success: { tenantId: "tenant-a", subject: "test-caller" }
    })
  })

  it("rejects an empty tenant or subject instead of defaulting", () => {
    expect(parseQueryPrincipal("  ", "test-caller")).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidQueryPrincipal", field: "tenantId" }
    })
    expect(parseQueryPrincipal("tenant-a", "")).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidQueryPrincipal", field: "subject" }
    })
  })
})

describe("resolveQueryContext", () => {
  it("binds one request to the scope's active snapshot exactly once", async () => {
    const context = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
        yield* activateCommitted(manifest, scope, snapshot.id, null)
        return yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid,
          asOf: 4,
          causalFloor: "bookmark-1"
        })
      })
    )

    expect(context.scope).toMatchObject({ tenantId: "tenant-a", uid: "user-a" })
    expect(context.snapshot.sourceCommitIds).toHaveLength(1)
    expect(context.record.state).toBe("ACTIVE")
    expect(context.record.snapshot.id).toBe(context.snapshot.id)
    expect(context.manifestVersion).toBe(1)
    expect(context.coverage).toEqual({ revisionsCovered: 1, scopeRevisions: 1, uncommitted: 0 })
    expect(context.asOf).toBe(4)
    expect(context.causalFloor).toBe("bookmark-1")
  })

  it("omits optional temporal cut and causal floor when the caller supplies neither", async () => {
    const context = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
        yield* activateCommitted(manifest, scope, snapshot.id, null)
        return yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid
        })
      })
    )

    expect("asOf" in context).toBe(false)
    expect("causalFloor" in context).toBe(false)
  })

  it("rejects an empty requested uid without touching the manifest", async () => {
    const outcome = await run(
      Effect.result(
        resolveQueryContext({ principal: principalFor(scope.tenant), requestedUid: "  " })
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidMemoryScope", field: "uid" }
    })
  })

  it("reports an unknown scope distinctly from a scope with no active snapshot", async () => {
    const outcome = await run(
      Effect.result(
        resolveQueryContext({ principal: principalFor("tenant-absent"), requestedUid: "user-absent" })
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "MemoryScopeNotFound", tenant: "tenant-absent", uid: "user-absent" }
    })
    expect(outcome._tag === "Failure" && outcome.failure).toBeInstanceOf(MemoryScopeNotFound)
  })

  it("reports no active snapshot when revisions exist but nothing was activated", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        yield* commitRevision(manifest, "session-a", digest("a"))
        return yield* Effect.result(
          resolveQueryContext({ principal: principalFor(scope.tenant), requestedUid: scope.uid })
        )
      })
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoActiveSnapshot", tenant: scope.tenant, uid: scope.uid }
    })
    expect(outcome._tag === "Failure" && outcome.failure).toBeInstanceOf(NoActiveSnapshot)
  })

  it("reports no active snapshot when snapshots exist but none was activated", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
        return yield* Effect.result(
          resolveQueryContext({ principal: principalFor(scope.tenant), requestedUid: scope.uid })
        )
      })
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoActiveSnapshot" }
    })
  })

  it("resolves the successor after activation while the earlier context still names its snapshot", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const first = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshotA = snapshotFor([first.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot: snapshotA })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshotA.id, ...verification(1) })
        yield* activateCommitted(manifest, scope, snapshotA.id, null)
        const before = yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid
        })

        const second = yield* commitRevision(manifest, "session-b", digest("b"))
        const snapshotB = snapshotFor([first.commitId, second.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot: snapshotB })
        yield* manifest.verifyUserIndexSnapshot({
          snapshotId: snapshotB.id,
          ...verification(2, "e")
        })
        yield* activateCommitted(manifest, scope, snapshotB.id, snapshotA.id)
        const after = yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid
        })
        return { before, after }
      })
    )

    expect(outcome.before.snapshot.id).not.toBe(outcome.after.snapshot.id)
    expect(outcome.before.snapshot.sourceCommitIds).toHaveLength(1)
    expect(outcome.after.snapshot.sourceCommitIds).toHaveLength(2)
    expect(outcome.before.coverage).toEqual({ revisionsCovered: 1, scopeRevisions: 1, uncommitted: 0 })
    expect(outcome.after.coverage).toEqual({ revisionsCovered: 2, scopeRevisions: 2, uncommitted: 0 })
    expect(outcome.before.record.state).toBe("ACTIVE")
  })

  it("keeps the same uid isolated across tenants", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const otherScope = { tenant: "tenant-b", uid: scope.uid } as const
        const revisionA = yield* commitRevision(manifest, "session-a", digest("a"), scope)
        const revisionB = yield* commitRevision(manifest, "session-a", digest("a"), otherScope)
        yield* seedManifest(manifest, scope)
        yield* seedManifest(manifest, otherScope)
        const snapshotA = snapshotFor([revisionA.commitId])
        const snapshotB = snapshotFor([revisionB.commitId], {
          scope: memoryScope(otherScope.tenant, otherScope.uid)
        })
        yield* manifest.registerUserIndexSnapshot({ snapshot: snapshotA })
        yield* manifest.registerUserIndexSnapshot({ snapshot: snapshotB })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshotA.id, ...verification(1) })
        yield* manifest.verifyUserIndexSnapshot({
          snapshotId: snapshotB.id,
          ...verification(1),
          graphRoots: ["t9:tenant-b|u6:user-a|snapshot|root-1"]
        })
        yield* activateCommitted(manifest, scope, snapshotA.id, null)
        yield* activateCommitted(manifest, otherScope, snapshotB.id, null)
        const contextA = yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid
        })
        const contextB = yield* resolveQueryContext({
          principal: principalFor(otherScope.tenant),
          requestedUid: otherScope.uid
        })
        return { contextA, contextB }
      })
    )

    expect(outcome.contextA.snapshot.id).not.toBe(outcome.contextB.snapshot.id)
    expect(outcome.contextA.scope).toMatchObject({ tenantId: "tenant-a", uid: "user-a" })
    expect(outcome.contextB.scope).toMatchObject({ tenantId: "tenant-b", uid: "user-a" })
  })

  it("defaults an omitted perspective to recorded time and requires COMMITTED", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
        yield* activateCommitted(manifest, scope, snapshot.id, null)
        return yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid
        })
      })
    )

    expect(outcome.perspective).toBe("recorded-time")
    expect(outcome.requiredWatermark).toBe("COMMITTED")
  })

  it("carries an explicitly chosen perspective", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
        yield* activateCommitted(manifest, scope, snapshot.id, null)
        const valid = yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid,
          perspective: "valid-time"
        })
        const bitemporal = yield* resolveQueryContext({
          principal: principalFor(scope.tenant),
          requestedUid: scope.uid,
          perspective: "bitemporal"
        })
        return { valid, bitemporal }
      })
    )

    expect(outcome.valid.perspective).toBe("valid-time")
    expect(outcome.bitemporal.perspective).toBe("bitemporal")
  })
})

describe("validateActiveSnapshot", () => {
  it("rejects pointers that do not name an active, evidenced, in-scope record", async () => {
    const active = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
        yield* activateCommitted(manifest, scope, snapshot.id, null)
        const resolved = yield* manifest.readActiveIndexSnapshot(scope)
        if (resolved === null) throw new Error("expected an active snapshot")
        return resolved
      })
    )
    const scopeValue = memoryScope(scope.tenant, scope.uid)

    expect(validateActiveSnapshot(scopeValue, active)).toMatchObject({
      _tag: "Success",
      success: { state: "ACTIVE" }
    })
    expect(
      validateActiveSnapshot(scopeValue, {
        ...active,
        record: { ...active.record, state: "SUPERSEDED" }
      })
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ActiveSnapshotCorrupt", reason: "stateNotActive" }
    })
    expect(
      validateActiveSnapshot(scopeValue, {
        ...active,
        record: {
          ...active.record,
          snapshot: { ...active.record.snapshot, scope: memoryScope("tenant-b", scope.uid) }
        }
      })
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ActiveSnapshotCorrupt", reason: "scopeMismatch" }
    })
    expect(
      validateActiveSnapshot(scopeValue, {
        ...active,
        record: { ...active.record, verificationDigest: null, graphRoots: null, counts: null }
      })
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ActiveSnapshotCorrupt", reason: "missingVerificationEvidence" }
    })
  })

  it("keeps the corrupt-pointer diagnostic typed", () => {
    const failure = new ActiveSnapshotCorrupt({
      snapshotId: "snapshot-v1-test",
      reason: "stateNotActive",
      detail: "SUPERSEDED"
    })
    expect(failure._tag).toBe("ActiveSnapshotCorrupt")
    expect(failure.message).toContain("snapshot-v1-test")
  })

  it("keeps the invalid-principal diagnostic typed", () => {
    const failure = new InvalidQueryPrincipal({ field: "tenantId", reason: "must not be empty" })
    expect(failure._tag).toBe("InvalidQueryPrincipal")
    expect(failure.message).toContain("tenantId")
  })
})

describe("QueryPrincipalProvider", () => {
  it("serves an explicitly configured principal", async () => {
    const principal = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layerStaticQueryPrincipal("tenant-a", "test-caller"))
          return yield* Context.get(context, QueryPrincipalProvider).currentPrincipal
        })
      )
    )

    expect(principal).toMatchObject({ tenantId: "tenant-a", subject: "test-caller" })
  })

  it("fails closed when the static principal is invalid", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layerStaticQueryPrincipal("", "test-caller"))
          return yield* Effect.result(
            Context.get(context, QueryPrincipalProvider).currentPrincipal
          )
        })
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidQueryPrincipal", field: "tenantId" }
    })
  })

  it("reads an explicit tenant and subject from configuration without defaults", async () => {
    const previousTenant = process.env["PALIMPSEST_QUERY_TENANT"]
    const previousSubject = process.env["PALIMPSEST_QUERY_SUBJECT"]
    process.env["PALIMPSEST_QUERY_TENANT"] = "tenant-a"
    process.env["PALIMPSEST_QUERY_SUBJECT"] = "test-caller"
    try {
      const principal = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layerQueryPrincipalFromConfig)
            return yield* Context.get(context, QueryPrincipalProvider).currentPrincipal
          })
        ).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())
        )
      )

      expect(principal).toMatchObject({ tenantId: "tenant-a", subject: "test-caller" })
    } finally {
      if (previousTenant === undefined) delete process.env["PALIMPSEST_QUERY_TENANT"]
      else process.env["PALIMPSEST_QUERY_TENANT"] = previousTenant
      if (previousSubject === undefined) delete process.env["PALIMPSEST_QUERY_SUBJECT"]
      else process.env["PALIMPSEST_QUERY_SUBJECT"] = previousSubject
    }
  })
})
