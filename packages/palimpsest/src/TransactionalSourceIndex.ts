import type { DatasetSession } from "@palimpsest/dataset"
import type { HydraError } from "@palimpsest/hydra"
import { Data, Effect } from "effect"
import type { ExtractionArtifact, PersistedSessionExtraction } from "./ExtractionArtifact.js"
import { IndexGraph, IndexGraphWriteRejected } from "./IndexGraph.js"
import type { IndexGeneration } from "./IndexGeneration.js"
import {
  IngestManifest,
  type BeginSourceRevision,
  type IngestManifestError
} from "./IngestManifest.js"
import { SourceTranscript, SourceTranscriptRevisionMismatch } from "./SourceTranscript.js"
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

/** The index generation must derive from the same explicit extraction generation as its source revision. */
export class SourceIndexGenerationMismatch extends Data.TaggedError("SourceIndexGenerationMismatch")<{
  readonly sourceExtractionGeneration: string
  readonly indexExtractionGeneration: string
}> {
  override get message(): string {
    return "Source revision and index generation name different extraction generations"
  }
}

/** A bounded source/index operation must never accidentally advance a later stage. */
export class SourceIndexTargetExceeded extends Data.TaggedError("SourceIndexTargetExceeded")<{
  readonly stage: "ENRICHED" | "CONSOLIDATED" | "COMMITTED"
}> {
  override get message(): string {
    return `Source/index operation cannot execute ${this.stage}`
  }
}

/** Typed failure universe passed to the caller's safe retry classifier. */
export type SourceIndexStageError<Error> =
  | Error
  | HydraError
  | IngestManifestError
  | SourceTranscriptRevisionMismatch
  | IndexGraphWriteRejected
  | SourceIndexTargetExceeded

/** Explicit request for source durability plus isolated derived indexing. */
export interface RunTransactionalSourceIndex<Error, Requirements> {
  /** Caller-supplied source identity and complete extraction-generation descriptor. */
  readonly sourceRevision: BeginSourceRevision
  /** Caller-supplied graph writer/schema generation; activation is deliberately separate. */
  readonly indexGeneration: IndexGeneration
  /** Verbatim source bytes whose digest must match `sourceRevision`. */
  readonly session: DatasetSession
  /** Provider call used only when the manifest has no verified extraction artifact yet. */
  readonly extract: (
    session: DatasetSession
  ) => Effect.Effect<PersistedSessionExtraction, Error, Requirements>
  /** Maps only known typed failures to a durable retry disposition. */
  readonly classifyFailure: (input: {
    readonly stage: IngestExecutionStage
    readonly error: SourceIndexStageError<Error>
  }) => IngestFailure
}

const targetExceeded = (
  stage: "ENRICHED" | "CONSOLIDATED" | "COMMITTED"
): Effect.Effect<never, SourceIndexTargetExceeded> =>
  Effect.fail(new SourceIndexTargetExceeded({ stage }))

/**
 * Makes the source and isolated index durable through `INDEXED`, and no
 * further. A separate workflow must validate projections and canonical views
 * before consolidation, commit, and active-generation selection.
 */
export const runTransactionalSourceIndex = <Error, Requirements>(
  input: RunTransactionalSourceIndex<Error, Requirements>
): Effect.Effect<
  TransactionalIngestStageResult,
  | SourceIndexGenerationMismatch
  | IngestManifestError
  | IngestStageFailed
  | IngestRetryBlocked
  | IngestCommitLockUnavailable,
  Requirements | SourceTranscript | IndexGraph | IngestManifest | IngestCommitLock
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
    // Persist the descriptor only after `begin` has authenticated its referenced
    // extraction generation. `storeIndexGeneration` itself is idempotent.
    yield* manifest.begin(input.sourceRevision)
    yield* manifest.storeIndexGeneration({ generation: input.indexGeneration })
    const sourceTranscript = yield* SourceTranscript
    const indexGraph = yield* IndexGraph
    const stages: TransactionalIngestStages<SourceIndexStageError<Error>, Requirements | SourceTranscript | IndexGraph | IngestManifest> = {
      SOURCE_DURABLE: (revision) => sourceTranscript.write(revision, input.session),
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
