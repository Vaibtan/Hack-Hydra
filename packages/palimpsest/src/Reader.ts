import type { LanguageModel } from "@effect/ai"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import { turnKey } from "./Keys.js"
import { adjudicate, applyBudget, dedupeByTurn, spanHash, type PackLabel } from "./Pack.js"
import type { AsOfLabelled } from "./Scoring.js"
import type { Route } from "./Understand.js"

/**
 * Reading an answer out of evidence.
 *
 * The reader never sees a Claim's text. A Claim is an *index entry* — a
 * paraphrase produced by an earlier model — and answering from it would make
 * the whole system a summary-of-a-summary. What the reader sees is the verbatim
 * turn text around each Span, which is the thing the graph was built to point
 * at. Claims survive only as ordering, labels and citation ids.
 */

/** Characters of surrounding turn text given on each side of a Span. */
export const SPAN_CONTEXT = 300

/**
 * Cuts a Span out of its turn with context on both sides, and reports where the
 * span sits inside the cut so a UI can highlight it. Clamped at both ends: a
 * span at the very start or end of a turn must not produce a negative offset or
 * one past the excerpt.
 */
export const cutExcerpt = (
  text: string,
  cs: number,
  ce: number,
  context = SPAN_CONTEXT
): { readonly excerpt: string; readonly highlight: { readonly start: number; readonly end: number } } => {
  const from = Math.max(0, Math.min(cs, text.length))
  const to = Math.max(from, Math.min(ce, text.length))
  const start = Math.max(0, from - context)
  const end = Math.min(text.length, to + context)
  const excerpt = text.slice(start, end)
  return {
    excerpt,
    highlight: { start: from - start, end: Math.min(excerpt.length, to - start) }
  }
}

/**
 * How much of the turn the reader is shown.
 *
 * `span` is v1: the Span plus 300 characters either side. `turn` is the whole
 * turn, prefixed by the one before it.
 *
 * The distinction is not a knob, it is two different questions. "What is my
 * dog's name" is answered by a sentence, and the surrounding paragraph is
 * noise. "What did you suggest when I asked about the chess opening" is
 * answered by a whole assistant message — the Span points at the one line the
 * extractor found quotable, and the answer is the list of five things around
 * it. v1 showed a span for both and lost the second kind by construction.
 */
export type Granularity = "span" | "turn"

/**
 * The routes read at whole-turn granularity.
 *
 * `assistant_output` because the answer *is* the message. `preference` because
 * a stated preference is usually qualified in the same breath — "I like it, but
 * only for short trips" — and a 300-character window cuts the qualification off
 * as often as it keeps it.
 *
 * Not `fact`, `count`, `update`, `temporal` or `multi_fact`: those need many
 * claims in one budget, and whole turns would spend it on three of them.
 */
export const TURN_ROUTES: ReadonlyArray<Route> = ["assistant_output", "preference"]

export const granularityFor = (route: Route | null, override?: Granularity): Granularity =>
  override ?? (route !== null && TURN_ROUTES.includes(route) ? "turn" : "span")

export interface HydratedSpan {
  readonly ckey: string
  /** Short, stable id the reader cites — the claim key's tail. */
  readonly id: string
  readonly sid: string
  /** The Session key (`sid` plus `#n` where a haystack repeats one), for Turn keys. */
  readonly sessionKey: string
  readonly turnIdx: number
  /** The Span's own character offsets into the turn. What the span hash covers. */
  readonly cs: number
  readonly ce: number
  readonly sessionOrd: number
  readonly sessionDate: number
  readonly tEvent: number
  readonly speaker: string
  readonly status: "CURRENT" | "SUPERSEDED"
  readonly atSession: number | null
  /** Verbatim turn text, cut to the span plus context on both sides. */
  readonly excerpt: string
  /** Where the span sits inside `excerpt`, so a UI can highlight it. */
  readonly highlight: { readonly start: number; readonly end: number }
  /**
   * The pack label, when the pack stage ran. `CURRENT` on its own means "not
   * superseded"; `EARLIER STATEMENT` means another CURRENT claim in the same
   * Slot was stated later. Absent on v1 and on every baseline, which is why
   * `renderReaderPrompt` falls back to the status.
   */
  readonly label?: PackLabel
}

