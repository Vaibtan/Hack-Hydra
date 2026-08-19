import type { LanguageModel } from "@effect/ai"
import type { DatasetSession } from "@palimpsest/dataset"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"

/**
 * Claim extraction: one LLM call per session.
 *
 * The output is deliberately *not* character offsets. Asking a model for `cs`
 * and `ce` produces spans that are usually a few characters off and sometimes
 * nonsense; asking it to copy the evidence verbatim and locating that string
 * ourselves makes the span exact by construction. `Span` is still
 * `(turn_idx, cs, ce)` — it is just computed here rather than guessed there.
 */

export const ENTITY_TYPES = ["person", "pet", "place", "org", "thing", "event", "topic", "self"] as const

/**
 * A closed-ish attribute vocabulary. Slot collisions are what makes supersession
 * fire at all, so two sessions describing the same thing must land on the same
 * `attr`; free-form values are allowed but the prompt pushes hard toward these.
 */
export const ATTRIBUTE_VOCABULARY = [
  "residence",
  "employer",
  "job_title",
  "name",
  "age",
  "birthday",
  "pet_name",
  "pet_type",
  "weight",
  "height",
  "phone",
  "email",
  "address",
  "plan",
  "deadline",
  "schedule",
  "status",
  "preference",
  "count",
  "price",
  "brand",
  "model",
  "colour",
  "location",
  "relationship",
  "diagnosis",
  "medication",
  "goal",
  "hobby",
  "skill",
  "purchase_date",
  "start_date",
  "end_date"
] as const

const Entity = Schema.Struct({
  canon: Schema.String,
  etype: Schema.Literal(...ENTITY_TYPES),
  aliases: Schema.Array(Schema.String)
})

const Slot = Schema.Struct({
  entity_canon: Schema.String,
  attr: Schema.String
})

/**
 * `Schema.NullOr` rather than `Schema.optional`: OpenAI's strict structured
 * output requires every property to be present, with absence expressed as null.
 */
const RawClaim = Schema.Struct({
  text: Schema.String,
  speaker: Schema.Literal("user", "assistant"),
  ctype: Schema.Literal("fact", "event", "preference", "assistant_output"),
  entities: Schema.Array(Entity),
  slot: Schema.NullOr(Slot),
  /** `YYYY-MM-DD`, `YYYY-MM` or `YYYY`, resolved against the session date. */
  t_event: Schema.NullOr(Schema.String),
  turn_idx: Schema.Number,
  /** Copied verbatim out of that turn. We locate it; the model does not count. */
  evidence_quote: Schema.String,
  keywords: Schema.Array(Schema.String)
})

const RawExtraction = Schema.Struct({ claims: Schema.Array(RawClaim) })

export type RawClaim = typeof RawClaim.Type

/** How a Span was recovered from the model's quote. Reported, never hidden. */
export type LocatedBy = "exact" | "normalised" | "markdown"

export interface Span {
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
}

export interface ExtractedEntity {
  readonly canon: string
  readonly etype: (typeof ENTITY_TYPES)[number]
  readonly aliases: ReadonlyArray<string>
}

export interface ExtractedClaim {
  readonly text: string
  readonly speaker: "user" | "assistant"
  readonly ctype: "fact" | "event" | "preference" | "assistant_output"
  readonly entities: ReadonlyArray<ExtractedEntity>
  readonly slot: { readonly entityCanon: string; readonly attr: string } | null
  /** `YYYYMMDD` with unknown parts zeroed, or 0 when the model gave no date. */
  readonly tEvent: number
  readonly tPrec: "day" | "month" | "year" | "none"
  readonly span: Span
  readonly keywords: ReadonlyArray<string>
  readonly located: LocatedBy
}

export interface DroppedClaim {
  readonly reason: "span_not_found" | "empty_quote" | "bad_turn_idx"
  readonly turnIdx: number
  readonly quote: string
  readonly text: string
}

export interface SessionExtraction {
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: ReadonlyArray<ExtractedClaim>
  readonly dropped: ReadonlyArray<DroppedClaim>
  readonly cached: boolean
}

/**
 * Markdown emphasis, list bullets and heading markers. Models reliably drop
 * these when asked to quote — `**Zillow**: filter by price` comes back as
 * `Zillow: filter by price` — so a quote that differs only by them is the same
 * span, not a hallucination.
 */
const MARKDOWN_NOISE = new Set(["*", "_", "`", "#", "~"])

/**
 * Collapses runs of whitespace (and optionally markdown noise), remembering
 * which original index every kept character came from, so a match in the
 * normalised text maps back to a real span.
 */
const normalise = (
  text: string,
  stripMarkdown = false
): { readonly value: string; readonly origin: ReadonlyArray<number> } => {
  let value = ""
  const origin: Array<number> = []
  let previousWasSpace = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (stripMarkdown && MARKDOWN_NOISE.has(char)) continue
    if (/\s/.test(char)) {
      if (previousWasSpace || value === "") continue
      value += " "
      origin.push(i)
      previousWasSpace = true
    } else {
      value += char
      origin.push(i)
      previousWasSpace = false
    }
  }
  return { value, origin }
}

