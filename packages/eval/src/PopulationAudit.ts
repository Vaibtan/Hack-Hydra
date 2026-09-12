import type { DatasetQuestion } from "@palimpsest/dataset"
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { Schema } from "effect"
import { benchmarkSlice } from "./Slice.js"
import {
  EXCLUSION_REASONS,
  Exclusion,
  isVerifiedIngestion,
  normalisePopulation,
  type Completion,
  type ExclusionReason,
  type IngestedPopulation,
  type PopulationSection,
  type SplitFile,
  type SplitObservation
} from "./Splits.js"

/**
 * The canonical, fail-closed population record. Everything a downstream result needs to know
 * about who was measured is here, and anything it cannot prove is `unknown` rather than a
 * defaulted success. Produced only from immutable inputs — the dataset file, the committed
 * split manifest, the committed result envelopes, and (when authorized) a read-only
 * reconciliation witness.
 */
export const PopulationRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** `dev`, `test`, or another split label; says which population this record describes. */
  split: Schema.NullOr(Schema.Literal("dev", "test")),
  dataset: Schema.String,
  datasetSha256: Schema.String,
  slice: Schema.Number,
  prefix: Schema.String,
  /** benchmarkSlice(questions, slice).length — the deterministic slice size. */
  requested: Schema.Number,
  /** Ids the split manifest names that actually exist in the dataset. */
  selected: Schema.Number,
  dev: Schema.Number,
  test: Schema.Number,
  answerable: Schema.Number,
  abstention: Schema.Number,
  ingested: Schema.Struct({
    state: Schema.Literal("unknown", "declared", "verified"),
    count: Schema.NullOr(Schema.Number),
    evidenceKind: Schema.Literal("manifest-committed", "legacy-query-visible", "declared", "unknown"),
    verifiedAt: Schema.NullOr(Schema.String),
    witness: Schema.NullOr(Schema.String)
  }),
  capacityGateTripped: Schema.Boolean,
  completion: Schema.Literal("complete", "capacity-capped", "unknown"),
  exclusions: Schema.Array(Exclusion),
  observed: Schema.Struct({ dev: Schema.Boolean, test: Schema.Boolean, note: Schema.String }),
  /** The deterministic membership every downstream result must share. */
  membership: Schema.Struct({
    dev: Schema.Array(Schema.String),
    test: Schema.Array(Schema.String)
  }),
  /** Query-visible membership after applying explicit, reason-coded exclusions. */
  eligible: Schema.Struct({
    dev: Schema.Array(Schema.String),
    test: Schema.Array(Schema.String)
  }),
  generatedAt: Schema.String,
  commands: Schema.Array(Schema.String),
  /** Question ids actually present in the committed result file for this split, when one exists. */
  evaluated: Schema.Array(Schema.String),
  /** Non-empty means the record is not acceptance evidence. */
  failures: Schema.Array(Schema.String)
})
/** Parsed canonical population audit artifact. */
export type PopulationRecord = typeof PopulationRecord.Type

/** The canonical witness produced by the read-only reconciliation; never written without one. */
export const RECONCILE_FILE = "data/splits/retrieval-v2.reconcile.json"

/** Per-user outcome of comparing expected source sessions with query-visible legacy sessions. */
export const RECONCILIATION_STATUSES = ["complete", "partial", "missing"] as const
/** Result of comparing one selected user's expected and query-visible session identities. */
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number]

/** Exact legacy graph membership observed for one selected question. */
export const ReconciledUser = Schema.Struct({
  questionId: Schema.String,
  uid: Schema.String,
  expectedSessionKeys: Schema.Array(Schema.String),
  visibleSessionKeys: Schema.Array(Schema.String),
  missingSessionKeys: Schema.Array(Schema.String),
  unexpectedSessionKeys: Schema.Array(Schema.String),
  duplicateSessionKeys: Schema.Array(Schema.String),
  status: Schema.Literal(...RECONCILIATION_STATUSES)
})
/** Parsed exact session-membership witness for one user. */
export type ReconciledUser = typeof ReconciledUser.Type

/** Immutable evidence from one read-only reconciliation of the legacy query-visible graph. */
export const ReconcileWitness = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  dataset: Schema.String,
  datasetSha256: Schema.String,
  membershipSha256: Schema.String,
  prefix: Schema.String,
  verifiedAt: Schema.String,
  evidenceKind: Schema.Literal("legacy-query-visible"),
  graph: Schema.Struct({
    kind: Schema.Literal("legacy-prefix"),
    prefix: Schema.String,
    snapshotId: Schema.Null
  }),
  command: Schema.String,
  users: Schema.Array(ReconciledUser)
})
/** Parsed immutable legacy reconciliation artifact. */
export type ReconcileWitness = typeof ReconcileWitness.Type

