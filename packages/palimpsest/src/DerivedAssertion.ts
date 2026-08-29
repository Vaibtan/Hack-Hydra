import { Data, Either } from "effect"
import type { HydratedSpan } from "./Reader.js"
import type { AsOfLabelled } from "./Scoring.js"
import type { ChainClaim } from "./Supersede.js"

/** The verbatim source slice that makes a generated index assertion inspectable. */
export interface DerivedAssertionSourceSpan {
  readonly sourceDigest: string
  readonly logicalSessionId: string
  readonly sid: string
  readonly turnIdx: number
  readonly offsetStart: number
  readonly offsetEnd: number
  readonly speaker: string
  readonly excerpt: string
  readonly highlight: { readonly start: number; readonly end: number }
}

/** A model-generated index assertion; `derivedText` is never evidence. */
export interface DerivedIndexAssertion {
  readonly assertionKey: string
  readonly derivedText: string
  readonly sessionOrd: number
  readonly tEvent: number
  readonly sid: string
  readonly supersededBy: string | null
  readonly atSession: number | null
  readonly source: DerivedAssertionSourceSpan
}

/** A public derived assertion had no durable source-revision witness or source span. */
export class DerivedAssertionSourceUnavailable extends Data.TaggedError(
  "DerivedAssertionSourceUnavailable"
)<{
  readonly reason: "sourceRevisionUnavailable" | "sourceSpanUnavailable"
}> {
  override get message(): string {
    return "Derived index assertion has no resolvable verbatim source"
  }
}

const hasSourceRevisionWitness = (claim: ChainClaim): boolean =>
  /^[a-f0-9]{64}$/.test(claim.sourceDigest) && claim.sourceLogicalSessionId !== ""

/** Shapes chain records as source-hydration input without treating their text as evidence. */
export const sourceLinkedChainEvidence = (
  claims: ReadonlyArray<ChainClaim>
): ReadonlyArray<AsOfLabelled> =>
  claims.map((claim) => ({
    ckey: claim.ckey,
    text: claim.text,
    speaker: claim.speaker,
    ctype: claim.ctype,
    sessionOrd: claim.sessionOrd,
    sessionDate: claim.sessionDate,
    tEvent: claim.tEvent,
    tPrec: claim.tPrec,
    sid: claim.sid,
    turnIdx: claim.turnIdx,
    cs: claim.cs,
    ce: claim.ce,
    anchors: [],
    convergence: 0,
    score: 0,
    hops: 0,
    status: claim.supersededBy === null ? "CURRENT" : "SUPERSEDED",
    supersededBy: claim.supersededBy,
    atSession: claim.atSession
  }))

/**
 * Projects slot-chain records only when each model-generated assertion has a
 * linked verbatim source span. This is a pure policy seam shared by HTTP and
 * CLI adapters, so neither can relabel generated text as evidence by accident.
 */
export const prepareDerivedIndexAssertions = (
  claims: ReadonlyArray<ChainClaim>,
  sourceSpans: ReadonlyArray<HydratedSpan>
): Either.Either<ReadonlyArray<DerivedIndexAssertion>, DerivedAssertionSourceUnavailable> => {
  const sourceByAssertion = new Map(sourceSpans.map((source) => [source.ckey, source]))
  const assertions: Array<DerivedIndexAssertion> = []
  for (const claim of claims) {
    if (!hasSourceRevisionWitness(claim)) {
      return Either.left(new DerivedAssertionSourceUnavailable({ reason: "sourceRevisionUnavailable" }))
    }
    const sourceSpan = sourceByAssertion.get(claim.ckey)
    if (sourceSpan === undefined) {
      return Either.left(new DerivedAssertionSourceUnavailable({ reason: "sourceSpanUnavailable" }))
    }
    assertions.push({
      assertionKey: claim.ckey,
      derivedText: claim.text,
      sessionOrd: claim.sessionOrd,
      tEvent: claim.tEvent,
      sid: claim.sid,
      supersededBy: claim.supersededBy,
      atSession: claim.atSession,
      source: {
        sourceDigest: claim.sourceDigest,
        logicalSessionId: claim.sourceLogicalSessionId,
        sid: sourceSpan.sid,
        turnIdx: claim.turnIdx,
        offsetStart: claim.cs,
        offsetEnd: claim.ce,
        speaker: sourceSpan.speaker,
        excerpt: sourceSpan.excerpt,
        highlight: sourceSpan.highlight
      }
    })
  }
  return Either.right(assertions)
}