/**
 * Turns the model's quote into a real span. Exact match first; otherwise match
 * on whitespace-normalised text and map the offsets back. Anything that still
 * does not match is dropped and reported — never written with a guessed offset.
 */
export const locateSpan = (
  turnText: string,
  quote: string
): { readonly cs: number; readonly ce: number; readonly located: LocatedBy } | null => {
  if (quote.trim() === "") return null

  const exact = turnText.indexOf(quote)
  if (exact !== -1) return { cs: exact, ce: exact + quote.length, located: "exact" }

  for (const [stripMarkdown, located] of [
    [false, "normalised"],
    [true, "markdown"]
  ] as const) {
    const haystack = normalise(turnText, stripMarkdown)
    const needle = normalise(quote, stripMarkdown)
    if (needle.value === "") continue
    const at = haystack.value.indexOf(needle.value)
    if (at === -1) continue

    const cs = haystack.origin[at]
    const endOrigin = haystack.origin[at + needle.value.length - 1]
    if (cs === undefined || endOrigin === undefined) continue
    return { cs, ce: endOrigin + 1, located }
  }
  return null
}

/** `2023-04-10` / `2023-04` / `2023` → a `YYYYMMDD` integer plus its precision. */
export const parseEventDate = (
  value: string | null
): { readonly tEvent: number; readonly tPrec: "day" | "month" | "year" | "none" } => {
  if (value === null) return { tEvent: 0, tPrec: "none" }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (day !== null) return { tEvent: Number(`${day[1]}${day[2]}${day[3]}`), tPrec: "day" }
  const month = /^(\d{4})-(\d{2})$/.exec(value)
  if (month !== null) return { tEvent: Number(`${month[1]}${month[2]}00`), tPrec: "month" }
  const year = /^(\d{4})$/.exec(value)
  if (year !== null) return { tEvent: Number(`${year[1]}0000`), tPrec: "year" }
  return { tEvent: 0, tPrec: "none" }
}

const SYSTEM = `You build a searchable memory index over a chat transcript.

You are given ONE conversation session between a user and an assistant, its date, the entities
already known about this user, and an attribute vocabulary. You return the atomic claims the session
establishes, each anchored to the exact words that support it.

What to extract
- Every atomic assertion the USER makes about themselves, their life, their possessions, their
  plans, their opinions and the people, pets, places and things around them.
- Content from ASSISTANT turns that the user could later ask about: schedules, itineraries, lists,
  recommendations, code, calculations, summaries, instructions. Use ctype "assistant_output".
- Preferences and dislikes, as ctype "preference" — including preferences about how the assistant
  should respond (tone, format, length).
- Dated events, as ctype "event", with t_event resolved.
- Be exhaustive. A fact you skip cannot be recalled later. When in doubt, extract it. Several small
  claims are better than one compound claim.
- One atomic fact per claim. "I moved to Brooklyn in March and got a hamster" is TWO claims.

Fields
- text: a self-contained sentence stating the claim, understandable with no other context. Resolve
  pronouns ("I" -> "the user"). Keep the user's own nouns.
- speaker: who said the supporting words, "user" or "assistant".
- ctype: "fact" | "event" | "preference" | "assistant_output".
- entities: every thing the claim is about, canonicalised — lowercase, singular, ASCII, no articles
  ("my hamster" -> "hamster", "the MoMA" -> "moma", "Charity 5K Run" -> "charity 5k run"). REUSE a
  canon from the known-entity list whenever it refers to the same thing; that is what links sessions
  together. The user themselves is always canon "me" with etype "self". Give aliases the user
  actually used.
- slot: a slot is one changeable property of one specific thing, and it exists so the memory can
  notice a LATER value REPLACING an earlier one. Set it only when a *different value for the same
  slot could later make this claim untrue*.
  - entity_canon is the thing the value belongs to, and it is almost never "me". The mortgage's
    amount is (mortgage, price), not (me, price). The laptop's brand is (laptop, brand). Only a
    genuine property of the person uses "me": residence, employer, job_title, age, weight, height,
    phone, email, birthday.
  - NEVER emit (me, preference). A preference belongs to the thing it is about — liking a meditation
    app is (headspace, preference), preferring a news source is (associated press, preference),
    wanting short videos is (comedy sketch, length). If the preference is not about one specific
    thing, set slot to null.
  - Two claims about the same property of the same thing MUST use the identical
    (entity_canon, attr) pair — that pairing is the only way the memory sees a replacement.
  - Amounts, prices, counts, dates, deadlines and statuses attached to a thing are the highest-value
    slots. "Pre-approved for $450,000" is (mortgage, price); a later "$500,000" must land there too.
  - Set slot to null for one-off events, observations, questions, opinions about nothing in
    particular, and anything additive — two hobbies, two items on a list, two symptoms.
- t_event: the date the claim is ABOUT, not the session date, as "YYYY-MM-DD", "YYYY-MM" or "YYYY".
  Resolve relative expressions against the session date ("last Tuesday", "three weeks ago",
  "March 15th" with no year). null when the claim has no date.
- turn_idx: the index of the turn the supporting words are in.
- evidence_quote: a CONTIGUOUS substring COPIED EXACTLY, character for character, from that turn's
  text — the shortest span that supports the claim. Do not paraphrase, re-punctuate, fix spelling,
  translate, or join two separated fragments. If you cannot copy it exactly, choose a longer span
  you can copy exactly.
- keywords: 4-12 search terms someone might use to look this claim up later. Include the specific
  words AND their hypernyms and synonyms ("jacket" -> clothing, apparel, outerwear; "hamster" ->
  pet, rodent, animal; "Wells Fargo" -> bank, mortgage, lender). This is how the claim gets found
  by a question that uses different words.

Return only claims grounded in this session's text.`

