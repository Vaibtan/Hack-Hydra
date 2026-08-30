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

/**
 * `highlight.start` is where the span sits inside the excerpt, so the excerpt
 * covers `[cs - highlight.start, + excerpt.length)` of the turn. Default 0,
 * i.e. the excerpt starts at the span.
 */
const span = (
  ckey: string,
  chars: number,
  sessionKey = "s1",
  turnIdx = 0,
  cs = 0,
  ce = 10,
  highlightStart = 0
) => ({
  ckey,
  sessionKey,
  turnIdx,
  cs,
  ce,
  excerpt: "x".repeat(chars),
  highlight: { start: highlightStart, end: Math.min(chars, highlightStart + (ce - cs)) }
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

  it("names every drop with its id, reason and cost", () => {
    // A count says how many excerpts went. A reader of a receipt asking why the
    // answer session is not in the evidence needs to know which, and that the
    // reason was money rather than the selector's judgement.
    const spans = [span("aaaaaaaakeep0001", 4000), span("bbbbbbbbdrop0002", 4000)]
    const report = applyBudget(spans, { budget: 1500 })

    expect(report.drops).toEqual([
      { ckey: "bbbbbbbbdrop0002", id: "drop0002", reason: "budget", chars: 4000 }
    ])
  })

  it("uses the reader's own citation form for the dropped id", () => {
    // The id in the receipt has to be the id the reader would have cited, or a
    // reader of the trace cannot match a drop to an excerpt.
    const report = applyBudget([span("u|c|0123456789abcdef", 40_000)], { budget: 10 })
    expect(report.drops[0]!.id).toBe("89abcdef")
  })

  it("flags a pack that is over budget with nothing droppable left", () => {
    // Reachable and previously silent: a question with many probe hits produces
    // a pack that exceeds the budget with nothing in it that may be cut. That
    // is the right trade, but a reader-token number that quietly misses its
    // target needs a row saying why.
    const report = applyBudget([span("probe", 400_000)], {
      budget: 10,
      protectedKeys: new Set(["probe"])
    })

    expect(report.overBudget).toBe(true)
    expect(report.drops).toEqual([])
  })

  it("does not flag a pack that fits, or one the budget successfully cut", () => {
    expect(applyBudget([span("a", 40)]).overBudget).toBe(false)
    expect(applyBudget([span("a", 4000), span("b", 4000)], { budget: 1500 }).overBudget).toBe(false)
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
  it("collapses claims from one turn when the text covers both", () => {
    // Both spans sit inside the wider excerpt's window, so one excerpt is
    // honestly one excerpt.
    const wide = span("b", 300, "s1", 4, 5, 40, 0) // covers turn [5, 305)
    const inner = span("a", 100, "s1", 4, 10, 20, 0) // covers turn [10, 110)
    const deduped = dedupeByTurn([wide, inner])
    expect(deduped).toHaveLength(1)
    expect([deduped[0]!.cs, deduped[0]!.ce]).toEqual([5, 40])
    expect(deduped[0]!.excerpt.length).toBe(300)
  })

  it("does NOT merge two disjoint windows of the same turn", () => {
    // The failure this pins: an assistant turn of 3 000 characters with a claim
    // at [0,50] and another at [2000,2900]. Hydration cuts +-300, so the
    // excerpts are turn[0..350] and turn[1700..3000] — disjoint. Merging them
    // would show the reader only the second while `spanHash` recorded
    // `s1|4|0|2900`, asserting bytes 0..2900 were seen.
    const first = span("a", 350, "s1", 4, 0, 50, 0) // covers turn [0, 350)
    const second = span("b", 1300, "s1", 4, 2000, 2900, 300) // covers turn [1700, 3000)
    const deduped = dedupeByTurn([first, second])
    expect(deduped).toHaveLength(2)
    expect(deduped.map((s) => [s.cs, s.ce])).toEqual([
      [0, 50],
      [2000, 2900]
    ])
    // And the hash records two spans, not one union that nobody read.
    expect(spanHash(deduped)).not.toBe(spanHash([{ ...first, cs: 0, ce: 2900 }]))
  })

  it("keeps the widest window when one excerpt swallows another", () => {
    const narrow = span("a", 60, "s1", 4, 100, 110, 0) // covers [100, 160)
    const wide = span("b", 600, "s1", 4, 120, 130, 120) // covers [0, 600)
    const deduped = dedupeByTurn([narrow, wide])
    expect(deduped).toHaveLength(1)
    expect([deduped[0]!.cs, deduped[0]!.ce]).toEqual([100, 130])
    expect(deduped[0]!.excerpt.length).toBe(600)
  })

  it("keeps the selector's ranking, taking the first occurrence's position", () => {
    const spans = [span("a", 10, "s1", 1), span("b", 10, "s2", 1), span("c", 10, "s1", 1)]
    expect(dedupeByTurn(spans).map((s) => s.sessionKey)).toEqual(["s1", "s2"])
  })

  it("does not merge the same turn index of two different sessions", () => {
    expect(dedupeByTurn([span("a", 10, "s1", 3), span("b", 10, "s2", 3)])).toHaveLength(2)
  })

  it("never widens a span past the text that was actually cut", () => {
    // Property: every surviving row's [cs, ce) lies inside its own excerpt.
    const rows = dedupeByTurn([
      span("a", 350, "s1", 4, 0, 50, 0),
      span("b", 1300, "s1", 4, 2000, 2900, 300),
      span("c", 400, "s1", 4, 100, 140, 100)
    ])
    for (const row of rows) {
      const from = row.cs - row.highlight.start
      expect(row.cs).toBeGreaterThanOrEqual(from)
      expect(row.ce).toBeLessThanOrEqual(from + row.excerpt.length)
    }
  })
})
