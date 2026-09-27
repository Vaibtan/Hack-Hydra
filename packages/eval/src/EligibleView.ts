import { Schema } from "effect"
import { EvalRow, SYSTEM_NAMES, envelopeVariant, type EvalEnvelope, type SystemName } from "./Envelope.js"
import { Exclusion, type SplitName } from "./Splits.js"

/** Repository-relative directory of derived eligible-population views; never a results envelope. */
export const ELIGIBLE_VIEW_DIR = "results/views"

/**
 * A byte-preserving subset of an already-read arm restricted to the eligible population. It names
 * its source and exclusions and is deliberately not an `EvalEnvelope`, so it cannot be mistaken
 * for, merged with, or tabled as a new run.
 */
export const EligibleView = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("eligible-population-view"),
  system: Schema.Literals([...SYSTEM_NAMES]),
  split: Schema.Literals(["dev", "test"]),
  source: Schema.Struct({
    path: Schema.String,
    sha256: Schema.String,
    rows: Schema.Number
  }),
  eligible: Schema.Array(Schema.String),
  excluded: Schema.Array(Exclusion),
  view: Schema.Struct({ rows: Schema.Array(EvalRow) })
})
/** Parsed eligible-population view. */
export type EligibleView = typeof EligibleView.Type

/** An already-read artifact whose digest the caller has verified against the freeze manifest. */
export interface EligibleViewSource {
  /** Repository-relative path of the source artifact. */
  readonly path: string
  readonly sha256: string
  readonly envelope: EvalEnvelope
}

/** One split's original membership and its frozen effective population. */
export interface SplitPopulation {
  readonly split: SplitName
  /** The original observed split membership the source artifact must cover exactly. */
  readonly original: ReadonlyArray<string>
  readonly eligible: ReadonlyArray<string>
  /** Frozen exclusions; entries outside this split are ignored. */
  readonly exclusions: ReadonlyArray<Exclusion>
}

/** A derived view, or every reason the source or population cannot yield one. */
export type EligibleViewOutcome =
  | { readonly _tag: "Derived"; readonly view: EligibleView }
  | { readonly _tag: "Refused"; readonly reasons: ReadonlyArray<string> }

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const sample = (ids: ReadonlyArray<string>): string =>
  `${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ` (+${ids.length - 8} more)` : ""}`

const repeated = (ids: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) twice.add(id)
    else seen.add(id)
  }
  return [...twice].sort(byCodeUnit)
}

const coverage = (
  label: string,
  observed: ReadonlyArray<string>,
  expected: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const have = new Set(observed)
  const want = new Set(expected)
  const missing = expected.filter((id) => !have.has(id))
  const outside = observed.filter((id) => !want.has(id))
  const twice = repeated(observed)
  return [
    ...(missing.length === 0 ? [] : [`${label} is missing ${missing.length} id(s): ${sample(missing)}`]),
    ...(outside.length === 0 ? [] : [`${label} has ${outside.length} id(s) outside the population: ${sample(outside)}`]),
    ...(twice.length === 0 ? [] : [`${label} repeats ${sample(twice)}`])
  ]
}

const populationReasons = (population: SplitPopulation): ReadonlyArray<string> => {
  const original = new Set(population.original)
  const excluded = population.exclusions.filter((entry) => original.has(entry.questionId))
  const excludedIds = new Set(excluded.map((entry) => entry.questionId))
  const both = population.eligible.filter((id) => excludedIds.has(id))
  const covered = [...population.eligible, ...excluded.map((entry) => entry.questionId)]
  return [
    ...(both.length === 0 ? [] : [`eligible ids are also excluded: ${sample(both)}`]),
    ...coverage(`eligible plus excluded ${population.split}`, covered, population.original)
  ]
}

/**
 * Restrict an already-read arm to the eligible population without changing any row. Fails closed
 * unless the source is one whole full-pipeline run over exactly the original split membership and
 * the eligible and excluded ids partition that membership.
 *
 * @param source - The verified source artifact.
 * @param population - The split's original membership and frozen eligible population.
 * @returns The derived view, or every refusal reason.
 */
