import type { DatasetSession } from "@palimpsest/dataset"
import { Context, Effect, Layer, Result } from "effect"
import { extractSession } from "./Extract.js"
import type { IngestGenerationConfig } from "./GenerationConfig.js"
import { IndexGraph } from "./IndexGraph.js"
import { IngestCommitLock, IngestCommitLockLive } from "./IngestCommitLock.js"
import { IngestManifest, IngestManifestLive } from "./IngestManifest.js"
import { InvalidMemoryScope, parseMemoryScope } from "./MemoryScope.js"
import { sourceRevisionInputForSession } from "./SourceIdentity.js"
import { SourceTranscript } from "./SourceTranscript.js"
import {
  runTransactionalSourceIndex,
  type SourceIndexStageError
} from "./TransactionalSourceIndex.js"

export interface SourceIndexSessionPlan {
  readonly sourceRevision: ReturnType<typeof sourceRevisionInputForSession>
  readonly indexGeneration: IngestGenerationConfig["indexGeneration"]
}

export interface PlanSourceIndexSession {
  readonly tenant: string
  readonly uid: string
  readonly session: DatasetSession
  readonly generation: IngestGenerationConfig
}

interface SourceIndexFailureClassification {
  readonly code: string
  readonly retryable: boolean
}

/** Validates tenant/uid into a `MemoryScope` at the new-plane entry boundary (S01). */
export const planSourceIndexSession = (
  input: PlanSourceIndexSession
): Result.Result<SourceIndexSessionPlan, InvalidMemoryScope> => {
  const scope = parseMemoryScope(input.tenant, input.uid)
  if (scope._tag === "Failure") return Result.fail(scope.failure)
  return Result.succeed({
    sourceRevision: sourceRevisionInputForSession(scope.success, input.session, input.generation.extractionGeneration),
    indexGeneration: input.generation.indexGeneration
  })
}

const classifyFailure = (input: {
  readonly error: SourceIndexStageError<never>
}): SourceIndexFailureClassification => {
  switch (input.error._tag) {
    case "HydraEngineError":
      return { code: `HYDRA_${input.error.code}`, retryable: input.error.retryable }
    case "HydraUnavailable":
    case "IngestManifestUnavailable":
      return { code: input.error._tag, retryable: true }
    case "GraphIdCollision":
      return { code: "GRAPH_ID_COLLISION", retryable: false }
    case "InvalidGraphIdClaim":
      return { code: "INVALID_GRAPH_ID_CLAIM", retryable: false }
    case "HydraParseError":
    case "HydraLimitError":
    case "IndexGraphWriteRejected":
    case "SourceIndexTargetExceeded":
    case "SourceTranscriptRevisionMismatch":
      return { code: input.error._tag, retryable: false }
    default:
      return { code: `SOURCE_INDEX_${input.error._tag}`, retryable: false }
  }
}

export const indexSourceSession = (input: PlanSourceIndexSession) =>
  Effect.gen(function* () {
    const plan = planSourceIndexSession(input)
    if (plan._tag === "Failure") return yield* Effect.fail(plan.failure)
    return yield* runTransactionalSourceIndex({
      sourceRevision: plan.success.sourceRevision,
      indexGeneration: plan.success.indexGeneration,
      session: input.session,
      extract: extractSession,
      classifyFailure: ({ error }) => classifyFailure({ error })
    })
  })

const make = Effect.gen(function* () {
  const sourceTranscript = yield* SourceTranscript
  const indexGraph = yield* IndexGraph
  const manifest = yield* IngestManifest
  const commitLock = yield* IngestCommitLock

  const indexSession = (input: PlanSourceIndexSession) =>
    indexSourceSession(input).pipe(
      Effect.provideService(SourceTranscript, sourceTranscript),
      Effect.provideService(IndexGraph, indexGraph),
      Effect.provideService(IngestManifest, manifest),
      Effect.provideService(IngestCommitLock, commitLock)
    )

  return { indexSession } as const
})

export type SourceIndex = Effect.Success<typeof make>
const SourceIndexTag = Context.Service<SourceIndex>("palimpsest/SourceIndex")
export const SourceIndex = Object.assign(SourceIndexTag, { layer: Layer.effect(SourceIndexTag, make) })

export const SourceIndexLive = SourceIndex.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      SourceTranscript.layer,
      IndexGraph.layer,
      IngestManifestLive,
      IngestCommitLockLive
    )
  )
)
