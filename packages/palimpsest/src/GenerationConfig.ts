import { Config, Data, Effect, Result } from "effect"
import {
  createRuntimeExtractionGeneration,
  type ExtractionRuntimeDependencies
} from "./Extract.js"
import { createIndexGeneration, type IndexGeneration } from "./IndexGeneration.js"
import type { ExtractionGeneration, VersionedDependency } from "./SourceIdentity.js"

export const LOCAL_GENERATION_COMPONENTS = {
  extractor: "palimpsest.extract-session",
  graphSchema: "palimpsest.generation-index-schema",
  graphWriter: "palimpsest.index-graph",
  tokenizer: "palimpsest.claim-tokens"
} as const

export interface IngestGenerationConfigInput {
  readonly modelId: string
  readonly modelRevision: string
  readonly extractorRevision: string
  readonly tokenizerRevision: string
  readonly graphWriterRevision: string
  readonly graphSchemaRevision: string
}

export interface IngestGenerationConfig {
  readonly extractionGeneration: ExtractionGeneration
  readonly indexGeneration: IndexGeneration
}

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
): Result.Result<VersionedDependency, InvalidIngestGenerationConfig> => {
  if (revision.trim().length === 0) {
    return Result.fail(new InvalidIngestGenerationConfig({ field }))
  }
  return Result.succeed({ id, revision })
}

export const makeIngestGenerationConfig = (
  input: IngestGenerationConfigInput
): Result.Result<IngestGenerationConfig, InvalidIngestGenerationConfig> => {
  if (input.modelId.trim().length === 0) {
    return Result.fail(new InvalidIngestGenerationConfig({ field: "modelId" }))
  }
  const model = dependency(input.modelId, input.modelRevision, "modelRevision")
  if (model._tag === "Failure") return Result.fail(model.failure)
  const extractor = dependency(
    LOCAL_GENERATION_COMPONENTS.extractor,
    input.extractorRevision,
    "extractorRevision"
  )
  if (extractor._tag === "Failure") return Result.fail(extractor.failure)
  const tokenizer = dependency(
    LOCAL_GENERATION_COMPONENTS.tokenizer,
    input.tokenizerRevision,
    "tokenizerRevision"
  )
  if (tokenizer._tag === "Failure") return Result.fail(tokenizer.failure)
  const graphWriter = dependency(
    LOCAL_GENERATION_COMPONENTS.graphWriter,
    input.graphWriterRevision,
    "graphWriterRevision"
  )
  if (graphWriter._tag === "Failure") return Result.fail(graphWriter.failure)
  const graphSchema = dependency(
    LOCAL_GENERATION_COMPONENTS.graphSchema,
    input.graphSchemaRevision,
    "graphSchemaRevision"
  )
  if (graphSchema._tag === "Failure") return Result.fail(graphSchema.failure)

  const extractionDependencies: ExtractionRuntimeDependencies = {
    extractor: extractor.success,
    model: model.success,
    tokenizer: tokenizer.success
  }
  const extractionGeneration = createRuntimeExtractionGeneration(extractionDependencies)
  return Result.succeed({
    extractionGeneration,
    indexGeneration: createIndexGeneration({
      extractionGeneration,
      graphWriter: graphWriter.success,
      graphSchema: graphSchema.success
    })
  })
}

export const ingestGenerationConfig = Effect.gen(function* () {
  const parsed = makeIngestGenerationConfig({
    modelId: yield* Config.string("PALIMPSEST_MODEL"),
    modelRevision: yield* Config.string("PALIMPSEST_EXTRACTION_MODEL_REVISION"),
    extractorRevision: yield* Config.string("PALIMPSEST_EXTRACTION_EXTRACTOR_REVISION"),
    tokenizerRevision: yield* Config.string("PALIMPSEST_EXTRACTION_TOKENIZER_REVISION"),
    graphWriterRevision: yield* Config.string("PALIMPSEST_INDEX_WRITER_REVISION"),
    graphSchemaRevision: yield* Config.string("PALIMPSEST_INDEX_SCHEMA_REVISION")
  })
  if (parsed._tag === "Failure") return yield* Effect.fail(parsed.failure)
  return parsed.success
})
