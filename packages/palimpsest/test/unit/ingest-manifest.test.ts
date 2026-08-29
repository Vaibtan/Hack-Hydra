import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  IngestManifest,
  IngestManifestLayerMemory,
  IngestManifestLive,
  createExtractionGeneration,
  type BeginSourceRevision,
  type IngestManifestError
} from "../../src/index.js"

const extractionGeneration = createExtractionGeneration({
  extractor: { id: "test-extractor", revision: "git:test" },
  model: { id: "test-model", revision: "snapshot:test" },
  tokenizer: { id: "test-tokenizer", revision: "v1" },
  promptTemplate: "test extraction prompt",
  outputSchema: { type: "object", version: 1 }
})

const baseRevision: BeginSourceRevision = {
  tenant: "default",
  uid: "user-a",
  logicalSessionId: "session-a",
  sourceDigest: "a".repeat(64),
  sourceBytes: 104,
  extractionGeneration: {
    id: extractionGeneration.id,
    canonicalJson: extractionGeneration.canonicalJson
  }
}

const run = <A>(effect: Effect.Effect<A, IngestManifestError, IngestManifest>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(Effect.provide(IngestManifestLayerMemory))
    )
  )

const projectionStats = {
  claims: 2,
  entities: 1,
  slots: 1,
  tokens: 3,
  sessions: 1,
  turns: 2,
  supersessions: 0,
  contestedSlots: 0
} as const

