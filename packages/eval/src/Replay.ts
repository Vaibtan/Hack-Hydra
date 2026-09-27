import { Schema } from "effect"
import { decodeEnvelope, envelopeVariant, type EvalEnvelope } from "./Envelope.js"
import { canonicalJson, type JsonObject, type JsonValue } from "./JsonValue.js"

/**
 * Row fields that record how long a run took rather than what it decided. They are the only
 * fields a semantic replay may change; every other field, including ones this schema does not
 * name, must be byte-identical as canonical JSON.
 */
export const MEASUREMENT_ROW_FIELDS = ["latencyMs", "askMs", "graphMs", "stageTimingsMs"] as const
/** Replay-only evidence fields absent from the 2026 historical rows and checked separately below. */
export const REPLAY_PROOF_ROW_FIELDS = ["judgeResolvedModel", "evidenceBytesSha256"] as const

/** Envelope fields two runs must share for their rows to describe the same experiment. */
export const REPLAY_IDENTITY_FIELDS = [
  "system",
  "dataset",
  "prefix",
  "split",
  "profile",
  "readerModel",
  "selectModel",
  "sufficiencyModel",
  "judgeModel",
  "extractionGeneration"
] as const satisfies ReadonlyArray<keyof EvalEnvelope>

/** The subject used for envelope-level differences. */
export const ENVELOPE_SUBJECT = "(envelope)"

const RawRows = Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })

/** A results envelope plus its rows as raw JSON objects, so unknown fields take part in comparison. */
export interface ReplayRun {
  readonly envelope: EvalEnvelope
  readonly rows: ReadonlyArray<JsonObject>
}

/**
 * Parse one results file for comparison.
 *
 * @param input - The decoded JSON document of a results envelope.
 * @returns The typed envelope and the same rows as JSON objects.
 * @throws When the document is not a valid results envelope.
 */
export const parseReplayRun = (input: JsonObject): ReplayRun => ({
  envelope: decodeEnvelope(input),
  rows: Schema.decodeUnknownSync(RawRows)(input).rows
})

/** One field whose canonical JSON differs between the frozen run and the replay. */
export interface ReplayDifference {
  /** The question id, or `(envelope)` for run-level identity. */
  readonly questionId: string
  readonly field: string
  /** Canonical JSON of the frozen value, or `null` when the field is absent. */
  readonly frozen: string | null
  /** Canonical JSON of the replayed value, or `null` when the field is absent. */
  readonly replay: string | null
}

/** Outcome of comparing a replay with the frozen run it must reproduce. */
export interface ReplayComparison {
  readonly verdict: "semantically-identical" | "semantically-different"
  /** Questions present exactly once in both runs and compared field by field. */
  readonly compared: number
  /** Frozen question ids the replay did not answer. */
  readonly missing: ReadonlyArray<string>
  /** Replay question ids the frozen run does not contain. */
  readonly unexpected: ReadonlyArray<string>
  /** Question ids repeated in either run. */
  readonly repeated: ReadonlyArray<string>
  readonly differences: ReadonlyArray<ReplayDifference>
  /** Compared questions whose only changes are measurement fields; informational, never a failure. */
  readonly measurementOnly: number
  /** Missing or contradictory replay audit proof; any entry invalidates the replay. */
  readonly proofFindings: ReadonlyArray<string>
}

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const canonicalOrNull = (value: JsonValue | undefined): string | null =>
  value === undefined ? null : canonicalJson(value)

const questionIdOf = (row: JsonObject): string => {
  const id = row["questionId"]
  return Schema.is(Schema.String)(id) ? id : ""
}

const indexRows = (rows: ReadonlyArray<JsonObject>) => {
  const byId = new Map<string, JsonObject>()
  const repeated = new Set<string>()
  for (const row of rows) {
    const id = questionIdOf(row)
    if (byId.has(id)) repeated.add(id)
    else byId.set(id, row)
  }
  return { byId, repeated: [...repeated].sort(byCodeUnit) }
}

const identityValue = (envelope: EvalEnvelope, field: (typeof REPLAY_IDENTITY_FIELDS)[number]): string | null => {
  const value = envelope[field]
  return value === undefined || value === null ? null : canonicalJson(value)
}

