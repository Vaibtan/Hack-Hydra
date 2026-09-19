import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Data, Effect } from "effect"
import type { ExtractionArtifact, PersistedSessionExtraction } from "./ExtractionArtifact.js"
import { claimIndexGraphWritePlan, claimSourceTranscriptPlan } from "./GraphIdClaims.js"
import { IndexGraph, IndexGraphWriteRejected, planIndexGraphWrite } from "./IndexGraph.js"
import type { IndexGeneration } from "./IndexGeneration.js"
import {
  IngestManifest,
  type BeginSourceRevision,
  type IngestManifestError
} from "./IngestManifest.js"
import { SourceTranscript, SourceTranscriptRevisionMismatch, planSourceTranscriptWrite } from "./SourceTranscript.js"
import {
  IngestRetryBlocked,
  IngestStageFailed,
  runTransactionalIngestToStage,
  type IngestExecutionStage,
  type IngestFailure,
  type TransactionalIngestStageResult,
  type TransactionalIngestStages
} from "./TransactionalIngest.js"
import type { IngestCommitLock, IngestCommitLockUnavailable } from "./IngestCommitLock.js"
import { createExtractionArtifact } from "./ExtractionArtifact.js"

export class SourceIndexGenerationMismatch extends Data.TaggedError("SourceIndexGenerationMismatch")<{
  readonly sourceExtractionGeneration: string
  readonly indexExtractionGeneration: string
}> {
  override get message(): string {
    return "Source revision and index generation name different extraction generations"
  }
}

export class SourceIndexTargetExceeded extends Data.TaggedError("SourceIndexTargetExceeded")<{
  readonly stage: "ENRICHED" | "CONSOLIDATED" | "COMMITTED"
}> {
  override get message(): string {
    return `Source/index operation cannot execute ${this.stage}`
  }
}

/** Every failure a stage can hand to `classifyFailure`. */
export type SourceIndexStageError<Error> =
  | Error
  | HydraError
  | IngestManifestError
  | SourceTranscriptRevisionMismatch
  | IndexGraphWriteRejected
  | SourceIndexTargetExceeded

export interface RunTransactionalSourceIndex<Error, Requirements> {
  readonly sourceRevision: BeginSourceRevision
  readonly indexGeneration: IndexGeneration
  readonly session: DatasetSession
  readonly extract: (
    session: DatasetSession
  ) => Effect.Effect<PersistedSessionExtraction, Error, Requirements>
  readonly classifyFailure: (input: {
    readonly stage: IngestExecutionStage
    readonly error: SourceIndexStageError<Error>
  }) => IngestFailure
}

const targetExceeded = (
  stage: "ENRICHED" | "CONSOLIDATED" | "COMMITTED"
): Effect.Effect<never, SourceIndexTargetExceeded> =>
  Effect.fail(new SourceIndexTargetExceeded({ stage }))

/** Drives a source revision through SOURCE_DURABLE and INDEXED only; later stages are refused. */
export const runTransactionalSourceIndex = <Error, Requirements>(
  input: RunTransactionalSourceIndex<Error, Requirements>
): Effect.Effect<
  TransactionalIngestStageResult,
  | SourceIndexGenerationMismatch
  | IngestManifestError
  | IngestStageFailed
  | IngestRetryBlocked
  | IngestCommitLockUnavailable,
  Requirements | SourceTranscript | IndexGraph | IngestManifest | IngestCommitLock | HydraClient
> =>
  Effect.gen(function* () {
    if (input.sourceRevision.extractionGeneration.id !== input.indexGeneration.extractionGenerationId) {
      return yield* Effect.fail(
        new SourceIndexGenerationMismatch({
          sourceExtractionGeneration: input.sourceRevision.extractionGeneration.id,
          indexExtractionGeneration: input.indexGeneration.extractionGenerationId
        })
      )
    }
    const manifest = yield* IngestManifest
    yield* manifest.begin(input.sourceRevision)
    yield* manifest.storeIndexGeneration({ generation: input.indexGeneration })
    const sourceTranscript = yield* SourceTranscript
    const indexGraph = yield* IndexGraph
    const hydra = yield* HydraClient
    const stages: TransactionalIngestStages<SourceIndexStageError<Error>, Requirements | SourceTranscript | IndexGraph | IngestManifest> = {
      SOURCE_DURABLE: (revision) =>
        Effect.gen(function* () {
          // Durable id claims precede the upsert (S01): a retry re-claims
          // idempotently, a collision fails before ambiguous data is written.
          const transcriptPlan = planSourceTranscriptWrite(revision, input.session)
          if (transcriptPlan._tag === "Failure") return yield* Effect.fail(transcriptPlan.failure)
          yield* claimSourceTranscriptPlan(manifest, hydra, transcriptPlan.success)
          return yield* sourceTranscript.write(revision, input.session)
        }),
      INDEXED: (revision) =>
        Effect.gen(function* () {
          const existing = yield* manifest.readExtractionArtifact(revision)
          const artifact: ExtractionArtifact =
            existing ??
            (yield* input.extract(input.session).pipe(
              Effect.flatMap((extraction) =>
                manifest.storeExtractionArtifact({
                  revision,
                  artifact: createExtractionArtifact({
                    commitId: revision.commitId,
                    sourceDigest: revision.sourceDigest,
                    extractionGeneration: revision.extractionGeneration,
                    extraction: {
                      sid: input.session.sid,
                      sessionOrd: revision.sessionOrdinal,
                      claims: extraction.claims,
                      dropped: extraction.dropped
                    }
                  })
                })
              )
            ))
          const indexPlan = planIndexGraphWrite({
            generation: input.indexGeneration,
            revision,
            session: input.session,
            claims: artifact.extraction.claims
          })
          if (indexPlan._tag === "Failure") return yield* Effect.fail(indexPlan.failure)
          yield* claimIndexGraphWritePlan(manifest, hydra, indexPlan.success)
          return yield* indexGraph.write({
            generation: input.indexGeneration,
            revision,
            session: input.session,
            claims: artifact.extraction.claims
          })
        }),
      ENRICHED: () => targetExceeded("ENRICHED"),
      CONSOLIDATED: () => targetExceeded("CONSOLIDATED"),
      COMMITTED: () => targetExceeded("COMMITTED")
    }
    return yield* runTransactionalIngestToStage({
      sourceRevision: input.sourceRevision,
      target: "INDEXED",
      stages,
      classifyFailure: input.classifyFailure
    })
  })
