import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"
import { Effect, Result } from "effect"
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
import { createDatabase, MANIFEST_SCHEMA_VERSION } from "../../src/IngestManifest/Schema.js"
import { createSnapshotOperations, type SnapshotOperations } from "../../src/IngestManifest/Snapshots.js"
import { parseMemoryScope, type MemoryScope } from "../../src/MemoryScope.js"
import { createExtractionGeneration } from "../../src/SourceIdentity.js"
import { createUserIndexSnapshot, parseUserIndexSnapshot } from "../../src/UserIndexSnapshot.js"
import { createCanonicalViewOperations } from "../../src/IngestManifest/CanonicalView.js"
import { createGenerationOperations } from "../../src/IngestManifest/Generations.js"
import { createRevisionOperations } from "../../src/IngestManifest/Revisions.js"

const execFileAsync = promisify(execFile)

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

const otherIndexGeneration = createIndexGeneration({
  extractionGeneration: extraction,
  graphWriter: { id: "test-writer", revision: "git:writer-2" },
  graphSchema: { id: "test-graph-schema", revision: "v1" }
})

const scope = { tenant: "default", uid: "user-a" } as const

const memoryScope = (tenant: string, uid: string): MemoryScope => {
  const parsed = parseMemoryScope(tenant, uid)
  if (Result.isFailure(parsed)) throw parsed.failure
  return parsed.success
}

const viewOf = (identities: ReadonlyArray<{ id: string; canon: string }>): EntityCanonicalView => {
  const created = createEntityCanonicalView({
    identities: identities.map((identity) => ({ ...identity, etype: "person" })),
    equivalences: []
  })
  if (Result.isFailure(created)) throw created.failure
  return created.success
}

const view = viewOf([{ id: "identity-alice", canon: "alice" }])
const altView = viewOf([{ id: "identity-alice", canon: "alice" }, { id: "identity-bob", canon: "bob" }])
const thirdView = viewOf([
  { id: "identity-alice", canon: "alice" },
  { id: "identity-carol", canon: "carol" }
])

type ManifestOps = RevisionOperations & GenerationOperations & CanonicalViewOperations & SnapshotOperations

const digest = (marker: string): string => marker.repeat(64)

const verification = (sourceRevisions: number, marker = "f") => ({
  verificationDigest: digest(marker),
  graphRoots: ["t7:default|u6:user-a|snapshot|root-1"],
  counts: { sourceRevisions, vertices: 12, relationships: 7 }
})

const snapshotFor = (
  sourceCommitIds: ReadonlyArray<string>,
  overrides?: {
    readonly scope?: MemoryScope
    readonly indexGenerationId?: string
    readonly canonicalViewId?: string
    readonly manifestSchemaVersion?: number
  }
) =>
  Result.getOrThrow(
    createUserIndexSnapshot({
      scope: overrides?.scope ?? memoryScope(scope.tenant, scope.uid),
      indexGenerationId: overrides?.indexGenerationId ?? indexGeneration.id,
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
        extractionGeneration: {
          id: extraction.id,
          canonicalJson: extraction.canonicalJson
        }
      })
    ).revision
    for (const [from, to] of STAGE_PATH) {
      revision = yield* manifest.advance({ revision, from, to })
    }
    return revision
  })

const seedManifest = (manifest: ManifestOps): Effect.Effect<void, IngestManifestError> =>
  Effect.gen(function* () {
    yield* manifest.storeIndexGeneration({ generation: indexGeneration })
    yield* manifest.storeEntityCanonicalView({ ...scope, view })
    yield* manifest.storeEntityCanonicalView({ ...scope, view: altView })
  })

const run = <A>(effect: Effect.Effect<A, IngestManifestError, IngestManifest>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(IngestManifestLayerMemory))))

const opsFor = (database: DatabaseSync): ManifestOps => ({
  ...createRevisionOperations(database),
  ...createGenerationOperations(database),
  ...createCanonicalViewOperations(database),
  ...createSnapshotOperations(database)
})

