import type { LanguageModel } from "@effect/ai"
import { HydraClient, HydraLimitError, type HydraError } from "@palimpsest/hydra"
import { Llm, readPathModels, type ReadPathModels } from "@palimpsest/llm"
import { Duration, Effect, Fiber } from "effect"
import {
  convergenceArm,
  discoveryArm,
  discoverySeeds,
  emptyArm,
  probeArm,
  probeLabel,
  slotMateArm,
  subQuestionArm,
  unionArms,
  type ArmKind,
  type LiveArm,
  type SlotMateArm,
  type StageGuard
} from "./Arms.js"
import { questionDateInt, unionOptionsFor, type Ablations, type AskOptions, type AskProfile } from "./Plan.js"
import { DEFAULT_TOP_K } from "./Scoring.js"
import type { Supersede } from "./Supersede.js"
import { understand, type Understood } from "./Understand.js"

/** The ceiling on any single HydraDB read an ask makes; below the engine's own 30 s cap so it protects the ask, not the node. */
export const DEFAULT_READ_TIMEOUT_MS = 25_000

/** Read per call: `loadDotEnv()` runs after this module is evaluated. */
export const readTimeoutMs = (): number => {
  const configured = Number(process.env["PALIMPSEST_READ_TIMEOUT_MS"])
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_READ_TIMEOUT_MS
}

export const withReadTimeout = <A>(
  stage: string,
  effect: Effect.Effect<A, HydraError>
): Effect.Effect<A, HydraError> =>
  Effect.suspend(() => {
    const ceiling = readTimeoutMs()
    return Effect.timeoutFail(effect, {
      duration: Duration.millis(ceiling),
      onTimeout: () =>
        new HydraLimitError({
          reason: `retrieval stage ${stage} exceeded ${ceiling} ms`,
          status: 408,
          query: `<ask:${stage}>`
        })
    })
  })

export interface Stopwatch {
  readonly stages: Record<string, number>
  readonly timed: <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const stopwatch = (): Stopwatch => {
  const stages: Record<string, number> = {}
  return {
    stages,
    timed: (stage, effect) =>
      Effect.suspend(() => {
        const started = Date.now()
        return Effect.onExit(effect, () =>
          Effect.sync(() => {
            stages[stage] = Date.now() - started
          })
        )
      })
  }
}

export interface Gathered {
  readonly uid: string
  readonly question: string
  readonly understood: Understood
  /** The convergence arm's sources: the understood terms widened by `extraTerms`. */
  readonly terms: ReadonlyArray<string>
  readonly extraTerms: ReadonlyArray<string>
  readonly total: number
  readonly historical: boolean
  readonly profile: AskProfile
  readonly maxLen: number
  readonly topK: number
  readonly questionDate: number
  readonly asOf: number | undefined
  readonly ablations: Ablations
  readonly models: ReadPathModels
  /** Convergence first, then the sub-question and probe arms. */
  readonly reaching: ReadonlyArray<LiveArm>
  readonly discovery: LiveArm
  readonly slotMate: SlotMateArm
  readonly edges: ReadonlyMap<string, { readonly newer: string; readonly atSession: number }>
  readonly graphMs: number
  readonly askStarted: number
  readonly clock: Stopwatch
}

export const gather = (
  hydra: HydraClient,
  supersede: Supersede,
  totalClaims: (uid: string) => Effect.Effect<number, HydraError>,
  uid: string,
  question: string,
  options: AskOptions
): Effect.Effect<Gathered, HydraError, LanguageModel.LanguageModel | Llm> =>
  Effect.gen(function* () {
    const askStarted = Date.now()
    const models = readPathModels((yield* Llm).model)
    const clock = stopwatch()
    const { timed } = clock

    const profile = options.profile ?? "full"
    const maxLen = options.maxLen ?? 2
    const topK = options.topK ?? DEFAULT_TOP_K
    const questionDate = questionDateInt(options.questionDate)

    const statsFiber = yield* Effect.fork(timed("userStats", totalClaims(uid)))
    const understood = yield* timed(
      "understand",
      understand(question, questionDate, options.questionDate)
    )
    const graphStarted = Date.now()
    const total = yield* Fiber.join(statsFiber)

    const historical = options.historical ?? understood.historical
    const ablations = options.ablations ?? {}
    const extraTerms = options.extraTerms ?? []
    const terms =
      extraTerms.length === 0
        ? understood.terms
        : [...new Set([...understood.terms, ...extraTerms])].sort()
    const subQuestions = ablations.noDecompose === true ? [] : understood.subQuestions
    const unionOptions = unionOptionsFor(options.asOf)

    const guard: StageGuard = (stage, effect) => timed(stage, withReadTimeout(stage, effect))
    const runArm = (
      label: string,
      kind: ArmKind,
      effect: Effect.Effect<LiveArm, HydraError>,
      optional: boolean
    ): Effect.Effect<LiveArm, HydraError> =>
      optional
        ? Effect.catchTag(guard(label, effect), "HydraLimitError", () =>
            Effect.succeed(emptyArm(kind, label, true))
          )
        : guard(label, effect)

    const reaching = yield* Effect.all(
      [
        runArm("convergence", "convergence", convergenceArm(hydra, uid, terms, total, maxLen), false),
        ...subQuestions.map((sub, index) =>
          runArm(`sub:${index}`, "subQuestion", subQuestionArm(hydra, uid, sub, index, total, maxLen), true)
        ),
        ...understood.probes.map((probe) =>
          runArm(probeLabel(probe), "probe", probeArm(hydra, uid, probe, total), true)
        )
      ],
      { concurrency: 4 }
    )

    const convergence = reaching[0]!
    const firstPass = unionArms(reaching, unionOptions)
    const seeds =
      ablations.noDiscovery === true
        ? []
        : discoverySeeds(convergence.rawPaths, firstPass.candidates.slice(0, 10), new Set(terms))
    const discovery = yield* runArm(
      "discovery",
      "discovery",
      discoveryArm(hydra, uid, seeds, total, maxLen),
      true
    )

    const secondPass = unionArms([...reaching, discovery], unionOptions)
    const slotMate = yield* slotMateArm(
      hydra,
      uid,
      secondPass.candidates.slice(0, topK),
      new Set(secondPass.candidates.map((candidate) => candidate.ckey)),
      total,
      guard
    )

    const union = unionArms([...reaching, discovery, slotMate], unionOptions)
    const edges = yield* guard(
      "edges",
      supersede.readEdges(
        uid,
        union.candidates.map((candidate) => candidate.ckey),
        options.asOf
      )
    )
    const graphMs = Date.now() - graphStarted

    return {
      uid,
      question,
      understood,
      terms,
      extraTerms,
      total,
      historical,
      profile,
      maxLen,
      topK,
      questionDate,
      asOf: options.asOf,
      ablations,
      models,
      reaching,
      discovery,
      slotMate,
      edges,
      graphMs,
      askStarted,
      clock
    }
  })
