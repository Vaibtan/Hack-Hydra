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

const undouble = (base: string): string => {
  const last = base[base.length - 1]
  const previous = base[base.length - 2]
  return last !== undefined && last === previous && DOUBLES.includes(last)
    ? base.slice(0, -1)
    : base
}

export const stem = (word: string): string => {
  if (word.length <= 3) return word

  // Object.hasOwn: IRREGULAR["constructor"] would otherwise be Object.prototype.constructor and throw.
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

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu

export const stems = (text: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0].replace(/['’]s$/, "")
    if (word.length < 2) continue
    if (STOPWORDS.has(word)) continue
    const stemmed = stem(word)
    if (stemmed.length < 2) continue
    out.push(stemmed)
  }
  return out
}

/** The spec's cap: at most this many Tokens hang off any one Claim. */
export const MAX_TOKENS_PER_CLAIM = 24

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
