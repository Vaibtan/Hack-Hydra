import { describe, expect, it } from "vitest"
import {
  TURN_ROUTES,
  cutExcerpt,
  granularityFor,
  renderReaderPrompt,
  type HydratedSpan,
  type PackLabel
} from "../../src/index.js"

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

describe("granularity", () => {
  it("reads a whole turn for the routes whose answer IS the turn", () => {
    // An assistant_output question asks what the assistant said. The Span is
    // the one line the extractor found quotable; the answer is the list of five
    // suggestions around it, and 300 characters either side cuts it in half.
    expect(granularityFor("assistant_output")).toBe("turn")
    expect(granularityFor("preference")).toBe("turn")
  })

  it("reads a span for the routes that need many claims in one budget", () => {
    for (const route of ["fact", "count", "update", "temporal", "multi_fact"] as const) {
      expect(granularityFor(route)).toBe("span")
    }
  })

  it("is span when there is no route at all, which is v1 and every baseline", () => {
    expect(granularityFor(null)).toBe("span")
  })

  it("lets the ablation flag override the route, in both directions", () => {
    expect(granularityFor("assistant_output", "span")).toBe("span")
    expect(granularityFor("fact", "turn")).toBe("turn")
  })

  it("names the turn routes explicitly, so adding a route does not silently opt in", () => {
    expect([...TURN_ROUTES]).toEqual(["assistant_output", "preference"])
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
    // The two are different claims and the prompt has to read like it. The
    // memory *inferred* a supersession edge; it only *observed* that something
    // else about the same slot was said afterwards. Telling the reader the
    // second is the first is how a still-true fact gets discarded.
    expect(labelled("EARLIER STATEMENT", "CURRENT")).toContain(
      "EARLIER STATEMENT about the same thing"
    )
    expect(labelled(undefined, "SUPERSEDED")).toContain("SUPERSEDED by a later statement")
  })

  it("lets SUPERSEDED win over any pack label, because it is graph structure", () => {
    expect(labelled("CURRENT", "SUPERSEDED")).toContain("SUPERSEDED by a later statement")
    expect(labelled("CURRENT", "SUPERSEDED")).not.toContain("EARLIER STATEMENT")
  })

  it("reads as v1 does when the pack stage did not run", () => {
    // No label at all is v1 and every baseline, and their prompts must not move
    // by a byte or the paired comparison is between two prompts.
    expect(labelled(undefined, "CURRENT")).toContain(", user, CURRENT")
  })
})
