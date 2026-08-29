import { createHash } from "node:crypto"
import type { Route } from "./Understand.js"

/**
 * Turning a selected evidence set into the thing the reader actually sees.
 *
 * Three jobs, all of them pure, all of them things v1 either did not do or did
 * in one shape for every question:
 *
 *  - **adjudication**, and only where it helps: telling the reader which of a
 *    Slot's current claims is the latest one;
 *  - **the budget**, so a wide slot cannot decide how many tokens the reader is
 *    asked to read;
 *  - **the hash**, over the source spans rather than the claim keys, so "same
 *    evidence" means the same bytes.
 */

export type PackLabel = "CURRENT" | "EARLIER STATEMENT" | "SUPERSEDED"

/**
 * The routes where the latest current claim of a Slot is singled out.
 *
 * Not every route, and this is the part that is easy to get wrong. `(me,
 * hobby)` and "things to return" are multi-valued: labelling the older entries
 * `EARLIER STATEMENT` there tells the reader to discard facts that are all
 * still true, which is exactly how a count question loses half its items. So
 * adjudication runs on `update` and `fact` — the routes that ask for *a* value
 * — and nowhere else.
 */
export const ADJUDICATED_ROUTES: ReadonlyArray<Route> = ["update", "fact"]

/** What adjudication needs off a claim. */
export interface Adjudicable {
  readonly ckey: string
  readonly status: "CURRENT" | "SUPERSEDED"
  readonly sessionOrd: number
  readonly tEvent: number
}

/**
 * Labels each claim `CURRENT`, `EARLIER STATEMENT` or `SUPERSEDED`.
 *
 * A superseded claim is superseded on every route — that is graph structure,
 * not a reading strategy. The `EARLIER STATEMENT` label is the new one, and it
 * exists because supersession inference is incomplete: two claims can both be
 * `CURRENT` in the same Slot with different values, and v1 handed both to the
 * reader with the same label and no way to choose. This says which was said
 * last without asserting that the other was replaced.
 */
export const adjudicate = <A extends Adjudicable>(
  claims: ReadonlyArray<A>,
  slotOf: ReadonlyMap<string, string>,
  route: Route
): ReadonlyArray<A & { readonly label: PackLabel }> => {
  const adjudicated = ADJUDICATED_ROUTES.includes(route)
  const latestOfSlot = new Map<string, A>()
  if (adjudicated) {
    for (const claim of claims) {
      if (claim.status !== "CURRENT") continue
      const slot = slotOf.get(claim.ckey)
      if (slot === undefined) continue
      const best = latestOfSlot.get(slot)
      if (
        best === undefined ||
        claim.sessionOrd > best.sessionOrd ||
        (claim.sessionOrd === best.sessionOrd && claim.tEvent > best.tEvent) ||
        (claim.sessionOrd === best.sessionOrd &&
          claim.tEvent === best.tEvent &&
          claim.ckey.localeCompare(best.ckey) > 0)
      ) {
        latestOfSlot.set(slot, claim)
      }
    }
  }

  return claims.map((claim) => {
    if (claim.status === "SUPERSEDED") return { ...claim, label: "SUPERSEDED" as const }
    if (!adjudicated) return { ...claim, label: "CURRENT" as const }
    const slot = slotOf.get(claim.ckey)
    if (slot === undefined) return { ...claim, label: "CURRENT" as const }
    const latest = latestOfSlot.get(slot)
    return {
      ...claim,
      label: latest !== undefined && latest.ckey !== claim.ckey
        ? ("EARLIER STATEMENT" as const)
        : ("CURRENT" as const)
    }
  })
}

// ------------------------------------------------------------------- budget

/**
 * Characters per token, for the budget estimate.
 *
 * Four is the usual English figure and the value the full-context baseline's
 * 520 000-character cap was already sized from. It is a *placeholder until the
 * dev run calibrates it*: the reader's provider-reported `readerInputTokens`
 * and the packed character count are recorded side by side in every results
 * row, so the ratio is a division rather than an assumption, and the receipt
 * echoes whichever value produced a given result. There is no tokenizer to
 * appeal to — Luna's is unverified — which is why this is a measured constant
 * and not a library call.
 */
export const CHARS_PER_TOKEN = 4

/** Reader input tokens per ask. The 1/30-of-full-context story rests on this. */
export const READER_TOKEN_BUDGET = 6000

export interface Packable {
  readonly ckey: string
  readonly sessionKey: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
  readonly excerpt: string
  /** Where the span sits inside `excerpt` — what locates the excerpt in the turn. */
  readonly highlight: { readonly start: number; readonly end: number }
}

export const estimateTokens = (spans: ReadonlyArray<{ readonly excerpt: string }>): number =>
  Math.ceil(spans.reduce((n, span) => n + span.excerpt.length, 0) / CHARS_PER_TOKEN)

export interface BudgetReport<A> {
  readonly kept: ReadonlyArray<A>
  readonly dropped: ReadonlyArray<A>
  readonly estimatedTokens: number
  readonly charsPerToken: number
  readonly budget: number
}

/**
 * Cuts the pack down to the budget, from the tail of the selector's ranking.
 *
 * The tail, not the longest excerpt: the selector already said which rows help
 * least, and dropping by size instead would quietly prefer short evidence to
 * relevant evidence. `protectedKeys` are never dropped — a probe hit is an
 * `(entity, attribute)` the question named outright, and losing it to a budget
 * is losing the thing the question was about.
 */