const assertReconcileWitness: (input: unknown) => asserts input is ReconcileWitness = Schema.asserts(
  ReconcileWitness,
  { errors: "all" }
)

/** Parse an untrusted reconciliation artifact before it influences population status. */
export const parseReconcileWitness = (input: unknown): ReconcileWitness => {
  assertReconcileWitness(input)
  return input
}

/** Return the lowercase SHA-256 digest of UTF-8 text. */
export const sha256Text = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

/** Stable identity of the split membership and legacy graph prefix, excluding mutable audit fields. */
export const splitMembershipSha256 = (
  file: Pick<SplitFile, "dataset" | "slice" | "prefix" | "dev" | "test">
): string =>
  sha256Text(
    JSON.stringify({
      dataset: file.dataset,
      slice: file.slice,
      prefix: file.prefix,
      dev: file.dev,
      test: file.test
    })
  )

const duplicateValues = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    else seen.add(value)
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right))
}

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

/** Inputs for comparing one user's expected and visible legacy sessions. */
export interface BuildReconciledUserInput {
  readonly questionId: string
  readonly uid: string
  readonly expectedSessionKeys: ReadonlyArray<string>
  readonly visibleSessionKeys: ReadonlyArray<string>
}

/** Compare exact expected and query-visible session identities for one legacy graph user. */
export const buildReconciledUser = (input: BuildReconciledUserInput): ReconciledUser => {
  const expectedSessionKeys = [...input.expectedSessionKeys].sort((left, right) => left.localeCompare(right))
  const visibleSessionKeys = [...input.visibleSessionKeys].sort((left, right) => left.localeCompare(right))
  const expected = new Set(expectedSessionKeys)
  const visible = new Set(visibleSessionKeys)
  const missingSessionKeys = expectedSessionKeys.filter((key) => !visible.has(key))
  const unexpectedSessionKeys = visibleSessionKeys.filter((key) => !expected.has(key))
  const duplicateSessionKeys = duplicateValues(visibleSessionKeys)
  const status: ReconciliationStatus =
    visibleSessionKeys.length === 0
      ? "missing"
      : missingSessionKeys.length === 0 &&
          unexpectedSessionKeys.length === 0 &&
          duplicateSessionKeys.length === 0
        ? "complete"
        : "partial"
  return {
    questionId: input.questionId,
    uid: input.uid,
    expectedSessionKeys,
    visibleSessionKeys,
    missingSessionKeys,
    unexpectedSessionKeys,
    duplicateSessionKeys,
    status
  }
}

/** Deterministic complete/missing/partial question IDs derived from detailed witness rows. */
export const witnessQuestionIds = (
  witness: ReconcileWitness
): {
  readonly complete: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  readonly partial: ReadonlyArray<string>
} => ({
  complete: witness.users.filter((user) => user.status === "complete").map((user) => user.questionId).sort(),
  missing: witness.users.filter((user) => user.status === "missing").map((user) => user.questionId).sort(),
  partial: witness.users.filter((user) => user.status === "partial").map((user) => user.questionId).sort()
})

/** Select the only defensible completion branch from witnessed and selected user counts. */
export const completionFromWitness = (
  complete: number,
  selected: number,
  capacityGateTripped: boolean
): Completion => complete === selected ? "complete" : capacityGateTripped ? "capacity-capped" : "unknown"

/** Immutable inputs against which a reconciliation witness must be checked. */
export interface ReconcileWitnessContext {
  readonly dataset: string
  readonly datasetSha256: string
  readonly membershipSha256: string
  readonly prefix: string
  readonly expectedUsers: ReadonlyArray<{
    readonly questionId: string
    readonly uid: string
    readonly expectedSessionKeys: ReadonlyArray<string>
  }>
}

