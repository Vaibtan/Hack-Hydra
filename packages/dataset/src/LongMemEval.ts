/**
 * LongMemEval loader.
 *
 * Two files, one shape: `longmemeval_oracle.json` keeps only the answer-bearing
 * sessions and tags every turn with `has_answer`; `longmemeval_s_cleaned.json`
 * adds ~40-60 distractor sessions per question and carries `has_answer` only on
 * the turns where it is true. Both are read the same way here.
 *
 * The one trap: `haystack_dates` is not sorted. 211 of the 500 S questions and
 * 34 of the 500 oracle questions present their sessions out of chronological
 * order, so `session_ord` must come from the timestamp.
 */

export interface HaystackDate {
  /** The original string, kept so evidence can be shown as the dataset wrote it. */
  readonly raw: string
  /** Epoch seconds, UTC — the dataset carries no zone, so UTC keeps it deterministic. */
  readonly ts: number
  /** `YYYYMMDD`, the integer form HydraDB stores. */
  readonly dateInt: number
}

export type Role = "user" | "assistant"

export interface DatasetTurn {
  readonly turnIdx: number
  readonly role: Role
  readonly text: string
  /** Ground truth for extraction recall. Absent in the S file means false. */
  readonly hasAnswer: boolean
}

export interface DatasetSession {
  readonly sid: string
  /** 1-based rank by timestamp within the question; ties keep input order. */
  readonly sessionOrd: number
  readonly date: HaystackDate
  readonly turns: ReadonlyArray<DatasetTurn>
}

export interface DatasetQuestion {
  readonly questionId: string
  readonly questionType: string
  readonly question: string
  readonly answer: string
  readonly questionDate: HaystackDate
  /** Ordered by `sessionOrd`. */
  readonly sessions: ReadonlyArray<DatasetSession>
  readonly answerSessionIds: ReadonlyArray<string>
  /** The 30 questions whose correct answer is a refusal. */
  readonly isAbstention: boolean
}

export interface RawQuestion {
  readonly question_id: string
  readonly question_type: string
  readonly question: string
  readonly answer?: string
  readonly question_date: string
  readonly haystack_dates: ReadonlyArray<string>
  readonly haystack_session_ids: ReadonlyArray<string>
  readonly haystack_sessions: ReadonlyArray<ReadonlyArray<{ role: string; content: string; has_answer?: boolean }>>
  readonly answer_session_ids?: ReadonlyArray<string>
}

/** `2023/04/10 (Mon) 17:50` — the only timestamp format either file uses. */
const DATE_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]{3}\)\s+(\d{2}):(\d{2})$/

export const parseHaystackDate = (raw: string): HaystackDate => {
  const match = DATE_PATTERN.exec(raw.trim())
  if (match === null) throw new Error(`unrecognised LongMemEval timestamp: ${JSON.stringify(raw)}`)
  const [, y, mo, d, h, mi] = match as unknown as [string, string, string, string, string, string]
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  return {
    raw,
    ts: Date.UTC(year, month - 1, day, Number(h), Number(mi)) / 1000,
    dateInt: year * 10_000 + month * 100 + day
  }
}

export const parseQuestion = (raw: RawQuestion): DatasetQuestion => {
  const unordered = raw.haystack_sessions.map((turns, index) => ({
    index,
    sid: raw.haystack_session_ids[index] ?? `session_${index}`,
    date: parseHaystackDate(raw.haystack_dates[index] ?? ""),
    turns: turns.map((turn, turnIdx): DatasetTurn => ({
      turnIdx,
      role: turn.role === "assistant" ? "assistant" : "user",
      text: turn.content,
      hasAnswer: turn.has_answer === true
    }))
  }))

  // Sort by timestamp, falling back to file position so ties are stable and
  // reproducible regardless of the engine's sort implementation.
  const ordered = [...unordered].sort((a, b) => a.date.ts - b.date.ts || a.index - b.index)

  return {
    questionId: raw.question_id,
    questionType: raw.question_type,
    question: raw.question,
    answer: raw.answer ?? "",
    questionDate: parseHaystackDate(raw.question_date),
    sessions: ordered.map((session, i) => ({
      sid: session.sid,
      sessionOrd: i + 1,
      date: session.date,
      turns: session.turns
    })),
    answerSessionIds: raw.answer_session_ids ?? [],
    isAbstention: raw.question_id.endsWith("_abs")
  }
}
