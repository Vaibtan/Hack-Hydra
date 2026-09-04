import { Data, Effect } from "effect"
import {
  INGEST_STATES,
  IngestManifest,
  type BeginSourceRevision,
  type IngestManifestError,
  type IngestState,
  type SourceRevision
} from "./IngestManifest.js"
import { IngestCommitLock, type IngestCommitLockUnavailable } from "./IngestCommitLock.js"

export const INGEST_EXECUTION_STAGES = [
  "SOURCE_DURABLE",
  "INDEXED",
  "ENRICHED",
  "CONSOLIDATED",
  "COMMITTED"
] as const

export type IngestExecutionStage = (typeof INGEST_EXECUTION_STAGES)[number]

type StageTransition = Readonly<{
  from: IngestState
  to: IngestExecutionStage
}>

const STAGE_TRANSITIONS: ReadonlyArray<StageTransition> = [
  { from: "RECEIVED", to: "SOURCE_DURABLE" },
  { from: "SOURCE_DURABLE", to: "INDEXED" },
  { from: "INDEXED", to: "ENRICHED" },
  { from: "ENRICHED", to: "CONSOLIDATED" },
  { from: "CONSOLIDATED", to: "COMMITTED" }
]

export interface IngestFailure {
  readonly code: string
  readonly retryable: boolean
}

export type TransactionalIngestStage<Error, Requirements> = (
  revision: SourceRevision
) => Effect.Effect<void, Error, Requirements>

export type TransactionalIngestStages<Error, Requirements> = Readonly<{
  [Stage in IngestExecutionStage]: TransactionalIngestStage<Error, Requirements>
}>

export interface RunTransactionalIngest<Error, Requirements> {
  readonly sourceRevision: BeginSourceRevision
  readonly stages: TransactionalIngestStages<Error, Requirements>
  readonly classifyFailure: (input: {
    readonly stage: IngestExecutionStage
    readonly error: Error
  }) => IngestFailure
}

/** A caller stage failed and the manifest now records its safe retry disposition. */
export class IngestStageFailed extends Data.TaggedError("IngestStageFailed")<{
  readonly commitId: string
  readonly stage: IngestExecutionStage
  readonly code: string
  readonly retryable: boolean
}> {
  override get message(): string {
    return `Source revision ${this.commitId} failed during ${this.stage}: ${this.code}`
  }
}

/** A previously recorded non-retryable failure prevents an accidental replay. */
export class IngestRetryBlocked extends Data.TaggedError("IngestRetryBlocked")<{
  readonly commitId: string
  readonly state: IngestState
  readonly code: string
}> {
  override get message(): string {
    return `Source revision ${this.commitId} cannot retry ${this.state}: ${this.code}`
  }
}

export interface TransactionalIngestResult {
  readonly revision: SourceRevision
  /** True when this request found a prior, already committed source revision. */
  readonly alreadyCommitted: boolean
}

export interface RunTransactionalIngestToStage<Error, Requirements>
  extends RunTransactionalIngest<Error, Requirements> {
  /** No later stage callback may run during this request. */
  readonly target: IngestExecutionStage
}

export interface TransactionalIngestStageResult {
  readonly revision: SourceRevision
  /** True when the revision was already at or beyond the requested durable stage. */
  readonly alreadyAtTarget: boolean
}

const statePosition = (state: IngestState): number => INGEST_STATES.indexOf(state)

export const runTransactionalIngestToStage = <Error, Requirements>(
  input: RunTransactionalIngestToStage<Error, Requirements>
): Effect.Effect<
  TransactionalIngestStageResult,
  IngestManifestError | IngestStageFailed | IngestRetryBlocked | IngestCommitLockUnavailable,
  Requirements | IngestManifest | IngestCommitLock
> =>
  Effect.gen(function* () {
    const commitLock = yield* IngestCommitLock
    const manifest = yield* IngestManifest
    return yield* commitLock.withUserLock(
      { tenant: input.sourceRevision.tenant, uid: input.sourceRevision.uid },
      Effect.gen(function* () {
        const begun = yield* manifest.begin(input.sourceRevision)
        let revision = begun.revision

        if (statePosition(revision.state) >= statePosition(input.target)) {
          return { revision, alreadyAtTarget: true }
        }
        if (revision.failureRetryable === false && revision.failureCode !== null) {
          return yield* Effect.fail(
            new IngestRetryBlocked({
              commitId: revision.commitId,
              state: revision.state,
              code: revision.failureCode
            })
          )
        }

        for (const transition of STAGE_TRANSITIONS) {
          if (statePosition(transition.to) > statePosition(input.target)) break
          if (revision.state !== transition.from) continue
          const stage = transition.to
          revision = yield* input.stages[stage](revision).pipe(
            Effect.matchEffect({
              onFailure: (error) => {
                const failure = input.classifyFailure({ stage, error })
                return manifest.recordFailure({
                  revision,
                  code: failure.code,
                  retryable: failure.retryable
                }).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      new IngestStageFailed({
                        commitId: revision.commitId,
                        stage,
                        code: failure.code,
                        retryable: failure.retryable
                      })
                    )
                  )
                )
              },
              onSuccess: () => manifest.advance({ revision, from: transition.from, to: transition.to })
            })
          )
        }

        return { revision, alreadyAtTarget: false }
      })
    )
  })

export const runTransactionalIngest = <Error, Requirements>(
  input: RunTransactionalIngest<Error, Requirements>
): Effect.Effect<
  TransactionalIngestResult,
  IngestManifestError | IngestStageFailed | IngestRetryBlocked | IngestCommitLockUnavailable,
  Requirements | IngestManifest | IngestCommitLock
> =>
  runTransactionalIngestToStage({ ...input, target: "COMMITTED" }).pipe(
    Effect.map(({ revision, alreadyAtTarget }) => ({
      revision,
      alreadyCommitted: alreadyAtTarget
    }))
  )
