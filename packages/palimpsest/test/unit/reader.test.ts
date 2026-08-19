import { describe, expect, it } from "vitest"
import { cutExcerpt, renderReaderPrompt, type HydratedSpan } from "../../src/index.js"

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

/**
 * The excerpt-order label.
 *
 * `orderEvidence` puts CURRENT before SUPERSEDED unless the question is
 * historical, so the prompt's old "oldest first" was wrong exactly on the
 * knowledge-update questions — the ones where the reader has to tell the
 * replaced value from the one that replaced it. A label that misdescribes the
 * order is worse than no label: it tells the model to trust a sequence that
 * isn't there.
 */
const span = (
  id: string,
  sessionOrd: number,
  status: "CURRENT" | "SUPERSEDED"
): HydratedSpan => ({
  ckey: `u|c|${id}`,
  id,
  sid: `s${sessionOrd}`,
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
    // The claim in the label has to hold for the list beneath it.
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