const renderPrompt = (
  session: DatasetSession,
  knownEntities: ReadonlyArray<ExtractedEntity>
): string => {
  const entityList =
    knownEntities.length === 0
      ? "(none yet — this is the first session)"
      : knownEntities
          .map((e) => `- ${e.canon} (${e.etype})${e.aliases.length > 0 ? ` aka ${e.aliases.join(", ")}` : ""}`)
          .join("\n")

  const turns = session.turns
    .map((turn) => `[turn ${turn.turnIdx} | ${turn.role}]\n${turn.text}`)
    .join("\n\n")

  return [
    `SESSION DATE: ${session.date.raw}`,
    "",
    "KNOWN ENTITIES FOR THIS USER:",
    entityList,
    "",
    `ATTRIBUTE VOCABULARY: ${ATTRIBUTE_VOCABULARY.join(", ")}`,
    "",
    "TRANSCRIPT:",
    turns
  ].join("\n")
}

export const extractSession = (
  session: DatasetSession,
  knownEntities: ReadonlyArray<ExtractedEntity> = []
): Effect.Effect<SessionExtraction, never, Llm | LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const generated = yield* llm
      .generateObject({
        kind: "extract",
        system: SYSTEM,
        prompt: renderPrompt(session, knownEntities),
        schema: RawExtraction,
        objectName: "claims"
      })
      .pipe(Effect.orDie)

    const claims: Array<ExtractedClaim> = []
    const dropped: Array<DroppedClaim> = []

    for (const raw of generated.value.claims) {
      const turn = session.turns[raw.turn_idx]
      if (turn === undefined) {
        dropped.push({
          reason: "bad_turn_idx",
          turnIdx: raw.turn_idx,
          quote: raw.evidence_quote,
          text: raw.text
        })
        continue
      }
      if (raw.evidence_quote.trim() === "") {
        dropped.push({ reason: "empty_quote", turnIdx: raw.turn_idx, quote: "", text: raw.text })
        continue
      }
      const span = locateSpan(turn.text, raw.evidence_quote)
      if (span === null) {
        dropped.push({
          reason: "span_not_found",
          turnIdx: raw.turn_idx,
          quote: raw.evidence_quote,
          text: raw.text
        })
        continue
      }
      const { tEvent, tPrec } = parseEventDate(raw.t_event)
      claims.push({
        text: raw.text,
        speaker: raw.speaker,
        ctype: raw.ctype,
        entities: raw.entities.map((entity) => ({
          canon: entity.canon,
          etype: entity.etype,
          aliases: entity.aliases
        })),
        slot:
          raw.slot === null ? null : { entityCanon: raw.slot.entity_canon, attr: raw.slot.attr },
        tEvent,
        tPrec,
        span: { turnIdx: raw.turn_idx, cs: span.cs, ce: span.ce },
        keywords: raw.keywords,
        located: span.located
      })
    }

    return {
      sid: session.sid,
      sessionOrd: session.sessionOrd,
      claims,
      dropped,
      cached: generated.cached
    }
  })

/** Merges the entities seen so far, so canon keys stay stable across sessions. */
export const mergeEntities = (
  known: ReadonlyArray<ExtractedEntity>,
  claims: ReadonlyArray<ExtractedClaim>
): ReadonlyArray<ExtractedEntity> => {
  const byCanon = new Map<string, { etype: ExtractedEntity["etype"]; aliases: Set<string> }>()
  for (const entity of known) {
    byCanon.set(entity.canon, { etype: entity.etype, aliases: new Set(entity.aliases) })
  }
  for (const claim of claims) {
    for (const entity of claim.entities) {
      const existing = byCanon.get(entity.canon)
      if (existing === undefined) {
        byCanon.set(entity.canon, { etype: entity.etype, aliases: new Set(entity.aliases) })
      } else {
        for (const alias of entity.aliases) existing.aliases.add(alias)
      }
    }
  }
  return [...byCanon.entries()]
    .map(([canon, value]) => ({ canon, etype: value.etype, aliases: [...value.aliases] }))
    .sort((a, b) => a.canon.localeCompare(b.canon))
}
