import type { DatasetSession } from "@palimpsest/dataset"
import { createIndexGeneration } from "../../src/IndexGeneration.js"
import { canonicalSessionSource, createExtractionGeneration } from "../../src/SourceIdentity.js"
import { runTransactionalSourceIndex } from "../../src/TransactionalSourceIndex.js"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

const session: DatasetSession = {
  sid: "session-a",
  key: "session-a",
  sessionOrd: 1,
  date: { raw: "2026-08-20", dateInt: 20260820, ts: 1_755_657_600_000 },
  turns: [{ turnIdx: 0, role: "user", text: "hello", hasAnswer: false }]
}

const sourceGeneration = createExtractionGeneration({
  extractor: { id: "extractor", revision: "git:source" },
  model: { id: "model", revision: "snapshot:source" },
  tokenizer: { id: "tokenizer", revision: "v1" },
  promptTemplate: "source prompt",
  outputSchema: { type: "object", version: 1 }
})

const otherGeneration = createExtractionGeneration({
  extractor: { id: "extractor", revision: "git:other" },
  model: { id: "model", revision: "snapshot:other" },
  tokenizer: { id: "tokenizer", revision: "v1" },
  promptTemplate: "other prompt",
  outputSchema: { type: "object", version: 1 }
})

describe("runTransactionalSourceIndex", () => {
  it("rejects incompatible source and index generations before any data-plane dependency is used", async () => {
    const source = canonicalSessionSource(session)
    const program = runTransactionalSourceIndex({
        sourceRevision: {
          tenant: "default",
          uid: "user-a",
          logicalSessionId: session.key,
          sourceDigest: source.sourceDigest,
          sourceBytes: source.sourceBytes,
          extractionGeneration: {
            id: sourceGeneration.id,
            canonicalJson: sourceGeneration.canonicalJson
          }
        },
        indexGeneration: createIndexGeneration({
          extractionGeneration: otherGeneration,
          graphWriter: { id: "index-writer", revision: "git:abc123" },
          graphSchema: { id: "index-schema", revision: "v1" }
        }),
        session,
        extract: () => Effect.die("must not extract"),
        classifyFailure: () => ({ code: "UNREACHABLE", retryable: false })
      }).pipe(Effect.either)
    const outcome = await Effect.runPromise(
      program as Effect.Effect<
        typeof program extends Effect.Effect<infer Success, infer _Failure, infer _Requirements>
          ? Success
          : never,
        typeof program extends Effect.Effect<infer _Success, infer Failure, infer _Requirements>
          ? Failure
          : never,
        never
      >
    )

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { _tag: "SourceIndexGenerationMismatch" }
    })
  })
})