/** Return every mismatch that prevents a reconciliation witness from being acceptance evidence. */
export const reconcileWitnessFailures = (
  witness: ReconcileWitness,
  context: ReconcileWitnessContext
): ReadonlyArray<string> => {
  const failures: Array<string> = []
  if (witness.dataset !== context.dataset) failures.push(`witness dataset ${witness.dataset} != ${context.dataset}`)
  if (witness.datasetSha256 !== context.datasetSha256) failures.push("witness dataset hash does not match")
  if (witness.membershipSha256 !== context.membershipSha256) failures.push("witness split membership hash does not match")
  if (witness.prefix !== context.prefix || witness.graph.prefix !== context.prefix) {
    failures.push(`witness graph prefix does not match ${context.prefix}`)
  }

  const expectedByQuestion = new Map(context.expectedUsers.map((user) => [user.questionId, user] as const))
  const selected = new Set(expectedByQuestion.keys())
  const witnessedIds = witness.users.map((user) => user.questionId)
  for (const duplicate of duplicateValues(witnessedIds)) failures.push(`witness repeats question ${duplicate}`)
  const witnessed = new Set(witnessedIds)
  for (const id of selected) {
    if (!witnessed.has(id)) failures.push(`witness omits selected question ${id}`)
  }
  for (const id of witnessedIds) {
    if (!selected.has(id)) failures.push(`witness includes unselected question ${id}`)
  }
  for (const user of witness.users) {
    const expectedUser = expectedByQuestion.get(user.questionId)
    if (expectedUser !== undefined) {
      if (user.uid !== expectedUser.uid) failures.push(`witness uid is inconsistent for ${user.questionId}`)
      const expectedSessionKeys = [...expectedUser.expectedSessionKeys].sort((left, right) => left.localeCompare(right))
      if (JSON.stringify(user.expectedSessionKeys) !== JSON.stringify(expectedSessionKeys)) {
        failures.push(`witness expected sessions are inconsistent for ${user.questionId}`)
      }
    }
    const rebuilt = buildReconciledUser(user)
    if (
      rebuilt.status !== user.status ||
      !sameStrings(rebuilt.expectedSessionKeys, user.expectedSessionKeys) ||
      !sameStrings(rebuilt.visibleSessionKeys, user.visibleSessionKeys) ||
      !sameStrings(rebuilt.missingSessionKeys, user.missingSessionKeys) ||
      !sameStrings(rebuilt.unexpectedSessionKeys, user.unexpectedSessionKeys) ||
      !sameStrings(rebuilt.duplicateSessionKeys, user.duplicateSessionKeys)
    ) {
      failures.push(`witness session classification is inconsistent for ${user.questionId}`)
    }
  }
  return failures
}

