import type { Route } from "./Understand.js"

export const NOT_IN_MEMORY = "NOT_IN_MEMORY"

export type Granularity = "span" | "turn"

/** What one route decides downstream of retrieval: hydration, adjudication, the sufficiency call and the reader's rules. */
export interface RouteRules {
  readonly granularity: Granularity
  /** Whether the latest CURRENT claim of a Slot is singled out as `CURRENT` and the rest `EARLIER STATEMENT`. */
  readonly adjudicate: boolean
  /** Whether the sufficiency check runs on this route at all. */
  readonly sufficiency: boolean
  /** The block appended to the reader's system prompt. */
  readonly rules: string
}

export const RoutePolicy: Readonly<Record<Route, RouteRules>> = {
  fact: {
    granularity: "span",
    adjudicate: true,
    sufficiency: false,
    rules: `- Answer in as few words as the question allows - a name, a number, a date, a short phrase.`
  },
  preference: {
    granularity: "turn",
    adjudicate: false,
    sufficiency: true,
    rules: `- Open by naming the personal facts from the excerpts that the preference rests on, then give
  the preference. A preference with no stated basis is indistinguishable from a guess.
- Keep any qualification the person gave alongside it ("but only for short trips").`
  },
  assistant_output: {
    granularity: "turn",
    adjudicate: false,
    sufficiency: false,
    rules: `- The excerpts include what the assistant said. Quote the relevant part verbatim rather than
  paraphrasing it: the question is about what was said, so a paraphrase is a different answer.
- If several suggestions were given, list them all, in the order they appear.`
  },
  update: {
    granularity: "span",
    adjudicate: true,
    sufficiency: true,
    rules: `- Give the value that is CURRENT. You may add what it replaced, as "previously X".
- An excerpt marked EARLIER STATEMENT is not necessarily wrong - it is what was said before
  something else about the same thing. Prefer the later one and say so.`
  },
  count: {
    granularity: "span",
    adjudicate: false,
    sufficiency: true,
    rules: `- Enumerate the items in plain words, then give the number. Do not give a bare number: a count
  the reader cannot check is a count nobody can trust.
- Count distinct things. Two excerpts describing one item are one item.`
  },
  temporal: {
    granularity: "span",
    adjudicate: false,
    sufficiency: true,
    rules: `- Do the date arithmetic explicitly: name the two dates, then give the interval, then the answer.
- The question's date is given above. Excerpt dates are the dates of the conversations, and an
  "about" date is when the thing itself happened - prefer that one when both are present.`
  },
  multi_fact: {
    granularity: "span",
    adjudicate: false,
    sufficiency: true,
    rules: `- The answer needs more than one excerpt. Name each fact you are combining and which excerpt it
  came from, then give the combined answer.
- If one of the facts you need is missing, say which, and answer ${NOT_IN_MEMORY}.`
  }
}

export const granularityFor = (route: Route | null, override?: Granularity): Granularity =>
  override ?? (route === null ? "span" : RoutePolicy[route].granularity)
