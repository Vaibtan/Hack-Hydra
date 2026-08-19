import { describe, expect, it } from "vitest"
import { cutExcerpt } from "../../src/index.js"

/**
 * The span window. The reader is only ever shown verbatim turn text, so this
 * is the function that decides what it sees — and the highlight it returns is
 * what the UI draws over the evidence.
 */
const TURN =
  "Zero one two three four five six seven eight nine. " + // 51 chars
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
    // A span can only be stale if the transcript changed under it, but a
    // reader crash is a much worse outcome than a short excerpt.
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
