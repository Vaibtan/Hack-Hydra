import { LOCAL_GENERATION_COMPONENTS, makeIngestGenerationConfig } from "../../src/GenerationConfig.js"
import { describe, expect, it } from "vitest"

const input = {
  modelId: "gpt-5.6-luna",
  modelRevision: "gpt-5.6-luna",
  extractorRevision: "git:extract-immutable",
  tokenizerRevision: "git:tokenizer-immutable",
  graphWriterRevision: "git:index-writer-immutable",
  graphSchemaRevision: "git:index-schema-immutable"
} as const

describe("makeIngestGenerationConfig", () => {
  it("binds the real extractor prompt and schema to versioned runtime dependencies", () => {
    const result = makeIngestGenerationConfig(input)

    expect(result).toMatchObject({ _tag: "Success" })
    if (result._tag === "Failure") return
    expect(result.success.extractionGeneration).toMatchObject({
      model: { id: "gpt-5.6-luna", revision: "gpt-5.6-luna" },
      extractor: {
        id: LOCAL_GENERATION_COMPONENTS.extractor,
        revision: "git:extract-immutable"
      },
      tokenizer: {
        id: LOCAL_GENERATION_COMPONENTS.tokenizer,
        revision: "git:tokenizer-immutable"
      }
    })
    expect(result.success.extractionGeneration.promptTemplateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.success.extractionGeneration.outputSchemaSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.success.indexGeneration).toMatchObject({
      graphWriter: {
        id: LOCAL_GENERATION_COMPONENTS.graphWriter,
        revision: "git:index-writer-immutable"
      },
      graphSchema: {
        id: LOCAL_GENERATION_COMPONENTS.graphSchema,
        revision: "git:index-schema-immutable"
      }
    })
  })

  it("creates distinct generations when an index-shaping revision changes", () => {
    const original = makeIngestGenerationConfig(input)
    const changed = makeIngestGenerationConfig({
      ...input,
      graphSchemaRevision: "git:index-schema-next"
    })

    expect(original).toMatchObject({ _tag: "Success" })
    expect(changed).toMatchObject({ _tag: "Success" })
    if (original._tag === "Failure" || changed._tag === "Failure") return
    expect(changed.success.extractionGeneration.id).toBe(original.success.extractionGeneration.id)
    expect(changed.success.indexGeneration.id).not.toBe(original.success.indexGeneration.id)
  })

  it("refuses missing immutable deployment inputs", () => {
    const result = makeIngestGenerationConfig({ ...input, tokenizerRevision: "   " })

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidIngestGenerationConfig", field: "tokenizerRevision" }
    })
  })

  it("refuses a missing model identity separately from its revision", () => {
    const result = makeIngestGenerationConfig({ ...input, modelId: "" })

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidIngestGenerationConfig", field: "modelId" }
    })
  })
})
