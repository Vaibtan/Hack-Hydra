/**
 * Turning a question's time phrase into a window over the memory.
 *
 * The model supplies the *phrase* and nothing else — "two months ago", "last
 * March", "this weekend" — and the interval is computed here, in code. That
 * split is deliberate. Date arithmetic is the one part of understanding a
 * question that has a right answer, and a model that returns an interval
 * directly returns a plausible one; `Anchors` has been extracting `time_ref`
 * since day one and nothing ever consumed it, so the phrase was already there
 * and the arithmetic was the missing half.
 *
 * Intervals are closed-open `[start, end)` over `YYYYMMDD` integers, which is
 * the form the graph already stores dates in (`Claim.t_event`,
 * `Session.date`), so scoping is an integer comparison and never a timezone
 * question.
 */

/** How coarse the phrase was. Reported, because "last year" is not a day. */
export type TimePrecision = "day" | "week" | "month" | "year"

export interface DayInterval {
  /** Inclusive, `YYYYMMDD`. */
  readonly start: number
  /** Exclusive, `YYYYMMDD`. */
  readonly end: number
  readonly precision: TimePrecision
  /** The phrase this came from, verbatim, so a receipt can show its own input. */
  readonly phrase: string
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
] as const

/** Sunday-first, matching `Date.getUTCDay`. */
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
}

const toDate = (dateInt: number): Date =>
  new Date(
    Date.UTC(Math.floor(dateInt / 10000), (Math.floor(dateInt / 100) % 100) - 1, dateInt % 100)
  )

const toInt = (date: Date): number =>
  date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()

const addDays = (dateInt: number, days: number): number => {
  const date = toDate(dateInt)
  date.setUTCDate(date.getUTCDate() + days)
  return toInt(date)
}

/** First day of the month `offset` months from `dateInt`'s month. */
const monthStart = (dateInt: number, offset = 0): number => {
  const year = Math.floor(dateInt / 10000)
  const month = Math.floor(dateInt / 100) % 100
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1))
  return toInt(shifted)
}

const wholeMonth = (anchor: number, phrase: string): DayInterval => ({
  start: monthStart(anchor),
  end: monthStart(anchor, 1),
  precision: "month",
  phrase
})

const wholeYear = (year: number, phrase: string): DayInterval => ({
  start: year * 10000 + 101,
  end: (year + 1) * 10000 + 101,
  precision: "year",
  phrase
})

const singleDay = (dateInt: number, phrase: string): DayInterval => ({
  start: dateInt,
  end: addDays(dateInt, 1),
  precision: "day",
  phrase
})

/** Monday of the week containing `dateInt`. ISO weeks: Monday starts one. */
const weekStart = (dateInt: number): number => {
  const day = toDate(dateInt).getUTCDay()
  return addDays(dateInt, day === 0 ? -6 : 1 - day)
}

const wholeWeek = (dateInt: number, phrase: string): DayInterval => {
  const start = weekStart(dateInt)
  return { start, end: addDays(start, 7), precision: "week", phrase }
}

const normalise = (phrase: string): string =>
  phrase
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const monthIndex = (word: string): number =>
  MONTHS.findIndex((month) => month === word || month.slice(0, 3) === word.slice(0, 3))

const count = (word: string): number | null => {
  if (/^\d+$/.test(word)) return Number(word)
  return NUMBER_WORDS[word] ?? null
}

/**
 * Resolves one phrase against the question's own date.
 *
 * Unrecognised is `null`, not a guess: an interval that is merely plausible is
 * worse than none, because the scope stage would then boost the wrong window
 * and quietly bury the right claim. The supported forms are exactly the ones
 * LongMemEval's temporal questions use, and the unit table is the contract.
 *
 * `questionDate` is `YYYYMMDD` — the form `HaystackDate.dateInt` already has.
 */
