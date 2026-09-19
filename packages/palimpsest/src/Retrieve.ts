import { HydraClient, type HydraError } from "@palimpsest/hydra"
import type { Llm } from "@palimpsest/llm"
import { Context, Effect, Layer } from "effect"
import { gather } from "./Gather.js"
import {
  abstentionReason,
  determinismHash,
  emptySelection,
  planFromArms,
  selectionRow,
  type AskOptions,
  type AskResult
} from "./Plan.js"
import { applySelection, enforceSelection, select, shortId } from "./Select.js"
import { applyAsOf, orderEvidence } from "./Scoring.js"
import { Supersede } from "./Supersede.js"
import { readUserStats } from "./User.js"

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const supersede = yield* Supersede

  /** The idf denominator, memoised per uid; `forgetUser` drops it after a live ingest. */
  const claimTotals = new Map<string, number>()

  const totalClaims = (uid: string): Effect.Effect<number, HydraError> => {
    const memoised = claimTotals.get(uid)
    if (memoised !== undefined) return Effect.succeed(memoised)
    return readUserStats(hydra, uid).pipe(
      Effect.flatMap((stats) =>
        stats._tag === "Some"
          ? Effect.sync(() => {
              claimTotals.set(uid, stats.value.claims)
              return stats.value.claims
            })
          : Effect.die(
              new Error(
                `user ${uid} has no User vertex — ingest it, or run ` +
                  `\`pnpm backfill-user\` if it was ingested before the vertex existed`
              )
            )
      )
    )
  }

  const forgetUser = (uid: string): Effect.Effect<void> =>
    Effect.sync(() => {
      claimTotals.delete(uid)
    })

  /** Understand, gather the arms, plan, select, label as-of. */
  const ask = (
    uid: string,
    question: string,
    options: AskOptions = {}
  ): Effect.Effect<AskResult, HydraError, Llm> =>
    Effect.gen(function* () {
      const gathered = yield* gather(hydra, supersede, totalClaims, uid, question, options)
      const planned = planFromArms(gathered)
      const timings = () => ({
        askMs: Date.now() - gathered.askStarted,
        graphMs: gathered.graphMs,
        stages: { ...gathered.clock.stages }
      })

      if (planned.grounded.length === 0) {
        return {
          verdict: "ABSENT" as const,
          reason: abstentionReason(planned),
          evidence: [],
          receipt: planned.receipt,
          hash: determinismHash([]),
          timings: timings(),
          plan: { ...planned.plan, protectedKeys: [], selection: emptySelection }
        }
      }

      const candidates = planned.scoped.claims
      const selection =
        gathered.ablations.noSelect === true
          ? {
              ...enforceSelection(
                candidates,
                new Set(candidates.map((candidate) => shortId(candidate.ckey)))
              ),
              reasons: {},
              cached: true
            }
          : yield* gathered.clock.timed(
              "select",
              select(
                question,
                options.questionDate ?? String(gathered.questionDate),
                gathered.understood.route,
                candidates
              )
            )
      const applied = applySelection(candidates, selection)
      const evidence = orderEvidence(
        applyAsOf(applied.kept, gathered.edges, options.asOf),
        gathered.historical
      )

      return {
        verdict: "ANSWER" as const,
        reason: null,
        evidence,
        receipt: planned.receipt,
        hash: determinismHash(evidence.map((claim) => claim.ckey)),
        timings: timings(),
        plan: {
          ...planned.plan,
          protectedKeys: applied.kept
            .filter((candidate) => candidate.kind === "probe")
            .map((candidate) => candidate.ckey),
          selection: selectionRow(applied, selection.reasons)
        }
      }
    })

  return { ask, totalClaims, forgetUser } as const
})

export type Retrieve = Effect.Success<typeof make>
const RetrieveTag = Context.Service<Retrieve>("palimpsest/Retrieve")
export const Retrieve = Object.assign(RetrieveTag, { layer: Layer.effect(RetrieveTag, make) })
