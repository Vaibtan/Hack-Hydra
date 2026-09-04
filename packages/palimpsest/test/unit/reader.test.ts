import { describe, expect, it } from "vitest"
import type { PackLabel } from "../../src/Pack.js"
import { cutExcerpt, renderReaderPrompt, systemFor, type HydratedSpan } from "../../src/Reader.js"
import { RoutePolicy, granularityFor } from "../../src/Routes.js"
import { ROUTES } from "../../src/Understand.js"

const TURN =
  "Zero one two three four five six seven eight nine. " +
  "The user was pre-approved for a $350,000 loan from Wells Fargo. " +
  "Then some more text follows here to give the cut something to work with."

const SPAN = "pre-approved for a $350,000 loan"
const CS = TURN.indexOf(SPAN)
const CE = CS + SPAN.length

describe("cutExcerpt", () => {
  it("returns the span with context on both sides, and points at it", () => {
    const cut = cutExcerpt(TURN, CS, CE, 20)
    expect(cut.excerpt.slice(cut.highlight.start, cut.highlight.end)).toBe(SPAN)
    expect(TURN).toContain(cut.excerpt)
    expect(cut.excerpt.length).toBe(SPAN.length + 40)
  })

  it("clamps at the start of the turn instead of producing a negative offset", () => {
    const cut = cutExcerpt(TURN, 0, 4, 300)
    expect(cut.highlight.start).toBe(0)
    expect(cut.excerpt.slice(cut.highlight.start, cut.highlight.end)).toBe("Zero")
  })

  it("clamps at the end of the turn instead of running past it", () => {
    const cut = cutExcerpt(TURN, TURN.length - 5, TURN.length, 300)
    expect(cut.highlight.end).toBeLessThanOrEqual(cut.excerpt.length)
    expect(cut.excerpt.slice(cut.highlight.start, cut.highlight.end)).toBe(TURN.slice(-5))
  })

  it("gives the whole turn when the context window covers it", () => {
    expect(cutExcerpt(TURN, CS, CE, 10_000).excerpt).toBe(TURN)
  })

  it("survives a span that points past the end of the text", () => {
    const cut = cutExcerpt("short", 3, 900, 10)
    expect(cut.excerpt).toBe("short")
    expect(cut.highlight.start).toBe(3)
    expect(cut.highlight.end).toBe(5)
  })

  it("never returns a highlight outside the excerpt it returned", () => {
    for (const [cs, ce] of [
      [0, 0],
      [0, TURN.length],
      [TURN.length, TURN.length],
      [10, 5],
      [-4, 12]
    ]) {
      const cut = cutExcerpt(TURN, cs!, ce!, 15)
      expect(cut.highlight.start).toBeGreaterThanOrEqual(0)
      expect(cut.highlight.end).toBeLessThanOrEqual(cut.excerpt.length)
      expect(cut.highlight.end).toBeGreaterThanOrEqual(cut.highlight.start)
    }
  })
})

const span = (
  id: string,
  sessionOrd: number,
  status: "CURRENT" | "SUPERSEDED"
): HydratedSpan => ({
  ckey: `u|c|${id}`,
  id,
  sid: `s${sessionOrd}`,
  sessionKey: `s${sessionOrd}`,
  turnIdx: 0,
  cs: 0,
  ce: 7,
  sessionOrd,
  sessionDate: 20230100 + sessionOrd,
  tEvent: 0,
  speaker: "user",
  status,
  atSession: status === "SUPERSEDED" ? sessionOrd + 1 : null,
  excerpt: `excerpt ${id}`,
  highlight: { start: 0, end: 7 }
})

describe("renderReaderPrompt", () => {
  const spans = [span("aaa", 3, "CURRENT"), span("bbb", 1, "SUPERSEDED")]
  const prompt = renderReaderPrompt("What am I pre-approved for?", "2023/12/18 (Mon) 04:17", spans)

  it("describes the order the excerpts are actually in", () => {
    expect(prompt).toContain("CURRENT first and then superseded, each group oldest first")
    expect(prompt.indexOf("[aaa]")).toBeLessThan(prompt.indexOf("[bbb]"))
    expect(prompt).not.toContain("EXCERPTS (2), oldest first")
  })

  it("carries the question date, the count, and each excerpt's status", () => {
    expect(prompt).toContain("QUESTION DATE: 2023/12/18 (Mon) 04:17")
    expect(prompt).toContain("EXCERPTS (2)")
    expect(prompt).toContain("SUPERSEDED by a later statement (at session 2)")
  })

  it("shows verbatim excerpts and never a claim's text", () => {
    expect(prompt).toContain("excerpt aaa")
    expect(prompt).toContain("excerpt bbb")
  })
})

