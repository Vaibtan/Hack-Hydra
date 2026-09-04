import type { LanguageModel } from "@effect/ai"
import type { DatasetQuestion } from "@palimpsest/dataset"
import type { Llm } from "@palimpsest/llm"
import { answerV2, determinismHash, type HydratedSpan, type Reader, type Retrieve } from "@palimpsest/palimpsest"
import { Effect } from "effect"
import { buildIndex, fullContextSpans, topSpans } from "./Bm25.js"
import { ablationNames, type AblationFlags } from "./Cli.js"
import type { SystemName } from "./Envelope.js"
import { oracleSessionSpans } from "./Oracle.js"
import type { BaselineOutcome, SystemOutcome } from "./Row.js"

export interface V2Options {
  readonly profile: "full" | "fast"
  readonly ablations: AblationFlags
  readonly granularity: "span" | "turn" | null
}

export interface SystemDeps {
  readonly retrieve: Retrieve
  readonly reader: Reader
  readonly uid: string
  readonly v2: V2Options
  readonly fullCtxChars: number
}

export type SystemRun = Effect.Effect<SystemOutcome, unknown, LanguageModel.LanguageModel | Llm>

export interface SystemSpec {
  readonly needsGraph: boolean
  readonly run: (question: DatasetQuestion, deps: SystemDeps) => SystemRun
}

const readBaseline = (
  deps: SystemDeps,
  question: DatasetQuestion,
  spans: ReadonlyArray<HydratedSpan>,
  sessionsDropped: number
): Effect.Effect<BaselineOutcome, never, LanguageModel.LanguageModel | Llm> =>
  deps.reader
    .readSpans(question.question, question.questionDate.raw, spans)
    .pipe(
      Effect.map((read) => ({
        kind: "baseline" as const,
        spans,
        sessionsDropped,
        hash: determinismHash(spans.map((span) => span.ckey)),
        read
      }))
    )

const runV2: SystemSpec["run"] = (question, deps) => {
  const { noSufficiency, noReaderRoute, ...ablations } = deps.v2.ablations
  return answerV2(deps.retrieve, deps.reader, deps.uid, question.question, question.questionDate.raw, {
    profile: deps.v2.profile,
    ablations,
    ...(noSufficiency === true ? { noSufficiency: true } : {}),
    ...(noReaderRoute === true ? { noReaderRoute: true } : {}),
    ...(deps.v2.granularity === null ? {} : { granularity: deps.v2.granularity })
  }).pipe(
    Effect.map((answered) => ({
      kind: "v2" as const,
      answered,
      ablations: ablationNames(deps.v2.ablations)
    }))
  )
}

const retired: SystemSpec = {
  needsGraph: true,
  run: () => Effect.die("v1 was removed; run it from the pre-cleanup-v1 tag")
}

export const SYSTEMS: Readonly<Record<SystemName, SystemSpec>> = {
  "palimpsest-v2": { needsGraph: true, run: runV2 },
  bm25: {
    needsGraph: false,
    run: (question, deps) => readBaseline(deps, question, topSpans(question, buildIndex(question)), 0)
  },
  "oracle-session": {
    needsGraph: false,
    run: (question, deps) => readBaseline(deps, question, oracleSessionSpans(question), 0)
  },
  fullctx: {
    needsGraph: false,
    run: (question, deps) => {
      const full = fullContextSpans(question, deps.fullCtxChars)
      return readBaseline(deps, question, full.spans, full.sessionsDropped)
    }
  },
  palimpsest: retired,
  "palimpsest-premise": retired
}

export const RETIRED_SYSTEMS: ReadonlyArray<SystemName> = ["palimpsest", "palimpsest-premise"]

export const LIVE_SYSTEMS: ReadonlyArray<SystemName> = ["palimpsest-v2", "oracle-session", "bm25", "fullctx"]