/** Streamed, so a 265 MB dataset is not held in memory just to hash it. */
export const datasetSha256 = async (path: string): Promise<string> => {
  const handle = await open(path, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

/** Requested, selected, and split-specific question membership. */
export interface PopulationMembership {
  /** benchmarkSlice(questions, slice). */
  readonly requested: ReadonlyArray<DatasetQuestion>
  /** Manifest ids present in the dataset, deterministic order. */
  readonly selected: ReadonlyArray<DatasetQuestion>
  readonly dev: ReadonlyArray<string>
  readonly test: ReadonlyArray<string>
}

/**
 * Membership checks that fail closed. Any failure means the population is not acceptance
 * evidence and the gate must refuse it.
 */
export const membershipFailures = (membership: PopulationMembership): ReadonlyArray<string> => {
  const failures: Array<string> = []
  const requested = new Set(membership.requested.map((q) => q.questionId))
  const selected = new Set(membership.selected.map((q) => q.questionId))

  const selectDuplicates = duplicateValues(membership.selected.map((q) => q.questionId))
  if (selectDuplicates.length > 0) {
    failures.push(`the manifest names duplicate selected ids: ${selectDuplicates.slice(0, 8).join(", ")}`)
  }
  const devDuplicates = duplicateValues(membership.dev)
  const testDuplicates = duplicateValues(membership.test)
  if (devDuplicates.length > 0) {
    failures.push(`dev repeats ${devDuplicates.slice(0, 8).join(", ")}`)
  }
  if (testDuplicates.length > 0) {
    failures.push(`test repeats ${testDuplicates.slice(0, 8).join(", ")}`)
  }

  for (const split of ["dev", "test"] as const) {
    const ids = split === "dev" ? membership.dev : membership.test
    const stray = ids.filter((id) => !requested.has(id))
    if (stray.length > 0) {
      failures.push(
        `${split} names ${stray.length} id(s) outside benchmarkSlice: ${stray.slice(0, 8).join(", ")}`
      )
    }
  }

  const overlap = membership.dev.filter((id) => membership.test.includes(id))
  if (overlap.length > 0) {
    failures.push(`dev and test overlap on ${overlap.slice(0, 8).join(", ")}`)
  }

  const union = new Set([...membership.dev, ...membership.test])
  const uncovered = [...selected].filter((id) => !union.has(id))
  if (uncovered.length > 0) {
    failures.push(
      `${uncovered.length} selected id(s) are in neither dev nor test: ${uncovered.slice(0, 8).join(", ")}`
    )
  }
  const extra = [...union].filter((id) => !selected.has(id))
  if (extra.length > 0) {
    failures.push(`dev/test name ${extra.length} id(s) the manifest does not select: ${extra.slice(0, 8).join(", ")}`)
  }

  return failures
}

/**
 * Fail closed on the ingestion half of the population. `declared` and `unknown` are never
 * evidence, and a verified count that contradicts the membership is a hard failure.
 */
export interface IngestionGateInput {
  readonly ingested: IngestedPopulation
  readonly selected: number
  readonly completion: Completion
  readonly capacityGateTripped: boolean
  readonly exclusions: ReadonlyArray<Exclusion>
}

/** Return every contradiction between witnessed ingestion and the declared completion branch. */
export const ingestionFailures = (input: IngestionGateInput): ReadonlyArray<string> => {
  const { ingested, selected, completion, capacityGateTripped, exclusions } = input
  const failures: Array<string> = []
  if (!isVerifiedIngestion(ingested)) {
    failures.push(
      `ingested population is ${ingested.state} (${ingested.evidenceKind}); a requested count is not a ` +
        "verified count. Run the read-only reconciliation and record its witness or freeze a " +
        "capacity-capped population."
    )
    return failures
  }
  if (ingested.count === null) {
    failures.push("ingested population claims `verified` with a null count")
    return failures
  }
  if (ingested.count > selected) {
    failures.push(`verified ingested ${ingested.count} exceeds the selected population ${selected}`)
  }
  if (completion === "unknown") {
    failures.push("completion branch is unknown despite a verified ingestion witness")
  }
  if (completion === "complete" && ingested.count !== selected) {
    failures.push(
      `completion is complete but only ${ingested.count}/${selected} selected users are verified complete`
    )
  }
  if (completion === "complete" && capacityGateTripped) {
    failures.push(
      "completion is complete but capacityGateTripped is true; the completion branch and flag disagree"
    )
  }
  if (completion === "capacity-capped" && !capacityGateTripped) {
    failures.push("completion is capacity-capped but capacityGateTripped is false")
  }
  if (completion === "capacity-capped" && ingested.count === selected) {
    failures.push(`completion is capacity-capped but all ${selected} selected users are verified complete`)
  }
  const excluded = new Set(exclusions.map((entry) => entry.questionId))
  const expectedExclusions = selected - ingested.count
  if (excluded.size !== exclusions.length) failures.push("exclusions repeat one or more question IDs")
  if (completion === "complete" && exclusions.length > 0) {
    failures.push(`completion is complete but ${exclusions.length} exclusion(s) are recorded`)
  }
  if (completion === "capacity-capped" && excluded.size !== expectedExclusions) {
    failures.push(
      `capacity-capped completion requires ${expectedExclusions} uniquely excluded users, found ${excluded.size}`
    )
  }
  return failures
}

/** The split halves already read during development, derived from committed result files. */
export const observedSplits = (present: {
  readonly dev: boolean
  readonly test: boolean
}): SplitObservation => ({
  dev: present.dev,
  test: present.test,
  note:
    present.test && present.dev
      ? "both splits have committed result files; treat as held-out but not blind"
      : present.dev
        ? "dev has committed result files; test is unread"
        : "no committed result files; the population is unobserved"
})

/** Inputs needed to construct one canonical population audit record. */
export interface BuildPopulationRecordInput {
  readonly split: "dev" | "test" | null
  readonly dataset: string
  readonly datasetSha256: string
  readonly slice: number
  readonly prefix: string
  readonly membership: PopulationMembership
  readonly population: PopulationSection
  readonly exclusions: ReadonlyArray<Exclusion>
  readonly observed: SplitObservation
  readonly generatedAt: string
  readonly commands: ReadonlyArray<string>
  /** Result rows observed for this split; `populationGateFailures` checks them against membership. */
  readonly evaluated?: ReadonlyArray<string>
}

/** Build a canonical population record and retain every discovered contradiction. */
export const buildPopulationRecord = (input: BuildPopulationRecordInput): PopulationRecord => {
  const normalised = normalisePopulation(input.population)
  const counts = {
    requested: input.membership.requested.length,
    selected: input.membership.selected.length,
    dev: input.membership.dev.length,
    test: input.membership.test.length,
    answerable: input.membership.selected.filter((q) => !q.isAbstention).length,
    abstention: input.membership.selected.filter((q) => q.isAbstention).length
  }
  const failures = [
    ...membershipFailures(input.membership),
    ...ingestionFailures({
      ingested: normalised.ingested,
      selected: counts.selected,
      completion: normalised.completion,
      capacityGateTripped: normalised.capacityGateTripped,
      exclusions: input.exclusions
    })
  ]
  const evaluated = [...(input.evaluated ?? [])].sort((a, b) => a.localeCompare(b))
  const excluded = new Set(input.exclusions.map((entry) => entry.questionId))
  for (const questionId of excluded) {
    if (!input.membership.selected.some((question) => question.questionId === questionId)) {
      failures.push(`exclusion names unselected question ${questionId}`)
    }
  }
  return {
    schemaVersion: 1,
    split: input.split,
    dataset: input.dataset,
    datasetSha256: input.datasetSha256,
    slice: input.slice,
    prefix: input.prefix,
    ...counts,
    ingested: normalised.ingested,
    capacityGateTripped: normalised.capacityGateTripped,
    completion: normalised.completion,
    exclusions: input.exclusions,
    observed: input.observed,
    membership: { dev: input.membership.dev, test: input.membership.test },
    eligible: {
      dev: input.membership.dev.filter((questionId) => !excluded.has(questionId)),
      test: input.membership.test.filter((questionId) => !excluded.has(questionId))
    },
    generatedAt: input.generatedAt,
    commands: input.commands,
    evaluated,
    failures
  }
}

/** The split's membership, rebuilt from the dataset and the committed manifest. */
export const membershipOf = (
  questions: ReadonlyArray<DatasetQuestion>,
  file: SplitFile
): PopulationMembership => {
  const requested = benchmarkSlice(questions, file.slice)
  const byId = new Map(requested.map((question) => [question.questionId, question] as const))
  const pick = (ids: ReadonlyArray<string>): ReadonlyArray<DatasetQuestion> =>
    ids.flatMap((id) => {
      const question = byId.get(id)
      return question === undefined ? [] : [question]
    })
  return {
    requested,
    selected: pick([...new Set([...file.dev, ...file.test])]),
    dev: [...file.dev].sort((a, b) => a.localeCompare(b)),
    test: [...file.test].sort((a, b) => a.localeCompare(b))
  }
}

/** Population record and observed result membership checked by the final gate. */
export interface PopulationGateInput {
  readonly record: PopulationRecord
  /** Question ids actually present in the committed result files for this split. */
  readonly evaluated: ReadonlyArray<string>
}

/**
 * The population gate: selected, committed, and evaluated must agree, and the ingestion must be
 * witnessed. Returns every failure, not the first.
 */
export const populationGateFailures = (input: PopulationGateInput): ReadonlyArray<string> => {
  const failures: Array<string> = [...input.record.failures]
  const selected = new Set(
    input.record.split === "dev"
      ? input.record.eligible.dev
      : input.record.split === "test"
        ? input.record.eligible.test
        : [...input.record.eligible.dev, ...input.record.eligible.test]
  )
  const evaluatedDuplicates = duplicateValues(input.evaluated)
  if (evaluatedDuplicates.length > 0) {
    failures.push(`evaluated rows repeat ${evaluatedDuplicates.slice(0, 8).join(", ")}`)
  }
  const evaluated = new Set(input.evaluated)

  const stray = [...evaluated].filter((id) => !selected.has(id))
  if (stray.length > 0) {
    failures.push(
      `${stray.length} evaluated id(s) are not in the selected population: ${stray.slice(0, 8).join(", ")}`
    )
  }

  if (input.record.completion !== "unknown" && input.record.ingested.count !== null) {
    const missing = [...selected].filter((id) => !evaluated.has(id))
    if (missing.length > 0) {
      failures.push(
        `the ${input.record.completion} eligible population (${input.record.ingested.count} ingested) has ` +
          `${missing.length} selected id(s) that were not evaluated: ${missing.slice(0, 8).join(", ")}`
      )
    }
  }

  return failures
}

/** Create sorted reason-coded exclusions for selected IDs absent from the complete set. */
export const exclusionsFrom = (
  selected: ReadonlyArray<string>,
  complete: ReadonlyArray<string>,
  reason: ExclusionReason
): ReadonlyArray<Exclusion> => {
  const done = new Set(complete)
  return [...selected]
    .filter((id) => !done.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((questionId) => ({ questionId, reason }))
}

/** Supported population exclusion reasons. */
export const exclusionReasons = EXCLUSION_REASONS

export type { Completion }