describe("granularity", () => {
  it("reads a whole turn for the routes whose answer IS the turn", () => {
    expect(granularityFor("assistant_output")).toBe("turn")
    expect(granularityFor("preference")).toBe("turn")
  })

  it("reads a span for the routes that need many claims in one budget", () => {
    for (const route of ["fact", "count", "update", "temporal", "multi_fact"] as const) {
      expect(granularityFor(route)).toBe("span")
    }
  })

  it("is span when there is no route at all, which is every baseline", () => {
    expect(granularityFor(null)).toBe("span")
  })

  it("lets the ablation flag override the route, in both directions", () => {
    expect(granularityFor("assistant_output", "span")).toBe("span")
    expect(granularityFor("fact", "turn")).toBe("turn")
  })

  it("names the turn routes explicitly, so adding a route does not silently opt in", () => {
    expect(ROUTES.filter((route) => RoutePolicy[route].granularity === "turn")).toEqual([
      "preference",
      "assistant_output"
    ])
  })
})

describe("the pack label in the prompt", () => {
  const labelled = (label: PackLabel | undefined, status: "CURRENT" | "SUPERSEDED") => {
    const base = span("aaaaaaaa", 1, status)
    return renderReaderPrompt("q", "2023/04/10 (Mon) 17:50", [
      label === undefined ? base : { ...base, label }
    ])
  }

  it("says CURRENT when nothing else in the slot was said later", () => {
    expect(labelled("CURRENT", "CURRENT")).toContain(", user, CURRENT")
  })

  it("distinguishes EARLIER STATEMENT from SUPERSEDED", () => {
    expect(labelled("EARLIER STATEMENT", "CURRENT")).toContain(
      "EARLIER STATEMENT about the same thing"
    )
    expect(labelled(undefined, "SUPERSEDED")).toContain("SUPERSEDED by a later statement")
  })

  it("lets SUPERSEDED win over any pack label, because it is graph structure", () => {
    expect(labelled("CURRENT", "SUPERSEDED")).toContain("SUPERSEDED by a later statement")
    expect(labelled("CURRENT", "SUPERSEDED")).not.toContain("EARLIER STATEMENT")
  })

  it("reads as the baselines do when the pack stage did not run", () => {
    expect(labelled(undefined, "CURRENT")).toContain(", user, CURRENT")
  })
})

describe("the route rules block", () => {
  it("keeps the terse rule on fact and nowhere else", () => {
    expect(RoutePolicy.fact.rules).toContain("as few words")
    for (const route of ["count", "temporal", "update", "preference", "multi_fact"] as const) {
      expect(RoutePolicy[route].rules).not.toContain("as few words")
    }
  })

  it("tells a count question to enumerate before it numbers", () => {
    expect(RoutePolicy.count.rules).toContain("Enumerate")
    expect(RoutePolicy.count.rules).toContain("distinct")
  })

  it("tells an assistant-output question to quote rather than paraphrase", () => {
    expect(RoutePolicy.assistant_output.rules).toContain("verbatim")
  })

  it("tells an update question that EARLIER STATEMENT is not wrong", () => {
    expect(RoutePolicy.update.rules).toContain("EARLIER STATEMENT")
  })

  it("tells a multi-fact question to abstain with the constant, not a paraphrase", () => {
    expect(RoutePolicy.multi_fact.rules).toContain("answer NOT_IN_MEMORY")
  })

  it("appends to one system prompt rather than forking seven", () => {
    const base = systemFor(null)
    for (const route of ROUTES) {
      expect(systemFor(route).startsWith(base)).toBe(true)
      expect(systemFor(route)).toContain(RoutePolicy[route].rules)
    }
  })

  it("is the baselines' prompt byte for byte when there is no route", () => {
    expect(systemFor(null)).not.toContain("For this question in particular")
  })
})
