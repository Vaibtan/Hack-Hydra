import { Llm } from "@palimpsest/llm"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { answerV2, type AnswerOptions, type V2Answer } from "../../src/Answer.js"
import type { AskOptions, AskResult, RetrievalPlan } from "../../src/Plan.js"
import type { HydratedSpan, ReadAnswer, Reader } from "../../src/Reader.js"
import type { Retrieve } from "../../src/Retrieve.js"
import { ABSTAIN_TIERS } from "../../src/Sufficiency.js"


const span = (over: Partial<HydratedSpan> & { id: string }): HydratedSpan => ({
  ckey: `u|c|${over.id}`,
  sid: "s1",
  sessionKey: "s1",
  turnIdx: 0,
  cs: 0,
  ce: 10,
  sessionOrd: 1,
  sessionDate: 20230101,
  tEvent: 0,
  speaker: "user",
  status: "CURRENT",
  atSession: null,
  excerpt: "I live in Osaka",
  highlight: { start: 0, end: 10 },
  ...over
})

const plan = (over: Partial<RetrievalPlan> = {}): RetrievalPlan => ({
  route: "update",
  routeReason: "model",
  flags: { wantsCount: false, hasTimeRef: false, needsDecomposition: false },
  subQuestions: [],
  probes: [],
  extraTerms: [],
  arms: [],
  union: { candidates: 1, dropped: 0 },
  timeScope: { phrase: null, interval: null, inScope: 0, outOfScope: 0, applied: false },
  selection: { kept: [], dropped: [], reasons: {}, fallback: false },
  intervalSentence: null,
  slots: {},
  protectedKeys: [],
  unionSessions: ["s1"],
  ablations: {},
  ...over
})

const ask = (over: Partial<AskResult> = {}): AskResult =>
  ({
    verdict: "ANSWER",
    reason: null,
    evidence: [],
    receipt: {} as AskResult["receipt"],
    hash: "hash",
    timings: { askMs: 1, graphMs: 1, stages: {} },
    plan: plan(),
    ...over
  }) as AskResult

const readAnswer = (over: Partial<ReadAnswer> = {}): ReadAnswer =>
  ({
    answer: "Osaka",
    notInMemory: false,
    citedIds: ["one"],
    reasoning: "",
    spans: [span({ id: "one" })],
    cached: true,
    inputTokens: 100,
    outputTokens: 5,
    hydrateMs: 1,
    readMs: 1,
    spanHash: "spanhash",
    granularity: "span",
    pack: null,
    recited: false,
    ...over
  }) as ReadAnswer

interface Judgement {
  readonly tier: "EXACT" | "INFERRABLE" | "PARTIAL"
  readonly missing?: string
  readonly missing_terms?: ReadonlyArray<string>
  readonly premise?: string
  readonly premise_contradicted_by?: ReadonlyArray<string>
}

const stubLlm = (judgements: ReadonlyArray<Judgement | "fail">, calls: Array<string>) => {
  let next = 0
  return Layer.succeed(Llm, {
    model: "stub",
    cacheDir: "",
    concurrency: 1,
    generateObject: (options: { kind: string; schema: Schema.Schema<unknown, never> }) =>
      Effect.suspend(() => {
        calls.push(options.kind)
        const judgement = judgements[next++] ?? judgements[judgements.length - 1]!
        if (judgement === "fail") return Effect.fail(new Error("provider 500"))
        return Effect.succeed({
          value: {
            tier: judgement.tier,
            missing: judgement.missing ?? "",
            missing_terms: judgement.missing_terms ?? [],
            premise: judgement.premise ?? "",
            premise_contradicted_by: judgement.premise_contradicted_by ?? []
          },
          cached: false,
          model: "stub",
          inputTokens: 0,
          outputTokens: 0
        })
      }),
    usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
    resetUsage: Effect.void
  } as unknown as Llm)
}

interface Harness {
  readonly asks: ReadonlyArray<AskResult>
  readonly reads: ReadonlyArray<ReadAnswer>
  readonly judgements: ReadonlyArray<Judgement | "fail">
  readonly options?: AnswerOptions
}

