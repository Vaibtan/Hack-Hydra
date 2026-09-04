
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
  word.length < 3 ? -1 : MONTHS.findIndex((month) => month.startsWith(word))

const count = (word: string): number | null => {
  if (/^\d+$/.test(word)) return Number(word)
  return NUMBER_WORDS[word] ?? null
}

interface ParseContext {
  readonly questionDate: number
  readonly year: number
  readonly phrase: string
}

interface ParseRule {
  readonly pattern: RegExp
  /** `null` means the pattern matched but the words did not resolve; the next rule is tried. */
  readonly build: (match: RegExpExecArray, ctx: ParseContext) => DayInterval | null
}

const YEAR = /^(19|20)\d{2}$/

const monthOf = (year: number, month: number): number => year * 10000 + (month + 1) * 100 + 1

const wholeMonthOffset = (ctx: ParseContext, offset: number): DayInterval => ({
  start: monthStart(ctx.questionDate, offset),
  end: monthStart(ctx.questionDate, offset + 1),
  precision: "month",
  phrase: ctx.phrase
})

/** Tried in order; the first rule whose pattern matches and whose `build` resolves wins. */
const PARSE_TABLE: ReadonlyArray<ParseRule> = [
  {
    pattern: /^(?:today|this morning|this afternoon)$/,
    build: (_, ctx) => singleDay(ctx.questionDate, ctx.phrase)
  },
  {
    pattern: /^(?:yesterday|last night|yesterday evening)$/,
    build: (_, ctx) => singleDay(addDays(ctx.questionDate, -1), ctx.phrase)
  },
  {
    pattern: /^(?:this weekend|the weekend|last weekend)$/,
    build: (_, ctx) => {
      const day = toDate(ctx.questionDate).getUTCDay()
      const saturday = addDays(ctx.questionDate, day === 6 ? 0 : -(day + 1))
      return { start: saturday, end: addDays(saturday, 2), precision: "day", phrase: ctx.phrase }
    }
  },
  {
    pattern: /^(?:about |around |roughly |some )?(\S+) (day|days|week|weeks|month|months|year|years) ago$/,
    build: (match, ctx) => {
      const n = count(match[1]!)
      if (n === null) return null
      const unit = match[2]!
      if (unit.startsWith("day")) return singleDay(addDays(ctx.questionDate, -n), ctx.phrase)
      if (unit.startsWith("week")) return wholeWeek(addDays(ctx.questionDate, -7 * n), ctx.phrase)
      if (unit.startsWith("month")) return wholeMonthOffset(ctx, -n)
      return wholeYear(ctx.year - n, ctx.phrase)
    }
  },
  {
    pattern: /^(?:last|previous|the last|the previous) (.+)$/,
    build: (match, ctx) => {
      const rest = match[1]!
      if (rest === "week") return wholeWeek(addDays(ctx.questionDate, -7), ctx.phrase)
      if (rest === "month") return wholeMonthOffset(ctx, -1)
      if (rest === "year") return wholeYear(ctx.year - 1, ctx.phrase)

      const weekday = WEEKDAYS.findIndex((name) => name === rest)
      if (weekday !== -1) {
        const today = toDate(ctx.questionDate).getUTCDay()
        const back = ((today - weekday + 6) % 7) + 1
        return singleDay(addDays(ctx.questionDate, -back), ctx.phrase)
      }

      const month = monthIndex(rest)
      if (month === -1) return null
      const questionMonth = (Math.floor(ctx.questionDate / 100) % 100) - 1
      return wholeMonth(monthOf(month < questionMonth ? ctx.year : ctx.year - 1, month), ctx.phrase)
    }
  },
  { pattern: /^this month$/, build: (_, ctx) => wholeMonth(ctx.questionDate, ctx.phrase) },
  { pattern: /^this year$/, build: (_, ctx) => wholeYear(ctx.year, ctx.phrase) },
  { pattern: /^this week$/, build: (_, ctx) => wholeWeek(ctx.questionDate, ctx.phrase) },
  {
    pattern: /^(?:in |back in |during |on )?(.+)$/,
    build: (match, ctx) => {
      const rest = match[1]!.split(" ")
      if (rest.length === 1 && YEAR.test(rest[0] ?? "")) return wholeYear(Number(rest[0]), ctx.phrase)

      const month = monthIndex(rest[0] ?? "")
      if (month === -1) return null
      const explicit = rest[1] !== undefined && YEAR.test(rest[1])
      if (rest.length === 1 || explicit) {
        const questionMonth = (Math.floor(ctx.questionDate / 100) % 100) - 1
        const targetYear = explicit
          ? Number(rest[1])
          : month <= questionMonth
            ? ctx.year
            : ctx.year - 1
        return wholeMonth(monthOf(targetYear, month), ctx.phrase)
      }
      const day = count(rest[1] ?? "")
      if (day === null || day < 1 || day > 31) return null
      if (rest[2] !== undefined && YEAR.test(rest[2])) {
        return singleDay(Number(rest[2]) * 10000 + (month + 1) * 100 + day, ctx.phrase)
      }
      const candidate = ctx.year * 10000 + (month + 1) * 100 + day
      return singleDay(candidate <= ctx.questionDate ? candidate : candidate - 10000, ctx.phrase)
    }
  },
  {
    pattern: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
    build: (match, ctx) =>
      singleDay(Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]), ctx.phrase)
  },
  {
    pattern: /^(\d{4})[-/](\d{1,2})$/,
    build: (match, ctx) => wholeMonth(Number(match[1]) * 10000 + Number(match[2]) * 100 + 1, ctx.phrase)
  },
  {
    pattern: /^(\d{1,2}) ([a-z]+) ((?:19|20)\d{2})$/,
    build: (match, ctx) => {
      const month = monthIndex(match[2]!)
      if (month === -1) return null
      return singleDay(Number(match[3]) * 10000 + (month + 1) * 100 + Number(match[1]), ctx.phrase)
    }
  }
]

