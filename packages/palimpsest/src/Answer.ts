import type { LanguageModel } from "@effect/ai"
import type { HydraError } from "@palimpsest/hydra"
import type { Llm } from "@palimpsest/llm"
import { Effect } from "effect"
import type { Granularity, ReadAnswer, Reader } from "./Reader.js"
import type { AskOptions, AskResult, PlanSufficiency, Retrieve } from "./Retrieve.js"
import type { AbstentionReason } from "./Scoring.js"
import {
  abstains,
  judgeSufficiency,
  premiseContradiction,
  runsOn,
  skipped,
  type SufficiencyReport
} from "./Sufficiency.js"

/**
 * The whole v2 path, in one call: retrieve, pack, check, maybe go back once,
 * read.
 *
 * A function and not a service, deliberately. Every caller already holds both
 * `Retrieve` and `Reader` — the eval, the CLI, the demo server — and adding a
 * third service to their layers would buy nothing over passing the two they
 * have. What it does buy is that the *loop* lives in one place: the eval and
 * the demo must not be able to drift into running different pipelines, because
 * the numbers in the writeup come from one of them and the video from the
 * other.
 *
 * v1 does not come through here. It is `retrieve.ask` then `reader.read`, as it
 * has always been, and that is what keeps its evidence byte-identical while
 * both pipelines read one graph.
 */

export interface V2Answer {
  readonly ask: AskResult
  /** The final read. Absent when the verdict was `ABSENT` before reading. */
  readonly read: ReadAnswer | null
  readonly verdict: "ANSWER" | "ABSENT"
  readonly reason: AbstentionReason | null
  readonly sufficiency: SufficiencyReport
  /** The refined pass ran. At most once, by construction. */
  readonly secondPass: boolean
  /** The ask that produced the evidence actually read — the second, if there was one. */
  readonly passes: number
}

export interface AnswerOptions extends AskOptions {
  readonly premiseCheck?: boolean
  /** Forces one granularity for every route, for the `span|turn` ablation. */
  readonly granularity?: Granularity
  /** Skips the sufficiency stage entirely, for the `--no-sufficiency` ablation. */
  readonly noSufficiency?: boolean
  /**
   * Drops the route-specific rules block from the reader prompt, for the
   * `--reader-route=off` ablation. The reader then sees v1's single prompt,
   * byte for byte, on v2's evidence — which is the comparison that isolates
   * the rules from everything else v2 changed.
   */
  readonly noReaderRoute?: boolean
}

/**
 * Writes the sufficiency verdict back onto the ask's plan.
 *
 * #29's receipt box asks for `plan.sufficiency`, and the plan comes out of
 * `Retrieve.ask` before the pack the check judges exists. Rather than leave the
 * field to whichever caller happens to hold both halves — the eval, the HTTP
 * projection and the CLI each held a different subset, and the HTTP projection
 * was the only one that assembled it — `answerV2` returns an `AskResult` whose
 * plan is already complete. Every consumer then reads one shape.
 *
 * A v1 ask has no plan and gets none.
 */
const withSufficiency = (
  ask: AskResult,
  report: SufficiencyReport,
  secondPass: boolean
): AskResult => {
  if (ask.plan === null) return ask
  const sufficiency: PlanSufficiency = {
    // `skipped` is a value the tier enum does not have, and the distinction
    // matters to a reader of a receipt: `skipped()` reports `EXACT`, which
    // would otherwise read as "the check ran and was satisfied".
    tier: report.skipped ? "skipped" : report.tier,
    missing: report.missing,
    premise: report.premise,
    premiseContradictedBy: report.premiseContradictedBy,
    secondPass
  }
  return { ...ask, plan: { ...ask.plan, sufficiency } }
}

/**
 * Turns an ask into the reader's pack options.
 *
 * Only ever called with a plan, because only v2 has one — the option is what
 * switches the pack stage on, and v1 must never pass it.
 */
const packOptions = (ask: AskResult, granularity?: Granularity) => {
  const plan = ask.plan
  if (plan === null) return undefined
  return {
    route: plan.route,
    ...(granularity === undefined ? {} : { granularity }),
    slotOf: new Map(Object.entries(plan.slots)),
    protectedKeys: new Set(plan.protectedKeys)
  }
}

