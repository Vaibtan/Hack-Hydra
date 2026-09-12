import { describe, expect, it } from "vitest"
import { Either } from "effect"
import { parseMemoryScope } from "../../src/MemoryScope.js"
import { canonicalSessionSource, createExtractionGeneration, parseExtractionGeneration, sourceRevisionInputForSession } from "../../src/SourceIdentity.js"

const session = {
  sid: "source-session",
  key: "source-session",
  sessionOrd: 4,
  date: {
    raw: "2024/03/02 (Sat) 09:15",
    ts: 1_709_370_900,
    dateInt: 20_240_302
  },
  turns: [
    { turnIdx: 0, role: "user" as const, text: "I adopted a hamster.", hasAnswer: false },
    { turnIdx: 1, role: "assistant" as const, text: "Congratulations!", hasAnswer: true }
  ]
}

const extractionGeneration = createExtractionGeneration({
  extractor: { id: "palimpsest.extract", revision: "v1" },
  model: { id: "gpt-5.6-luna", revision: "2026-08-20" },
  tokenizer: { id: "provider-tokenizer", revision: "2026-08-20" },
  promptTemplate: "extract prompt v1",
  outputSchema: { type: "object", required: ["claims"] }
})

describe("source identity", () => {
  it("uses only verbatim source content, not evaluation labels or allocated ordinal", () => {
    const baseline = canonicalSessionSource(session)
    const evaluationOnlyChange = canonicalSessionSource({
      ...session,
      sessionOrd: 99,
      turns: session.turns.map((turn) => ({ ...turn, hasAnswer: !turn.hasAnswer }))
    })

    expect(evaluationOnlyChange).toEqual(baseline)
    expect(baseline.canonicalJson).toBe(
      '{"format":"palimpsest.session-source.v1","session":{"date":"2024/03/02 (Sat) 09:15","turns":[{"role":"user","text":"I adopted a hamster.","turn_idx":0},{"role":"assistant","text":"Congratulations!","turn_idx":1}]}}'
    )
    expect(baseline.sourceBytes).toBe(Buffer.byteLength(baseline.canonicalJson, "utf8"))
    expect(baseline.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it("changes identity when a durable source field changes", () => {
    expect(
      canonicalSessionSource({
        ...session,
        turns: [{ ...session.turns[0]!, text: "I adopted two hamsters." }, session.turns[1]!]
      }).sourceDigest
    ).not.toBe(canonicalSessionSource(session).sourceDigest)
  })

  it("records every extraction-generation input in a stable fingerprint", () => {
    const reordered = createExtractionGeneration({
      outputSchema: { required: ["claims"], type: "object" },
      promptTemplate: "extract prompt v1",
      tokenizer: { revision: "2026-08-20", id: "provider-tokenizer" },
      model: { revision: "2026-08-20", id: "gpt-5.6-luna" },
      extractor: { revision: "v1", id: "palimpsest.extract" }
    })

    expect(reordered).toEqual(extractionGeneration)
    expect(extractionGeneration.id).toMatch(/^extract-v1-[a-f0-9]{64}$/)
    expect(extractionGeneration.promptTemplateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(extractionGeneration.outputSchemaSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(
      parseExtractionGeneration(extractionGeneration.id, extractionGeneration.canonicalJson)
    ).toMatchObject({ _tag: "Right", right: extractionGeneration })
    expect(
      parseExtractionGeneration("extract-v1-" + "0".repeat(64), extractionGeneration.canonicalJson)
    ).toMatchObject({ _tag: "Left", left: { reason: "identifierMismatch" } })
  })

  it("makes the manifest input use the logical session key and canonical source", () => {
    const scope = Either.getOrThrow(parseMemoryScope("default", "user-a"))
    expect(sourceRevisionInputForSession(scope, session, extractionGeneration)).toEqual({
      tenant: "default",
      uid: "user-a",
      logicalSessionId: "source-session",
      sourceDigest: canonicalSessionSource(session).sourceDigest,
      sourceBytes: canonicalSessionSource(session).sourceBytes,
      extractionGeneration: {
        id: extractionGeneration.id,
        canonicalJson: extractionGeneration.canonicalJson
      }
    })
  })
})
