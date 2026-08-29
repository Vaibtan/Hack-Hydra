import type { DatasetQuestion } from "@palimpsest/dataset"
import type { HydratedSpan } from "@palimpsest/palimpsest"

/**
 * The reading ceiling: the answer sessions' turns, whole, and nothing else.
 *
 * This is not a retrieval system and is not meant to be beaten. It is the
 * number that says how much of the remaining gap is retrieval's to close: if
 * the same reader, given exactly the sessions the dataset says contain the
 * answer, still gets 12 % of the questions wrong, then 12 points are not
 * available to any amount of selection or scoping, and tuning retrieval further
 * is spending money on the wrong stage.
 *
 * `answer_session_ids` matches `session.sid`, not `session.key` — 13 of the 500
 * haystacks list the same sid twice with different dates, and the dataset's
 * label does not distinguish them. Both revisions are included, which is the
 * generous reading and the right one for a ceiling.
 */
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