const Answer = Schema.Struct({
  answer: Schema.String,
  cited_ids: Schema.Array(Schema.String),
  /** The model's own date arithmetic, when the question needed any. */
  reasoning: Schema.String
})

/**
 * The premise-checking variant. A question can be unanswerable because its
 * *presupposition* is false rather than because the evidence is thin —
 * "how many engineers do I lead as Software Engineer Manager?" asked by
 * someone who never became a manager. Retrieval reaches real claims about
 * engineers and counts, converges hard, and the reader answers a number. The
 * count is real; the premise is not.
 *
 * Whether making the reader test the premise helps is an empirical question
 * with a cost — it can only trade abstention recall against false abstention on
 * answerable questions — so both variants exist and the eval runs the A/B.
 */
const PremiseAnswer = Schema.Struct({
  answer: Schema.String,
  cited_ids: Schema.Array(Schema.String),
  reasoning: Schema.String,
  /** Every presupposition of the question is supported by the excerpts. */
  premise_supported: Schema.Boolean,
  /** Which presupposition failed, when one did. */
  premise_note: Schema.String
})

export const NOT_IN_MEMORY = "NOT_IN_MEMORY"

const SYSTEM = `You answer a question about one person using only the transcript excerpts given.

The excerpts are verbatim quotes from that person's past conversations with an assistant. Each is
labelled with its date, who was speaking, and whether the memory still considers it CURRENT or
SUPERSEDED by a later statement.

Rules
- Answer ONLY from the excerpts. Do not use anything you know about the world.
- If the excerpts do not contain the answer, reply with exactly ${NOT_IN_MEMORY} as the answer, and
  nothing else. A wrong answer is worse than no answer.
- Prefer CURRENT excerpts. A SUPERSEDED excerpt records what was true earlier, so use it only when
  the question asks what *was* the case, or how something changed.
- Do date arithmetic explicitly in the reasoning field: name the two dates, then give the interval.
  The question's date is given; excerpt dates are the dates of the conversations.
- For a counting question, count the distinct items in the excerpts and say the number.
- Answer in as few words as the question allows — a name, a number, a date, a short phrase. Do not
  restate the question or explain unless the question asks why.
- cited_ids: the ids of the excerpts you actually used. Cite at least one whenever you answer.`

const PREMISE_RULE = `
- Before answering, check every presupposition of the question against the excerpts — that the
  person has the thing, holds the role, did the event, made the purchase. A question can name
  something that never happened and still overlap the excerpts heavily. If a presupposition is
  contradicted by the excerpts, or simply absent from them, set premise_supported to false, name the
  failing presupposition in premise_note, and answer exactly ${NOT_IN_MEMORY}.
- premise_supported: true only when every presupposition holds. premise_note: empty when it does.`

const PREMISE_SYSTEM = SYSTEM + PREMISE_RULE

/**
 * The reader's prompt. Exported so the excerpt-order label can be tested
 * against the order `orderEvidence` actually produces — they disagreed, and
 * exactly on the questions where it mattered.
 */
export const renderReaderPrompt = (
  question: string,
  questionDate: string,
  spans: ReadonlyArray<HydratedSpan>
): string => {
  const body = spans.map((span) => {
    const status =
      span.status === "SUPERSEDED"
        ? `SUPERSEDED by a later statement (at session ${span.atSession})`
        : // `EARLIER STATEMENT` is a weaker claim than SUPERSEDED and has to
          // read like one: the memory did not infer a replacement, it only
          // knows something else about the same slot was said afterwards.
          span.label === "EARLIER STATEMENT"
          ? "EARLIER STATEMENT about the same thing"
          : "CURRENT"
    const dated = span.tEvent > 0 ? `, about ${span.tEvent}` : ""
    return [
      `[${span.id}] session ${span.sessionOrd} on ${span.sessionDate}${dated}, ${span.speaker}, ${status}`,
      span.excerpt
    ].join("\n")
  })

  return [
    `QUESTION DATE: ${questionDate}`,
    `QUESTION: ${question}`,
    "",
    // `orderEvidence` puts CURRENT before SUPERSEDED unless the question is
    // historical, so "oldest first" was wrong exactly when supersession
    // mattered — on the knowledge-update questions. Say what the order is.
    `EXCERPTS (${spans.length}), CURRENT first and then superseded, each group oldest first:`,
    "",
    body.join("\n\n")
  ].join("\n")
}