export const answerV2 = (
  retrieve: Retrieve,
  reader: Reader,
  uid: string,
  question: string,
  questionDate: string,
  options: AnswerOptions = {}
): Effect.Effect<V2Answer, HydraError, LanguageModel.LanguageModel | Llm> =>
  Effect.gen(function* () {
    const profile = options.profile ?? "full"
    const askOptions = { ...options, questionDate, pipeline: "v2" as const }

    const first = yield* retrieve.ask(uid, question, askOptions)
    if (first.verdict === "ABSENT") {
      return {
        ask: withSufficiency(first, skipped(), false),
        read: null,
        verdict: "ABSENT" as const,
        reason: first.reason,
        sufficiency: skipped(),
        secondPass: false,
        passes: 1
      }
    }

    const readOptions = {
      ...(options.premiseCheck === true ? { premiseCheck: true } : {}),
      ...(options.noReaderRoute === true ? {} : { route: first.plan?.route ?? null }),
      ...(() => {
        const pack = packOptions(first, options.granularity)
        return pack === undefined ? {} : { pack }
      })()
    }

    // The check reads the *packed* excerpts, which is why it cannot live inside
    // `ask`: the pack is what the reader will see, and judging sufficiency from
    // the claim index text instead would be judging a summary of the evidence
    // rather than the evidence.
    const firstRead = yield* reader.read(question, questionDate, first.evidence, readOptions)
    const route = first.plan?.route ?? "fact"

    if (options.noSufficiency === true || !runsOn(route, firstRead.spans, profile)) {
      return {
        ask: withSufficiency(first, skipped(), false),
        read: firstRead,
        verdict: "ANSWER" as const,
        reason: null,
        sufficiency: skipped(),
        secondPass: false,
        passes: 1
      }
    }

    const judged = yield* judgeSufficiency(question, questionDate, route, firstRead.spans)

    // A contradicted premise short-circuits: there is nothing a second pass can
    // find that would make a false presupposition true, and reading on would
    // produce a confident answer to a question that should not have one.
    const contradiction = premiseContradiction(judged, firstRead.spans)
    if (contradiction !== null) {
      return {
        ask: withSufficiency(first, judged, false),
        read: firstRead,
        verdict: "ABSENT" as const,
        reason: "CONTRADICTED_PREMISE" as const,
        sufficiency: judged,
        secondPass: false,
        passes: 1
      }
    }

    if (judged.tier !== "PARTIAL" || judged.missingTerms.length === 0) {
      return {
        ask: withSufficiency(first, judged, false),
        read: firstRead,
        verdict: "ANSWER" as const,
        reason: null,
        sufficiency: judged,
        secondPass: false,
        passes: 1
      }
    }

    // ---- exactly one refined pass ------------------------------------------
    // The same arms, widened by the terms the check named. Not a loop: a second
    // PARTIAL is information ("this memory does not contain it"), a third would
    // be a budget, and every extra pass is another graph read and two more LLM
    // calls on a question that is already the expensive kind.
    const second = yield* retrieve.ask(uid, question, {
      ...askOptions,
      extraTerms: judged.missingTerms
    })
    if (second.verdict === "ABSENT") {
      // The wider search abstained where the narrower one did not, which can
      // only mean the widening changed the candidate set out from under the
      // verdict. Keep the first pass's answer: a second pass exists to add
      // evidence, never to take an answer away.
      return {
        ask: withSufficiency(first, judged, true),
        read: firstRead,
        verdict: "ANSWER" as const,
        reason: null,
        sufficiency: judged,
        secondPass: true,
        passes: 2
      }
    }

    const secondRead = yield* reader.read(question, questionDate, second.evidence, {
      ...readOptions,
      ...(() => {
        const pack = packOptions(second, options.granularity)
        return pack === undefined ? {} : { pack }
      })()
    })
    const rejudged = yield* judgeSufficiency(question, questionDate, route, secondRead.spans)

    const stillContradicted = premiseContradiction(rejudged, secondRead.spans)
    if (stillContradicted !== null) {
      return {
        ask: withSufficiency(second, rejudged, true),
        read: secondRead,
        verdict: "ABSENT" as const,
        reason: "CONTRADICTED_PREMISE" as const,
        sufficiency: rejudged,
        secondPass: true,
        passes: 2
      }
    }

    return {
      ask: withSufficiency(second, rejudged, true),
      read: secondRead,
      verdict: abstains(rejudged) ? ("ABSENT" as const) : ("ANSWER" as const),
      reason: abstains(rejudged) ? ("INSUFFICIENT_EVIDENCE" as const) : null,
      sufficiency: rejudged,
      secondPass: true,
      passes: 2
    }
  })
