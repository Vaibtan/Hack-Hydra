import { describe, expect, it } from "vitest"
import {
  MAX_PROBES,
  MAX_SUB_QUESTIONS,
  anchorStems,
  applyRouteCues,
  shapeUnderstanding,
  type Route
} from "../../src/Understand.js"

/**
 * The route is a reader prompt and a hydration granularity, and getting it
 * wrong is silent — the answer comes back plausible and short. So the cues that
 * override the model are a table here rather than something an eval run
 * discovers.
 */
const QUESTION_DATE = 20230520

const model = (over: Partial<Parameters<typeof shapeUnderstanding>[2]> = {}) => ({
  anchor_terms: [],
  historical: false,
  wants_count: false,
  time_ref: null,
  route: "fact" as Route,
  sub_questions: [],
  probes: [],
  ...over
})

const shape = (question: string, over: Partial<Parameters<typeof shapeUnderstanding>[2]> = {}) =>
  shapeUnderstanding(question, QUESTION_DATE, model(over), true)

describe("deterministic route cues", () => {
  it("calls a how-many question a count whatever the model said", () => {
    expect(applyRouteCues("How many items do I need to pick up?", "preference", null)).toEqual({
      route: "count",
      reason: "cue:how_many"
    })
    // And only "how many". The cue was widened to `how much|how often|how
    // numerous` at some point, and the first v2 dev run showed what that cost:
    // 21 of 36 questions on the count route, 9 of them multi-session and 4
    // temporal-reasoning. "How much did I pay" is a fact and "how often do I
    // go" is a frequency; neither is a list to enumerate, which is what the
    // count route's reader rule asks for.
    expect(applyRouteCues("How much did I pay?", "fact", null).route).toBe("fact")
    expect(applyRouteCues("How often do I go to the gym?", "fact", null).route).toBe("fact")
    expect(applyRouteCues("How numerous are my plants?", "fact", null).reason).toBe("model")
  })

  it("does not turn a date-arithmetic question into an enumeration", () => {
    // "How many years older is my grandma than me" says "how many" and is
    // subtraction, not a list -- and it is the two-fact comparison question
    // #27 exists for. A model that has already called a question temporal has
    // resolved something a regex cannot, so the cue defers to it.
    expect(
      applyRouteCues("How many years older is my grandma than me?", "temporal", null)
    ).toEqual({ route: "temporal", reason: "model" })
    // The cue still fires over every other route, including on a question that
    // happens to mention time.
    expect(
      applyRouteCues("How many items do I need to pick up this week?", "multi_fact", "this week")
        .route
    ).toBe("count")
  })

  it("calls a did-I-with question temporal only when it also carries a time phrase", () => {
    expect(applyRouteCues("Did I go to the museum with Sam?", "fact", "two months ago")).toEqual({
      route: "temporal",
      reason: "cue:did_i_with_time"
    })
    expect(applyRouteCues("Did I go to the museum with Sam?", "fact", null).reason).toBe("model")
  })

  it("calls a currently-plus-attribute question an update", () => {
    expect(applyRouteCues("Where do I currently live?", "fact", null)).toEqual({
      route: "update",
      reason: "cue:currently"
    })
    // It also fires when the model called it a fact and the question does not
    // use a vocabulary word: "live" is `residence`, and resolving that is the
    // model's job, not a regex's.
    expect(applyRouteCues("What is my current employer?", "preference", null).route).toBe("update")
    // But not on a route that is not about a value.
    expect(applyRouteCues("What should I still try?", "preference", null).reason).toBe("model")
  })

  it("leaves the model's route alone when no cue fires", () => {
    expect(applyRouteCues("What beer should I try?", "preference", null)).toEqual({
      route: "preference",
      reason: "model"
    })
  })

  it("prefers count over the other cues when a question triggers both", () => {
    expect(
      applyRouteCues("How many times did I go with Sam?", "fact", "last month").route
    ).toBe("count")
  })
})