/**
 * The route-specific block appended to the system prompt.
 *
 * v1 had one prompt for every question, and its instructions were tuned for the
 * common case: "answer in as few words as the question allows". That rule is
 * right for `fact` and actively wrong everywhere else — it tells a count
 * question to say "five" without saying five of what, and a preference question
 * to name a preference without the facts that justify it, which is the shape
 * the judge marks wrong.
 *
 * So the terse rule survives only on `fact`, and each other route gets the
 * instruction its own failure mode needs. There is one system prompt with a
 * block appended, not seven prompts: a divergence between them would be
 * invisible and would show up as an unexplained per-route accuracy difference.
 */
export const ROUTE_RULES: Readonly<Record<Route, string>> = {
  fact: `- Answer in as few words as the question allows - a name, a number, a date, a short phrase.`,
  preference: `- Open by naming the personal facts from the excerpts that the preference rests on, then give
  the preference. A preference with no stated basis is indistinguishable from a guess.
- Keep any qualification the person gave alongside it ("but only for short trips").`,
  assistant_output: `- The excerpts include what the assistant said. Quote the relevant part verbatim rather than
  paraphrasing it: the question is about what was said, so a paraphrase is a different answer.
- If several suggestions were given, list them all, in the order they appear.`,
  update: `- Give the value that is CURRENT. You may add what it replaced, as "previously X".
- An excerpt marked EARLIER STATEMENT is not necessarily wrong - it is what was said before
  something else about the same thing. Prefer the later one and say so.`,
  count: `- Enumerate the items in plain words, then give the number. Do not give a bare number: a count
  the reader cannot check is a count nobody can trust.
- Count distinct things. Two excerpts describing one item are one item.`,
  temporal: `- Do the date arithmetic explicitly: name the two dates, then give the interval, then the answer.
- The question's date is given above. Excerpt dates are the dates of the conversations, and an
  "about" date is when the thing itself happened - prefer that one when both are present.`,
  multi_fact: `- The answer needs more than one excerpt. Name each fact you are combining and which excerpt it
  came from, then give the combined answer.
- If one of the facts you need is missing, say which, and answer ${"NOT_IN_MEMORY"}.`
}

/**
 * The system prompt for one route.
 *
 * `null` is v1 and every baseline: one prompt, unchanged, byte for byte. That
 * is what `--reader-route=off` selects too, so the ablation measures the rules
 * block and nothing else.
 */
export const systemFor = (route: Route | null, premiseCheck: boolean): string => {
  const base = premiseCheck ? PREMISE_SYSTEM : SYSTEM
  return route === null ? base : `${base}\n\nFor this question in particular:\n${ROUTE_RULES[route]}`
}

export interface ReadOptions {
  /**
   * Make the reader test the question's presuppositions before answering.
   * Off by default: it is a measured trade, not a strict improvement, and the
   * numbers for both variants are in `results/table-*.md`.
   */
  readonly premiseCheck?: boolean
  /**
   * The v2 pack stage. Absent means v1's behaviour exactly — span granularity,
   * no labels, no budget — which is what keeps v1's evidence byte-identical
   * while both pipelines run against one graph.
   */
  readonly pack?: PackOptions
  /**
   * Appends the route's rules block to the system prompt. Absent is v1's single
   * prompt, unchanged — which is what `--reader-route=off` selects.
   */
  readonly route?: Route | null
}

export interface PackOptions {
  /** Decides granularity and whether a Slot's latest claim is singled out. */
  readonly route: Route
  /** Overrides the route's granularity, for the `--granularity` ablation. */
  readonly granularity?: Granularity
  /** Which Slot each claim fills, from `plan.slots`. */
  readonly slotOf?: ReadonlyMap<string, string>
  /** Never dropped by the budget — the probe hits the question named outright. */
  readonly protectedKeys?: ReadonlySet<string>
  readonly budgetTokens?: number
}

