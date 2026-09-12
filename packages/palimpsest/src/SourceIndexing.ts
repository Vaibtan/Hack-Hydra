import type { DatasetSession } from "@palimpsest/dataset"
import { Effect, Either, Layer } from "effect"
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

/** Validates tenant/uid into a `MemoryScope` at the new-plane entry boundary (S01). */
export const planSourceIndexSession = (
  input: PlanSourceIndexSession
): Either.Either<SourceIndexSessionPlan, InvalidMemoryScope> => {
  const scope = parseMemoryScope(input.tenant, input.uid)
  if (scope._tag === "Left") return Either.left(scope.left)
  return Either.right({
    sourceRevision: sourceRevisionInputForSession(scope.right, input.session, input.generation.extractionGeneration),
    indexGeneration: input.generation.indexGeneration
  })
}

const classifyFailure = (input: {
  readonly error: SourceIndexStageError<never>
}): { readonly code: string; readonly retryable: boolean } => {
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
    if (plan._tag === "Left") return yield* Effect.fail(plan.left)
    return yield* runTransactionalSourceIndex({
      sourceRevision: plan.right.sourceRevision,
      indexGeneration: plan.right.indexGeneration,
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

export class SourceIndex extends Effect.Service<SourceIndex>()("palimpsest/SourceIndex", { effect: make }) {}

export const SourceIndexLive = SourceIndex.Default.pipe(
  Layer.provide(
    Layer.mergeAll(
      SourceTranscript.Default,
      IndexGraph.Default,
      IngestManifestLive,
      IngestCommitLockLive
    )
  )
)
