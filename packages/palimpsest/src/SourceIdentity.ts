import { createHash } from "node:crypto"
import type { DatasetSession } from "@palimpsest/dataset"
import { Data, Result, Schema } from "effect"
import type { BeginSourceRevision } from "./IngestManifest.js"
import type { MemoryScope } from "./MemoryScope.js"

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalJson>
  | { readonly [key: string]: CanonicalJson }

const CanonicalJsonValueSchema = Schema.suspend(
  (): Schema.Codec<CanonicalJson> =>
    Schema.Union([
      Schema.Null,
      Schema.Boolean,
      Schema.Finite,
      Schema.String,
      Schema.Array(CanonicalJsonValueSchema),
      Schema.Record(Schema.String, CanonicalJsonValueSchema)
    ])
)

/** Recursive finite JSON value accepted by the content-addressing encoder. */
export const CanonicalJsonSchema: Schema.Codec<CanonicalJson> = CanonicalJsonValueSchema

export interface VersionedDependency {
  readonly id: string
  readonly revision: string
}

export interface ExtractionGenerationInput {
  readonly extractor: VersionedDependency
  readonly model: VersionedDependency
  readonly tokenizer: VersionedDependency
  readonly promptTemplate: string
  readonly outputSchema: CanonicalJson
}

export interface ExtractionGeneration {
  readonly id: string
  readonly extractor: VersionedDependency
  readonly model: VersionedDependency
  readonly tokenizer: VersionedDependency
  readonly promptTemplateSha256: string
  readonly outputSchemaSha256: string
  readonly canonicalJson: string
}

export class InvalidExtractionGeneration extends Data.TaggedError("InvalidExtractionGeneration")<{
  readonly reason: "invalidEncoding" | "identifierMismatch"
}> {
  override get message(): string {
    return `Invalid extraction generation: ${this.reason}`
  }
}

export interface CanonicalSessionSource {
  readonly canonicalJson: string
  readonly sourceDigest: string
  readonly sourceBytes: number
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const isCanonicalArray = (value: CanonicalJson): value is ReadonlyArray<CanonicalJson> =>
  Array.isArray(value)

/** Key-sorted JSON; the byte form every content address in the ingest plane hashes. */
export const canonicalJson = (value: CanonicalJson): string => {
  if (value === null || Schema.is(Schema.Boolean)(value) || Schema.is(Schema.String)(value)) {
    return JSON.stringify(value)
  }
  if (Schema.is(Schema.Number)(value)) {
    return JSON.stringify(value)
  }
  if (isCanonicalArray(value)) return `[${value.map(canonicalJson).join(",")}]`

  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`
}

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

const VersionedDependencySchema = Schema.Struct({ id: Schema.String, revision: Schema.String })
const ExtractionGenerationDescriptorSchema = Schema.Struct({
  extractor: VersionedDependencySchema,
  format: Schema.Literal("palimpsest.extraction-generation.v1"),
  model: VersionedDependencySchema,
  output_schema_sha256: Schema.String,
  prompt_template_sha256: Schema.String,
  tokenizer: VersionedDependencySchema
})

export const parseExtractionGeneration = (
  id: string,
  serialized: string
): Result.Result<ExtractionGeneration, InvalidExtractionGeneration> => {
  try {
    const decoded = Schema.decodeUnknownResult(ExtractionGenerationDescriptorSchema)(JSON.parse(serialized))
    if (Result.isFailure(decoded)) {
      return Result.fail(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
    }
    const descriptor = decoded.success
    if (
      descriptor.extractor.id.trim().length === 0 ||
      descriptor.extractor.revision.trim().length === 0 ||
      descriptor.model.id.trim().length === 0 ||
      descriptor.model.revision.trim().length === 0 ||
      descriptor.tokenizer.id.trim().length === 0 ||
      descriptor.tokenizer.revision.trim().length === 0 ||
      !/^[a-f0-9]{64}$/.test(descriptor.prompt_template_sha256) ||
      !/^[a-f0-9]{64}$/.test(descriptor.output_schema_sha256)
    ) {
      return Result.fail(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
    }
    const generation = extractionGenerationFromDescriptor(descriptor)
    if (generation.canonicalJson !== serialized) {
      return Result.fail(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
    }
    if (generation.id !== id) {
      return Result.fail(new InvalidExtractionGeneration({ reason: "identifierMismatch" }))
    }
    return Result.succeed(generation)
  } catch {
    return Result.fail(new InvalidExtractionGeneration({ reason: "invalidEncoding" }))
  }
}

export const sourceRevisionInputForSession = (
  scope: MemoryScope,
  session: DatasetSession,
  extractionGeneration: ExtractionGeneration
): BeginSourceRevision => {
  const source = canonicalSessionSource(session)
  return {
    tenant: scope.tenantId,
    uid: scope.uid,
    logicalSessionId: session.key,
    sourceDigest: source.sourceDigest,
    sourceBytes: source.sourceBytes,
    extractionGeneration: {
      id: extractionGeneration.id,
      canonicalJson: extractionGeneration.canonicalJson
    }
  }
}
