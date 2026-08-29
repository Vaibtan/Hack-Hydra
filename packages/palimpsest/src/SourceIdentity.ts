import { createHash } from "node:crypto"
import type { DatasetSession } from "@palimpsest/dataset"
import { Data, Either } from "effect"
import type { BeginSourceRevision } from "./IngestManifest.js"

/** JSON values accepted by the canonical serialiser. */
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalJson>
  | { readonly [key: string]: CanonicalJson }

/** An unknown value could not be represented in the canonical JSON domain. */
export class InvalidCanonicalJson extends Data.TaggedError("InvalidCanonicalJson")<{
  readonly reason: "nonFiniteNumber" | "unsupportedValue" | "cyclicValue"
}> {
  override get message(): string {
    return `Invalid canonical JSON: ${this.reason}`
  }
}

/** A fully specified model or tokenizer identity. */
export interface VersionedDependency {
  readonly id: string
  readonly revision: string
}

/** Inputs that determine whether an extraction can be reproduced. */
export interface ExtractionGenerationInput {
  readonly extractor: VersionedDependency
  readonly model: VersionedDependency
  readonly tokenizer: VersionedDependency
  readonly promptTemplate: string
  readonly outputSchema: CanonicalJson
}

/** Immutable description of the exact extraction generation used by a revision. */
export interface ExtractionGeneration {
  readonly id: string
  readonly extractor: VersionedDependency
  readonly model: VersionedDependency
  readonly tokenizer: VersionedDependency
  readonly promptTemplateSha256: string
  readonly outputSchemaSha256: string
  /** Canonical, auditable definition whose digest is incorporated in `id`. */
  readonly canonicalJson: string
}

/** A persisted extraction-generation descriptor was malformed or mismatched its id. */
export class InvalidExtractionGeneration extends Data.TaggedError("InvalidExtractionGeneration")<{
  readonly reason: "invalidEncoding" | "identifierMismatch"
}> {
  override get message(): string {
    return `Invalid extraction generation: ${this.reason}`
  }
}

/** Canonical durable source representation for one logical session. */
export interface CanonicalSessionSource {
  readonly canonicalJson: string
  readonly sourceDigest: string
  readonly sourceBytes: number
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const parseCanonicalJsonValue = (
  value: unknown,
  ancestors: ReadonlySet<object>
): Either.Either<CanonicalJson, InvalidCanonicalJson> => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return Either.right(value)
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? Either.right(value)
      : Either.left(new InvalidCanonicalJson({ reason: "nonFiniteNumber" }))
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return Either.left(new InvalidCanonicalJson({ reason: "cyclicValue" }))
    const nextAncestors = new Set(ancestors).add(value)
    const entries: Array<CanonicalJson> = []
    for (const entry of value) {
      const parsed = parseCanonicalJsonValue(entry, nextAncestors)
      if (parsed._tag === "Left") return parsed
      entries.push(parsed.right)
    }
    return Either.right(entries)
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) return Either.left(new InvalidCanonicalJson({ reason: "cyclicValue" }))
    const nextAncestors = new Set(ancestors).add(value)
    const entries: Record<string, CanonicalJson> = {}
    for (const [key, entry] of Object.entries(value)) {
      const parsed = parseCanonicalJsonValue(entry, nextAncestors)
      if (parsed._tag === "Left") return parsed
      entries[key] = parsed.right
    }
    return Either.right(entries)
  }
  return Either.left(new InvalidCanonicalJson({ reason: "unsupportedValue" }))
}

/** Parses an unknown JSON-like value into the values accepted by `canonicalJson`. */
export const parseCanonicalJson = (
  value: unknown
): Either.Either<CanonicalJson, InvalidCanonicalJson> => parseCanonicalJsonValue(value, new Set())

/**
 * Serialises JSON without depending on object insertion order. This makes the
 * bytes used for source and generation identities stable across callers.
 */
