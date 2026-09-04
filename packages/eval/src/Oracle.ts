import type { DatasetQuestion } from "@palimpsest/dataset"
import type { HydratedSpan } from "@palimpsest/palimpsest"

/** Reading ceiling: the answer sessions' turns, whole; matches on `sid`, so a duplicated sid includes both revisions. */
export const oracleSessionSpans = (question: DatasetQuestion): ReadonlyArray<HydratedSpan> => {
  const answers = new Set(question.answerSessionIds)
  return [...question.sessions]
    .filter((session) => answers.has(session.sid))
    .sort((a, b) => a.sessionOrd - b.sessionOrd)
    .flatMap((session) =>
      session.turns.map(
        (turn): HydratedSpan => ({
          ckey: `oracle|${session.key}|${turn.turnIdx}`,
          id: `${session.sessionOrd}-${turn.turnIdx}`,
          sid: session.sid,
          sessionKey: session.key,
          turnIdx: turn.turnIdx,
          cs: 0,
          ce: turn.text.length,
          sessionOrd: session.sessionOrd,
          sessionDate: session.date.dateInt,
          tEvent: 0,
          speaker: turn.role,
          status: "CURRENT",
          atSession: null,
          excerpt: turn.text,
          highlight: { start: 0, end: 0 }
        })
      )
    )
}