const run = async (harness: Harness) => {
  const askedWith: Array<AskOptions> = []
  const readSpans: Array<ReadonlyArray<HydratedSpan>> = []
  const llmCalls: Array<string> = []
  let askIndex = 0
  let readIndex = 0

  const retrieve = {
    ask: (_uid: string, _question: string, options: AskOptions) =>
      Effect.sync(() => {
        askedWith.push(options)
        return harness.asks[askIndex++] ?? harness.asks[harness.asks.length - 1]!
      })
  } as unknown as Retrieve

  const reader = {
    read: (
      _question: string,
      _date: string,
      _evidence: unknown,
      _options: unknown
    ) =>
      Effect.sync(() => {
        const answer = harness.reads[readIndex++] ?? harness.reads[harness.reads.length - 1]!
        readSpans.push(answer.spans)
        return answer
      })
  } as unknown as Reader

  const result = await Effect.runPromise(
    Effect.provide(
      answerV2(
        retrieve,
        reader,
        "u",
        "Where do I live?",
        "2023/05/01 (Mon) 10:00",
        harness.options ?? {}
      ) as Effect.Effect<Awaited<ReturnType<typeof Effect.runPromise>>, never, Llm>,
      stubLlm(harness.judgements, llmCalls)
    ) as Effect.Effect<never, never, never>
  )
  return { result: result as unknown as V2Answer, askedWith, readSpans, llmCalls }
}

describe("the sufficiency loop", () => {
  it("reads once and never asks the model when the ask already abstained", async () => {
    const { result, llmCalls, readSpans } = await run({
      asks: [ask({ verdict: "ABSENT", reason: "A1_no_anchors", plan: plan() })],
      reads: [readAnswer()],
      judgements: [{ tier: "EXACT" }]
    })

    expect(result.verdict).toBe("ABSENT")
    expect(result.reason).toBe("A1_no_anchors")
    expect(result.read).toBeNull()
    expect(readSpans).toEqual([])
    expect(llmCalls).toEqual([])
  })

  it("skips the check on the routes that never pay for it", async () => {
    const { result, llmCalls } = await run({
      asks: [ask({ plan: plan({ route: "fact" }) })],
      reads: [readAnswer()],
      judgements: [{ tier: "PARTIAL", missing: "the old value", missing_terms: ["osaka"] }]
    })

    expect(llmCalls).toEqual([])
    expect(result.verdict).toBe("ANSWER")
    expect(result.secondPass).toBe(false)
    expect(result.ask.plan.sufficiency.tier).toBe("skipped")
  })

  it("skips the check in the fast profile, which is what makes fast fast", async () => {
    const { llmCalls, result } = await run({
      asks: [ask()],
      reads: [readAnswer()],
      judgements: [{ tier: "PARTIAL", missing: "x", missing_terms: ["y"] }],
      options: { profile: "fast" }
    })

    expect(llmCalls).toEqual([])
    expect(result.passes).toBe(1)
  })

  it("skips the check under --no-sufficiency", async () => {
    const { llmCalls } = await run({
      asks: [ask()],
      reads: [readAnswer()],
      judgements: [{ tier: "PARTIAL", missing: "x", missing_terms: ["y"] }],
      options: { noSufficiency: true }
    })

    expect(llmCalls).toEqual([])
  })

  it("answers on EXACT without going back", async () => {
    const { result, llmCalls, askedWith } = await run({
      asks: [ask()],
      reads: [readAnswer()],
      judgements: [{ tier: "EXACT" }]
    })

    expect(llmCalls).toEqual(["sufficiency"])
    expect(askedWith).toHaveLength(1)
    expect(result.verdict).toBe("ANSWER")
    expect(result.ask.plan.sufficiency.tier).toBe("EXACT")
  })

  it("treats INFERRABLE as a complete answer, not a warning", async () => {
    const { result, askedWith } = await run({
      asks: [ask()],
      reads: [readAnswer()],
      judgements: [{ tier: "INFERRABLE" }]
    })

    expect(result.verdict).toBe("ANSWER")
    expect(result.secondPass).toBe(false)
    expect(askedWith).toHaveLength(1)
  })

  it("does not go back on PARTIAL with nothing to search for", async () => {
    const { result, askedWith } = await run({
      asks: [ask()],
      reads: [readAnswer()],
      judgements: [{ tier: "PARTIAL", missing: "the old value", missing_terms: [] }]
    })

    expect(askedWith).toHaveLength(1)
    expect(result.verdict).toBe("ANSWER")
    expect(result.secondPass).toBe(false)
  })
})