export interface ReadAnswer {
  readonly answer: string
  readonly notInMemory: boolean
  readonly citedIds: ReadonlyArray<string>
  readonly reasoning: string
  readonly spans: ReadonlyArray<HydratedSpan>
  readonly cached: boolean
  /** Null unless the premise check ran. */
  readonly premiseSupported: boolean | null
  readonly premiseNote: string
  /** What this read cost the provider — the "reader tokens" column of the eval. */
  readonly inputTokens: number
  readonly outputTokens: number
  /**
   * Wall time of the HydraDB hydration, so the eval can add it to the ask's
   * `graphMs` and report the whole graph cost. Zero when the spans were already
   * in hand (`readSpans`, and every baseline).
   */
  readonly hydrateMs: number
  /** Wall time of the reader's own LLM call. */
  readonly readMs: number
  /**
   * sha256 over the hydrated span tuples — session key, turn, char range.
   *
   * The claim-key hash answers "did retrieval choose the same claims", which is
   * a question about the index. A judge replaying an answer is asking "did the
   * reader see the same bytes", and two different claims can point at one span
   * while one claim can be hydrated at two granularities.
   */
  readonly spanHash: string
  readonly granularity: Granularity
  /** The chars/4 estimate of what was packed, and what the budget dropped. */
  readonly estimatedTokens: number
  readonly budgetDropped: number
  /**
   * The sessions the budget cut. A recall miss that happened *here* is neither
   * retrieval's nor selection's, and the error-class table has to be able to
   * say so.
   */
  readonly budgetDroppedSessions: ReadonlyArray<string>
  /** The first answer cited nothing that exists and the reader was asked again. */
  readonly recited: boolean
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const llm = yield* Llm