describe("UserIndexSnapshot identity", () => {
  it("content-addresses scope, generation, view, ordered revisions, and schema version", () => {
    const sourceCommitIds = ["ingest-a", "ingest-b"]
    const base = {
      scope: memoryScope(scope.tenant, scope.uid),
      indexGenerationId: indexGeneration.id,
      canonicalViewId: view.id,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION
    }
    const first = Result.getOrThrow(createUserIndexSnapshot({ ...base, sourceCommitIds }))
    const equivalent = Result.getOrThrow(createUserIndexSnapshot({ ...base, sourceCommitIds }))

    expect(equivalent.id).toBe(first.id)
    expect(first.id.startsWith("snapshot-v1-")).toBe(true)
    expect(
      Result.getOrThrow(
        createUserIndexSnapshot({ ...base, sourceCommitIds: [...sourceCommitIds].reverse() })
      ).id
    ).not.toBe(first.id)
    expect(
      Result.getOrThrow(
        createUserIndexSnapshot({ ...base, canonicalViewId: altView.id, sourceCommitIds })
      ).id
    ).not.toBe(first.id)
    expect(
      Result.getOrThrow(
        createUserIndexSnapshot({
          ...base,
          indexGenerationId: otherIndexGeneration.id,
          sourceCommitIds
        })
      ).id
    ).not.toBe(first.id)
    expect(
      Result.getOrThrow(
        createUserIndexSnapshot({
          ...base,
          scope: memoryScope("other-tenant", scope.uid),
          sourceCommitIds
        })
      ).id
    ).not.toBe(first.id)
    expect(
      Result.getOrThrow(
        createUserIndexSnapshot({
          ...base,
          manifestSchemaVersion: MANIFEST_SCHEMA_VERSION + 1,
          sourceCommitIds
        })
      ).id
    ).not.toBe(first.id)
  })

  it("round-trips through its canonical descriptor and rejects malformed encodings", () => {
    const snapshot = snapshotFor(["ingest-a", "ingest-b"])

    expect(parseUserIndexSnapshot(snapshot.id, snapshot.canonicalJson)).toMatchObject({
      _tag: "Success",
      success: {
        id: snapshot.id,
        indexGenerationId: indexGeneration.id,
        canonicalViewId: view.id,
        sourceCommitIds: ["ingest-a", "ingest-b"],
        manifestSchemaVersion: MANIFEST_SCHEMA_VERSION
      }
    })
    expect(parseUserIndexSnapshot(snapshot.id, "{}")._tag).toBe("Failure")
    expect(parseUserIndexSnapshot(snapshot.id, "{ \"uid\": \"user-a\" }")._tag).toBe("Failure")
    expect(
      parseUserIndexSnapshot(snapshot.id, snapshot.canonicalJson.replace("\"uid\":\"user-a\"", "\"uid\":\"user-b\""))
    ).toMatchObject({ _tag: "Failure", failure: { reason: "identifierMismatch" } })
    expect(parseUserIndexSnapshot("snapshot-v1-forged", snapshot.canonicalJson)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "identifierMismatch" }
    })

    expect(
      createUserIndexSnapshot({
        scope: memoryScope(scope.tenant, scope.uid),
        indexGenerationId: indexGeneration.id,
        canonicalViewId: view.id,
        sourceCommitIds: ["ingest-a", "ingest-a"],
        manifestSchemaVersion: MANIFEST_SCHEMA_VERSION
      })
    ).toMatchObject({
      _tag: "Failure",
      failure: { reason: "invalidEncoding" }
    })
    const formatPair = `"format":"palimpsest.user-index-snapshot.v1"`
    const reordered = `{${formatPair},${snapshot.canonicalJson.slice(1).replace(`,${formatPair}`, "")}`
    expect(parseUserIndexSnapshot(snapshot.id, reordered)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "invalidEncoding" }
    })
  })
})

