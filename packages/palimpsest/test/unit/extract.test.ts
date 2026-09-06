import { describe, expect, it } from "vitest"
import { QUOTED_VERSE_NOTE, locateSpan, mergeEntities, parseEventDate, withQuotedVerseNote } from "../../src/Extract.js"
import type { ExtractedClaim } from "../../src/Extract.js"

const TURN =
  "I'm thinking of getting my car detailed soon.\nBy the way, I just got my car serviced\n  for the first time on March 15th, and it was great."

describe("locateSpan", () => {
  it("finds a quote copied exactly and reports the substring it spans", () => {
    const span = locateSpan(TURN, "my car serviced")
    expect(span).not.toBeNull()
    expect(span!.located).toBe("exact")
    expect(TURN.slice(span!.cs, span!.ce)).toBe("my car serviced")
  })

  it("recovers a quote whose whitespace the model normalised", () => {
    const span = locateSpan(TURN, "I just got my car serviced for the first time on March 15th")
    expect(span).not.toBeNull()
    expect(span!.located).toBe("normalised")
    expect(TURN.slice(span!.cs, span!.ce)).toBe(
      "I just got my car serviced\n  for the first time on March 15th"
    )
  })

  it("recovers a quote the model stripped markdown emphasis from", () => {
    const turn =
      "Here are some options:\n\n1. **Zillow**: Filter by price, location, and amenities.\n2. **Trulia**: Similar."
    const span = locateSpan(turn, "Zillow: Filter by price, location, and amenities.")
    expect(span).not.toBeNull()
    expect(span!.located).toBe("markdown")
    const covered = turn.slice(span!.cs, span!.ce)
    expect(covered.replace(/[*_`#~]/g, "")).toBe("Zillow: Filter by price, location, and amenities.")
  })

  it("refuses a quote that is not in the turn, rather than guessing an offset", () => {
    expect(locateSpan(TURN, "I got my motorcycle serviced")).toBeNull()
    expect(locateSpan(TURN, "   ")).toBeNull()
    expect(locateSpan(TURN, "")).toBeNull()
  })

  it("locates a quote at the very start and very end of the turn", () => {
    const start = locateSpan(TURN, "I'm thinking")!
    expect(start.cs).toBe(0)
    const tail = "and it was great."
    const end = locateSpan(TURN, tail)!
    expect(end.ce).toBe(TURN.length)
  })
})

describe("parseEventDate", () => {
  it("keeps the precision the model gave, zeroing the parts it did not", () => {
    expect(parseEventDate("2023-03-15")).toEqual({ tEvent: 20230315, tPrec: "day" })
    expect(parseEventDate("2023-03")).toEqual({ tEvent: 20230300, tPrec: "month" })
    expect(parseEventDate("2023")).toEqual({ tEvent: 20230000, tPrec: "year" })
  })

  it("treats no date and an unparseable date the same: unknown", () => {
    expect(parseEventDate(null)).toEqual({ tEvent: 0, tPrec: "none" })
    expect(parseEventDate("last Tuesday")).toEqual({ tEvent: 0, tPrec: "none" })
  })

  it("orders correctly against day-precision dates in the same month", () => {
    expect(parseEventDate("2023-03").tEvent).toBeLessThan(parseEventDate("2023-03-01").tEvent)
  })
})

const claim = (entities: ExtractedClaim["entities"]): ExtractedClaim => ({
  text: "x",
  speaker: "user",
  ctype: "fact",
  entities,
  slot: null,
  tEvent: 0,
  tPrec: "none",
  span: { turnIdx: 0, cs: 0, ce: 1 },
  keywords: [],
  located: "exact"
})

describe("mergeEntities", () => {
  it("accumulates aliases for a canon seen in more than one session", () => {
    const known = [{ canon: "hamster", etype: "pet" as const, aliases: ["nibbles"] }]
    const merged = mergeEntities(known, [
      claim([{ canon: "hamster", etype: "pet", aliases: ["little guy"] }])
    ])
    expect(merged).toEqual([
      { canon: "hamster", etype: "pet", aliases: ["nibbles", "little guy"] }
    ])
  })

  it("adds new canons and keeps the list sorted so the prompt is stable", () => {
    const merged = mergeEntities([{ canon: "moma", etype: "org", aliases: [] }], [
      claim([{ canon: "hamster", etype: "pet", aliases: [] }])
    ])
    expect(merged.map((e) => e.canon)).toEqual(["hamster", "moma"])
  })
})

describe("withQuotedVerseNote", () => {
  it("appends the note after the transcript so the base prompt and its cache key are untouched", () => {
    const prompt = "SESSION DATE: x\n\nTRANSCRIPT:\n[turn 0 | user]\nlyrics here"
    const withNote = withQuotedVerseNote(prompt)
    expect(withNote.startsWith(`${prompt}\n`)).toBe(true)
    expect(withNote.endsWith(QUOTED_VERSE_NOTE)).toBe(true)
    expect(QUOTED_VERSE_NOTE).toContain("at most eight words")
  })
})
