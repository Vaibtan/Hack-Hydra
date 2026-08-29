import { describe, expect, it } from "vitest"
import {
  ADJUDICATED_ROUTES,
  CHARS_PER_TOKEN,
  READER_TOKEN_BUDGET,
  adjudicate,
  applyBudget,
  dedupeByTurn,
  estimateTokens,
  spanHash,
  spanTuple
} from "../../src/Pack.js"

const claim = (
  ckey: string,
  sessionOrd: number,
  status: "CURRENT" | "SUPERSEDED" = "CURRENT",
  tEvent = 0
) => ({ ckey, sessionOrd, status, tEvent })

/** `me|residence` holds one value at a time; `me|hobby` holds several. */
const RESIDENCE = new Map([
  ["a", "u|s|me|residence"],
  ["b", "u|s|me|residence"],
  ["c", "u|s|me|residence"]
])

describe("adjudication", () => {
  it("names the latest current claim of a slot on an update question", () => {
    const labelled = adjudicate(
      [claim("a", 1), claim("b", 5), claim("c", 3)],
      RESIDENCE,
      "update"
    )
    expect(labelled.map((c) => [c.ckey, c.label])).toEqual([
      ["a", "EARLIER STATEMENT"],
      ["b", "CURRENT"],
      ["c", "EARLIER STATEMENT"]
    ])
  })

  it("does the same on a fact question and nothing else", () => {
    expect(ADJUDICATED_ROUTES).toEqual(["update", "fact"])
    expect(
      adjudicate([claim("a", 1), claim("b", 5)], RESIDENCE, "fact").map((c) => c.label)
    ).toEqual(["EARLIER STATEMENT", "CURRENT"])
  })

  it("leaves every current claim current on a count question", () => {
    // The failure this prevents: `me|hobby` and "things to return" are
    // multi-valued, and telling the reader the older ones are superseded is how
    // a count loses half its items.
    expect(
      adjudicate([claim("a", 1), claim("b", 5), claim("c", 3)], RESIDENCE, "count").map(
        (c) => c.label
      )
    ).toEqual(["CURRENT", "CURRENT", "CURRENT"])
    for (const route of ["preference", "temporal", "assistant_output", "multi_fact"] as const) {
      expect(
        adjudicate([claim("a", 1), claim("b", 5)], RESIDENCE, route).every(
          (c) => c.label === "CURRENT"
        )
      ).toBe(true)
    }
  })

  it("keeps a superseded claim superseded on every route", () => {
    for (const route of ["update", "count", "preference"] as const) {
      const labelled = adjudicate([claim("a", 1, "SUPERSEDED"), claim("b", 5)], RESIDENCE, route)
      expect(labelled[0]!.label).toBe("SUPERSEDED")
    }
  })

  it("leaves a claim that fills no slot alone", () => {
    const labelled = adjudicate([claim("a", 1), claim("z", 9)], RESIDENCE, "update")
    expect(labelled.find((c) => c.ckey === "z")!.label).toBe("CURRENT")
  })

  it("breaks a same-session tie by event date, then by key", () => {
    const labelled = adjudicate(
      [claim("a", 4, "CURRENT", 20230101), claim("b", 4, "CURRENT", 20230505)],
      RESIDENCE,
      "update"
    )
    expect(labelled.find((c) => c.ckey === "b")!.label).toBe("CURRENT")
    expect(labelled.find((c) => c.ckey === "a")!.label).toBe("EARLIER STATEMENT")
  })
})

const span = (ckey: string, chars: number, sessionKey = "s1", turnIdx = 0, cs = 0, ce = 10) => ({
  ckey,
  sessionKey,
  turnIdx,
  cs,
  ce,
  excerpt: "x".repeat(chars)
})