describe("flags", () => {
  it("are independent of the route", () => {
    const understood = shape("How many museums did I visit two months ago?", {
      route: "preference",
      time_ref: "two months ago",
      sub_questions: [{ question: "Which museums did I visit?", anchor_terms: ["museum"] }]
    })
    expect(understood.route).toBe("count")
    expect(understood.flags).toEqual({
      wantsCount: true,
      hasTimeRef: true,
      needsDecomposition: true
    })
  })

  it("take the cue as evidence of a count even when the model said otherwise", () => {
    expect(shape("How many pets do I have?", { wants_count: false }).flags.wantsCount).toBe(true)
  })

  it("do not see a time reference in an empty phrase", () => {
    expect(shape("Where do I live?", { time_ref: "  " }).flags.hasTimeRef).toBe(false)
  })
})

describe("the interval", () => {
  it("is resolved in code from the phrase the model copied out", () => {
    const understood = shape("Which museum did I visit two months ago?", {
      time_ref: "two months ago"
    })
    expect(understood.timeRef).toBe("two months ago")
    expect(understood.timeInterval).toMatchObject({ start: 20230301, end: 20230401 })
  })

  it("is null when the phrase is not one of the supported forms", () => {
    const understood = shape("What did I say a while back?", { time_ref: "a while back" })
    expect(understood.flags.hasTimeRef).toBe(true)
    expect(understood.timeInterval).toBeNull()
  })
})

describe("sub-questions and probes", () => {
  it("carry their own stems so no second round trip is needed", () => {
    const understood = shape("How much older is my grandma than me?", {
      sub_questions: [
        { question: "How old is my grandma?", anchor_terms: ["age", "birthday"] },
        { question: "How old am I?", anchor_terms: ["age"] }
      ]
    })
    expect(understood.subQuestions).toHaveLength(2)
    expect(understood.subQuestions[0]!.terms).toContain("grandma")
    expect(understood.subQuestions[0]!.terms).toContain("birthday")
    // Sorted and de-duplicated, exactly as the primary anchors are.
    expect([...understood.subQuestions[0]!.terms]).toEqual(
      [...understood.subQuestions[0]!.terms].sort()
    )
  })

  it("are capped, and empty entries dropped", () => {
    const understood = shape("q", {
      sub_questions: Array.from({ length: 9 }, (_, i) => ({
        question: i === 0 ? "  " : `sub ${i}`,
        anchor_terms: []
      })),
      probes: Array.from({ length: 9 }, (_, i) => ({ entity_canon: `e${i}`, attr: "age" }))
    })
    expect(understood.subQuestions).toHaveLength(MAX_SUB_QUESTIONS)
    expect(understood.subQuestions.every((sub) => sub.question.trim() !== "")).toBe(true)
    expect(understood.probes).toHaveLength(MAX_PROBES)
  })

  it("normalise a probe to the case and spacing a Slot key uses", () => {
    const understood = shape("q", { probes: [{ entity_canon: "  Grandma ", attr: " AGE " }] })
    expect(understood.probes[0]).toEqual({ entityCanon: "grandma", attr: "age" })
  })

  it("leave needsDecomposition false when the question needs one fact", () => {
    expect(shape("What is my hamster called?").flags.needsDecomposition).toBe(false)
  })
})

describe("anchor stems", () => {
  it("always include the question's own words, so a useless expansion cannot break retrieval", () => {
    const terms = anchorStems("What is my hamster called?", [])
    expect(terms).toContain("hamster")
  })

  it("merge the expansion in, de-duplicated and sorted", () => {
    const terms = anchorStems("What is my hamster called?", ["hamster", "pet", "rodent"])
    expect(terms).toContain("pet")
    expect(terms).toContain("rodent")
    expect(new Set(terms).size).toBe(terms.length)
    expect([...terms]).toEqual([...terms].sort())
  })

  it("answers a one-word question rather than producing nothing", () => {
    // "Nibbles?" must still reach its claims — routing may not make a simple
    // question worse.
    expect(anchorStems("Nibbles?", []).length).toBeGreaterThan(0)
  })
})
