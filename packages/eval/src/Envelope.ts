import type { V2Answer } from "@palimpsest/palimpsest"
import { Schema } from "effect"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import type { JudgeTemplate } from "./Judge.js"
import type { JsonObject } from "./JsonValue.js"

export const SYSTEM_NAMES = [
  "palimpsest",
  "palimpsest-v2",
  "palimpsest-premise",
  "oracle-session",
  "bm25",
  "fullctx"
] as const

export type SystemName = (typeof SYSTEM_NAMES)[number]

export const isSystemName = (value: string): value is SystemName =>
  SYSTEM_NAMES.some((name) => name === value)

type AbstentionReason = NonNullable<V2Answer["reason"]>
type SufficiencyTier = V2Answer["ask"]["plan"]["sufficiency"]["tier"]
type Complete<Union, Listed> = [Exclude<Union, Listed>] extends [never] ? true : Exclude<Union, Listed>

export const ABSTENTION_REASONS = [
  "A1_no_anchors",
  "A2_no_convergence",
  "INCOMPLETE_MEMORY",
  "INSUFFICIENT_EVIDENCE",
  "CONTRADICTED_PREMISE"
] as const satisfies ReadonlyArray<AbstentionReason>
export const ABSTENTION_REASONS_COMPLETE: Complete<AbstentionReason, (typeof ABSTENTION_REASONS)[number]> = true

export const SUFFICIENCY_TIERS = [
  "EXACT",
  "INFERRABLE",
  "PARTIAL",
  "skipped"
] as const satisfies ReadonlyArray<SufficiencyTier>
export const SUFFICIENCY_TIERS_COMPLETE: Complete<SufficiencyTier, (typeof SUFFICIENCY_TIERS)[number]> = true

export const JUDGE_TEMPLATES = [
  "default",
  "temporal-reasoning",
  "knowledge-update",
  "single-session-preference",
  "abstention"
] as const satisfies ReadonlyArray<JudgeTemplate>
export const JUDGE_TEMPLATES_COMPLETE: Complete<JudgeTemplate, (typeof JUDGE_TEMPLATES)[number]> = true

const opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const Strings = Schema.Array(Schema.String)

export const EvalRow = Schema.Struct({
  system: Schema.Literals([...SYSTEM_NAMES]),
  questionId: Schema.String,
  questionType: Schema.String,
  isAbstention: Schema.Boolean,
  verdict: Schema.Literals(["ANSWER", "ABSENT", "INCOMPLETE"]),
  reason: Schema.NullOr(Schema.Literals([...ABSTENTION_REASONS])),
  answer: Schema.String,
  notInMemory: Schema.Boolean,
  premiseSupported: Schema.NullOr(Schema.Boolean),
  premiseNote: Schema.String,
  judged: Schema.Boolean,
  judgeTemplate: Schema.Literals([...JUDGE_TEMPLATES]),
  judgeReply: Schema.String,
  judgeModel: Schema.String,
  /** Provider-returned model identity; absent on historical rows that did not retain it. */
  judgeResolvedModel: opt(Schema.NullOr(Schema.String)),
  /** Exact ordered hydrated evidence bytes and metadata seen by the reader. */
  evidenceBytesSha256: opt(Schema.String),
  evidenceSessions: Strings,
  answerSessions: Strings,
  sessionHit: Schema.Boolean,
  evidence: Schema.Number,
  anchorsAsked: Schema.Number,
  anchorsReachingClaims: Schema.Number,
  readerInputTokens: Schema.Number,
  readerOutputTokens: Schema.Number,
  sessionsDropped: Schema.Number,
  latencyMs: Schema.Number,
  hash: Schema.String,
  route: opt(Schema.NullOr(Schema.String)),
  flags: opt(Strings),
  graphMs: opt(Schema.Number),
  askMs: opt(Schema.Number),
  stageTimingsMs: opt(Schema.Record(Schema.String, Schema.Number)),
  sufficiencyTier: opt(Schema.NullOr(Schema.Literals([...SUFFICIENCY_TIERS]))),
  sufficiencyMissing: opt(Schema.String),
  sufficiencyPremise: opt(Schema.String),
  secondPass: opt(Schema.Boolean),
  selectorFallback: opt(Schema.Boolean),
  claimHash: opt(Schema.String),
  unionSessions: opt(Strings),
  keptSessions: opt(Strings),
  budgetDroppedSessions: opt(Strings),
  budgetDropIds: opt(Strings),
  overBudget: opt(Schema.Boolean),
  granularity: opt(Schema.Literals(["span", "turn"])),
  estimatedTokens: opt(Schema.Number),
  ablations: opt(Strings),
  recited: opt(Schema.Boolean),
  errorClass: opt(Schema.NullOr(Schema.String))
})
export type EvalRow = typeof EvalRow.Type

export const BatchRecord = Schema.Struct({
  index: Schema.Number,
  count: Schema.Number,
  population: Strings
})