describe("user index snapshot manifest", () => {
  it("registers a building snapshot and reconstructs it from the manifest row", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        const registered = yield* manifest.registerUserIndexSnapshot({ snapshot })
        const repeated = yield* manifest.registerUserIndexSnapshot({ snapshot })
        const read = yield* manifest.readUserIndexSnapshot(snapshot.id)
        const listed = yield* manifest.listUserIndexSnapshots(scope)
        const missing = yield* manifest.readUserIndexSnapshot("snapshot-v1-absent")
        return { registered, repeated, read, listed, missing, revision }
      })
    )

    expect(outcome.registered).toMatchObject({
      state: "BUILDING",
      buildAttempt: 1,
      verificationDigest: null,
      graphRoots: null,
      counts: null,
      failureCode: null
    })
    expect(outcome.registered.snapshot).toEqual(outcome.read?.snapshot)
    expect(outcome.repeated).toEqual(outcome.registered)
    expect(outcome.listed.map((record) => record.snapshot.id)).toEqual([outcome.registered.snapshot.id])
    expect(outcome.missing).toBeNull()
    expect(outcome.read?.snapshot.sourceCommitIds).toEqual([outcome.revision.commitId])
  })

  it("rejects registrations that name unknown or foreign-scope inputs", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const foreign = yield* commitRevision(manifest, "session-a", digest("b"), {
          tenant: "tenant-b",
          uid: scope.uid
        })
        const unknownGeneration = yield* manifest
          .registerUserIndexSnapshot({
            snapshot: snapshotFor([revision.commitId], { indexGenerationId: otherIndexGeneration.id })
          })
          .pipe(Effect.result)
        const unknownView = yield* manifest
          .registerUserIndexSnapshot({
            snapshot: snapshotFor([revision.commitId], { canonicalViewId: "canonical-view-v1-absent" })
          })
          .pipe(Effect.result)
        const unknownRevision = yield* manifest
          .registerUserIndexSnapshot({ snapshot: snapshotFor(["ingest-absent"]) })
          .pipe(Effect.result)
        const foreignRevision = yield* manifest
          .registerUserIndexSnapshot({ snapshot: snapshotFor([foreign.commitId]) })
          .pipe(Effect.result)
        const snapshot = snapshotFor([revision.commitId])
        const forged = yield* manifest
          .registerUserIndexSnapshot({
            snapshot: { ...snapshot, canonicalJson: snapshotFor(["ingest-a"]).canonicalJson }
          })
          .pipe(Effect.result)
        return { unknownGeneration, unknownView, unknownRevision, foreignRevision, forged }
      })
    )

    expect(outcome.unknownGeneration).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IndexGenerationNotFound" }
    })
    expect(outcome.unknownView).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EntityCanonicalViewNotFound" }
    })
    expect(outcome.unknownRevision).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "UserIndexSnapshotBindingMismatch", reason: "unknownRevision" }
    })
    expect(outcome.foreignRevision).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "UserIndexSnapshotBindingMismatch", reason: "scopeMismatch" }
    })
    expect(outcome.forged).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidUserIndexSnapshot" }
    })
  })

  it("verifies a building snapshot once and keeps identical evidence idempotent", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        const verified = yield* manifest.verifyUserIndexSnapshot({
          snapshotId: snapshot.id,
          ...verification(1)
        })
        const repeated = yield* manifest.verifyUserIndexSnapshot({
          snapshotId: snapshot.id,
          ...verification(1)
        })
        const conflict = yield* manifest
          .verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1, "e") })
          .pipe(Effect.result)
        const badDigest = yield* manifest
          .verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1), verificationDigest: "not-hex" })
          .pipe(Effect.result)
        const badCounts = yield* manifest
          .verifyUserIndexSnapshot({
            snapshotId: snapshot.id,
            ...verification(1),
            counts: { sourceRevisions: 2, vertices: 1, relationships: 1 }
          })
          .pipe(Effect.result)
        const missing = yield* manifest
          .verifyUserIndexSnapshot({ snapshotId: "snapshot-v1-absent", ...verification(0) })
          .pipe(Effect.result)
        return { verified, repeated, conflict, badDigest, badCounts, missing }
      })
    )

    expect(outcome.verified).toMatchObject({
      state: "VERIFIED",
      verificationDigest: digest("f"),
      graphRoots: ["t7:default|u6:user-a|snapshot|root-1"],
      counts: { sourceRevisions: 1, vertices: 12, relationships: 7 }
    })
    expect(outcome.repeated).toEqual(outcome.verified)
    expect(outcome.conflict).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotVerificationConflict" }
    })
    expect(outcome.badDigest).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidSnapshotUpdate", field: "verificationDigest" }
    })
    expect(outcome.badCounts).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidSnapshotUpdate", field: "counts" }
    })
    expect(outcome.missing).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "UserIndexSnapshotNotFound" }
    })
  })

  it("fails a building snapshot and reopens it as a new build attempt", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshot = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot })
        const failed = yield* manifest.failUserIndexSnapshot({
          snapshotId: snapshot.id,
          code: "BUILD_CRASH"
        })
        const repeated = yield* manifest.failUserIndexSnapshot({
          snapshotId: snapshot.id,
          code: "BUILD_CRASH"
        })
        const differentCode = yield* manifest
          .failUserIndexSnapshot({ snapshotId: snapshot.id, code: "OTHER" })
          .pipe(Effect.result)
        const verifyFailed = yield* manifest
          .verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
          .pipe(Effect.result)
        const reopened = yield* manifest.registerUserIndexSnapshot({ snapshot })
        const verified = yield* manifest.verifyUserIndexSnapshot({
          snapshotId: snapshot.id,
          ...verification(1)
        })
        const emptyCode = yield* manifest
          .failUserIndexSnapshot({ snapshotId: snapshot.id, code: " " })
          .pipe(Effect.result)
        return { failed, repeated, differentCode, verifyFailed, reopened, verified, emptyCode }
      })
    )

    expect(outcome.failed).toMatchObject({ state: "FAILED", failureCode: "BUILD_CRASH" })
    expect(outcome.repeated).toEqual(outcome.failed)
    expect(outcome.differentCode).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidSnapshotTransition", current: "FAILED" }
    })
    expect(outcome.verifyFailed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidSnapshotTransition", current: "FAILED", requested: "VERIFIED" }
    })
    expect(outcome.reopened).toMatchObject({
      state: "BUILDING",
      buildAttempt: 2,
      failureCode: null
    })
    expect(outcome.verified.state).toBe("VERIFIED")
    expect(outcome.emptyCode).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidSnapshotUpdate", field: "failureCode" }
    })
  })

  it("activates a verified snapshot, supersedes the previous one, and rolls back", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const first = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const snapshotA = snapshotFor([first.commitId])
        const snapshotB = snapshotFor([first.commitId], { canonicalViewId: altView.id })
        yield* manifest.registerUserIndexSnapshot({ snapshot: snapshotA })
        yield* manifest.registerUserIndexSnapshot({ snapshot: snapshotB })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshotA.id, ...verification(1) })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: snapshotB.id, ...verification(1, "e") })
        const activatedA = yield* manifest.activateIndexSnapshot({
          ...scope,
          snapshotId: snapshotA.id,
          expectedManifestVersion: 1,
          expectedActiveSnapshotId: null
        })
        const repeatedA = yield* manifest.activateIndexSnapshot({
          ...scope,
          snapshotId: snapshotA.id,
          expectedManifestVersion: 3,
          expectedActiveSnapshotId: null
        })
        const activatedB = yield* manifest.activateIndexSnapshot({
          ...scope,
          snapshotId: snapshotB.id,
          expectedManifestVersion: 1,
          expectedActiveSnapshotId: snapshotA.id
        })
        const afterB = yield* manifest.readActiveIndexSnapshot(scope)
        const supersededA = yield* manifest.readUserIndexSnapshot(snapshotA.id)

        const rolledBack = yield* manifest.activateIndexSnapshot({
          ...scope,
          snapshotId: snapshotA.id,
          expectedManifestVersion: 1,
          expectedActiveSnapshotId: snapshotB.id
        })
        const afterRollback = yield* manifest.readActiveIndexSnapshot(scope)
        const supersededB = yield* manifest.readUserIndexSnapshot(snapshotB.id)
        return {
          activatedA,
          repeatedA,
          activatedB,
          afterB,
          supersededA,
          rolledBack,
          afterRollback,
          supersededB,
          snapshotAId: snapshotA.id,
          snapshotBId: snapshotB.id
        }
      })
    )

    expect(outcome.activatedA).toMatchObject({
      manifestVersion: 1,
      record: { state: "ACTIVE", snapshot: { id: outcome.snapshotAId } }
    })
    expect(outcome.repeatedA).toEqual(outcome.activatedA)
    expect(outcome.activatedB.record.snapshot.id).toBe(outcome.snapshotBId)
    expect(outcome.afterB?.record.snapshot.id).toBe(outcome.snapshotBId)
    expect(outcome.supersededA?.state).toBe("SUPERSEDED")
    expect(outcome.rolledBack.record.snapshot.id).toBe(outcome.snapshotAId)
    expect(outcome.afterRollback?.record.snapshot.id).toBe(outcome.snapshotAId)
    expect(outcome.supersededB?.state).toBe("SUPERSEDED")
  })

  it("refuses activation for unverified, unknown, foreign-scope, or stale inputs", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const revision = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const building = snapshotFor([revision.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot: building })
        const buildingActivation = yield* manifest
          .activateIndexSnapshot({
            ...scope,
            snapshotId: building.id,
            expectedManifestVersion: 1,
            expectedActiveSnapshotId: null
          })
          .pipe(Effect.result)
        const unknown = yield* manifest
          .activateIndexSnapshot({
            ...scope,
            snapshotId: "snapshot-v1-absent",
            expectedManifestVersion: 1,
            expectedActiveSnapshotId: null
          })
          .pipe(Effect.result)
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: building.id, ...verification(1) })
        const foreignScope = yield* manifest
          .activateIndexSnapshot({
            tenant: "tenant-b",
            uid: scope.uid,
            snapshotId: building.id,
            expectedManifestVersion: 1,
            expectedActiveSnapshotId: null
          })
          .pipe(Effect.result)
        const stale = yield* manifest
          .activateIndexSnapshot({
            ...scope,
            snapshotId: building.id,
            expectedManifestVersion: 7,
            expectedActiveSnapshotId: null
          })
          .pipe(Effect.result)
        const activated = yield* manifest.activateIndexSnapshot({
          ...scope,
          snapshotId: building.id,
          expectedManifestVersion: 1,
          expectedActiveSnapshotId: null
        })
        const activeAfterFailures = yield* manifest.readActiveIndexSnapshot(scope)
        return { buildingActivation, unknown, foreignScope, stale, activated, activeAfterFailures }
      })
    )

    expect(outcome.buildingActivation).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidSnapshotTransition", current: "BUILDING", requested: "ACTIVE" }
    })
    expect(outcome.unknown).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "UserIndexSnapshotNotFound" }
    })
    expect(outcome.foreignScope).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SnapshotScopeMismatch" }
    })
    expect(outcome.stale).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SnapshotActivationConflict",
        expectedManifestVersion: 7,
        actualManifestVersion: 1
      }
    })
    expect(outcome.activated.record.state).toBe("ACTIVE")
    expect(outcome.activeAfterFailures?.record.snapshot.id).toBe(outcome.activated.record.snapshot.id)
  })

  it("refuses activation when a listed revision is uncommitted or a committed one is uncovered", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const first = yield* commitRevision(manifest, "session-a", digest("a"))
        yield* seedManifest(manifest)
        const pending = (
          yield* manifest.begin({
            tenant: scope.tenant,
            uid: scope.uid,
            logicalSessionId: "session-pending",
            sourceDigest: digest("c"),
            sourceBytes: 50,
            extractionGeneration: {
              id: extraction.id,
              canonicalJson: extraction.canonicalJson
            }
          })
        ).revision
        const withPending = snapshotFor([first.commitId, pending.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot: withPending })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: withPending.id, ...verification(2) })
        const uncommitted = yield* manifest
          .activateIndexSnapshot({
            ...scope,
            snapshotId: withPending.id,
            expectedManifestVersion: 1,
            expectedActiveSnapshotId: null
          })
          .pipe(Effect.result)

        const coveringOnlyFirst = snapshotFor([first.commitId])
        yield* manifest.registerUserIndexSnapshot({ snapshot: coveringOnlyFirst })
        yield* manifest.verifyUserIndexSnapshot({ snapshotId: coveringOnlyFirst.id, ...verification(1) })
        const second = yield* commitRevision(manifest, "session-b", digest("b"))
        const uncovered = yield* manifest
          .activateIndexSnapshot({
            ...scope,
            snapshotId: coveringOnlyFirst.id,
            expectedManifestVersion: 2,
            expectedActiveSnapshotId: null
          })
          .pipe(Effect.result)
        return { uncommitted, uncovered, pending, second }
      })
    )

    expect(outcome.uncommitted).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SnapshotRevisionNotCommitted",
        commitId: outcome.pending.commitId,
        state: "RECEIVED"
      }
    })
    expect(outcome.uncovered).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SnapshotRevisionCoverageMismatch",
        missingCommitIds: [outcome.second.commitId]
      }
    })
  })

  it("keeps the previous snapshot active when a verified successor never activates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-snapshot-"))
    const path = join(directory, "manifest.sqlite")
    try {
      const firstDatabase = createDatabase(path)
      let snapshotAId = ""
      let snapshotBId = ""
      try {
        const ops = opsFor(firstDatabase)
        const [snapshotA, snapshotB] = await Effect.runPromise(
          Effect.gen(function* () {
            const first = yield* commitRevision(ops, "session-a", digest("a"))
            yield* seedManifest(ops)
            const a = snapshotFor([first.commitId])
            yield* ops.registerUserIndexSnapshot({ snapshot: a })
            yield* ops.verifyUserIndexSnapshot({ snapshotId: a.id, ...verification(1) })
            yield* ops.activateIndexSnapshot({
              ...scope,
              snapshotId: a.id,
              expectedManifestVersion: 1,
              expectedActiveSnapshotId: null
            })
            const second = yield* commitRevision(ops, "session-b", digest("b"))
            const b = snapshotFor([first.commitId, second.commitId])
            yield* ops.registerUserIndexSnapshot({ snapshot: b })
            yield* ops.verifyUserIndexSnapshot({ snapshotId: b.id, ...verification(2) })
            return [a, b] as const
          })
        )
        snapshotAId = snapshotA.id
        snapshotBId = snapshotB.id
      } finally {
        firstDatabase.close()
      }

      const reopened = createDatabase(path)
      try {
        const snapshots = createSnapshotOperations(reopened)
        const active = await Effect.runPromise(snapshots.readActiveIndexSnapshot(scope))
        const successor = await Effect.runPromise(snapshots.readUserIndexSnapshot(snapshotBId))
        expect(active?.record.snapshot.id).toBe(snapshotAId)
        expect(active?.manifestVersion).toBe(1)
        expect(successor?.state).toBe("VERIFIED")
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("migrates a version-9 manifest forward and keeps committed revisions readable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-snapshot-migration-"))
    const path = join(directory, "manifest.sqlite")
    try {
      const created = createDatabase(path)
      let commitId = ""
      try {
        const ops = opsFor(created)
        commitId = (
          await Effect.runPromise(
            Effect.gen(function* () {
              const revision = yield* commitRevision(ops, "session-a", digest("a"))
              yield* seedManifest(ops)
              return revision
            })
          )
        ).commitId
      } finally {
        created.close()
      }

      const downgraded = new DatabaseSync(path)
      downgraded.exec(`
        DROP TABLE active_index_snapshots;
        DROP TABLE user_index_snapshot_revisions;
        DROP TABLE user_index_snapshots;
        PRAGMA user_version = 9;
      `)
      downgraded.close()

      const migrated = createDatabase(path)
      try {
        const ops = opsFor(migrated)
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const revision = yield* ops.read({
              tenant: scope.tenant,
              uid: scope.uid,
              logicalSessionId: "session-a",
              sourceDigest: digest("a"),
              extractionGeneration: extraction.id
            })
            const snapshot = snapshotFor([commitId])
            yield* ops.registerUserIndexSnapshot({ snapshot })
            yield* ops.verifyUserIndexSnapshot({ snapshotId: snapshot.id, ...verification(1) })
            const active = yield* ops.activateIndexSnapshot({
              ...scope,
              snapshotId: snapshot.id,
              expectedManifestVersion: 1,
              expectedActiveSnapshotId: null
            })
            return { revision, active }
          })
        )
        expect(outcome.revision).toMatchObject({ commitId, state: "COMMITTED" })
        expect(outcome.active.record.state).toBe("ACTIVE")
        const versionRow = migrated.prepare("PRAGMA user_version").get()
        expect(versionRow).toMatchObject({ user_version: MANIFEST_SCHEMA_VERSION })
      } finally {
        migrated.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a future manifest schema without downgrading it", () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-snapshot-future-schema-"))
    const path = join(directory, "manifest.sqlite")
    try {
      const future = new DatabaseSync(path)
      future.exec(`PRAGMA user_version = ${MANIFEST_SCHEMA_VERSION + 1};`)
      future.close()

      expect(() => createDatabase(path)).toThrow(
        `manifest schema version ${MANIFEST_SCHEMA_VERSION + 1} is newer than supported version ${MANIFEST_SCHEMA_VERSION}`
      )

      const unchanged = new DatabaseSync(path)
      try {
        expect(unchanged.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: MANIFEST_SCHEMA_VERSION + 1
        })
      } finally {
        unchanged.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reports a corrupted stored snapshot row as unavailable", async () => {
    const database = createDatabase(":memory:")
    try {
      const ops = opsFor(database)
      const [snapshotAId, snapshotBId] = await Effect.runPromise(
        Effect.gen(function* () {
          const revision = yield* commitRevision(ops, "session-a", digest("a"))
          yield* seedManifest(ops)
          const snapshotA = snapshotFor([revision.commitId])
          const snapshotB = snapshotFor([revision.commitId], { canonicalViewId: altView.id })
          yield* ops.registerUserIndexSnapshot({ snapshot: snapshotA })
          yield* ops.registerUserIndexSnapshot({ snapshot: snapshotB })
          return [snapshotA.id, snapshotB.id] as const
        })
      )
      database
        .prepare(`UPDATE user_index_snapshots SET canonical_json = ? WHERE snapshot_id = ?`)
        .run('{"format":"palimpsest.user-index-snapshot.v1"}', snapshotAId)
      database
        .prepare(`DELETE FROM user_index_snapshot_revisions WHERE snapshot_id = ? AND position = 0`)
        .run(snapshotBId)
      const malformed = await Effect.runPromise(
        ops.readUserIndexSnapshot(snapshotAId).pipe(Effect.result)
      )
      const missingRevision = await Effect.runPromise(
        ops.readUserIndexSnapshot(snapshotBId).pipe(Effect.result)
      )
      for (const outcome of [malformed, missingRevision]) {
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "IngestManifestUnavailable", operation: "readUserIndexSnapshot" }
        })
      }
    } finally {
      database.close()
    }
  })

  it("gives competing activations one compare-and-swap winner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-snapshot-race-"))
    const path = join(directory, "manifest.sqlite")
    const worker = join(
      process.cwd(),
      "packages",
      "palimpsest",
      "test",
      "fixtures",
      "snapshot-activation-worker.ts"
    )
    try {
      const setup = createDatabase(path)
      let snapshotAId = ""
      let snapshotBId = ""
      let snapshotCId = ""
      try {
        const ops = opsFor(setup)
        ;[snapshotAId, snapshotBId, snapshotCId] = await Effect.runPromise(
          Effect.gen(function* () {
            const first = yield* commitRevision(ops, "session-a", digest("a"))
            yield* seedManifest(ops)
            yield* ops.storeEntityCanonicalView({ ...scope, view: thirdView })
            const second = yield* commitRevision(ops, "session-b", digest("b"))
            const a = snapshotFor([first.commitId, second.commitId])
            const b = snapshotFor([first.commitId, second.commitId], { canonicalViewId: altView.id })
            const c = snapshotFor([first.commitId, second.commitId], { canonicalViewId: thirdView.id })
            yield* ops.registerUserIndexSnapshot({ snapshot: a })
            yield* ops.registerUserIndexSnapshot({ snapshot: b })
            yield* ops.registerUserIndexSnapshot({ snapshot: c })
            yield* ops.verifyUserIndexSnapshot({ snapshotId: a.id, ...verification(2) })
            yield* ops.verifyUserIndexSnapshot({ snapshotId: b.id, ...verification(2, "e") })
            yield* ops.verifyUserIndexSnapshot({ snapshotId: c.id, ...verification(2, "d") })
            return [a.id, b.id, c.id] as const
          })
        )
      } finally {
        setup.close()
      }

      const runWorker = (snapshotId: string, expected: number) =>
        execFileAsync(
          process.execPath,
          ["--import", "tsx", worker, path, scope.tenant, scope.uid, snapshotId, String(expected)],
          { cwd: process.cwd(), windowsHide: true }
        )
      const outcomes = await Promise.all([
        runWorker(snapshotAId, 2),
        runWorker(snapshotBId, 2),
        runWorker(snapshotCId, 1)
      ])
      expect(outcomes.map(({ stdout }) => stdout.trim()).sort()).toEqual([
        "SnapshotActivationConflict",
        "SnapshotActivePointerConflict",
        "activated"
      ])

      const database = createDatabase(path)
      try {
        const snapshots = createSnapshotOperations(database)
        const active = await Effect.runPromise(snapshots.readActiveIndexSnapshot(scope))
        const listed = await Effect.runPromise(snapshots.listUserIndexSnapshots(scope))
        expect([snapshotAId, snapshotBId]).toContain(active?.record.snapshot.id)
        expect(active?.manifestVersion).toBe(2)
        expect(listed.map((record) => record.state).sort()).toEqual([
          "ACTIVE",
          "VERIFIED",
          "VERIFIED"
        ])
      } finally {
        database.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