describe("IngestManifest", () => {
  it("keeps a durable source revision incomplete until the commit state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const created = yield* manifest.begin(baseRevision)
        const sourceDurable = yield* manifest.advance({
          revision: created.revision,
          from: "RECEIVED",
          to: "SOURCE_DURABLE"
        })
        const resumed = yield* manifest.begin(baseRevision)
        return { created, sourceDurable, resumed }
      })
    )

    expect(result.created.disposition).toBe("created")
    expect(result.created.revision.state).toBe("RECEIVED")
    expect(result.sourceDurable.state).toBe("SOURCE_DURABLE")
    expect(result.resumed.disposition).toBe("resumed")
    expect(result.resumed.revision.state).toBe("SOURCE_DURABLE")
    expect(result.resumed.revision.commitId).toBe(result.created.revision.commitId)
  })

  it("assigns one ordinal to revisions of the same logical session and a new ordinal to another session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const first = yield* manifest.begin(baseRevision)
        const changedBytes = yield* manifest.begin({
          ...baseRevision,
          sourceDigest: "b".repeat(64),
          sourceBytes: 105
        })
        const nextSession = yield* manifest.begin({
          ...baseRevision,
          logicalSessionId: "session-b",
          sourceDigest: "c".repeat(64)
        })
        return { first, changedBytes, nextSession }
      })
    )

    expect(result.changedBytes.disposition).toBe("created")
    expect(result.changedBytes.revision.sessionOrdinal).toBe(result.first.revision.sessionOrdinal)
    expect(result.nextSession.revision.sessionOrdinal).toBe(result.first.revision.sessionOrdinal + 1)
  })

  it("does not merge two logical sessions just because their source bytes match", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const first = yield* manifest.begin(baseRevision)
        const second = yield* manifest.begin({
          ...baseRevision,
          logicalSessionId: "session-with-identical-bytes"
        })
        return { first, second }
      })
    )

    expect(result.first.disposition).toBe("created")
    expect(result.second.disposition).toBe("created")
    expect(result.second.revision.commitId).not.toBe(result.first.revision.commitId)
    expect(result.second.revision.sessionOrdinal).toBe(result.first.revision.sessionOrdinal + 1)
  })

  it("records the full extraction-generation definition and rejects an id collision", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const created = yield* manifest.begin(baseRevision)
          const recorded = yield* manifest.readExtractionGeneration(
            baseRevision.extractionGeneration.id
          )
          const collision = yield* manifest
            .begin({
              ...baseRevision,
              logicalSessionId: "session-b",
              extractionGeneration: {
                ...baseRevision.extractionGeneration,
                canonicalJson: '{"format":"different"}'
              }
            })
            .pipe(Effect.either)
          return { created, recorded, collision }
        }).pipe(Effect.provide(IngestManifestLayerMemory))
      )
    )

    expect(outcome.created.revision.extractionGeneration).toBe(baseRevision.extractionGeneration.id)
    expect(outcome.recorded).toEqual(baseRevision.extractionGeneration)
    expect(outcome.collision).toMatchObject({ _tag: "Left", left: { _tag: "InvalidSourceRevision" } })
  })

  it("rejects a non-canonical generation definition before it can name a revision", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        return yield* manifest
          .begin({
            ...baseRevision,
            extractionGeneration: {
              ...baseRevision.extractionGeneration,
              canonicalJson: '{ "model": "test", "format": "palimpsest.extraction-generation.v1" }'
            }
          })
          .pipe(Effect.either)
      })
    )

    expect(outcome).toMatchObject({ _tag: "Left", left: { _tag: "InvalidSourceRevision" } })
  })

  it("allocates one commit for concurrent retries and unique monotonic ordinals for distinct sessions", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const sameRevision = yield* Effect.all(
          Array.from({ length: 32 }, () => manifest.begin(baseRevision)),
          { concurrency: "unbounded" }
        )
        const distinctRevisions = yield* Effect.all(
          Array.from({ length: 32 }, (_, index) =>
            manifest.begin({
              ...baseRevision,
              logicalSessionId: `concurrent-session-${index}`,
              sourceDigest: index.toString(16).padStart(64, "0")
            })
          ),
          { concurrency: "unbounded" }
        )
        return { sameRevision, distinctRevisions }
      })
    )

    expect(outcome.sameRevision.filter((result) => result.disposition === "created")).toHaveLength(1)
    expect(new Set(outcome.sameRevision.map((result) => result.revision.commitId)).size).toBe(1)
    expect(outcome.distinctRevisions.map((result) => result.revision.sessionOrdinal)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 2)
    )
  })

  it("upgrades the old source identity without losing its resumable revision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-manifest-v1-"))
    const path = join(directory, "manifest.sqlite")
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE user_manifests (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        next_session_ordinal INTEGER NOT NULL,
        manifest_version INTEGER NOT NULL,
        PRIMARY KEY (tenant, uid)
      ) STRICT;
      INSERT INTO user_manifests VALUES ('default', 'user-a', 2, 0);
      CREATE TABLE source_revisions (
        revision_key TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        source_bytes INTEGER NOT NULL,
        extraction_generation TEXT NOT NULL,
        session_ordinal INTEGER NOT NULL,
        commit_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        manifest_version INTEGER NOT NULL,
        failure_code TEXT,
        failure_retryable INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (tenant, uid, source_digest, extraction_generation)
      ) STRICT;
      INSERT INTO source_revisions VALUES (
        'v1-key', 'default', 'user-a', 'session-a', '${"a".repeat(64)}', 104,
        '${extractionGeneration.id}', 1, 'legacy-commit', 'SOURCE_DURABLE', 0, NULL, NULL, 1, 1
      );
    `)
    legacy.close()

    const previousPath = process.env["PALIMPSEST_INGEST_MANIFEST_PATH"]
    process.env["PALIMPSEST_INGEST_MANIFEST_PATH"] = path
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const manifest = yield* IngestManifest
            const resumed = yield* manifest.read({
              tenant: baseRevision.tenant,
              uid: baseRevision.uid,
              logicalSessionId: baseRevision.logicalSessionId,
              sourceDigest: baseRevision.sourceDigest,
              extractionGeneration: baseRevision.extractionGeneration.id
            })
            const distinct = yield* manifest.begin({
              ...baseRevision,
              logicalSessionId: "session-b"
            })
            return { resumed, distinct }
          }).pipe(Effect.provide(IngestManifestLive))
        )
      )

      expect(result.resumed).toMatchObject({ commitId: "legacy-commit", state: "SOURCE_DURABLE" })
      expect(result.distinct).toMatchObject({ disposition: "created" })
    } finally {
      if (previousPath === undefined) delete process.env["PALIMPSEST_INGEST_MANIFEST_PATH"]
      else process.env["PALIMPSEST_INGEST_MANIFEST_PATH"] = previousPath
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a stage jump so a partial ingest cannot be called committed", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const created = yield* manifest.begin(baseRevision)
          return yield* manifest.advance({
            revision: created.revision,
            from: "RECEIVED",
            to: "COMMITTED"
          }).pipe(Effect.either)
        }).pipe(Effect.provide(IngestManifestLayerMemory))
      )
    )

    expect(outcome._tag).toBe("Left")
    if (outcome._tag === "Left") {
      expect(outcome.left._tag).toBe("InvalidIngestTransition")
    }
  })

  it("does not advance a terminal failure or attach a failure to a committed revision", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const terminal = yield* manifest.begin(baseRevision)
        const failed = yield* manifest.recordFailure({
          revision: terminal.revision,
          code: "POLICY_REJECTED",
          retryable: false
        })
        const blockedAdvance = yield* manifest
          .advance({ revision: failed, from: "RECEIVED", to: "SOURCE_DURABLE" })
          .pipe(Effect.either)

        let committed = (
          yield* manifest.begin({
            ...baseRevision,
            logicalSessionId: "committed-session",
            sourceDigest: "d".repeat(64)
          })
        ).revision
        for (const [from, to] of [
          ["RECEIVED", "SOURCE_DURABLE"],
          ["SOURCE_DURABLE", "INDEXED"],
          ["INDEXED", "ENRICHED"],
          ["ENRICHED", "CONSOLIDATED"],
          ["CONSOLIDATED", "COMMITTED"]
        ] as const) {
          committed = yield* manifest.advance({ revision: committed, from, to })
        }
        const committedFailure = yield* manifest
          .recordFailure({ revision: committed, code: "TOO_LATE", retryable: true })
          .pipe(Effect.either)
        return { blockedAdvance, committedFailure }
      })
    )

    expect(outcome.blockedAdvance).toMatchObject({
      _tag: "Left",
      left: { _tag: "IngestRevisionBlocked", failureCode: "POLICY_REJECTED" }
    })
    expect(outcome.committedFailure).toMatchObject({
      _tag: "Left",
      left: { _tag: "InvalidSourceRevision" }
    })
  })

  it("applies a consolidated commit delta once and exposes versioned projection state", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        let revision = (
          yield* manifest.begin({ ...baseRevision, sourceDigest: "9".repeat(64) })
        ).revision
        for (const [from, to] of [
          ["RECEIVED", "SOURCE_DURABLE"],
          ["SOURCE_DURABLE", "INDEXED"],
          ["INDEXED", "ENRICHED"],
          ["ENRICHED", "CONSOLIDATED"]
        ] as const) {
          revision = yield* manifest.advance({ revision, from, to })
        }
        const delta = {
          revision,
          stats: projectionStats,
          tokenDf: new Map([
            ["token-a", 2],
            ["token-b", 1]
          ]),
          slotClaims: new Map([["slot-a", 2]])
        }
        const applied = yield* manifest.applyProjectionDelta(delta)
        const reapplied = yield* manifest.applyProjectionDelta(delta)
        const conflict = yield* manifest
          .applyProjectionDelta({ ...delta, stats: { ...projectionStats, claims: 3 } })
          .pipe(Effect.either)
        const committed = yield* manifest.advance({
          revision,
          from: "CONSOLIDATED",
          to: "COMMITTED"
        })
        const projection = yield* manifest.readProjection({ tenant: "default", uid: "user-a" })
        const counts = yield* manifest.readProjectionCounts({ tenant: "default", uid: "user-a" })
        return { applied, reapplied, conflict, committed, projection, counts }
      })
    )

    expect(outcome.applied).toMatchObject({ manifestVersion: 1, stats: projectionStats })
    expect(outcome.reapplied).toEqual(outcome.applied)
    expect(outcome.conflict).toMatchObject({
      _tag: "Left",
      left: { _tag: "ProjectionDeltaConflict" }
    })
    expect(outcome.committed).toMatchObject({ state: "COMMITTED", manifestVersion: 1 })
    expect(outcome.projection).toMatchObject({
      consistency: "consistent",
      manifestVersion: 1,
      stats: projectionStats
    })
    expect(outcome.counts.tokenDf).toEqual(new Map([["token-a", 2], ["token-b", 1]]))
    expect(outcome.counts.slotClaims).toEqual(new Map([["slot-a", 2]]))
  })

  it("rebuilds a deliberately corrupted scoped projection from its commit delta", async () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-projection-"))
    const path = join(directory, "manifest.sqlite")
    const previousPath = process.env["PALIMPSEST_INGEST_MANIFEST_PATH"]
    process.env["PALIMPSEST_INGEST_MANIFEST_PATH"] = path
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const manifest = yield* IngestManifest
            let revision = (
              yield* manifest.begin({ ...baseRevision, sourceDigest: "8".repeat(64) })
            ).revision
            for (const [from, to] of [
              ["RECEIVED", "SOURCE_DURABLE"],
              ["SOURCE_DURABLE", "INDEXED"],
              ["INDEXED", "ENRICHED"],
              ["ENRICHED", "CONSOLIDATED"]
            ] as const) {
              revision = yield* manifest.advance({ revision, from, to })
            }
            yield* manifest.applyProjectionDelta({
              revision,
              stats: projectionStats,
              tokenDf: new Map([
                ["token-a", 2],
                ["token-b", 1]
              ]),
              slotClaims: new Map([["slot-a", 2]])
            })
            yield* manifest.advance({ revision, from: "CONSOLIDATED", to: "COMMITTED" })
          }).pipe(Effect.provide(IngestManifestLive))
        )
      )

      const corrupt = new DatabaseSync(path)
      corrupt.exec(`
        UPDATE user_projections
           SET stats_json = '{"claims":0,"contestedSlots":0,"entities":0,"sessions":0,"slots":0,"supersessions":0,"tokens":0,"turns":0}',
               consistency = 'stale';
        UPDATE projection_token_counts SET value = 0;
        DELETE FROM projection_slot_counts;
      `)
      corrupt.close()

      const repaired = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const manifest = yield* IngestManifest
            const reconciliation = yield* manifest.reconcileProjection({ tenant: "default", uid: "user-a" })
            const counts = yield* manifest.readProjectionCounts({ tenant: "default", uid: "user-a" })
            return { reconciliation, counts }
          }).pipe(Effect.provide(IngestManifestLive))
        )
      )

      expect(repaired.reconciliation).toMatchObject({
        outcome: "repaired",
        state: { consistency: "consistent", manifestVersion: 1, stats: projectionStats }
      })
      expect(repaired.counts.tokenDf).toEqual(new Map([["token-a", 2], ["token-b", 1]]))
      expect(repaired.counts.slotClaims).toEqual(new Map([["slot-a", 2]]))
    } finally {
      if (previousPath === undefined) delete process.env["PALIMPSEST_INGEST_MANIFEST_PATH"]
      else process.env["PALIMPSEST_INGEST_MANIFEST_PATH"] = previousPath
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