  /**
   * Fetches the verbatim turn text behind each evidence Span, in one round
   * trip, by walking the `EVIDENCE` edge each Claim already carries.
   */
  const hydrate = (
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadonlyArray<HydratedSpan>, HydraError> =>
    Effect.gen(function* () {
      if (evidence.length === 0) return []

      const paths = yield* hydra.msPaths({
        sourceLabel: "Claim",
        sourceProperty: "ckey",
        sourceValues: evidence.map((claim) => claim.ckey),
        relTypes: ["EVIDENCE"],
        relDirection: "outgoing",
        maxLen: 1
      })

      const turnText = new Map<string, { text: string; chunks: number }>()
      for (const path of paths) {
        const claim = path.nodes[0]
        const turn = path.nodes[path.nodes.length - 1]
        if (claim === undefined || turn === undefined || claim === turn) continue
        turnText.set(String(claim.properties["ckey"] ?? ""), {
          text: String(turn.properties["text"] ?? ""),
          chunks: Number(turn.properties["chunks"] ?? 1)
        })
      }

      // A turn longer than HydraDB's 32 743-byte string cap spilled into
      // HAS_CHUNK vertices; reassemble only those, and only when the span
      // actually reaches past the first chunk.
      const needsChunks = evidence.filter((claim) => {
        const turn = turnText.get(claim.ckey)
        return turn !== undefined && turn.chunks > 1 && claim.ce > turn.text.length
      })
      if (needsChunks.length > 0) {
        const chunkPaths = yield* hydra.msPaths({
          sourceLabel: "Claim",
          sourceProperty: "ckey",
          sourceValues: needsChunks.map((claim) => claim.ckey),
          relTypes: ["EVIDENCE", "HAS_CHUNK"],
          relDirection: "outgoing",
          maxLen: 2
        })
        const extra = new Map<string, Array<{ idx: number; text: string }>>()
        for (const path of chunkPaths) {
          if (path.relationships.length !== 2) continue
          const ckey = String(path.nodes[0]?.properties["ckey"] ?? "")
          const chunk = path.nodes[2]
          if (chunk === undefined) continue
          const bucket = extra.get(ckey) ?? []
          bucket.push({
            idx: Number(chunk.properties["chunk_idx"] ?? 0),
            text: String(chunk.properties["text"] ?? "")
          })
          extra.set(ckey, bucket)
        }
        for (const [ckey, chunks] of extra) {
          const base = turnText.get(ckey)
          if (base === undefined) continue
          const tail = chunks.sort((a, b) => a.idx - b.idx).map((chunk) => chunk.text).join("")
          turnText.set(ckey, { text: base.text + tail, chunks: base.chunks })
        }
      }

      return evidence.flatMap((claim): ReadonlyArray<HydratedSpan> => {
        const turn = turnText.get(claim.ckey)
        if (turn === undefined) return []
        const cut = cutExcerpt(turn.text, claim.cs, claim.ce)
        return [
          {
            ckey: claim.ckey,
            id: claim.ckey.slice(-8),
            sid: claim.sid,
            sessionKey: claim.sessionKey,
            turnIdx: claim.turnIdx,
            cs: claim.cs,
            ce: claim.ce,
            sessionOrd: claim.sessionOrd,
            sessionDate: claim.sessionDate,
            tEvent: claim.tEvent,
            speaker: claim.speaker,
            status: claim.status,
            atSession: claim.atSession,
            excerpt: cut.excerpt,
            highlight: cut.highlight
          }
        ]
      })
    })


  /**
   * The user prefix on every claim key, so a Turn key can be rebuilt from it.
   *
   * `claimKey` is the only thing that ever produces these and its shape is
   * fixed (`uid|c|<sha1>`), so this is a parse of a format this repository
   * owns — not a guess about a foreign string.
   */
  const uidOf = (ckey: string): string => {
    const at = ckey.indexOf("|c|")
    return at === -1 ? "" : ckey.slice(0, at)
  }

  /**
   * Whole turns, each prefixed by the one before it.
   *
   * The preceding turn and not the following one: an assistant output is an
   * *answer*, and the thing that identifies which answer it is is the question
   * that produced it. What the person said next is a reaction, and paying for
   * it would double the budget for evidence that is rarely the evidence.
   *
   * Turn keys are built from `sessionKey`, never from the bare `sid` —
   * thirteen haystacks list one session id twice at different dates, and the
   * bare id would hydrate the wrong conversation without erroring.
   *
   * A neighbour that is not there simply produces no path, so the excerpt is
   * the turn alone. That is the whole of the missing-neighbour handling: the
   * walk asks for keys, and keys that do not exist contribute nothing.
   */
  const hydrateTurns = (
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadonlyArray<HydratedSpan>, HydraError> =>
    Effect.gen(function* () {
      if (evidence.length === 0) return []
      const uid = uidOf(evidence[0]!.ckey)

      const wanted = new Set<string>()
      for (const claim of evidence) {
        wanted.add(turnKey(uid, claim.sessionKey, claim.turnIdx))
        if (claim.turnIdx > 0) wanted.add(turnKey(uid, claim.sessionKey, claim.turnIdx - 1))
      }

      // Turn <- Session over HAS_TURN. A source-only walk, so the client raises
      // `pathCount` and each turn comes back on its own path; every Turn has
      // exactly one Session parent, so it is one path per key and no more.
      const paths = yield* hydra.msPaths({
        sourceLabel: "Turn",
        sourceProperty: "turn",
        sourceValues: [...wanted].sort(),
        relTypes: ["HAS_TURN"],
        relDirection: "incoming",
        maxLen: 1
      })

      const turns = new Map<string, { text: string; chunks: number; role: string }>()
      for (const path of paths) {
        const node = path.nodes[0]
        const key = String(node?.properties["turn"] ?? "")
        if (node === undefined || key === "") continue
        turns.set(key, {
          text: String(node.properties["text"] ?? ""),
          chunks: Number(node.properties["chunks"] ?? 1),
          role: String(node.properties["role"] ?? "")
        })
      }

      // A turn over the 32 743-byte string cap spilled into HAS_CHUNK vertices.
      // At whole-turn granularity the reader is shown all of it, so unlike the
      // span path this reassembles every spilled turn, not only the ones a span
      // reaches past.
      const spilled = [...turns].filter(([, turn]) => turn.chunks > 1).map(([key]) => key)
      if (spilled.length > 0) {
        const chunkPaths = yield* hydra.msPaths({
          sourceLabel: "Turn",
          sourceProperty: "turn",
          sourceValues: spilled.sort(),
          relTypes: ["HAS_CHUNK"],
          relDirection: "outgoing",
          maxLen: 1
        })
        const extra = new Map<string, Array<{ idx: number; text: string }>>()
        for (const path of chunkPaths) {
          if (path.relationships.length !== 1) continue
          const key = String(path.nodes[0]?.properties["turn"] ?? "")
          const chunk = path.nodes[1]
          if (key === "" || chunk === undefined) continue
          const bucket = extra.get(key) ?? []
          bucket.push({
            idx: Number(chunk.properties["chunk_idx"] ?? 0),
            text: String(chunk.properties["text"] ?? "")
          })
          extra.set(key, bucket)
        }
        for (const [key, chunks] of extra) {
          const base = turns.get(key)
          if (base === undefined) continue
          const tail = chunks.sort((a, b) => a.idx - b.idx).map((chunk) => chunk.text).join("")
          turns.set(key, { ...base, text: base.text + tail })
        }
      }

      return evidence.flatMap((claim): ReadonlyArray<HydratedSpan> => {
        const turn = turns.get(turnKey(uid, claim.sessionKey, claim.turnIdx))
        if (turn === undefined) return []
        const before =
          claim.turnIdx > 0 ? turns.get(turnKey(uid, claim.sessionKey, claim.turnIdx - 1)) : undefined
        const prefix = before === undefined ? "" : `(${before.role} said) ${before.text}\n\n`
        const excerpt = prefix + turn.text
        return [
          {
            ckey: claim.ckey,
            id: claim.ckey.slice(-8),
            sid: claim.sid,
            sessionKey: claim.sessionKey,
            turnIdx: claim.turnIdx,
            cs: claim.cs,
            ce: claim.ce,
            sessionOrd: claim.sessionOrd,
            sessionDate: claim.sessionDate,
            tEvent: claim.tEvent,
            speaker: claim.speaker,
            status: claim.status,
            atSession: claim.atSession,
            excerpt,
            // The span still points at the claim inside the whole turn, so a UI
            // highlights the same characters it would at span granularity.
            highlight: {
              start: Math.min(prefix.length + claim.cs, excerpt.length),
              end: Math.min(prefix.length + claim.ce, excerpt.length)
            }
          }
        ]
      })
    })

  /**
   * Reads an answer out of spans that are already in hand.
   *
   * Split from `read` because the baselines need it: BM25 and full-context are
   * only meaningful as comparisons if they face the *same reader prompt* and
   * differ solely in what got selected. Anything that can produce a
   * `HydratedSpan` — the graph, a BM25 ranking over turns, or a whole haystack
   * — can be read the same way.
   */
  const readSpans = (
    question: string,
    questionDate: string,
    spans: ReadonlyArray<HydratedSpan>,
    options: ReadOptions = {}
  ): Effect.Effect<ReadAnswer, never, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const readStarted = Date.now()
      if (spans.length === 0) {
        return {
          answer: NOT_IN_MEMORY,
          notInMemory: true,
          citedIds: [],
          reasoning: "no evidence to read",
          spans,
          cached: true,
          premiseSupported: null,
          premiseNote: "",
          inputTokens: 0,
          outputTokens: 0,
          hydrateMs: 0,
          readMs: 0,
          spanHash: spanHash([]),
          granularity: granularityFor(options.pack?.route ?? null, options.pack?.granularity),
          estimatedTokens: 0,
          budgetDropped: 0,
          budgetDroppedSessions: [],
          recited: false
        }
      }

      const prompt = renderReaderPrompt(question, questionDate, spans)

      if (options.premiseCheck === true) {
        const generated = yield* llm
          .generateObject({
            kind: "read",
            system: systemFor(options.route ?? null, true),
            prompt,
            schema: PremiseAnswer,
            objectName: "answer"
          })
          .pipe(Effect.orDie)
        const answer = generated.value.answer.trim()
        return {
          answer,
          // A failed premise *is* a refusal, whatever the answer field says —
          // the two disagree often enough that trusting only the string would
          // undercount the thing being measured.
          notInMemory:
            answer === NOT_IN_MEMORY ||
            answer.startsWith(NOT_IN_MEMORY) ||
            !generated.value.premise_supported,
          citedIds: generated.value.cited_ids,
          reasoning: generated.value.reasoning,
          spans,
          cached: generated.cached,
          premiseSupported: generated.value.premise_supported,
          premiseNote: generated.value.premise_note,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens,
          hydrateMs: 0,
          readMs: Date.now() - readStarted,
          spanHash: spanHash(spans),
          granularity: granularityFor(options.pack?.route ?? null, options.pack?.granularity),
          estimatedTokens: 0,
          budgetDropped: 0,
          budgetDroppedSessions: [],
          recited: false
        }
      }

      const first = yield* llm
        .generateObject({
          kind: "read",
          system: systemFor(options.route ?? null, false),
          prompt,
          schema: Answer,
          objectName: "answer"
        })
        .pipe(Effect.orDie)

      // ---- citation validation, with exactly one re-ask --------------------
      // A cited id that is not in the pack is a fabricated citation, and an
      // answer with no valid citation at all is one the receipt cannot support.
      // The re-ask shows the model the ids it may use; if it still cannot cite
      // one, the honest verdict is that this evidence did not produce an
      // answer, not that it produced an uncheckable one.
      const known = new Set(spans.map((span) => span.id))
      const validOf = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
        ids.filter((id) => known.has(id))

      let generated = first
      let cited = validOf(first.value.cited_ids)
      let recited = false
      const said = first.value.answer.trim()
      if (cited.length === 0 && said !== NOT_IN_MEMORY && !said.startsWith(NOT_IN_MEMORY)) {
        recited = true
        generated = yield* llm
          .generateObject({
            kind: "read",
            system: systemFor(options.route ?? null, false),
            prompt: `${prompt}\n\nYour previous answer cited no excerpt that exists. Answer again, and
cite at least one id from this list exactly as written: ${[...known].join(", ")}.
If none of them supports an answer, reply ${NOT_IN_MEMORY}.`,
            schema: Answer,
            objectName: "answer"
          })
          .pipe(Effect.orDie)
        cited = validOf(generated.value.cited_ids)
      }

      const answer = generated.value.answer.trim()
      const uncited = recited && cited.length === 0
      return {
        answer: uncited ? NOT_IN_MEMORY : answer,
        notInMemory:
          uncited || answer === NOT_IN_MEMORY || answer.startsWith(NOT_IN_MEMORY),
        citedIds: cited,
        reasoning: generated.value.reasoning,
        spans,
        cached: generated.cached,
        premiseSupported: null,
        premiseNote: "",
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        hydrateMs: 0,
        readMs: Date.now() - readStarted,
        spanHash: spanHash(spans),
        granularity: granularityFor(options.pack?.route ?? null, options.pack?.granularity),
        estimatedTokens: 0,
        budgetDropped: 0,
        budgetDroppedSessions: [],
        recited
      }
    })

