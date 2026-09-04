import type { DatasetQuestion, DatasetSession } from "@palimpsest/dataset"
import { stems, type HydratedSpan } from "@palimpsest/palimpsest"

/** Okapi BM25 defaults. */
export const K1 = 1.5
export const B = 0.75

export const BM25_TOP_K = 10

interface Doc {
  readonly session: DatasetSession
  readonly turnIdx: number
  readonly role: string
  readonly text: string
  readonly terms: ReadonlyArray<string>
  readonly length: number
}

export interface Bm25Index {
  readonly docs: ReadonlyArray<Doc>
  readonly df: ReadonlyMap<string, number>
  readonly avgLength: number
}

export const buildIndex = (question: DatasetQuestion): Bm25Index => {
  const docs: Array<Doc> = []
  for (const session of question.sessions) {
    for (const turn of session.turns) {
      const terms = [...stems(turn.text)]
      docs.push({
        session,
        turnIdx: turn.turnIdx,
        role: turn.role,
        text: turn.text,
        terms,
        length: terms.length
      })
    }
  }

  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) df.set(term, (df.get(term) ?? 0) + 1)
  }

  const total = docs.reduce((n, doc) => n + doc.length, 0)
  return { docs, df, avgLength: docs.length === 0 ? 1 : total / docs.length }
}

const idf = (df: number, n: number): number => Math.log(1 + (n - df + 0.5) / (df + 0.5))

export const score = (index: Bm25Index, doc: Doc, queryTerms: ReadonlyArray<string>): number => {
  const tf = new Map<string, number>()
  for (const term of doc.terms) tf.set(term, (tf.get(term) ?? 0) + 1)

  let total = 0
  for (const term of new Set(queryTerms)) {
    const f = tf.get(term)
    if (f === undefined) continue
    const norm = 1 - B + (B * doc.length) / index.avgLength
    total += idf(index.df.get(term) ?? 0, index.docs.length) * ((f * (K1 + 1)) / (f + K1 * norm))
  }
  return total
}

/** Top-`k` whole turns as spans, chronological, all CURRENT. */
export const topSpans = (
  question: DatasetQuestion,
  index: Bm25Index,
  k: number = BM25_TOP_K
): ReadonlyArray<HydratedSpan> => {
  const queryTerms = [...stems(question.question)]
  const ranked = index.docs
    .map((doc) => ({ doc, score: score(index, doc, queryTerms) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.doc.session.sessionOrd - b.doc.session.sessionOrd ||
        a.doc.turnIdx - b.doc.turnIdx
    )
    .slice(0, k)

  return [...ranked]
    .sort(
      (a, b) =>
        a.doc.session.sessionOrd - b.doc.session.sessionOrd || a.doc.turnIdx - b.doc.turnIdx
    )
    .map(({ doc }) => asSpan(doc))
}

const asSpan = (doc: Doc): HydratedSpan => ({
  ckey: `bm25|${doc.session.key}|${doc.turnIdx}`,
  id: `${doc.session.sessionOrd}-${doc.turnIdx}`,
  sid: doc.session.sid,
  sessionKey: doc.session.key,
  turnIdx: doc.turnIdx,
  cs: 0,
  ce: doc.text.length,
  sessionOrd: doc.session.sessionOrd,
  sessionDate: doc.session.date.dateInt,
  tEvent: 0,
  speaker: doc.role,
  status: "CURRENT",
  atSession: null,
  excerpt: doc.text,
  highlight: { start: 0, end: 0 }
})

/** B2: the whole haystack; over `maxChars` the oldest sessions are dropped. */
export interface FullContext {
  readonly spans: ReadonlyArray<HydratedSpan>
  readonly sessionsDropped: number
  readonly chars: number
}

export const fullContextSpans = (
  question: DatasetQuestion,
  maxChars: number
): FullContext => {
  const sessions = [...question.sessions].sort((a, b) => a.sessionOrd - b.sessionOrd)

  let chars = 0
  const kept: Array<DatasetSession> = []
  for (const session of [...sessions].reverse()) {
    const size = session.turns.reduce((n, turn) => n + turn.text.length, 0)
    if (kept.length > 0 && chars + size > maxChars) break
    kept.push(session)
    chars += size
  }
  kept.reverse()

  const spans = kept.flatMap((session) =>
    session.turns.map((turn) =>
      asSpan({
        session,
        turnIdx: turn.turnIdx,
        role: turn.role,
        text: turn.text,
        terms: [],
        length: 0
      })
    )
  )

  return { spans, sessionsDropped: sessions.length - kept.length, chars }
}
