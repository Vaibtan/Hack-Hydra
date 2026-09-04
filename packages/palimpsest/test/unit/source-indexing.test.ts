import { makeIngestGenerationConfig } from "../../src/GenerationConfig.js"
import { planSourceIndexSession } from "../../src/SourceIndexing.js"
import type { DatasetSession } from "@palimpsest/dataset"
import { describe, expect, it } from "vitest"

const session: DatasetSession = {
  sid: "session-a",
  key: "session-a",
  sessionOrd: 1,
  date: { raw: "2026-08-20", dateInt: 20260820, ts: 1_755_657_600_000 },
  turns: [{ turnIdx: 0, role: "user", text: "I have a dog", hasAnswer: false }]
}

const generation = makeIngestGenerationConfig({
  modelId: "gpt-5.6-luna",
  modelRevision: "gpt-5.6-luna",
  extractorRevision: "git:extract-immutable",
  tokenizerRevision: "git:tokenizer-immutable",
  graphWriterRevision: "git:index-writer-immutable",
  graphSchemaRevision: "git:index-schema-immutable"
})

describe("planSourceIndexSession", () => {
  it("binds a caller's exact source bytes to one configured extraction and index generation", () => {
    expect(generation).toMatchObject({ _tag: "Right" })
    if (generation._tag === "Left") return

    const plan = planSourceIndexSession({
      tenant: "default",
      uid: "user-a",
      session,
      generation: generation.right
    })

    expect(plan.sourceRevision).toMatchObject({
      tenant: "default",
      uid: "user-a",
      logicalSessionId: "session-a",
      extractionGeneration: { id: generation.right.extractionGeneration.id }
    })
    expect(plan.sourceRevision.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.indexGeneration.id).toBe(generation.right.indexGeneration.id)
    expect(plan.indexGeneration.extractionGenerationId).toBe(
      plan.sourceRevision.extractionGeneration.id
    )
  })
})
