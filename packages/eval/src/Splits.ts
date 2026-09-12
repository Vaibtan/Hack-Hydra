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

/**
 * How an `ingested` count was established. `declared` is a claim without a witness — the exact
 * value the old `splits.ts` fallback wrote — and is never treated as acceptance evidence.
 */
export const INGESTION_EVIDENCE_KINDS = [
  "manifest-committed",
  "legacy-query-visible",
  "declared",
  "unknown"
] as const
/** Provenance category for an ingestion population claim. */
export type IngestionEvidenceKind = (typeof INGESTION_EVIDENCE_KINDS)[number]

/** `verified` means a reconciliation ran and wrote a witness; `declared`/`unknown` do not. */
export const INGESTION_STATES = ["unknown", "declared", "verified"] as const
/** Verification state of an ingestion population claim. */
export type IngestionState = (typeof INGESTION_STATES)[number]

/** Persisted shape of an ingestion count and its evidence reference. */
export const IngestedPopulation = Schema.Struct({
  state: Schema.Literal(...INGESTION_STATES),
  /** Present only when a reconciliation supplied one; null is honest, not zero. */
  count: Schema.NullOr(Schema.Number),
  evidenceKind: Schema.Literal(...INGESTION_EVIDENCE_KINDS),
  verifiedAt: Schema.NullOr(Schema.String),
  /** Repo-relative path/hash of the reconciliation witness this count came from. */
  witness: Schema.NullOr(Schema.String)
})
/** Parsed ingestion population record. */
export type IngestedPopulation = typeof IngestedPopulation.Type

/** A legacy scalar `ingested` (the unsupported `= requested` claim) or the structured record. */
export const PopulationCount = Schema.Union(IngestedPopulation, Schema.Number)
/** Backward-compatible persisted ingestion field. */
export type PopulationCount = typeof PopulationCount.Type

/** Convert legacy scalar counts into unverified declarations without preserving the claimed count. */
export const normaliseIngested = (value: PopulationCount): IngestedPopulation =>
  typeof value === "number"
    ? { state: "declared", count: null, evidenceKind: "declared", verifiedAt: null, witness: null }
    : value

/** Whether an ingestion count has complete provenance needed for acceptance evidence. */
export const isVerifiedIngestion = (value: IngestedPopulation): boolean =>
  value.state === "verified" &&
  value.count !== null &&
  (value.evidenceKind === "manifest-committed" || value.evidenceKind === "legacy-query-visible") &&
  value.verifiedAt !== null &&
  value.witness !== null

export const EXCLUSION_REASONS = [
  "capacity-capped",
  "ingest-failed",
  "missing-source",
  "not-in-dataset",
  "duplicate-id"
] as const
/** Reason a selected question is excluded from effective evaluation membership. */
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

/** Persisted reason-coded population exclusion. */
export const Exclusion = Schema.Struct({
  questionId: Schema.String,
  reason: Schema.Literal(...EXCLUSION_REASONS)
})
/** Parsed population exclusion. */
export type Exclusion = typeof Exclusion.Type

/** Whether each split's data has actually been read; a fact derived from committed result files. */
export const SplitObservation = Schema.Struct({
  dev: Schema.Boolean,
  test: Schema.Boolean,
  note: Schema.String
})
/** Whether committed result artifacts have observed each split. */
export type SplitObservation = typeof SplitObservation.Type

/** Allowed completion branches for the selected population. */
export const COMPLETIONS = ["complete", "capacity-capped", "unknown"] as const
/** Selected population completion branch. */
export type Completion = (typeof COMPLETIONS)[number]

const opt = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true })

/**
 * The population section. Legacy rows carry only `requested`/`ingested`/`capacityGateTripped`;
 * the audit reads the absent fields as missing and fails closed rather than assuming success.
 */
export const PopulationSection = Schema.Struct({
  requested: Schema.Number,
  ingested: PopulationCount,
  capacityGateTripped: Schema.Boolean,
  selected: opt(Schema.Number),
  completion: opt(Schema.NullOr(Schema.Literal(...COMPLETIONS))),
  datasetSha256: opt(Schema.NullOr(Schema.String)),
  answerable: opt(Schema.NullOr(Schema.Number)),
  abstention: opt(Schema.NullOr(Schema.Number)),
  exclusions: opt(Schema.Array(Exclusion)),
  observed: opt(Schema.NullOr(SplitObservation)),
  commands: opt(Schema.Array(Schema.String)),
  generatedAt: opt(Schema.NullOr(Schema.String)),
  /** When a reconciliation last verified ingestion; null while the count is undeclared. */
  verifiedAt: opt(Schema.NullOr(Schema.String))
})
/** Parsed population metadata stored in the split manifest. */
export type PopulationSection = typeof PopulationSection.Type

/** Normalized population metadata used by fail-closed audit logic. */
export interface NormalisedPopulation {
  readonly requested: number
  readonly selected: number | null
  readonly ingested: IngestedPopulation
  readonly capacityGateTripped: boolean
  readonly completion: Completion
  readonly datasetSha256: string | null
  readonly answerable: number | null
  readonly abstention: number | null
  readonly exclusions: ReadonlyArray<Exclusion>
  readonly observed: SplitObservation | null
  readonly commands: ReadonlyArray<string>
  readonly generatedAt: string | null
  readonly verifiedAt: string | null
}

/** Normalize optional legacy population metadata without upgrading unsupported claims. */
export const normalisePopulation = (section: PopulationSection): NormalisedPopulation => {
  const ingested = normaliseIngested(section.ingested)
  const completion: Completion =
    section.completion ??
    (isVerifiedIngestion(ingested)
      ? section.capacityGateTripped
        ? "capacity-capped"
        : "complete"
      : "unknown")
  return {
    requested: section.requested,
    selected: section.selected ?? null,
    ingested,
    capacityGateTripped: section.capacityGateTripped,
    completion,
    datasetSha256: section.datasetSha256 ?? null,
    answerable: section.answerable ?? null,
    abstention: section.abstention ?? null,
    exclusions: section.exclusions ?? [],
    observed: section.observed ?? null,
    commands: section.commands ?? [],
    generatedAt: section.generatedAt ?? null,
    verifiedAt: section.verifiedAt ?? null
  }
}

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
  population: PopulationSection,
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
