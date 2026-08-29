import { createHash } from "node:crypto"
import { Data, Either } from "effect"
import {
  canonicalJson,
  type ExtractionGeneration,
  type VersionedDependency
} from "./SourceIdentity.js"

/** Dependencies that change the derived graph even when extraction output is unchanged. */
export interface IndexGenerationInput {
  /** Immutable extraction definition whose output this index represents. */
  readonly extractionGeneration: ExtractionGeneration
  /** Revision of the code that shapes extracted data into graph records. */
  readonly graphWriter: VersionedDependency
  /** Revision of the graph labels, keys, properties, and relation contract. */
  readonly graphSchema: VersionedDependency
}

/** Immutable, content-addressed contract for one isolated derived graph build. */
export interface IndexGeneration {
  readonly id: string
  readonly extractionGenerationId: string
  readonly graphWriter: VersionedDependency
  readonly graphSchema: VersionedDependency
  /** Canonical descriptor that is hashed into `id` and persisted by the manifest. */
  readonly canonicalJson: string
}

/** A persisted index-generation descriptor failed its immutable contract checks. */
export class InvalidIndexGeneration extends Data.TaggedError("InvalidIndexGeneration")<{
  readonly reason: "invalidEncoding" | "identifierMismatch"
}> {
  override get message(): string {
    return `Invalid index generation: ${this.reason}`
  }
}

type IndexGenerationDescriptor = Readonly<{
  readonly format: "palimpsest.index-generation.v1"
  readonly extraction_generation: string
  readonly graph_schema: Readonly<{ readonly id: string; readonly revision: string }>
  readonly graph_writer: Readonly<{ readonly id: string; readonly revision: string }>
}>

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const descriptorFor = (input: IndexGenerationInput): IndexGenerationDescriptor => ({
  format: "palimpsest.index-generation.v1",
  extraction_generation: input.extractionGeneration.id,
  graph_schema: {
    id: input.graphSchema.id,
    revision: input.graphSchema.revision
  },
  graph_writer: {
    id: input.graphWriter.id,
    revision: input.graphWriter.revision
  }
})

/**
 * Pins every graph-shaping dependency. A prompt/schema/model change is already
 * represented by the referenced extraction generation; a writer or graph
 * schema change produces a distinct index generation here.
 */
export const createIndexGeneration = (input: IndexGenerationInput): IndexGeneration => {
  return generationFromDescriptor(descriptorFor(input))
}

const generationFromDescriptor = (descriptor: IndexGenerationDescriptor): IndexGeneration => {
  const serialized = canonicalJson(descriptor)
  return {
    id: `index-v1-${sha256(serialized)}`,
    extractionGenerationId: descriptor.extraction_generation,
    graphWriter: descriptor.graph_writer,
    graphSchema: descriptor.graph_schema,
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

/**
 * Verifies a persisted descriptor before it is selected for retrieval. The
 * manifest separately verifies that its extraction-generation reference exists.
 */
export const parseIndexGeneration = (
  id: string,
  serialized: string
): Either.Either<IndexGeneration, InvalidIndexGeneration> => {
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Either.left(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
    }
    const record = parsed as Readonly<Record<string, unknown>>
    const graphWriter = dependencyFrom(record["graph_writer"])
    const graphSchema = dependencyFrom(record["graph_schema"])
    if (
      record["format"] !== "palimpsest.index-generation.v1" ||
      typeof record["extraction_generation"] !== "string" ||
      record["extraction_generation"].trim().length === 0 ||
      graphWriter === undefined ||
      graphSchema === undefined
    ) {
      return Either.left(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
    }
    const reconstituted = generationFromDescriptor({
      format: "palimpsest.index-generation.v1",
      extraction_generation: record["extraction_generation"],
      graph_writer: graphWriter,
      graph_schema: graphSchema
    })
    if (reconstituted.canonicalJson !== serialized) {
      return Either.left(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
    }
    if (reconstituted.id !== id) {
      return Either.left(new InvalidIndexGeneration({ reason: "identifierMismatch" }))
    }
    return Either.right(reconstituted)
  } catch {
    return Either.left(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
  }
}
