import { Config, Data, Effect, Either } from "effect"
import {
  createRuntimeExtractionGeneration,
  type ExtractionRuntimeDependencies
} from "./Extract.js"
import { createIndexGeneration, type IndexGeneration } from "./IndexGeneration.js"
import type { ExtractionGeneration, VersionedDependency } from "./SourceIdentity.js"

/** Stable names for the local implementations whose revisions are configured at deployment. */
export const LOCAL_GENERATION_COMPONENTS = {
  extractor: "palimpsest.extract-session",
  graphSchema: "palimpsest.generation-index-schema",
  graphWriter: "palimpsest.index-graph",
  tokenizer: "palimpsest.claim-tokens"
} as const

/** Raw deployment inputs needed to bind an ingest to immutable implementation revisions. */
export interface IngestGenerationConfigInput {
  readonly modelId: string
  readonly modelRevision: string
  readonly extractorRevision: string
  readonly tokenizerRevision: string
  readonly graphWriterRevision: string
  readonly graphSchemaRevision: string
}

/** Parsed immutable definitions shared by every transactional source/index caller. */
export interface IngestGenerationConfig {
  readonly extractionGeneration: ExtractionGeneration
  readonly indexGeneration: IndexGeneration
}

/** A generation configuration input did not name a concrete immutable value. */
export class InvalidIngestGenerationConfig extends Data.TaggedError("InvalidIngestGenerationConfig")<{
  readonly field: keyof IngestGenerationConfigInput
}> {
  override get message(): string {
    return `Ingest generation configuration requires ${this.field}`
  }
}

const dependency = (
  id: string,
  revision: string,
  field: Exclude<keyof IngestGenerationConfigInput, "modelId">
): Either.Either<VersionedDependency, InvalidIngestGenerationConfig> => {
  if (revision.trim().length === 0) {
    return Either.left(new InvalidIngestGenerationConfig({ field }))
  }
  return Either.right({ id, revision })
}

/** Parses configured revisions into exact extraction and index generation descriptors. */
export const makeIngestGenerationConfig = (
  input: IngestGenerationConfigInput
): Either.Either<IngestGenerationConfig, InvalidIngestGenerationConfig> => {
  if (input.modelId.trim().length === 0) {
    return Either.left(new InvalidIngestGenerationConfig({ field: "modelId" }))
  }
  const model = dependency(input.modelId, input.modelRevision, "modelRevision")
  if (model._tag === "Left") return Either.left(model.left)
  const extractor = dependency(
    LOCAL_GENERATION_COMPONENTS.extractor,
    input.extractorRevision,
    "extractorRevision"
  )
  if (extractor._tag === "Left") return Either.left(extractor.left)
  const tokenizer = dependency(
    LOCAL_GENERATION_COMPONENTS.tokenizer,
    input.tokenizerRevision,
    "tokenizerRevision"
  )
  if (tokenizer._tag === "Left") return Either.left(tokenizer.left)
  const graphWriter = dependency(
    LOCAL_GENERATION_COMPONENTS.graphWriter,
    input.graphWriterRevision,
    "graphWriterRevision"
  )
  if (graphWriter._tag === "Left") return Either.left(graphWriter.left)
  const graphSchema = dependency(
    LOCAL_GENERATION_COMPONENTS.graphSchema,
    input.graphSchemaRevision,
    "graphSchemaRevision"
  )
  if (graphSchema._tag === "Left") return Either.left(graphSchema.left)

  const extractionDependencies: ExtractionRuntimeDependencies = {
    extractor: extractor.right,
    model: model.right,
    tokenizer: tokenizer.right
  }
  const extractionGeneration = createRuntimeExtractionGeneration(extractionDependencies)
  return Either.right({
    extractionGeneration,
    indexGeneration: createIndexGeneration({
      extractionGeneration,
      graphWriter: graphWriter.right,
      graphSchema: graphSchema.right
    })
  })
}

/**
 * Reads the deployment configuration at a composition root. No value defaults:
 * a transactional caller cannot silently use an unpinned model or local build.
 */
export const ingestGenerationConfig = Effect.gen(function* () {
  const parsed = makeIngestGenerationConfig({
    modelId: yield* Config.string("PALIMPSEST_MODEL"),
    modelRevision: yield* Config.string("PALIMPSEST_EXTRACTION_MODEL_REVISION"),
    extractorRevision: yield* Config.string("PALIMPSEST_EXTRACTION_EXTRACTOR_REVISION"),
    tokenizerRevision: yield* Config.string("PALIMPSEST_EXTRACTION_TOKENIZER_REVISION"),
    graphWriterRevision: yield* Config.string("PALIMPSEST_INDEX_WRITER_REVISION"),
    graphSchemaRevision: yield* Config.string("PALIMPSEST_INDEX_SCHEMA_REVISION")
  })
  if (parsed._tag === "Left") return yield* Effect.fail(parsed.left)
  return parsed.right
})
