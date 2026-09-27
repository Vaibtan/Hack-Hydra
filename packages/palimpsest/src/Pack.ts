import { createHash } from "node:crypto"
import { RoutePolicy } from "./Routes.js"

import type { Route } from "./Understand.js"

export type PackLabel = "CURRENT" | "EARLIER STATEMENT" | "SUPERSEDED"

export interface Adjudicable {
  readonly ckey: string
  readonly status: "CURRENT" | "SUPERSEDED"
  readonly sessionOrd: number
  readonly tEvent: number
}

/** `SUPERSEDED` holds on every route; `EARLIER STATEMENT` marks a CURRENT claim outranked in its Slot, on the routes that adjudicate. */
export const adjudicate = <A extends Adjudicable>(
  claims: ReadonlyArray<A>,
  slotOf: ReadonlyMap<string, string>,
  route: Route
): ReadonlyArray<A & { readonly label: PackLabel }> => {
  const adjudicated = RoutePolicy[route].adjudicate
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


/** Calibrated placeholder; the reader's provider-reported tokens are recorded beside it in every results row. */
export const CHARS_PER_TOKEN = 4

export const READER_TOKEN_BUDGET = 6000

export interface Packable {
  readonly ckey: string
  readonly sessionKey: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
  readonly excerpt: string
  readonly highlight: { readonly start: number; readonly end: number }
}

export const estimateTokens = (spans: ReadonlyArray<{ readonly excerpt: string }>): number =>
  Math.ceil(spans.reduce((n, span) => n + span.excerpt.length, 0) / CHARS_PER_TOKEN)

/** Distinct from the selector's `selector` / `turn_cap`: a decision about money, not relevance. */
export type BudgetDropReason = "budget"

export interface BudgetDrop {
  readonly ckey: string
  readonly id: string
  readonly reason: BudgetDropReason
  readonly chars: number
}

export interface BudgetReport<A> {
  readonly kept: ReadonlyArray<A>
  readonly dropped: ReadonlyArray<A>
  readonly drops: ReadonlyArray<BudgetDrop>
  readonly estimatedTokens: number
  readonly charsPerToken: number
  readonly budget: number
  /** Still over budget with nothing droppable left: every remaining row is protected. */
  readonly overBudget: boolean
}

export const applyBudget = <A extends { readonly ckey: string; readonly id: string; readonly excerpt: string }>(
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
  let overBudget = false
  while (estimateTokens(kept) > budget) {
    let index = -1
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!isProtected(kept[i]!)) {
        index = i
        break
      }
    }
    if (index === -1) {
      overBudget = true
      break
    }
    dropped.push(kept[index]!)
    kept.splice(index, 1)
  }

  return {
    kept,
    dropped,
    drops: dropped.map((span) => ({
      ckey: span.ckey,
      id: span.id,
      reason: "budget" as const,
      chars: span.excerpt.length
    })),
    estimatedTokens: estimateTokens(kept),
    charsPerToken: CHARS_PER_TOKEN,
    budget,
    overBudget
  }
}


export const spanTuple = (span: {
  readonly sessionKey: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
}): string => `${span.sessionKey}|${span.turnIdx}|${span.cs}|${span.ce}`

/** The determinism hash over source-span locators; it does not hash hydrated excerpt bytes. */
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

interface ExcerptWindow {
  readonly from: number
  readonly to: number
}

const excerptWindow = (span: Packable): ExcerptWindow => {
  const from = span.cs - span.highlight.start
  return { from, to: from + span.excerpt.length }
}

/** Merges spans of one turn only where one excerpt window covers both; disjoint windows stay separate rows. */
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

    seats.push(out.length)
    out.push(span)
  }

  return out
}
