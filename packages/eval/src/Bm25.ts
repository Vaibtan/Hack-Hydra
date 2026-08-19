import type { DatasetQuestion, DatasetSession } from "@palimpsest/dataset"
import { stems, type HydratedSpan } from "@palimpsest/palimpsest"

/**
 * B1: BM25 over the user's turns.
 *
 * The point of this baseline is to isolate *the index structure*, so it shares
 * everything else with Palimpsest: the same `stems()` tokenizer on both sides,
 * the same reader prompt, the same judge. What differs is only how the ten
 * pieces of text handed to the reader were chosen — a term-frequency ranking
 * over turns, against anchor convergence over a claim graph.
 *
 * Dependency-free on purpose: a BM25 library would bring its own tokenizer and
 * the comparison would quietly become about that instead.
 */

/** Okapi BM25's usual constants; `b` is full length normalisation. */
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

/** Robertson/Sparck Jones idf, the form that stays positive for common terms. */
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

/**
 * The top-`k` turns, as spans the shared reader can read.
 *
 * The whole turn is the excerpt — BM25 selects turns, not spans, and cutting a
 * window out of one would mean inventing a span the baseline never produced.
 * Everything is labelled CURRENT because a term index has no notion of
 * supersession; that absence is the comparison.
 */
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

  // Chronological for the reader, exactly as the graph path orders its
  // evidence, so the only difference stays *which* text was chosen.
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
  sessionOrd: doc.session.sessionOrd,
  sessionDate: doc.session.date.dateInt,
  tEvent: 0,
  speaker: doc.role,
  status: "CURRENT",
  atSession: null,
  excerpt: doc.text,
  highlight: { start: 0, end: 0 }
})

/**
 * B2: the whole haystack, oldest turn first.
 *
 * `maxChars` is the truncation policy and it is documented rather than hidden:
 * when a haystack does not fit, the **oldest sessions are dropped** and the
 * results row records how many. Dropping the newest would flatter the baseline
 * on knowledge-update questions, which are exactly the ones it should find
 * hard.
 */
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
  // Walk newest first so the sessions that survive are the newest ones, then
  // put them back in order.
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