  /**
   * Hydrate, then pack, then read.
   *
   * With no `pack` option this is v1 exactly — hydrate at span granularity and
   * read — which is what lets both pipelines run against one graph and still
   * produce byte-identical v1 evidence.
   *
   * With one, the order is dedupe, then label, then budget, and it is the only
   * order that works. Deduping first means a turn selected through three claims
   * is one excerpt before anything counts its tokens. Labelling before the
   * budget means the cut cannot orphan an `EARLIER STATEMENT` whose `CURRENT`
   * partner it dropped. Budgeting last means the number in the receipt is the
   * number the reader was actually charged for.
   */
  const read = (
    question: string,
    questionDate: string,
    evidence: ReadonlyArray<AsOfLabelled>,
    options: ReadOptions = {}
  ): Effect.Effect<ReadAnswer, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const pack = options.pack
      const granularity = granularityFor(pack?.route ?? null, pack?.granularity)

      const hydrateStarted = Date.now()
      const hydrated = yield* granularity === "turn" ? hydrateTurns(evidence) : hydrate(evidence)
      const hydrateMs = Date.now() - hydrateStarted

      if (pack === undefined) {
        const answer = yield* readSpans(question, questionDate, hydrated, options)
        return { ...answer, hydrateMs }
      }

      const deduped = dedupeByTurn(hydrated)
      const labelled = adjudicate(deduped, pack.slotOf ?? new Map(), pack.route)
      const budgeted = applyBudget(labelled, {
        ...(pack.budgetTokens === undefined ? {} : { budget: pack.budgetTokens }),
        ...(pack.protectedKeys === undefined ? {} : { protectedKeys: pack.protectedKeys })
      })

      const answer = yield* readSpans(question, questionDate, budgeted.kept, options)
      return {
        ...answer,
        hydrateMs,
        estimatedTokens: budgeted.estimatedTokens,
        budgetDropped: budgeted.dropped.length,
        budgetDroppedSessions: [...new Set(budgeted.dropped.map((span) => span.sid))].sort()
      }
    })

  return { hydrate, hydrateTurns, read, readSpans } as const
})

export class Reader extends Effect.Service<Reader>()("palimpsest/Reader", { effect: make }) {}
