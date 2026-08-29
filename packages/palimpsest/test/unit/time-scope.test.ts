import { describe, expect, it } from "vitest"
import { intervalSentence, resolveTimeInterval, type DayInterval } from "../../src/TimeScope.js"

/**
 * The resolver's contract is this table.
 *
 * Every row is `phrase × question date → interval`, because the arithmetic is
 * the whole point: the model supplies the phrase and nothing else, and a wrong
 * window is worse than no window — the scope stage would boost it and bury the
 * right claim.
 *
 * `2023-05-20` is a **Saturday**; `2023-05-17` is a Wednesday. Both are used
 * below, because weekday-relative phrases resolve differently on each.
 */
const SATURDAY = 20230520
const WEDNESDAY = 20230517

const at = (phrase: string, questionDate = SATURDAY): DayInterval | null =>
  resolveTimeInterval(phrase, questionDate)

const span = (interval: DayInterval | null): [number, number] | null =>
  interval === null ? null : [interval.start, interval.end]

describe("N units ago", () => {
  it("resolves days to the single day", () => {
    expect(span(at("3 days ago"))).toEqual([20230517, 20230518])
    expect(span(at("three days ago"))).toEqual([20230517, 20230518])
    expect(at("3 days ago")!.precision).toBe("day")
  })

  it("resolves weeks to the whole Monday-to-Sunday week", () => {
    // 2023-05-20 is a Saturday; one week back is 2023-05-13, whose week runs
    // Monday 2023-05-08 to Sunday 2023-05-14.
    expect(span(at("a week ago"))).toEqual([20230508, 20230515])
    expect(at("a week ago")!.precision).toBe("week")
  })

  it("resolves months to the whole calendar month, at month precision", () => {
    expect(span(at("two months ago"))).toEqual([20230301, 20230401])
    expect(at("two months ago")!.precision).toBe("month")
    expect(span(at("about six months ago"))).toEqual([20221101, 20221201])
  })

  it("crosses a year boundary", () => {
    expect(span(at("six months ago", 20230115))).toEqual([20220701, 20220801])
    expect(span(at("2 years ago"))).toEqual([20210101, 20220101])
  })

  it("returns null for a count it cannot read", () => {
    expect(at("umpteen months ago")).toBeNull()
  })
})

describe("last <unit>", () => {
  it("resolves last week, month and year to whole units", () => {
    expect(span(at("last week"))).toEqual([20230508, 20230515])
    expect(span(at("last month"))).toEqual([20230401, 20230501])
    expect(span(at("last year"))).toEqual([20220101, 20230101])
    expect(at("last year")!.precision).toBe("year")
  })

  it("resolves a weekday to the most recent one strictly before the question", () => {
    // Saturday 2023-05-20: "last Saturday" is a week earlier, not today.
    expect(span(at("last saturday"))).toEqual([20230513, 20230514])
    expect(span(at("last friday"))).toEqual([20230519, 20230520])
    expect(span(at("last sunday"))).toEqual([20230514, 20230515])
  })

  it("resolves a month name to the most recent one that has happened", () => {
    // Asked in May: last March is this year's.
    expect(span(at("last march"))).toEqual([20230301, 20230401])
    // Asked in February: last March is a year earlier.
    expect(span(at("last march", 20230210))).toEqual([20220301, 20220401])
    // The question's own month counts as a year ago, not as itself.
    expect(span(at("last may"))).toEqual([20220501, 20220601])
  })

  it("returns null for something that is not a unit", () => {
    expect(at("last time")).toBeNull()
  })
})

describe("named months and explicit dates", () => {
  it("resolves in <Month> to the most recent occurrence", () => {
    expect(span(at("in march"))).toEqual([20230301, 20230401])
    expect(span(at("in july"))).toEqual([20220701, 20220801])
    // The question's own month resolves to itself, unlike "last <month>".
    expect(span(at("in may"))).toEqual([20230501, 20230601])
  })

  it("resolves in <Month> <year>", () => {
    expect(span(at("in march 2021"))).toEqual([20210301, 20210401])
    expect(span(at("december 2019"))).toEqual([20191201, 20200101])
  })

  it("resolves a bare year", () => {
    expect(span(at("in 2019"))).toEqual([20190101, 20200101])
  })

  it("resolves month-and-day, with or without a year", () => {
    expect(span(at("march 14"))).toEqual([20230314, 20230315])
    expect(span(at("march 14 2021"))).toEqual([20210314, 20210315])
    expect(span(at("14 march 2021"))).toEqual([20210314, 20210315])
  })

  it("resolves ISO forms", () => {
    expect(span(at("2023-04-02"))).toEqual([20230402, 20230403])
    expect(span(at("2023/04/02"))).toEqual([20230402, 20230403])
    expect(span(at("2023-04"))).toEqual([20230401, 20230501])
  })

  it("accepts three-letter abbreviations", () => {
    expect(span(at("in mar 2021"))).toEqual([20210301, 20210401])
    expect(span(at("last sept"))).toEqual([20220901, 20221001])
  })
})

describe("relative days and weekends", () => {
  it("resolves today and yesterday", () => {
    expect(span(at("today"))).toEqual([20230520, 20230521])
    expect(span(at("yesterday"))).toEqual([20230519, 20230520])
    expect(span(at("last night"))).toEqual([20230519, 20230520])
  })

  it("takes this weekend as the most recent Saturday and Sunday", () => {
    // Asked on Saturday: the weekend that has started.
    expect(span(at("this weekend", SATURDAY))).toEqual([20230520, 20230522])
    // Asked on Wednesday: the weekend just gone, because the question is
    // retrospective.
    expect(span(at("this weekend", WEDNESDAY))).toEqual([20230513, 20230515])
  })

  it("resolves this week, month and year", () => {
    expect(span(at("this week"))).toEqual([20230515, 20230522])
    expect(span(at("this month"))).toEqual([20230501, 20230601])
    expect(span(at("this year"))).toEqual([20230101, 20240101])
  })
})

describe("no interval", () => {
  it("is null for a missing phrase, an empty one and anything unrecognised", () => {
    expect(resolveTimeInterval(null, SATURDAY)).toBeNull()
    expect(at("")).toBeNull()
    expect(at("   ")).toBeNull()
    expect(at("when I was younger")).toBeNull()
    expect(at("recently")).toBeNull()
    expect(at("a while back")).toBeNull()
  })
})

describe("punctuation and casing", () => {
  it("does not change the answer, and the phrase is echoed verbatim", () => {
    const interval = at("Two months ago,")
    expect(span(interval)).toEqual([20230301, 20230401])
    expect(interval!.phrase).toBe("Two months ago,")
  })
})

describe("the reader's sentence", () => {
  it("names the phrase and both ends, and says the end is exclusive", () => {
    const sentence = intervalSentence(at("two months ago")!)
    expect(sentence).toContain("two months ago")
    expect(sentence).toContain("2023-03-01")
    expect(sentence).toContain("2023-04-01")
    expect(sentence).toContain("not including")
  })
})
