import {
  createExtractionGeneration,
  createIndexGeneration,
  IngestManifest,
  IngestManifestLayerMemory,
  parseIndexGeneration
} from "../../src/index.js"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

const extraction = createExtractionGeneration({
  extractor: { id: "claim-extractor", revision: "git:abc123" },
  model: { id: "provider/model", revision: "snapshot:2026-08-20" },
  tokenizer: { id: "provider/tokenizer", revision: "v1" },
  promptTemplate: "Extract claims from the supplied transcript.",
  outputSchema: { type: "object", version: 1 }
})

describe("IndexGeneration", () => {
  it("content-addresses every graph-shaping dependency and rejects altered stored bytes", () => {
    const first = createIndexGeneration({
      extractionGeneration: extraction,
      graphWriter: { id: "palimpsest-graph-writer", revision: "git:abc123" },
      graphSchema: { id: "palimpsest-graph-schema", revision: "v2" }
    })
    const equivalent = createIndexGeneration({
      extractionGeneration: extraction,
      graphWriter: { id: "palimpsest-graph-writer", revision: "git:abc123" },
      graphSchema: { id: "palimpsest-graph-schema", revision: "v2" }
    })
    const changedSchema = createIndexGeneration({
      extractionGeneration: extraction,
      graphWriter: { id: "palimpsest-graph-writer", revision: "git:abc123" },
      graphSchema: { id: "palimpsest-graph-schema", revision: "v3" }
    })

    expect(first.id).toBe(equivalent.id)
    expect(first.id).not.toBe(changedSchema.id)
    expect(parseIndexGeneration(first.id, first.canonicalJson)).toMatchObject({
      _tag: "Right",
      right: { id: first.id, extractionGenerationId: extraction.id }
    })
    expect(parseIndexGeneration(first.id, changedSchema.canonicalJson)).toMatchObject({
      _tag: "Left",
      left: { reason: "identifierMismatch" }
    })
  })
})

describe("IndexGeneration manifest activation", () => {
  it("selects and rolls back whole immutable index generations", async () => {
    const original = createIndexGeneration({
      extractionGeneration: extraction,
      graphWriter: { id: "palimpsest-graph-writer", revision: "git:abc123" },
      graphSchema: { id: "palimpsest-graph-schema", revision: "v2" }
    })
    const replacement = createIndexGeneration({
      extractionGeneration: extraction,
      graphWriter: { id: "palimpsest-graph-writer", revision: "git:def456" },
      graphSchema: { id: "palimpsest-graph-schema", revision: "v2" }
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          yield* manifest.begin({
            tenant: "default",
            uid: "user-a",
            logicalSessionId: "session-a",
            sourceDigest: "a".repeat(64),
            sourceBytes: 1,
            extractionGeneration: {
              id: extraction.id,
              canonicalJson: extraction.canonicalJson
            }
          })
          yield* manifest.storeIndexGeneration({ generation: original })
          yield* manifest.storeIndexGeneration({ generation: replacement })
          yield* manifest.activateIndexGeneration({
            tenant: "default",
            uid: "user-a",
            generationId: original.id
          })
          const before = yield* manifest.readActiveIndexGeneration({ tenant: "default", uid: "user-a" })
          yield* manifest.activateIndexGeneration({
            tenant: "default",
            uid: "user-a",
            generationId: replacement.id
          })
          yield* manifest.activateIndexGeneration({
            tenant: "default",
            uid: "user-a",
            generationId: original.id
          })
          const after = yield* manifest.readActiveIndexGeneration({ tenant: "default", uid: "user-a" })
          return { before, after }
        }).pipe(Effect.provide(IngestManifestLayerMemory))
      )
    )

    expect(result.before?.id).toBe(original.id)
    expect(result.after?.id).toBe(original.id)
  })
})