export const canonicalJson = (value: CanonicalJson): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not permit non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`

  const object = value as Readonly<Record<string, CanonicalJson>>
  return `{${Object.keys(object)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`
}

/**
 * Selects only the immutable, verbatim session fields. Dataset answer labels
 * and allocated order are evaluation/placement metadata, never source bytes.
 */
export const canonicalSessionSource = (session: DatasetSession): CanonicalSessionSource => {
  const canonical = canonicalJson({
    format: "palimpsest.session-source.v1",
    session: {
      date: session.date.raw,
      turns: session.turns.map((turn) => ({
        role: turn.role,
        text: turn.text,
        turn_idx: turn.turnIdx
      }))
    }
  })

  return {
    canonicalJson: canonical,
    sourceDigest: sha256(canonical),
    sourceBytes: Buffer.byteLength(canonical, "utf8")
  }
}

/**
 * Captures all prompt/model/schema/tokenizer fields which change an extraction.
 * The descriptor is intentionally explicit rather than a model-name-only cache
 * key, so a provider revision cannot silently masquerade as the same output.
 */
export const createExtractionGeneration = (
  input: ExtractionGenerationInput
): ExtractionGeneration => {
  const descriptor = {
    extractor: { id: input.extractor.id, revision: input.extractor.revision },
    format: "palimpsest.extraction-generation.v1",
    model: { id: input.model.id, revision: input.model.revision },
    output_schema_sha256: sha256(canonicalJson(input.outputSchema)),
    prompt_template_sha256: sha256(input.promptTemplate),
    tokenizer: { id: input.tokenizer.id, revision: input.tokenizer.revision }
  } as const
  return extractionGenerationFromDescriptor(descriptor)
}

const extractionGenerationFromDescriptor = (descriptor: {
  readonly extractor: Readonly<{ readonly id: string; readonly revision: string }>
  readonly format: "palimpsest.extraction-generation.v1"
  readonly model: Readonly<{ readonly id: string; readonly revision: string }>
  readonly output_schema_sha256: string
  readonly prompt_template_sha256: string
  readonly tokenizer: Readonly<{ readonly id: string; readonly revision: string }>
}): ExtractionGeneration => {
  const serialized = canonicalJson(descriptor)
  return {
    id: `extract-v1-${sha256(serialized)}`,
    extractor: descriptor.extractor,
    model: descriptor.model,
    tokenizer: descriptor.tokenizer,
    promptTemplateSha256: descriptor.prompt_template_sha256,
    outputSchemaSha256: descriptor.output_schema_sha256,
    canonicalJson: serialized
  }
}

const dependencyFrom = (value: unknown): VersionedDependency | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Readonly<Record<string, unknown>>
  if (typeof record["id"] !== "string" || typeof record["revision"] !== "string") return undefined
  if (record["id"].trim().length === 0 || record["revision"].trim().length === 0) return undefined
  return { id: record["id"], revision: record["revision"] }
}

/** Verifies a durable extraction-generation descriptor before it can name source output. */
export const parseExtractionGeneration = (
  id: string,
  serialized: string
): Either.Either<ExtractionGeneration, InvalidExtractionGeneration> => {
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Either.left(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
    }
    const record = parsed as Readonly<Record<string, unknown>>
    const extractor = dependencyFrom(record["extractor"])
    const model = dependencyFrom(record["model"])
    const tokenizer = dependencyFrom(record["tokenizer"])
    const promptTemplateSha256 = record["prompt_template_sha256"]
    const outputSchemaSha256 = record["output_schema_sha256"]
    if (
      record["format"] !== "palimpsest.extraction-generation.v1" ||
      extractor === undefined ||
      model === undefined ||
      tokenizer === undefined ||
      typeof promptTemplateSha256 !== "string" ||
      typeof outputSchemaSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(promptTemplateSha256) ||
      !/^[a-f0-9]{64}$/.test(outputSchemaSha256)
    ) {
      return Either.left(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
    }
    const generation = extractionGenerationFromDescriptor({
      extractor,
      format: "palimpsest.extraction-generation.v1",
      model,
      output_schema_sha256: outputSchemaSha256,
      prompt_template_sha256: promptTemplateSha256,
      tokenizer
    })
    if (generation.canonicalJson !== serialized) {
      return Either.left(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
    }
    if (generation.id !== id) {
      return Either.left(new InvalidExtractionGeneration({ reason: "identifierMismatch" }))
    }
    return Either.right(generation)
  } catch {
    return Either.left(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
  }
}

/** Creates the manifest claim input without leaking benchmark-only labels. */
export const sourceRevisionInputForSession = (
  tenant: string,
  uid: string,
  session: DatasetSession,
  extractionGeneration: ExtractionGeneration
): BeginSourceRevision => {
  const source = canonicalSessionSource(session)
  return {
    tenant,
    uid,
    logicalSessionId: session.key,
    sourceDigest: source.sourceDigest,
    sourceBytes: source.sourceBytes,
    extractionGeneration: {
      id: extractionGeneration.id,
      canonicalJson: extractionGeneration.canonicalJson
    }
  }
}
