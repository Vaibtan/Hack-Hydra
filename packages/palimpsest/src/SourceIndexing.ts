import type { DatasetSession } from "@palimpsest/dataset"
import { Effect, Layer } from "effect"
import { extractSession } from "./Extract.js"
import type { IngestGenerationConfig } from "./GenerationConfig.js"
import { IndexGraph } from "./IndexGraph.js"
import { IngestCommitLock, IngestCommitLockLive } from "./IngestCommitLock.js"
import { IngestManifest, IngestManifestLive } from "./IngestManifest.js"
import { sourceRevisionInputForSession } from "./SourceIdentity.js"
import { SourceTranscript } from "./SourceTranscript.js"
import {
  runTransactionalSourceIndex,
  type SourceIndexStageError
} from "./TransactionalSourceIndex.js"

/** Immutable request planned for the shared bounded source/index operation. */
export interface SourceIndexSessionPlan {
  readonly sourceRevision: ReturnType<typeof sourceRevisionInputForSession>
  readonly indexGeneration: IngestGenerationConfig["indexGeneration"]
}

/** Input accepted by batch and HTTP adapters before they perform source indexing. */
export interface PlanSourceIndexSession {
  readonly tenant: string
  readonly uid: string
  readonly session: DatasetSession
  readonly generation: IngestGenerationConfig
}

/**
 * Binds one caller's source bytes to the configured immutable generations.
 * This deliberately contains no graph or provider effect, keeping both
 * adapters on the same source/index operation instead of copying its setup.
 */
export const planSourceIndexSession = (input: PlanSourceIndexSession): SourceIndexSessionPlan => ({
  sourceRevision: sourceRevisionInputForSession(
    input.tenant,
    input.uid,
    input.session,
    input.generation.extractionGeneration
  ),
  indexGeneration: input.generation.indexGeneration
})

const classifyFailure = (input: {
  readonly error: SourceIndexStageError<never>
}): { readonly code: string; readonly retryable: boolean } => {
  switch (input.error._tag) {
    case "HydraEngineError":
      return { code: `HYDRA_${input.error.code}`, retryable: input.error.retryable }
    case "HydraUnavailable":
    case "IngestManifestUnavailable":
      return { code: input.error._tag, retryable: true }
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

/**
 * Durably writes one source revision and its isolated index generation through
 * `INDEXED`. It is not a retrieval activation or terminal ingest success.
 */
export const indexSourceSession = (input: PlanSourceIndexSession) => {
  const plan = planSourceIndexSession(input)
  return runTransactionalSourceIndex({
    sourceRevision: plan.sourceRevision,
    indexGeneration: plan.indexGeneration,
    session: input.session,
    extract: extractSession,
    classifyFailure: ({ error }) => classifyFailure({ error })
  })
}

/**
 * Reusable production assembly for the bounded source/index application
 * operation. Entry points still provide the shared HydraDB and LLM adapters.
 */
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

/**
 * Cohesive bounded source/index application service reused by batch and HTTP
 * adapters. Its remaining LLM requirement deliberately reaches composition.
 */
export class SourceIndex extends Effect.Service<SourceIndex>()("palimpsest/SourceIndex", { effect: make }) {}

/** Production assembly that consumes the caller's shared HydraDB client. */
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
