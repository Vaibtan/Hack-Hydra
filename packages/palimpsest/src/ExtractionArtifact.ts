import { createHash } from "node:crypto"
import { Data, Result, Schema } from "effect"
import type { DroppedClaim, ExtractedClaim, ExtractedEntity } from "./Extract.js"
import { canonicalJson, type CanonicalJson } from "./SourceIdentity.js"

/** Extraction output without cache-hit state. */
export interface PersistedSessionExtraction {
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: ReadonlyArray<ExtractedClaim>
  readonly dropped: ReadonlyArray<DroppedClaim>
}

export interface CreateExtractionArtifact {
  readonly commitId: string
  readonly sourceDigest: string
  readonly extractionGeneration: string
  readonly extraction: PersistedSessionExtraction
}

export interface ExtractionArtifact extends CreateExtractionArtifact {
  readonly id: string
  readonly canonicalJson: string
}

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

export const createExtractionArtifact = (input: CreateExtractionArtifact): ExtractionArtifact => {
  const serialized = canonicalJson(descriptorFor(input))
  return {
    ...input,
    id: `extraction-artifact-v1-${sha256(serialized)}`,
    canonicalJson: serialized
  }
}

const PersistedEntitySchema = Schema.Struct({
  aliases: Schema.Array(Schema.String),
  canon: Schema.String,
  etype: Schema.Literals(["person", "pet", "place", "org", "thing", "event", "topic", "self"])
})

const PersistedClaimSchema = Schema.Struct({
  ctype: Schema.Literals(["fact", "event", "preference", "assistant_output"]),
  entities: Schema.Array(PersistedEntitySchema),
  keywords: Schema.Array(Schema.String),
  located: Schema.Literals(["exact", "normalised", "markdown"]),
  slot: Schema.Union([
    Schema.Null,
    Schema.Struct({ attr: Schema.String, entity_canon: Schema.String })
  ]),
  speaker: Schema.Literals(["user", "assistant"]),
  span: Schema.Struct({ ce: Schema.Number, cs: Schema.Number, turn_idx: Schema.Number }),
  t_event: Schema.Number,
  t_prec: Schema.Literals(["day", "month", "year", "none"]),
  text: Schema.String
})

const PersistedDroppedClaimSchema = Schema.Struct({
  quote: Schema.String,
  reason: Schema.Literals(["span_not_found", "empty_quote", "bad_turn_idx"]),
  text: Schema.String,
  turn_idx: Schema.Number
})

const ExtractionArtifactDescriptorSchema = Schema.Struct({
  commit_id: Schema.String,
  extraction: Schema.Struct({
    claims: Schema.Array(PersistedClaimSchema),
    dropped: Schema.Array(PersistedDroppedClaimSchema),
    session_ord: Schema.Number,
    sid: Schema.String
  }),
  extraction_generation: Schema.String,
  format: Schema.Literal("palimpsest.extraction-artifact.v1"),
  source_digest: Schema.String
})

const isSafeInteger = (value: number): boolean => Number.isSafeInteger(value)

const hasValidIntegers = (
  descriptor: typeof ExtractionArtifactDescriptorSchema.Type
): boolean =>
  isSafeInteger(descriptor.extraction.session_ord) &&
  descriptor.extraction.claims.every(
    (claim) =>
      isSafeInteger(claim.t_event) &&
      isSafeInteger(claim.span.turn_idx) &&
      isSafeInteger(claim.span.cs) &&
      isSafeInteger(claim.span.ce)
  ) &&
  descriptor.extraction.dropped.every((claim) => isSafeInteger(claim.turn_idx))

export const parseExtractionArtifact = (
  id: string,
  serialized: string
): Result.Result<ExtractionArtifact, InvalidExtractionArtifact> => {
  try {
    const decoded = Schema.decodeUnknownResult(ExtractionArtifactDescriptorSchema)(JSON.parse(serialized))
    if (Result.isFailure(decoded)) {
      return Result.fail(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    const descriptor = decoded.success
    if (
      !/^[a-f0-9]{64}$/.test(descriptor.source_digest) ||
      !hasValidIntegers(descriptor)
    ) {
      return Result.fail(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    const artifact = createExtractionArtifact({
      commitId: descriptor.commit_id,
      sourceDigest: descriptor.source_digest,
      extractionGeneration: descriptor.extraction_generation,
      extraction: {
        sid: descriptor.extraction.sid,
        sessionOrd: descriptor.extraction.session_ord,
        claims: descriptor.extraction.claims.map((claim) => ({
          text: claim.text,
          speaker: claim.speaker,
          ctype: claim.ctype,
          entities: claim.entities,
          slot:
            claim.slot === null
              ? null
              : { entityCanon: claim.slot.entity_canon, attr: claim.slot.attr },
          tEvent: claim.t_event,
          tPrec: claim.t_prec,
          span: { turnIdx: claim.span.turn_idx, cs: claim.span.cs, ce: claim.span.ce },
          keywords: claim.keywords,
          located: claim.located
        })),
        dropped: descriptor.extraction.dropped.map((claim) => ({
          reason: claim.reason,
          turnIdx: claim.turn_idx,
          quote: claim.quote,
          text: claim.text
        }))
      }
    })
    if (artifact.canonicalJson !== serialized) {
      return Result.fail(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
    }
    if (artifact.id !== id) {
      return Result.fail(new InvalidExtractionArtifact({ reason: "identifierMismatch" }))
    }
    return Result.succeed(artifact)
  } catch {
    return Result.fail(new InvalidExtractionArtifact({ reason: "invalidEncoding" }))
  }
}