describe("the second pass runs at most once", () => {
  it("widens the same arms with the terms the check named", async () => {
    const { askedWith, result } = await run({
      asks: [ask(), ask()],
      reads: [readAnswer(), readAnswer()],
      judgements: [
        { tier: "PARTIAL", missing: "the old value", missing_terms: ["Kyoto", "moved"] },
        { tier: "EXACT" }
      ]
    })

    expect(askedWith).toHaveLength(2)
    expect(askedWith[0]!.extraTerms).toBeUndefined()
    expect(askedWith[1]!.extraTerms).toEqual(["kyoto", "mov"])
    expect(result.secondPass).toBe(true)
    expect(result.passes).toBe(2)
  })

  it("stops at two passes even when the second is still PARTIAL", async () => {
    const { askedWith, llmCalls, result } = await run({
      asks: [ask(), ask()],
      reads: [readAnswer(), readAnswer()],
      judgements: [
        { tier: "PARTIAL", missing: "one more item", missing_terms: ["socks"] },
        { tier: "PARTIAL", missing: "one more item", missing_terms: ["socks"] }
      ]
    })

    expect(askedWith).toHaveLength(2)
    expect(llmCalls).toEqual(["sufficiency", "sufficiency"])
    expect(result.verdict).toBe(ABSTAIN_TIERS.includes("PARTIAL") ? "ABSENT" : "ANSWER")
    expect(result.reason).toBe(
      ABSTAIN_TIERS.includes("PARTIAL") ? "INSUFFICIENT_EVIDENCE" : null
    )
  })

  it("still widens on PARTIAL even though it no longer refuses", async () => {
    const { askedWith, result } = await run({
      asks: [ask(), ask()],
      reads: [readAnswer(), readAnswer({ answer: "Osaka, previously Kyoto" })],
      judgements: [
        { tier: "PARTIAL", missing: "the old value", missing_terms: ["kyoto"] },
        { tier: "PARTIAL", missing: "the old value", missing_terms: ["kyoto"] }
      ]
    })

    expect(askedWith).toHaveLength(2)
    expect(askedWith[1]!.extraTerms).toEqual(["kyoto"])
    expect(result.secondPass).toBe(true)
  })

  it("answers when the second pass found what the first was missing", async () => {
    const { result } = await run({
      asks: [ask(), ask()],
      reads: [readAnswer(), readAnswer({ answer: "Osaka, previously Kyoto" })],
      judgements: [
        { tier: "PARTIAL", missing: "the old value", missing_terms: ["kyoto"] },
        { tier: "EXACT" }
      ]
    })

    expect(result.verdict).toBe("ANSWER")
    expect(result.read?.answer).toBe("Osaka, previously Kyoto")
    expect(result.ask.plan.sufficiency).toMatchObject({ tier: "EXACT", secondPass: true })
  })
})