export const resolveTimeInterval = (
  phrase: string | null,
  questionDate: number
): DayInterval | null => {
  if (phrase === null) return null
  const text = normalise(phrase)
  if (text === "") return null
  const ctx: ParseContext = { questionDate, year: Math.floor(questionDate / 10000), phrase }

  for (const rule of PARSE_TABLE) {
    const match = rule.pattern.exec(text)
    if (match === null) continue
    const interval = rule.build(match, ctx)
    if (interval !== null) return interval
  }
  return null
}

export const intervalSentence = (interval: DayInterval): string => {
  const readable = (dateInt: number): string =>
    `${Math.floor(dateInt / 10000)}-${String(Math.floor(dateInt / 100) % 100).padStart(2, "0")}-` +
    `${String(dateInt % 100).padStart(2, "0")}`
  return (
    `The question refers to the period "${interval.phrase}", which is ` +
    `${readable(interval.start)} up to but not including ${readable(interval.end)}.`
  )
}

export interface TimeScopable {
  /** `YYYYMMDD`, with `YYYYMM00` for month precision and `YYYY0000` for year. `0` when unknown. */
  readonly tEvent: number
  readonly tPrec: string
  /** The date of the conversation the claim came from. */
  readonly sessionDate: number
}

export const UNDATED_SESSION_SLACK_DAYS = 7

export const claimSpan = (claim: TimeScopable): { readonly start: number; readonly end: number } | null => {
  if (claim.tEvent === 0) return null
  if (claim.tPrec === "year") {
    const year = Math.floor(claim.tEvent / 10000)
    return { start: year * 10000 + 101, end: (year + 1) * 10000 + 101 }
  }
  if (claim.tPrec === "month") {
    const first = claim.tEvent - (claim.tEvent % 100) + 1
    return { start: first, end: monthStart(first, 1) }
  }
  return { start: claim.tEvent, end: addDays(claim.tEvent, 1) }
}

const overlaps = (
  a: { readonly start: number; readonly end: number },
  b: { readonly start: number; readonly end: number }
): boolean => a.start < b.end && b.start < a.end

export const inScope = (claim: TimeScopable, interval: DayInterval): boolean => {
  const span = claimSpan(claim)
  if (span !== null) return overlaps(span, interval)
  const widened = {
    start: addDays(interval.start, -UNDATED_SESSION_SLACK_DAYS),
    end: addDays(interval.end, UNDATED_SESSION_SLACK_DAYS)
  }
  return claim.sessionDate >= widened.start && claim.sessionDate < widened.end
}

export const MIN_IN_SCOPE_TO_DROP_REST = 10

export interface TimeScopeReport<A> {
  readonly claims: ReadonlyArray<A>
  readonly inScope: number
  readonly outOfScope: number
  /** False when the question carried no resolvable time phrase. */
  readonly applied: boolean
}

export const applyTimeScope = <A extends TimeScopable>(
  claims: ReadonlyArray<A>,
  interval: DayInterval | null
): TimeScopeReport<A> => {
  if (interval === null) {
    return { claims, inScope: 0, outOfScope: 0, applied: false }
  }
  const within: Array<A> = []
  const outside: Array<A> = []
  for (const claim of claims) (inScope(claim, interval) ? within : outside).push(claim)
  const kept = within.length >= MIN_IN_SCOPE_TO_DROP_REST ? within : [...within, ...outside]
  return {
    claims: kept,
    inScope: within.length,
    outOfScope: outside.length,
    applied: true
  }
}
