import { createHash } from "node:crypto"
import { Data, Result, Schema } from "effect"
import {
  canonicalJson,
  type ExtractionGeneration,
  type VersionedDependency
} from "./SourceIdentity.js"

export interface IndexGenerationInput {
  readonly extractionGeneration: ExtractionGeneration
  readonly graphWriter: VersionedDependency
  readonly graphSchema: VersionedDependency
}

export interface IndexGeneration {
  readonly id: string
  readonly extractionGenerationId: string
  readonly graphWriter: VersionedDependency
  readonly graphSchema: VersionedDependency
  /** Canonical descriptor that is hashed into `id` and persisted by the manifest. */
  readonly canonicalJson: string
}

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

const VersionedDependencySchema = Schema.Struct({ id: Schema.String, revision: Schema.String })
const IndexGenerationDescriptorSchema = Schema.Struct({
  format: Schema.Literal("palimpsest.index-generation.v1"),
  extraction_generation: Schema.String,
  graph_schema: VersionedDependencySchema,
  graph_writer: VersionedDependencySchema
})

export const parseIndexGeneration = (
  id: string,
  serialized: string
): Result.Result<IndexGeneration, InvalidIndexGeneration> => {
  try {
    const decoded = Schema.decodeUnknownResult(IndexGenerationDescriptorSchema)(JSON.parse(serialized))
    if (Result.isFailure(decoded)) {
      return Result.fail(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
    }
    const descriptor = decoded.success
    if (
      descriptor.extraction_generation.trim().length === 0 ||
      descriptor.graph_schema.id.trim().length === 0 ||
      descriptor.graph_schema.revision.trim().length === 0 ||
      descriptor.graph_writer.id.trim().length === 0 ||
      descriptor.graph_writer.revision.trim().length === 0
    ) {
      return Result.fail(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
    }
    const reconstituted = generationFromDescriptor(descriptor)
    if (reconstituted.canonicalJson !== serialized) {
      return Result.fail(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
    }
    if (reconstituted.id !== id) {
      return Result.fail(new InvalidIndexGeneration({ reason: "identifierMismatch" }))
    }
    return Result.succeed(reconstituted)
  } catch {
    return Result.fail(new InvalidIndexGeneration({ reason: "invalidEncoding" }))
  }
}
