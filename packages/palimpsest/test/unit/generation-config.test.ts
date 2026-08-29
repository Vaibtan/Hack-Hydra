import {
  LOCAL_GENERATION_COMPONENTS,
  makeIngestGenerationConfig
} from "../../src/index.js"
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

    expect(result).toMatchObject({ _tag: "Right" })
    if (result._tag === "Left") return
    expect(result.right.extractionGeneration).toMatchObject({
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
    expect(result.right.extractionGeneration.promptTemplateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.right.extractionGeneration.outputSchemaSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.right.indexGeneration).toMatchObject({
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

    expect(original).toMatchObject({ _tag: "Right" })
    expect(changed).toMatchObject({ _tag: "Right" })
    if (original._tag === "Left" || changed._tag === "Left") return
    expect(changed.right.extractionGeneration.id).toBe(original.right.extractionGeneration.id)
    expect(changed.right.indexGeneration.id).not.toBe(original.right.indexGeneration.id)
  })

  it("refuses missing immutable deployment inputs", () => {
    const result = makeIngestGenerationConfig({ ...input, tokenizerRevision: "   " })

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "InvalidIngestGenerationConfig", field: "tokenizerRevision" }
    })
  })

  it("refuses a missing model identity separately from its revision", () => {
    const result = makeIngestGenerationConfig({ ...input, modelId: "" })

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "InvalidIngestGenerationConfig", field: "modelId" }
    })
  })
})