export const applyBudget = <A extends { readonly ckey: string; readonly excerpt: string }>(
  spans: ReadonlyArray<A>,
  options: {
    readonly budget?: number
    readonly protectedKeys?: ReadonlySet<string>
  } = {}
): BudgetReport<A> => {
  const budget = options.budget ?? READER_TOKEN_BUDGET
  const isProtected = (span: A): boolean => options.protectedKeys?.has(span.ckey) ?? false

  const kept = [...spans]
  const dropped: Array<A> = []
  while (estimateTokens(kept) > budget) {
    // From the tail, skipping protected rows.
    let index = -1
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!isProtected(kept[i]!)) {
        index = i
        break
      }
    }
    if (index === -1) break
    dropped.push(kept[index]!)
    kept.splice(index, 1)
  }

  return {
    kept,
    dropped,
    estimatedTokens: estimateTokens(kept),
    charsPerToken: CHARS_PER_TOKEN,
    budget
  }
}

// --------------------------------------------------------------------- hash

/**
 * One row per source span, in a form two runs can compare.
 *
 * `sessionKey`, not `sid`: thirteen haystacks list the same session id twice at
 * different dates, so `sid` alone names two different conversations.
 */
export const spanTuple = (span: {
  readonly sessionKey: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
}): string => `${span.sessionKey}|${span.turnIdx}|${span.cs}|${span.ce}`

/**
 * The determinism hash over **source spans**.
 *
 * v1 hashed claim keys, which answers "did retrieval choose the same claims"
 * — a question about the index. A judge replaying an answer is asking "did the
 * reader see the same bytes", and two different claims can point at the same
 * span while one claim can be hydrated at two granularities. The claim-key hash
 * is kept beside this one as `claimHash` so v1's results stay comparable.
 */
export const spanHash = (
  spans: ReadonlyArray<{
    readonly sessionKey: string
    readonly turnIdx: number
    readonly cs: number
    readonly ce: number
  }>
): string =>
  createHash("sha256")
    .update([...new Set(spans.map(spanTuple))].sort().join("\n"), "utf8")
    .digest("hex")

/**
 * The excerpt's own window inside the turn.
 *
 * `cutExcerpt` puts the span at `highlight.start` characters into the excerpt,
 * so the excerpt covers `[cs - highlight.start, that + excerpt.length)` of the
 * turn. Nothing else in a `Packable` says where in the turn its text came from.
 */
const excerptWindow = (span: Packable): { readonly from: number; readonly to: number } => {
  const from = span.cs - span.highlight.start
  return { from, to: from + span.excerpt.length }
}

/**
 * Collapses spans that came from the same turn — but only where the text
 * actually covers them.
 *
 * A turn selected through several claims should be one excerpt: the reader pays
 * for the same text once. The trap is that "one excerpt" is only true when one
 * of the excerpts *contains* the other's span. Hydration cuts ±300 characters
 * around each span, so two claims 2 000 characters apart in one turn produce two
 * **disjoint** windows; keeping the longer text and widening `cs`/`ce` to their
 * union then throws away one claim's evidence while `spanHash` records the union
 * as seen — two runs that showed the reader genuinely different text would hash
 * the same, which is the one thing the span hash exists to prevent.
 *
 * So spans merge only when the retained excerpt covers both, and otherwise both
 * survive as separate rows of the same turn. The proper fix is upstream — group
 * by turn *before* hydrating and cut one window over the union — and this stays
 * as the check that the invariant held.
 */
export const dedupeByTurn = <A extends Packable>(spans: ReadonlyArray<A>): ReadonlyArray<A> => {
  const out: Array<A> = []
  const seatsByTurn = new Map<string, Array<number>>()

  for (const span of spans) {
    const key = `${span.sessionKey}|${span.turnIdx}`
    const seats = seatsByTurn.get(key)
    if (seats === undefined) {
      seatsByTurn.set(key, [out.length])
      out.push(span)
      continue
    }

    const incoming = excerptWindow(span)
    let merged = false
    for (const seat of seats) {
      const held = out[seat]!
      const window = excerptWindow(held)
      const low = Math.min(held.cs, span.cs)
      const high = Math.max(held.ce, span.ce)
      const heldCovers = low >= window.from && high <= window.to
      const spanCovers = low >= incoming.from && high <= incoming.to
      if (!heldCovers && !spanCovers) continue
      // Both texts may cover the union; keep the one with more context around
      // it, so merging never costs the reader bytes it would otherwise see.
      const keepHeld =
        heldCovers && (!spanCovers || held.excerpt.length >= span.excerpt.length)
      const winner = keepHeld ? held : span
      const from = keepHeld ? window.from : incoming.from
      out[seat] = {
        ...winner,
        cs: low,
        ce: high,
        highlight: { start: low - from, end: high - from }
      }
      merged = true
      break
    }
    if (merged) continue

    // Disjoint windows in one turn: two excerpts, honestly. Hydration cuts
    // +-SPAN_CONTEXT around each span, so two claims far apart in a long turn
    // produce text that does not overlap, and pretending otherwise is what
    // makes the span hash lie.
    seats.push(out.length)
    out.push(span)
  }

  return out
}
