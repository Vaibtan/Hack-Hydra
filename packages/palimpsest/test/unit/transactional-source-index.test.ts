import type { DatasetSession } from "@palimpsest/dataset"
import { HydraMemory, vertexId } from "@palimpsest/hydra"
import { createIndexGeneration } from "../../src/IndexGeneration.js"
import { IngestCommitLockMemory } from "../../src/IngestCommitLock.js"
import { IngestManifest, makeIngestManifestTestLayer } from "../../src/IngestManifest.js"
import { IndexGraph } from "../../src/IndexGraph.js"
import { parseMemoryScope } from "../../src/MemoryScope.js"
import { canonicalSessionSource, createExtractionGeneration } from "../../src/SourceIdentity.js"
import { SourceTranscript } from "../../src/SourceTranscript.js"
import { sourceSessionKey } from "../../src/SourceTranscript.js"
import { runTransactionalSourceIndex } from "../../src/TransactionalSourceIndex.js"
import { Effect, Result, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { behaviorFake, runWithBehaviorFakes } from "../BehaviorFake.js"

const session: DatasetSession = {
  sid: "session-a",
  key: "session-a",
  sessionOrd: 1,
  date: { raw: "2026-08-20", dateInt: 20260820, ts: 1_755_657_600_000 },
  turns: [{ turnIdx: 0, role: "user", text: "hello", hasAnswer: false }]
}

const sourceGeneration = createExtractionGeneration({
  extractor: { id: "extractor", revision: "git:source" },
  model: { id: "model", revision: "snapshot:source" },
  tokenizer: { id: "tokenizer", revision: "v1" },
  promptTemplate: "source prompt",
  outputSchema: { type: "object", version: 1 }
})

const otherGeneration = createExtractionGeneration({
  extractor: { id: "extractor", revision: "git:other" },
  model: { id: "model", revision: "snapshot:other" },
  tokenizer: { id: "tokenizer", revision: "v1" },
  promptTemplate: "other prompt",
  outputSchema: { type: "object", version: 1 }
})

describe("runTransactionalSourceIndex", () => {
  it("rejects incompatible source and index generations before any data-plane dependency is used", async () => {
    const source = canonicalSessionSource(session)
    const program = runTransactionalSourceIndex({
        sourceRevision: {
          tenant: "default",
          uid: "user-a",
          logicalSessionId: session.key,
          sourceDigest: source.sourceDigest,
          sourceBytes: source.sourceBytes,
          extractionGeneration: {
            id: sourceGeneration.id,
            canonicalJson: sourceGeneration.canonicalJson
          }
        },
        indexGeneration: createIndexGeneration({
          extractionGeneration: otherGeneration,
          graphWriter: { id: "index-writer", revision: "git:abc123" },
          graphSchema: { id: "index-schema", revision: "v1" }
        }),
        session,
        extract: () => Effect.die("must not extract"),
        classifyFailure: () => ({ code: "UNREACHABLE", retryable: false })
      }).pipe(Effect.result)
    const outcome = await runWithBehaviorFakes(program)

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SourceIndexGenerationMismatch" }
    })
  })

  it("adopts a pre-S01 graph identity and quarantines its collision before upsert", async () => {
    const source = canonicalSessionSource(session)
    const scope = Result.getOrThrow(parseMemoryScope("default", "user-a"))
    const sessionKey = sourceSessionKey(scope, session.key, source.sourceDigest)
    const collidingIdentity = "forced-collision"
    const collisionReducer = (key: string): number =>
      key === collidingIdentity ? vertexId(sessionKey) : vertexId(key)
    const existingGraphIdentityLookup = Layer.succeed(HydraMemory, behaviorFake<HydraMemory>({
      readGraphIdentities: (_kind: "relationship" | "vertex", reducedId: number) =>
        Effect.succeed(reducedId === vertexId(sessionKey) ? [collidingIdentity] : [])
    }))
    let writes = 0

    const transcriptStub = Layer.succeed(SourceTranscript, behaviorFake<SourceTranscript>({
      write: () => {
        writes += 1
        return Effect.succeed({
          sourceDigest: source.sourceDigest,
          sessions: 1 as const,
          turns: 1,
          bookmark: Option.none<string>()
        })
      }
    }))
    const indexStub = Layer.succeed(IndexGraph, behaviorFake<IndexGraph>({
      write: () =>
        Effect.succeed({
          generationId: "index-unused",
          sourceDigest: source.sourceDigest,
          entities: 0,
          claims: 0,
          slots: 0,
          tokens: 0
        })
    }))

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const result = yield* runTransactionalSourceIndex({
            sourceRevision: {
              tenant: "default",
              uid: "user-a",
              logicalSessionId: session.key,
              sourceDigest: source.sourceDigest,
              sourceBytes: source.sourceBytes,
              extractionGeneration: {
                id: sourceGeneration.id,
                canonicalJson: sourceGeneration.canonicalJson
              }
            },
            indexGeneration: createIndexGeneration({
              extractionGeneration: sourceGeneration,
              graphWriter: { id: "index-writer", revision: "git:abc123" },
              graphSchema: { id: "index-schema", revision: "v1" }
            }),
            session,
            extract: () =>
              Effect.succeed({
                sid: session.sid,
                sessionOrd: session.sessionOrd,
                claims: [],
                dropped: []
              }),
            classifyFailure: ({ error }) => ({ code: error._tag, retryable: false })
          }).pipe(Effect.result)
          const quarantine = yield* manifest.listGraphIdQuarantine()
          return { result, quarantine }
        }).pipe(
          Effect.provide(makeIngestManifestTestLayer(collisionReducer)),
          Effect.provide(IngestCommitLockMemory),
          Effect.provide(existingGraphIdentityLookup),
          Effect.provide(transcriptStub),
          Effect.provide(indexStub)
        )
      )
    )

    expect(outcome.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IngestStageFailed", code: "GraphIdCollision" }
    })
    expect(outcome.quarantine).toMatchObject([
      { existingIdentity: collidingIdentity, rejectedIdentity: sessionKey }
    ])
    expect(writes).toBe(0)
  })
})