export const resolveTimeInterval = (
  phrase: string | null,
  questionDate: number
): DayInterval | null => {
  if (phrase === null) return null
  const text = normalise(phrase)
  if (text === "") return null
  const year = Math.floor(questionDate / 10000)

  // today / yesterday / last night
  if (text === "today" || text === "this morning" || text === "this afternoon") {
    return singleDay(questionDate, phrase)
  }
  if (text === "yesterday" || text === "last night" || text === "yesterday evening") {
    return singleDay(addDays(questionDate, -1), phrase)
  }

  // "this weekend" — the most recent Saturday and Sunday. A LongMemEval
  // question is retrospective, so on a Wednesday this is the weekend just
  // gone, not the one coming; on a Saturday or Sunday it is the current one.
  if (text === "this weekend" || text === "the weekend" || text === "last weekend") {
    const day = toDate(questionDate).getUTCDay()
    const backToSaturday = day === 6 ? 0 : -(day + 1)
    const saturday = addDays(questionDate, backToSaturday)
    return { start: saturday, end: addDays(saturday, 2), precision: "day", phrase }
  }

  // "<n> <unit> ago"
  const agoMatch = /^(?:about |around |roughly |some )?(\S+) (day|days|week|weeks|month|months|year|years) ago$/.exec(
    text
  )
  if (agoMatch !== null) {
    const n = count(agoMatch[1]!)
    if (n === null) return null
    const unit = agoMatch[2]!
    if (unit.startsWith("day")) return singleDay(addDays(questionDate, -n), phrase)
    if (unit.startsWith("week")) return wholeWeek(addDays(questionDate, -7 * n), phrase)
    if (unit.startsWith("month")) {
      return {
        start: monthStart(questionDate, -n),
        end: monthStart(questionDate, -n + 1),
        precision: "month",
        phrase
      }
    }
    return wholeYear(year - n, phrase)
  }

  // "last <unit>" / "the previous <unit>"
  const lastMatch = /^(?:last|previous|the last|the previous) (.+)$/.exec(text)
  if (lastMatch !== null) {
    const rest = lastMatch[1]!
    if (rest === "week") return wholeWeek(addDays(questionDate, -7), phrase)
    if (rest === "month") {
      return {
        start: monthStart(questionDate, -1),
        end: monthStart(questionDate, 0),
        precision: "month",
        phrase
      }
    }
    if (rest === "year") return wholeYear(year - 1, phrase)

    const weekday = WEEKDAYS.findIndex((name) => name === rest)
    if (weekday !== -1) {
      // The most recent occurrence *strictly before* the question date.
      const today = toDate(questionDate).getUTCDay()
      const back = ((today - weekday + 6) % 7) + 1
      return singleDay(addDays(questionDate, -back), phrase)
    }

    const month = monthIndex(rest)
    if (month !== -1) {
      // "last March" asked in May 2023 is March 2023; asked in February 2023 it
      // is March 2022 — the most recent one that has already happened.
      const questionMonth = (Math.floor(questionDate / 100) % 100) - 1
      const targetYear = month < questionMonth ? year : year - 1
      return wholeMonth(targetYear * 10000 + (month + 1) * 100 + 1, phrase)
    }
    return null
  }

  // "this month" / "this year"
  if (text === "this month") return wholeMonth(questionDate, phrase)
  if (text === "this year") return wholeYear(year, phrase)
  if (text === "this week") return wholeWeek(questionDate, phrase)

  // "in <Month> [year]" / "<Month> [year]" / "in <year>"
  const inMatch = /^(?:in |back in |during |on )?(.+)$/.exec(text)
  if (inMatch !== null) {
    const rest = inMatch[1]!.split(" ")
    const bareYear = /^(19|20)\d{2}$/.exec(rest[0] ?? "")
    if (rest.length === 1 && bareYear !== null) return wholeYear(Number(rest[0]), phrase)

    const month = monthIndex(rest[0] ?? "")
    if (month !== -1) {
      const explicit = rest[1] !== undefined ? /^(19|20)\d{2}$/.exec(rest[1]) : null
      if (rest.length === 1 || explicit !== null) {
        // Without a year, the most recent occurrence at or before the question
        // month: a memory question does not ask about the future.
        const questionMonth = (Math.floor(questionDate / 100) % 100) - 1
        const targetYear =
          explicit !== null ? Number(rest[1]) : month <= questionMonth ? year : year - 1
        return wholeMonth(targetYear * 10000 + (month + 1) * 100 + 1, phrase)
      }
      // "<Month> <day>[ <year>]"
      const day = count(rest[1] ?? "")
      if (day !== null && day >= 1 && day <= 31) {
        const withYear = rest[2] !== undefined ? /^(19|20)\d{2}$/.exec(rest[2]) : null
        const targetYear = withYear !== null ? Number(rest[2]) : year
        return singleDay(targetYear * 10000 + (month + 1) * 100 + day, phrase)
      }
    }
  }

  // Explicit dates: 2023-05-20, 2023/05/20, 2023-05, 20 May 2023.
  const isoDay = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
  if (isoDay !== null) {
    return singleDay(
      Number(isoDay[1]) * 10000 + Number(isoDay[2]) * 100 + Number(isoDay[3]),
      phrase
    )
  }
  const isoMonth = /^(\d{4})[-/](\d{1,2})$/.exec(text)
  if (isoMonth !== null) {
    return wholeMonth(Number(isoMonth[1]) * 10000 + Number(isoMonth[2]) * 100 + 1, phrase)
  }
  const dayMonthYear = /^(\d{1,2}) ([a-z]+) ((?:19|20)\d{2})$/.exec(text)
  if (dayMonthYear !== null) {
    const month = monthIndex(dayMonthYear[2]!)
    if (month !== -1) {
      return singleDay(
        Number(dayMonthYear[3]) * 10000 + (month + 1) * 100 + Number(dayMonthYear[1]),
        phrase
      )
    }
  }

  return null
}

/**
 * The sentence the reader is given when the question carries a time reference.
 *
 * Route-independent by design: a count question with a time phrase needs the
 * window as much as a temporal one does, and the reader is the only stage that
 * can say "between these two dates" in words.
 */
export const intervalSentence = (interval: DayInterval): string => {
  const readable = (dateInt: number): string =>
    `${Math.floor(dateInt / 10000)}-${String(Math.floor(dateInt / 100) % 100).padStart(2, "0")}-` +
    `${String(dateInt % 100).padStart(2, "0")}`
  return (
    `The question refers to the period "${interval.phrase}", which is ` +
    `${readable(interval.start)} up to but not including ${readable(interval.end)}.`
  )
}