export const deriveEligibleView = (
  source: EligibleViewSource,
  population: SplitPopulation
): EligibleViewOutcome => {
  const { envelope } = source
  const reasons: Array<string> = []
  if ((envelope.split ?? null) !== population.split) {
    reasons.push(`${source.path} is split ${String(envelope.split ?? null)}, not ${population.split}`)
  }
  if (envelopeVariant(envelope).length > 0) {
    reasons.push(`${source.path} is a variant run (${envelopeVariant(envelope).join(", ")}), not an arm`)
  }
  if (envelope.partial === true || envelope.batch !== undefined) {
    reasons.push(`${source.path} is a partial or batch file, not a whole run`)
  }
  reasons.push(
    ...coverage(
      source.path,
      envelope.rows.map((row) => row.questionId),
      population.original
    ),
    ...populationReasons(population)
  )
  if (reasons.length > 0) return { _tag: "Refused", reasons }

  const eligible = new Set(population.eligible)
  const original = new Set(population.original)
  return {
    _tag: "Derived",
    view: {
      schemaVersion: 1,
      kind: "eligible-population-view",
      system: envelope.system,
      split: population.split,
      source: { path: source.path, sha256: source.sha256, rows: envelope.rows.length },
      eligible: [...population.eligible].sort(byCodeUnit),
      excluded: population.exclusions
        .filter((entry) => original.has(entry.questionId))
        .sort((left, right) => byCodeUnit(left.questionId, right.questionId)),
      view: { rows: envelope.rows.filter((row) => eligible.has(row.questionId)) }
    }
  }
}

/**
 * The byte form of a view file: two-space JSON with a trailing newline and no timestamps, so the
 * same inputs always produce the same file.
 *
 * @param view - The derived view.
 * @returns The file contents.
 */
export const renderEligibleView = (view: EligibleView): string => `${JSON.stringify(view, null, 2)}\n`

/** One system's rows offered to a join. */
export interface JoinArm {
  readonly system: SystemName
  readonly rows: ReadonlyArray<EvalRow>
}

/** One eligible question with every arm's row. */
export interface JoinedQuestion {
  readonly questionId: string
  readonly questionType: string
  readonly isAbstention: boolean
  readonly rows: ReadonlyMap<SystemName, EvalRow>
}

/** Aligned rows for every eligible question, or every reason the arms cannot be joined. */
export type JoinOutcome =
  | { readonly _tag: "Joined"; readonly questions: ReadonlyArray<JoinedQuestion> }
  | { readonly _tag: "Refused"; readonly reasons: ReadonlyArray<string> }

/**
 * Align arms question by question over exactly the eligible population. Any arm with an id
 * outside the population, a missing id, or a repeated id refuses the whole join, as does a
 * question whose type or answerability differs between arms.
 *
 * @param eligible - The frozen eligible question ids.
 * @param arms - Each system's rows.
 * @returns The joined questions in sorted id order, or every refusal reason.
 */
export const joinEligible = (eligible: ReadonlyArray<string>, arms: ReadonlyArray<JoinArm>): JoinOutcome => {
  const reasons: Array<string> = []
  if (arms.length === 0) reasons.push("no arms to join")
  const systems = arms.map((arm) => arm.system)
  const twiceSystems = repeated(systems)
  if (twiceSystems.length > 0) reasons.push(`systems offered more than once: ${twiceSystems.join(", ")}`)
  const twiceEligible = repeated(eligible)
  if (twiceEligible.length > 0) reasons.push(`the eligible population repeats ${sample(twiceEligible)}`)
  for (const arm of arms) {
    reasons.push(...coverage(arm.system, arm.rows.map((row) => row.questionId), eligible))
  }
  if (reasons.length > 0) return { _tag: "Refused", reasons }

  const byArm = new Map(arms.map((arm) => [arm.system, new Map(arm.rows.map((row) => [row.questionId, row]))] as const))
  const questions: Array<JoinedQuestion> = []
  for (const questionId of [...eligible].sort(byCodeUnit)) {
    const rows = new Map<SystemName, EvalRow>()
    for (const [system, byId] of byArm) {
      const row = byId.get(questionId)
      if (row !== undefined) rows.set(system, row)
    }
    const kinds = new Set([...rows.values()].map((row) => `${row.questionType}|${String(row.isAbstention)}`))
    const first = [...rows.values()][0]
    if (kinds.size !== 1 || first === undefined) {
      reasons.push(`${questionId} has inconsistent question type or answerability across arms: ${[...kinds].join(" vs ")}`)
      continue
    }
    questions.push({ questionId, questionType: first.questionType, isAbstention: first.isAbstention, rows })
  }
  return reasons.length > 0 ? { _tag: "Refused", reasons } : { _tag: "Joined", questions }
}
