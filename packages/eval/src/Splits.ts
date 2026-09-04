import type { DatasetQuestion } from "@palimpsest/dataset"
import {
  LOCAL_GENERATION_COMPONENTS,
  createRuntimeExtractionGeneration,
  type ExtractionGeneration
} from "@palimpsest/palimpsest"
import { Schema } from "effect"

/** Repo-relative; committed before the first v2 result, with both id lists in full. */
export const SPLIT_FILE = "data/splits/retrieval-v2.json"

export type SplitName = "dev" | "test"

const Revision = (id: string, revision: string) =>
  Schema.Struct({ id: Schema.Literal(id), revision: Schema.Literal(revision) })

/** Pinned to the g3 graph, not to HEAD; the descriptor's prompt and schema hashes catch extraction drift. */
export const BENCHMARK_EXTRACTION_DEPENDENCIES = {
  extractor: { id: LOCAL_GENERATION_COMPONENTS.extractor, revision: "retrieval-v2-g3" },
  model: { id: "gpt-5.6-luna", revision: "gpt-5.6-luna" },
  tokenizer: { id: LOCAL_GENERATION_COMPONENTS.tokenizer, revision: "retrieval-v2-g3" }
} as const

export const GateRecord = Schema.Struct({
  readAt: Schema.String,
  passed: Schema.Boolean,
  numbers: Schema.Record({
    key: Schema.String,
    value: Schema.NullOr(Schema.Union(Schema.Number, Schema.String, Schema.Boolean))
  })
})
export type GateRecord = typeof GateRecord.Type

export const SplitFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  dataset: Schema.String,
  slice: Schema.Number,
  prefix: Schema.String,
  createdAt: Schema.String,
  note: Schema.String,
  extractionGeneration: Schema.Struct({
    id: Schema.String,
    promptTemplateSha256: Schema.String,
    outputSchemaSha256: Schema.String,
    dependencies: Schema.Struct({
      extractor: Revision(
        BENCHMARK_EXTRACTION_DEPENDENCIES.extractor.id,
        BENCHMARK_EXTRACTION_DEPENDENCIES.extractor.revision
      ),
      model: Revision(
        BENCHMARK_EXTRACTION_DEPENDENCIES.model.id,
        BENCHMARK_EXTRACTION_DEPENDENCIES.model.revision
      ),
      tokenizer: Revision(
        BENCHMARK_EXTRACTION_DEPENDENCIES.tokenizer.id,
        BENCHMARK_EXTRACTION_DEPENDENCIES.tokenizer.revision
      )
    })
  }),
  population: Schema.Struct({
    requested: Schema.Number,
    ingested: Schema.Number,
    capacityGateTripped: Schema.Boolean
  }),
  dev: Schema.Array(Schema.String),
  test: Schema.Array(Schema.String),
  gate: Schema.NullOr(GateRecord)
})
export type SplitFile = typeof SplitFile.Type

export const liveExtractionGeneration = (): ExtractionGeneration =>
  createRuntimeExtractionGeneration(BENCHMARK_EXTRACTION_DEPENDENCIES)

export class ExtractionGenerationDrift extends Error {
  constructor(
    readonly recorded: string,
    readonly live: string
  ) {
    super(
      `extraction generation drift: ${SPLIT_FILE} records ${recorded} but this checkout computes ` +
        `${live}. The extraction prompt or output schema changed, so results measured on the ` +
        `recorded graph are not comparable — re-ingest under a fresh prefix or restore the prompt.`
    )
  }
}

export const assertGenerationMatches = (file: SplitFile): void => {
  const live = liveExtractionGeneration()
  if (live.id !== file.extractionGeneration.id) {
    throw new ExtractionGenerationDrift(file.extractionGeneration.id, live.id)
  }
}

/** Dev is the g2-cached questions, so iterating on them costs $0; test is the rest. */
export const splitByCached = (
  population: ReadonlyArray<DatasetQuestion>,
  cachedIds: ReadonlyArray<string>
): { readonly dev: ReadonlyArray<string>; readonly test: ReadonlyArray<string> } => {
  const cached = new Set(cachedIds)
  const ids = population.map((question) => question.questionId).sort((a, b) => a.localeCompare(b))
  return {
    dev: ids.filter((id) => cached.has(id)),
    test: ids.filter((id) => !cached.has(id))
  }
}

export const outsidePopulation = (
  population: ReadonlyArray<DatasetQuestion>,
  cachedIds: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const ids = new Set(population.map((question) => question.questionId))
  return cachedIds.filter((id) => !ids.has(id)).sort((a, b) => a.localeCompare(b))
}
