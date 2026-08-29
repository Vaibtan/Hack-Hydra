import { createHash } from "node:crypto"
import { Data, Either } from "effect"
import type { DroppedClaim, ExtractedClaim, ExtractedEntity } from "./Extract.js"
import { canonicalJson, type CanonicalJson } from "./SourceIdentity.js"

/** Durable extraction output; cache-hit state is intentionally excluded. */
export interface PersistedSessionExtraction {
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: ReadonlyArray<ExtractedClaim>
  readonly dropped: ReadonlyArray<DroppedClaim>
}

/** Inputs bound into one content-addressed extraction artifact. */
export interface CreateExtractionArtifact {
  readonly commitId: string
  readonly sourceDigest: string
  readonly extractionGeneration: string
  readonly extraction: PersistedSessionExtraction
}

/** Immutable model output tied to exactly one source-processing commit. */
export interface ExtractionArtifact extends CreateExtractionArtifact {
  readonly id: string
  readonly canonicalJson: string
}

/** A persisted extraction artifact was malformed or no longer matched its id. */
export class InvalidExtractionArtifact extends Data.TaggedError("InvalidExtractionArtifact")<{
  readonly reason: "invalidEncoding" | "identifierMismatch"
}> {
  override get message(): string {
    return `Invalid extraction artifact: ${this.reason}`
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const toJsonEntity = (entity: ExtractedEntity): CanonicalJson => ({
  aliases: entity.aliases.map((alias): CanonicalJson => alias),
  canon: entity.canon,
  etype: entity.etype
})

const toJsonClaim = (claim: ExtractedClaim): CanonicalJson => ({
  ctype: claim.ctype,
  entities: claim.entities.map(toJsonEntity),
  keywords: claim.keywords.map((keyword): CanonicalJson => keyword),
  located: claim.located,
  slot:
    claim.slot === null
      ? null
      : { attr: claim.slot.attr, entity_canon: claim.slot.entityCanon },
  speaker: claim.speaker,
  span: { ce: claim.span.ce, cs: claim.span.cs, turn_idx: claim.span.turnIdx },
  t_event: claim.tEvent,
  t_prec: claim.tPrec,
  text: claim.text
})

const toJsonDroppedClaim = (claim: DroppedClaim): CanonicalJson => ({
  quote: claim.quote,
  reason: claim.reason,
  text: claim.text,
  turn_idx: claim.turnIdx
})

const descriptorFor = (input: CreateExtractionArtifact): CanonicalJson => ({
  commit_id: input.commitId,
  extraction: {
    claims: input.extraction.claims.map(toJsonClaim),
    dropped: input.extraction.dropped.map(toJsonDroppedClaim),
    session_ord: input.extraction.sessionOrd,
    sid: input.extraction.sid
  },
  extraction_generation: input.extractionGeneration,
  format: "palimpsest.extraction-artifact.v1",
  source_digest: input.sourceDigest
})

/** Creates a durable artifact identity from only source-bound model output. */
export const createExtractionArtifact = (input: CreateExtractionArtifact): ExtractionArtifact => {
  const serialized = canonicalJson(descriptorFor(input))
  return {
    ...input,
    id: `extraction-artifact-v1-${sha256(serialized)}`,
    canonicalJson: serialized
  }
}

const recordFrom = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const stringFrom = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const integerFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined

const stringsFrom = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined

const entityFrom = (value: unknown): ExtractedEntity | undefined => {
  const record = recordFrom(value)
  if (record === undefined) return undefined
  const canon = stringFrom(record["canon"])
  const etype = stringFrom(record["etype"])
  const aliases = stringsFrom(record["aliases"])
  if (
    canon === undefined ||
    aliases === undefined ||
    etype === undefined ||
    !["person", "pet", "place", "org", "thing", "event", "topic", "self"].includes(etype)
  ) {
    return undefined
  }
  return { canon, aliases, etype: etype as ExtractedEntity["etype"] }
}

const claimFrom = (value: unknown): ExtractedClaim | undefined => {
  const record = recordFrom(value)
  if (record === undefined) return undefined
  const text = stringFrom(record["text"])
  const speaker = stringFrom(record["speaker"])
  const ctype = stringFrom(record["ctype"])
  const tEvent = integerFrom(record["t_event"])
  const tPrec = stringFrom(record["t_prec"])
  const located = stringFrom(record["located"])
  const keywords = stringsFrom(record["keywords"])
  const rawEntities = record["entities"]
  const span = recordFrom(record["span"])
  if (
    text === undefined ||
    keywords === undefined ||
    !Array.isArray(rawEntities) ||
    speaker !== "user" && speaker !== "assistant" ||
    ctype !== "fact" && ctype !== "event" && ctype !== "preference" && ctype !== "assistant_output" ||
    tEvent === undefined ||
    tPrec !== "day" && tPrec !== "month" && tPrec !== "year" && tPrec !== "none" ||
    located !== "exact" && located !== "normalised" && located !== "markdown" ||
    span === undefined
  ) {
    return undefined
  }
  const entities = rawEntities.map(entityFrom)
  if (entities.some((entity) => entity === undefined)) return undefined
  const turnIdx = integerFrom(span["turn_idx"])
  const cs = integerFrom(span["cs"])
  const ce = integerFrom(span["ce"])
  if (turnIdx === undefined || cs === undefined || ce === undefined) return undefined
  const slotValue = record["slot"]
  let slot: ExtractedClaim["slot"]
  if (slotValue === null) {
    slot = null
  } else {
    const rawSlot = recordFrom(slotValue)
    const entityCanon = rawSlot === undefined ? undefined : stringFrom(rawSlot["entity_canon"])
    const attr = rawSlot === undefined ? undefined : stringFrom(rawSlot["attr"])
    if (entityCanon === undefined || attr === undefined) return undefined
    slot = { entityCanon, attr }
  }
  return {
    text,
    speaker,
    ctype,
    entities: entities as ReadonlyArray<ExtractedEntity>,
    slot,
    tEvent,
    tPrec,
    span: { turnIdx, cs, ce },
    keywords,
    located
  }
}

const droppedClaimFrom = (value: unknown): DroppedClaim | undefined => {
  const record = recordFrom(value)
  if (record === undefined) return undefined
  const reason = stringFrom(record["reason"])
  const turnIdx = integerFrom(record["turn_idx"])
  const quote = stringFrom(record["quote"])
  const text = stringFrom(record["text"])
  if (
    (reason !== "span_not_found" && reason !== "empty_quote" && reason !== "bad_turn_idx") ||
    turnIdx === undefined ||
    quote === undefined ||
    text === undefined
  ) {
    return undefined
  }
  return { reason, turnIdx, quote, text }
}

/** Reconstitutes a stored artifact only when its bytes and content-address both verify. */
export const parseExtractionArtifact = (
  id: string,
  serialized: string
): Either.Either<ExtractionArtifact, InvalidExtractionArtifact> => {
  try {
    const root = recordFrom(JSON.parse(serialized))
    if (root === undefined || root["format"] !== "palimpsest.extraction-artifact.v1") {
      return Either.left(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    const commitId = stringFrom(root["commit_id"])
    const sourceDigest = stringFrom(root["source_digest"])
    const extractionGeneration = stringFrom(root["extraction_generation"])
    const extraction = recordFrom(root["extraction"])
    if (
      commitId === undefined ||
      sourceDigest === undefined ||
      extractionGeneration === undefined ||
      extraction === undefined ||
      !/^[a-f0-9]{64}$/.test(sourceDigest)
    ) {
      return Either.left(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    const sid = stringFrom(extraction["sid"])
    const sessionOrd = integerFrom(extraction["session_ord"])
    const rawClaims = extraction["claims"]
    const rawDropped = extraction["dropped"]
    if (sid === undefined || sessionOrd === undefined || !Array.isArray(rawClaims) || !Array.isArray(rawDropped)) {
      return Either.left(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    const claims = rawClaims.map(claimFrom)
    const dropped = rawDropped.map(droppedClaimFrom)
    if (claims.some((claim) => claim === undefined) || dropped.some((claim) => claim === undefined)) {
      return Either.left(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    const artifact = createExtractionArtifact({
      commitId,
      sourceDigest,
      extractionGeneration,
      extraction: {
        sid,
        sessionOrd,
        claims: claims as ReadonlyArray<ExtractedClaim>,
        dropped: dropped as ReadonlyArray<DroppedClaim>
      }
    })
    if (artifact.canonicalJson !== serialized) {
      return Either.left(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    if (artifact.id !== id) {
      return Either.left(new InvalidExtractionArtifact({ reason: "identifierMismatch" }))
    }
    return Either.right(artifact)
  } catch {
    return Either.left(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
  }
}