describe("the token budget", () => {
  it("estimates from characters, at the calibrated ratio", () => {
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(READER_TOKEN_BUDGET).toBe(6000)
    expect(estimateTokens([span("a", 400), span("b", 400)])).toBe(200)
  })

  it("drops from the tail of the selector's ranking", () => {
    const spans = [span("a", 4000), span("b", 4000), span("c", 4000)]
    const report = applyBudget(spans, { budget: 2000 })
    expect(report.kept.map((s) => s.ckey)).toEqual(["a", "b"])
    expect(report.dropped.map((s) => s.ckey)).toEqual(["c"])
    expect(report.estimatedTokens).toBeLessThanOrEqual(2000)
  })

  it("never drops a probe hit, even when it is last", () => {
    const spans = [span("a", 4000), span("b", 4000), span("probe", 4000)]
    const report = applyBudget(spans, { budget: 2000, protectedKeys: new Set(["probe"]) })
    expect(report.kept.map((s) => s.ckey)).toContain("probe")
    expect(report.dropped.map((s) => s.ckey)).toEqual(["b"])
  })

  it("gives up rather than dropping the last protected row", () => {
    const spans = [span("probe", 400_000)]
    const report = applyBudget(spans, { budget: 10, protectedKeys: new Set(["probe"]) })
    expect(report.kept).toHaveLength(1)
    expect(report.dropped).toHaveLength(0)
    expect(report.estimatedTokens).toBeGreaterThan(report.budget)
  })

  it("reports the ratio and the budget it used, so a receipt can echo them", () => {
    const report = applyBudget([span("a", 40)])
    expect(report).toMatchObject({ charsPerToken: 4, budget: 6000 })
  })

  it("keeps everything when the pack already fits", () => {
    const spans = [span("a", 40), span("b", 40)]
    expect(applyBudget(spans).dropped).toEqual([])
  })
})

describe("the span hash", () => {
  it("is over source spans, not claim keys", () => {
    // Two different claims pointing at the same span are one row of evidence.
    const one = spanHash([span("claim-a", 10, "s1", 3, 100, 200)])
    const two = spanHash([span("claim-b", 10, "s1", 3, 100, 200)])
    expect(one).toBe(two)
  })

  it("does not depend on order", () => {
    const a = span("a", 10, "s1", 1, 0, 5)
    const b = span("b", 10, "s2", 4, 7, 9)
    expect(spanHash([a, b])).toBe(spanHash([b, a]))
  })

  it("separates two sessions that share an sid", () => {
    // The `#n` suffix is the only thing that distinguishes the 13 repeated ids.
    expect(spanTuple(span("a", 10, "abc", 3, 0, 5))).not.toBe(
      spanTuple(span("a", 10, "abc#2", 3, 0, 5))
    )
    expect(spanHash([span("a", 10, "abc", 3, 0, 5)])).not.toBe(
      spanHash([span("a", 10, "abc#2", 3, 0, 5)])
    )
  })

  it("is stable and 64 hex characters", () => {
    expect(spanHash([span("a", 10)])).toMatch(/^[0-9a-f]{64}$/)
    expect(spanHash([])).toBe(spanHash([]))
  })
})

describe("dedupe by turn", () => {
  it("collapses several claims from one turn into one excerpt", () => {
    const spans = [
      span("a", 100, "s1", 4, 10, 20),
      span("b", 300, "s1", 4, 5, 40),
      span("c", 100, "s1", 5, 0, 9)
    ]
    const deduped = dedupeByTurn(spans)
    expect(deduped).toHaveLength(2)
    const turn4 = deduped.find((s) => s.turnIdx === 4)!
    // The widest span survives, so no highlighted region is lost.
    expect([turn4.cs, turn4.ce]).toEqual([5, 40])
    expect(turn4.excerpt.length).toBe(300)
  })

  it("keeps the selector's ranking, taking the first occurrence's position", () => {
    const spans = [span("a", 10, "s1", 1), span("b", 10, "s2", 1), span("c", 10, "s1", 1)]
    expect(dedupeByTurn(spans).map((s) => s.sessionKey)).toEqual(["s1", "s2"])
  })

  it("does not merge the same turn index of two different sessions", () => {
    expect(dedupeByTurn([span("a", 10, "s1", 3), span("b", 10, "s2", 3)])).toHaveLength(2)
  })
})
