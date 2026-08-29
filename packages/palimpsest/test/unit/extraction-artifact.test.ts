import type { ExtractedClaim } from "../../src/Extract.js"
import {
  createExtractionArtifact,
  createExtractionGeneration,
  IngestManifest,
  IngestManifestLayerMemory,
  parseExtractionArtifact
} from "../../src/index.js"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

const extractionGeneration = createExtractionGeneration({
  extractor: { id: "test-extractor", revision: "git:test" },
  model: { id: "test-model", revision: "snapshot:test" },
  tokenizer: { id: "test-tokenizer", revision: "v1" },
  promptTemplate: "test extraction prompt",
  outputSchema: { type: "object", version: 1 }
})

const claim: ExtractedClaim = {
  text: "The user lives in Mumbai.",
  speaker: "user",
  ctype: "fact",
  entities: [{ canon: "the user", etype: "self", aliases: ["I"] }],
  slot: { entityCanon: "the user", attr: "residence" },
  tEvent: 0,
  tPrec: "none",
  span: { turnIdx: 0, cs: 0, ce: 15 },
  keywords: ["Mumbai"],
  located: "exact"
}

describe("ExtractionArtifact", () => {
  it("content-addresses only durable extraction output and rejects altered stored bytes", () => {
    const artifact = createExtractionArtifact({
      commitId: "ingest-test",
      sourceDigest: "a".repeat(64),
      extractionGeneration: extractionGeneration.id,
      extraction: {
        sid: "session-a",
        sessionOrd: 1,
        claims: [claim],
        dropped: []
      }
    })
    const altered = createExtractionArtifact({
      ...artifact,
      extraction: { ...artifact.extraction, claims: [{ ...claim, text: "The user lives in Pune." }] }
    })

    expect(parseExtractionArtifact(artifact.id, artifact.canonicalJson)).toMatchObject({
      _tag: "Right",
      right: { id: artifact.id, extraction: { claims: [claim] } }
    })
    expect(parseExtractionArtifact(artifact.id, altered.canonicalJson)).toMatchObject({
      _tag: "Left",
      left: { reason: "identifierMismatch" }
    })
  })
})

describe("ExtractionArtifact manifest persistence", () => {
  it("persists one immutable artifact only after its source is durable", async () => {
    const artifact = createExtractionArtifact({
      commitId: "placeholder",
      sourceDigest: "b".repeat(64),
      extractionGeneration: extractionGeneration.id,
      extraction: { sid: "session-a", sessionOrd: 1, claims: [claim], dropped: [] }
    })
    const stored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const begun = yield* manifest.begin({
            tenant: "default",
            uid: "user-a",
            logicalSessionId: "session-a",
            sourceDigest: "b".repeat(64),
            sourceBytes: 1,
            extractionGeneration: {
              id: extractionGeneration.id,
              canonicalJson: extractionGeneration.canonicalJson
            }
          })
          const revision = yield* manifest.advance({
            revision: begun.revision,
            from: "RECEIVED",
            to: "SOURCE_DURABLE"
          })
          const bound = createExtractionArtifact({ ...artifact, commitId: revision.commitId })
          yield* manifest.storeExtractionArtifact({ revision, artifact: bound })
          return yield* manifest.readExtractionArtifact(revision)
        }).pipe(Effect.provide(IngestManifestLayerMemory))
      )
    )

    expect(stored).toMatchObject({
      id: expect.stringMatching(/^extraction-artifact-v1-/),
      extraction: { claims: [claim] }
    })
  })
})