export const EvalLlmCallTrace = Schema.Struct({
  kind: Schema.String,
  cacheKey: Schema.String,
  cache: Schema.Literals(["hit", "live"]),
  requestedModel: Schema.String,
  resolvedModel: Schema.NullOr(Schema.String),
  protocol: Schema.Literals(["responses", "chat-completions"]),
  promptSha256: Schema.String,
  schemaSha256: Schema.String,
  outputSha256: Schema.String
})

export const EvalEnvelope = Schema.Struct({
  system: Schema.Literals([...SYSTEM_NAMES]),
  dataset: Schema.String,
  prefix: Schema.String,
  split: opt(Schema.NullOr(Schema.Literals(["dev", "test"]))),
  profile: opt(Schema.Literals(["full", "fast"])),
  variant: opt(Strings),
  /** `cold` is a priming pass under a raised read timeout; the gate refuses it. */
  pass: opt(Schema.Literals(["cold", "warm"])),
  slice: Schema.Number,
  requestedSlice: opt(Schema.Number),
  partial: opt(Schema.Boolean),
  batch: opt(BatchRecord),
  batches: opt(Schema.Number),
  readerModel: Schema.String,
  selectModel: opt(Schema.String),
  sufficiencyModel: opt(Schema.String),
  judgeModel: Schema.String,
  extractionGeneration: opt(Schema.String),
  runtimeConfig: opt(Schema.ObjectKeyword),
  ablations: opt(Strings),
  granularity: opt(Schema.NullOr(Schema.Literals(["span", "turn"]))),
  fullCtxChars: opt(Schema.NullOr(Schema.Number)),
  /** Audit proof emitted by frozen runs; historical envelopes legitimately lack it. */
  llmTrace: opt(Schema.Array(EvalLlmCallTrace)),
  freezeManifestSha256: opt(Schema.String),
  codeIdentity: opt(Schema.String),
  lockfileSha256: opt(Schema.String),
  /** Present only on immutable rescored views; answer-bearing fields remain source-derived. */
  scoreSource: opt(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  scoringProtocol: opt(
    Schema.Struct({
      endpoint: Schema.Literal("chat-completions"),
      model: Schema.Literal("gpt-4o-2024-08-06"),
      temperature: Schema.Literal(0),
      maxTokens: Schema.Literal(10),
      n: Schema.Literal(1),
      parser: Schema.Literal("case-insensitive-yes-substring")
    })
  ),
  rows: Schema.Array(EvalRow)
})
export type EvalEnvelope = typeof EvalEnvelope.Type

/** Fields two files must agree on to describe one measurement. */
export const MEASUREMENT_FIELDS = [
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

export const envelopeVariant = (envelope: Pick<EvalEnvelope, "variant" | "ablations" | "granularity">): ReadonlyArray<string> =>
  envelope.variant ??
  variantTokens({
    profile: "full",
    ablations: envelope.ablations ?? [],
    granularity: envelope.granularity ?? null
  })

export const ablationToken = (name: string): string => name.replace(/^no/, "no-").toLowerCase()

export const variantTokens = (input: {
  readonly profile: "full" | "fast"
  readonly ablations: ReadonlyArray<string>
  readonly granularity: "span" | "turn" | null
}): ReadonlyArray<string> =>
  [
    ...(input.profile === "full" ? [] : [`profile-${input.profile}`]),
    ...input.ablations.map(ablationToken),
    ...(input.granularity === null ? [] : [`granularity-${input.granularity}`])
  ].sort()

export const resultsStem = (input: {
  readonly system: SystemName
  readonly split: "dev" | "test" | null
  readonly sliceSize: number
  readonly variant: ReadonlyArray<string>
  readonly batch?: { readonly index: number; readonly count: number } | null
}): string => {
  const population = input.split ?? String(input.sliceSize)
  const variant = input.variant.length === 0 ? "" : `-${input.variant.join("-")}`
  const batch =
    input.batch === undefined || input.batch === null
      ? ""
      : `.batch-${String(input.batch.index).padStart(2, "0")}-of-${input.batch.count}`
  return `${input.system}-${population}${variant}${batch}`
}

export const isBatchFile = (name: string): boolean => /\.batch-\d+-of-\d+\.json$/.test(name)

const assertEnvelope: (input: unknown) => asserts input is EvalEnvelope = (input) =>
  Schema.asserts(EvalEnvelope, input)

export const decodeEnvelope = (input: JsonObject): EvalEnvelope => {
  assertEnvelope(input)
  return input
}

export const readEnvelope = (path: string): EvalEnvelope => {
  try {
    return decodeEnvelope(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const writeAtomic = (path: string, text: string): void => {
  writeFileSync(`${path}.tmp`, text, "utf8")
  renameSync(`${path}.tmp`, path)
}

/** Create a result artifact exactly once. Unlike `writeAtomic`, this never replaces evidence. */
export const writeExclusive = (path: string, text: string): void => {
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" })
}

/** Write a results envelope exactly once; an existing target is a hard refusal. */
export const writeEnvelopeExclusive = (path: string, envelope: EvalEnvelope): void =>
  writeExclusive(path, `${JSON.stringify(envelope, null, 2)}\n`)

export const writeEnvelopeAtomic = (path: string, envelope: EvalEnvelope): void =>
  writeAtomic(path, `${JSON.stringify(envelope, null, 2)}
`)