const envelopeDifferences = (frozen: EvalEnvelope, replay: EvalEnvelope): ReadonlyArray<ReplayDifference> => {
  const differences: Array<ReplayDifference> = []
  for (const field of REPLAY_IDENTITY_FIELDS) {
    const left = identityValue(frozen, field)
    const right = identityValue(replay, field)
    if (left !== right) differences.push({ questionId: ENVELOPE_SUBJECT, field, frozen: left, replay: right })
  }
  const derived: ReadonlyArray<readonly [string, JsonValue, JsonValue]> = [
    ["variant", envelopeVariant(frozen), envelopeVariant(replay)],
    ["ablations", frozen.ablations ?? [], replay.ablations ?? []],
    ["granularity", frozen.granularity ?? null, replay.granularity ?? null]
  ]
  for (const [field, left, right] of derived) {
    if (canonicalJson(left) !== canonicalJson(right)) {
      differences.push({ questionId: ENVELOPE_SUBJECT, field, frozen: canonicalJson(left), replay: canonicalJson(right) })
    }
  }
  if (replay.pass === "cold") {
    differences.push({
      questionId: ENVELOPE_SUBJECT,
      field: "pass",
      frozen: canonicalOrNull(frozen.pass),
      replay: canonicalJson(replay.pass)
    })
  }
  return differences
}

const rowDifferences = (questionId: string, frozen: JsonObject, replay: JsonObject) => {
  const measurement = new Set<string>(MEASUREMENT_ROW_FIELDS)
  const proof = new Set<string>(REPLAY_PROOF_ROW_FIELDS)
  const fields = [...new Set([...Object.keys(frozen), ...Object.keys(replay)])].sort(byCodeUnit)
  const semantic: Array<ReplayDifference> = []
  let measurementChanged = false
  for (const field of fields) {
    const left = canonicalOrNull(frozen[field])
    const right = canonicalOrNull(replay[field])
    if (left === right) continue
    if (measurement.has(field)) measurementChanged = true
    else if (proof.has(field) && frozen[field] === undefined) continue
    else semantic.push({ questionId, field, frozen: left, replay: right })
  }
  return { semantic, measurementChanged }
}

/**
 * Compare a replay with the frozen run it must reproduce. Semantic identity means the same
 * question set, the same run identity, and byte-identical canonical JSON for every row field
 * except the measurement fields; a difference is reported, never explained away.
 *
 * @param frozen - The accepted run.
 * @param replay - The replay under the code being qualified.
 * @returns The verdict with every difference.
 */
export const compareReplay = (
  frozen: ReplayRun,
  replay: ReplayRun,
  options: { readonly requireProof?: boolean } = {}
): ReplayComparison => {
  const left = indexRows(frozen.rows)
  const right = indexRows(replay.rows)
  const repeated = [...new Set([...left.repeated, ...right.repeated])].sort(byCodeUnit)
  const missing = [...left.byId.keys()].filter((id) => !right.byId.has(id)).sort(byCodeUnit)
  const unexpected = [...right.byId.keys()].filter((id) => !left.byId.has(id)).sort(byCodeUnit)
  const differences: Array<ReplayDifference> = [...envelopeDifferences(frozen.envelope, replay.envelope)]
  let compared = 0
  let measurementOnly = 0
  const proofFindings: Array<string> = []
  if (options.requireProof === true) {
    if (replay.envelope.llmTrace === undefined || replay.envelope.llmTrace.length === 0) {
      proofFindings.push("replay envelope has no LLM call trace")
    } else {
      const live = replay.envelope.llmTrace.filter((call) => call.cache !== "hit")
      if (live.length > 0) proofFindings.push(`${live.length} LLM call(s) were live rather than cache hits`)
    }
    for (const row of replay.rows) {
      const questionId = questionIdOf(row)
      const evidenceHash = row["evidenceBytesSha256"]
      if (!Schema.is(Schema.String)(evidenceHash) || evidenceHash.length !== 64) {
        proofFindings.push(`${questionId || "(missing question id)"} has no valid evidence-byte SHA-256`)
      }
    }
  }
  for (const [questionId, frozenRow] of left.byId) {
    const replayRow = right.byId.get(questionId)
    if (replayRow === undefined || repeated.includes(questionId)) continue
    compared++
    const row = rowDifferences(questionId, frozenRow, replayRow)
    differences.push(...row.semantic)
    if (row.semantic.length === 0 && row.measurementChanged) measurementOnly++
  }
  const identical =
    missing.length === 0 &&
    unexpected.length === 0 &&
    repeated.length === 0 &&
    differences.length === 0 &&
    proofFindings.length === 0
  return {
    verdict: identical ? "semantically-identical" : "semantically-different",
    compared,
    missing,
    unexpected,
    repeated,
    differences,
    measurementOnly,
    proofFindings
  }
}