describe("the three guards, each against the failure it was written for", () => {
  it("a provider error is skipped, never PARTIAL", async () => {
    const { result, askedWith } = await run({
      asks: [ask()],
      reads: [readAnswer()],
      judgements: ["fail"]
    })

    expect(result.verdict).toBe("ANSWER")
    expect(result.sufficiency.skipped).toBe(true)
    expect(askedWith).toHaveLength(1)
  })

  it("a second pass that abstains keeps the first pass's answer", async () => {
    const { result } = await run({
      asks: [ask(), ask({ verdict: "ABSENT", reason: "A2_no_convergence" })],
      reads: [readAnswer({ answer: "Osaka" })],
      judgements: [{ tier: "PARTIAL", missing: "the old value", missing_terms: ["kyoto"] }]
    })

    expect(result.verdict).toBe("ANSWER")
    expect(result.read?.answer).toBe("Osaka")
    expect(result.secondPass).toBe(true)
    expect(result.passes).toBe(2)
  })

  it("a premise named without a CURRENT citation in the pack is not a contradiction", async () => {
    const { result, askedWith } = await run({
      asks: [ask()],
      reads: [readAnswer({ spans: [span({ id: "one" })] })],
      judgements: [
        { tier: "EXACT", premise: "they own a dog", premise_contradicted_by: ["not-in-pack"] }
      ]
    })

    expect(result.verdict).toBe("ANSWER")
    expect(askedWith).toHaveLength(1)
  })

  it("a premise cited only to a SUPERSEDED excerpt is not a contradiction", async () => {
    const { result } = await run({
      asks: [ask()],
      reads: [readAnswer({ spans: [span({ id: "one", status: "SUPERSEDED" })] })],
      judgements: [{ tier: "EXACT", premise: "they own a dog", premise_contradicted_by: ["one"] }]
    })

    expect(result.verdict).toBe("ANSWER")
  })

  it("a premise cited to a CURRENT excerpt abstains without a second pass", async () => {
    const { result, askedWith } = await run({
      asks: [ask(), ask()],
      reads: [readAnswer()],
      judgements: [
        {
          tier: "PARTIAL",
          missing: "the purchase",
          missing_terms: ["dog"],
          premise: "they own a dog",
          premise_contradicted_by: ["one"]
        }
      ]
    })

    expect(result.verdict).toBe("ABSENT")
    expect(result.reason).toBe("CONTRADICTED_PREMISE")
    expect(result.secondPass).toBe(false)
    expect(askedWith).toHaveLength(1)
    expect(result.read).not.toBeNull()
  })

  it("records on the plan only the cited ids that are in the pack and CURRENT", async () => {
    const { result } = await run({
      asks: [ask()],
      reads: [
        readAnswer({
          spans: [span({ id: "old", status: "SUPERSEDED", atSession: 2 }), span({ id: "now" })]
        })
      ],
      judgements: [
        { tier: "EXACT", premise: "they own a dog", premise_contradicted_by: ["old", "now", "ghost"] }
      ]
    })

    expect(result.verdict).toBe("ABSENT")
    expect(result.reason).toBe("CONTRADICTED_PREMISE")
    expect(result.ask.plan.sufficiency.premiseContradictedBy).toEqual(["now"])
    expect(result.sufficiency.premiseCitedIds).toEqual(["old", "now", "ghost"])
  })

  it("never lets an id outside the pack reach the plan", async () => {
    const { result } = await run({
      asks: [ask()],
      reads: [readAnswer({ spans: [span({ id: "one" })] })],
      judgements: [{ tier: "EXACT", premise: "they own a dog", premise_contradicted_by: ["ghost"] }]
    })

    expect(result.verdict).toBe("ANSWER")
    expect(result.ask.plan.sufficiency.premise).toBe("they own a dog")
    expect(result.ask.plan.sufficiency.premiseContradictedBy).toEqual([])
  })
})

describe("the plan carries the sufficiency verdict, on every path", () => {
  it("distinguishes a check that said EXACT from one that did not run", async () => {
    const ran = await run({
      asks: [ask()],
      reads: [readAnswer()],
      judgements: [{ tier: "EXACT" }]
    })
    const notRun = await run({
      asks: [ask({ plan: plan({ route: "fact" }) })],
      reads: [readAnswer()],
      judgements: [{ tier: "EXACT" }]
    })

    expect(ran.result.ask.plan.sufficiency.tier).toBe("EXACT")
    expect(notRun.result.ask.plan.sufficiency.tier).toBe("skipped")
  })

  it("records the missing text and the premise the check named", async () => {
    const { result } = await run({
      asks: [ask(), ask()],
      reads: [readAnswer(), readAnswer()],
      judgements: [
        { tier: "PARTIAL", missing: "the third item", missing_terms: ["socks"] },
        { tier: "PARTIAL", missing: "the third item", missing_terms: ["socks"] }
      ]
    })

    expect(result.ask.plan.sufficiency).toMatchObject({
      tier: "PARTIAL",
      missing: "the third item",
      secondPass: true
    })
  })
})
