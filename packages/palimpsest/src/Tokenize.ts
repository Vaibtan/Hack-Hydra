/**
 * Anchors.
 *
 * A Token is a normalised content term. The same function runs at ingest (over
 * claim text, keywords and entity names) and at question time (over the
 * question and its LLM-expanded terms) — that symmetry is the whole mechanism:
 * it is what turns the graph into an inverted index, so an `MSpaths` call from
 * question tokens to Claims *is* the retrieval.
 *
 * Deliberately dumb and deterministic: lowercase, strip punctuation, drop
 * stopwords, strip a few English suffixes. Anything cleverer would have to be
 * reproduced exactly on both sides, and a stemmer that disagrees with itself
 * across versions silently destroys recall.
 */

/**
 * Function words only. Content-ish words that a naive list would include —
 * "new", "old", "time", "day", "count" — are deliberately kept: they are
 * exactly what `knowledge-update` and `temporal-reasoning` questions turn on.
 */
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as",
  "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can",
  "did", "do", "does", "doing", "done", "down", "during", "each", "few", "for", "from", "further",
  "get", "got", "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me",
  "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "ourselves", "out", "over", "own", "re", "s", "said", "same",
  "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "us", "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "would", "you", "your", "yours", "yourself", "yourselves",
  "user", "assistant"
])

/** Words whose plural is irregular enough that suffix stripping gets it wrong. */
const IRREGULAR: Record<string, string> = {
  children: "child",
  people: "person",
  men: "man",
  women: "woman",
  teeth: "tooth",
  feet: "foot",
  mice: "mouse",
  geese: "goose",
  wives: "wife",
  knives: "knife",
  lives: "life",
  leaves: "leaf"
}

const DOUBLES = "bdfglmnprt"

/** "runn" -> "run": undoes the consonant doubled before `-ing` / `-ed`. */
const undouble = (base: string): string => {
  const last = base[base.length - 1]
  const previous = base[base.length - 2]
  return last !== undefined && last === previous && DOUBLES.includes(last)
    ? base.slice(0, -1)
    : base
}

/**
 * Strips the handful of suffixes that actually cost recall on this dataset.
 *
 * What matters is not linguistic accuracy but *agreement*: every surface form
 * of a word must land on the same string, because ingest and the question meet
 * only at that string. A stemmer mapping "moved" and "move" to different keys
 * loses the claim silently. So the trailing `e` is stripped from every form
 * rather than restored on some — "move", "moved" and "moving" all become "mov".
 * Over-merging costs a little precision, which convergence scoring absorbs;
 * under-merging costs recall, which nothing downstream recovers.
 */
export const stem = (word: string): string => {
  if (word.length <= 3) return word

  // `Object.hasOwn`, not `IRREGULAR[word]`: a plain object literal inherits
  // `Object.prototype`, so `IRREGULAR["constructor"]` is the Object constructor
  // *function* and `base.endsWith` then throws. `stems` lowercases first, so
  // "constructor" is the only word in the language that reaches this — and it
  // reaches it in any conversation about code. It crashed the BM25 baseline,
  // which tokenises every turn of a haystack rather than only claim text.
  //
  // This cannot move an existing `tkey`: the input it changes previously threw,
  // so it never produced a token to move.
  const irregular = Object.hasOwn(IRREGULAR, word) ? IRREGULAR[word] : undefined
  let base = irregular ?? word

  if (irregular === undefined) {
    if (base.endsWith("ies") && base.length > 4) {
      base = `${base.slice(0, -3)}y`
    } else if (base.endsWith("sses") || base.endsWith("shes") || base.endsWith("ches")) {
      base = base.slice(0, -2)
    } else if (
      base.endsWith("s") &&
      !base.endsWith("ss") &&
      !base.endsWith("us") &&
      !base.endsWith("is")
    ) {
      base = base.slice(0, -1)
    } else if (base.endsWith("ing") && base.length > 5) {
      base = undouble(base.slice(0, -3))
    } else if (base.endsWith("ed") && base.length > 4) {
      base = undouble(base.slice(0, -2))
    }
  }

  if (base.endsWith("e") && base.length > 3) base = base.slice(0, -1)
  return base
}

/**
 * Splits on anything that is not a letter or digit, keeping an internal
 * apostrophe, so `Wells Fargo's`, `39.7 lbs` and `gpt-4o` all behave.
 */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu

export const stems = (text: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0].replace(/['’]s$/, "")
    if (word.length < 2) continue
    // Stopwords are checked on the surface form only: "note" stems to "not",
    // and dropping it because the *stem* collides with a function word would
    // throw away a perfectly good anchor.
    if (STOPWORDS.has(word)) continue
    const stemmed = stem(word)
    if (stemmed.length < 2) continue
    out.push(stemmed)
  }
  return out
}

/** The spec's cap: at most this many Tokens hang off any one Claim. */
export const MAX_TOKENS_PER_CLAIM = 24

/**
 * Tokens for one Claim, from its text, its LLM-supplied keywords, and the names
 * and aliases of the entities it mentions. Keywords come first because they are
 * the write-time query expansion — the hypernyms and synonyms a question is
 * likely to use — and they must survive the cap.
 */
export const claimTokens = (input: {
  readonly text: string
  readonly keywords: ReadonlyArray<string>
  readonly entityNames: ReadonlyArray<string>
}): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const ordered: Array<string> = []
  const add = (source: string) => {
    for (const token of stems(source)) {
      if (seen.has(token)) continue
      seen.add(token)
      ordered.push(token)
    }
  }
  for (const keyword of input.keywords) add(keyword)
  for (const name of input.entityNames) add(name)
  add(input.text)
  return ordered.slice(0, MAX_TOKENS_PER_CLAIM)
}
