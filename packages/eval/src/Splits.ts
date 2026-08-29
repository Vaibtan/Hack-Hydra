import type { DatasetQuestion } from "@palimpsest/dataset"
import {
  LOCAL_GENERATION_COMPONENTS,
  createRuntimeExtractionGeneration,
  type ExtractionGeneration
} from "@palimpsest/palimpsest"

/**
 * The predeclared dev/test split of the Retrieval v2 population.
 *
 * The file this module reads and writes is the only thing standing between
 * "we did not tune on test" and an assertion nobody can check. It is committed
 * **before** the first v2 result exists, it names both id lists in full, and
 * `--split test` refuses to run until it also carries a gate record. Recomputing
 * the lists at eval time from `benchmarkSlice` would defeat the point — the
 * whole guarantee is that the lists did not move.
 */

/** Repo-relative, so both the generator and the harness name the same file. */
export const SPLIT_FILE = "data/splits/retrieval-v2.json"

export type SplitName = "dev" | "test"

export interface GateRecord {
  /** ISO date the gate was read. */
  readonly readAt: string
  readonly passed: boolean
  readonly numbers: Readonly<Record<string, number | string | boolean | null>>
}

export interface SplitFile {
  readonly schemaVersion: 1
  readonly dataset: string
  /** `benchmarkSlice(questions, slice)` is the population these ids came from. */
  readonly slice: number
  /** The uid prefix the population was ingested under. */
  readonly prefix: string
  readonly createdAt: string
  readonly note: string
  readonly extractionGeneration: {
    readonly id: string
    readonly promptTemplateSha256: string
    readonly outputSchemaSha256: string
    readonly dependencies: typeof BENCHMARK_EXTRACTION_DEPENDENCIES
  }
  /** Ingest outcome, so a capacity-capped population is visible in the file. */
  readonly population: {
    readonly requested: number
    readonly ingested: number
    readonly capacityGateTripped: boolean
  }
  readonly dev: ReadonlyArray<string>
  readonly test: ReadonlyArray<string>
  readonly gate: GateRecord | null
}

/**
 * The extraction generation's declared dependency revisions, pinned for the
 * whole v1-vs-v2 comparison.
 *
 * `scripts/palimpsest-generation-config.ps1` derives these from `git rev-parse
 * HEAD`, which is right for the transactional ingest — a release pins itself to
 * a commit — and wrong here: this comparison spans a ticket per commit, and an
 * id that changes with every unrelated commit cannot be the thing an eval
 * refuses to run against. What must not move is the *extraction*, and that is
 * caught by the two content hashes the descriptor already carries
 * (`prompt_template_sha256`, `output_schema_sha256`) plus the model id. So the
 * revisions are declared constants naming the graph they belong to, and the
 * hashes do the real work: change `EXTRACTION_SYSTEM_PROMPT` or the output
 * schema and the id changes, which is exactly the confound the freeze exists to
 * prevent.
 *
 * The one thing this does *not* catch is a change to `Tokenize.ts`, which would
 * alter Token vertices without touching the extraction descriptor. The graph is
 * frozen for this work (#22, *Out of Scope*), so that is a declared assumption
 * rather than an enforced one.
 */
export const BENCHMARK_EXTRACTION_DEPENDENCIES = {
  extractor: { id: LOCAL_GENERATION_COMPONENTS.extractor, revision: "retrieval-v2-g3" },
  model: { id: "gpt-5.6-luna", revision: "gpt-5.6-luna" },
  tokenizer: { id: LOCAL_GENERATION_COMPONENTS.tokenizer, revision: "retrieval-v2-g3" }
} as const

/** The generation id as this checkout computes it, right now. */
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

/**
 * Fails closed when the checkout's extraction differs from the one that built
 * the graph. Cheap, and the alternative is a table whose two halves were
 * extracted by different prompts with nothing in the file to say so.
 */
export const assertGenerationMatches = (file: SplitFile): void => {
  const live = liveExtractionGeneration()
  if (live.id !== file.extractionGeneration.id) {
    throw new ExtractionGenerationDrift(file.extractionGeneration.id, live.id)
  }
}

/**
 * Splits a population into the questions already cached from the `g2` run and
 * the rest.
 *
 * Dev is *whatever was already paid for*, not a fresh sample: those 60 have
 * cached anchors, reads and judgements, so iteration on them costs $0, and
 * every one of them is a question v1's numbers already exist for.
 */
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

/** Ids in `cachedIds` that the population does not contain. Must be empty. */
export const outsidePopulation = (
  population: ReadonlyArray<DatasetQuestion>,
  cachedIds: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const ids = new Set(population.map((question) => question.questionId))
  return cachedIds.filter((id) => !ids.has(id)).sort((a, b) => a.localeCompare(b))
}
