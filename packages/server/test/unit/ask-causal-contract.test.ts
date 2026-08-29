import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AskRequest } from "../../src/index.js"

describe("ask causal contract", () => {
  it("accepts an optional caller-held causal bookmark without making it mandatory", () => {
    const decode = Schema.decodeUnknownEither(AskRequest)

    expect(decode({ question: "Where did I move?" })).toMatchObject({ _tag: "Right" })
    expect(decode({ question: "Where did I move?", bookmark: "sgk:1:scope:cell:42" })).toMatchObject({
      _tag: "Right",
      right: { bookmark: "sgk:1:scope:cell:42" }
    })
  })
})
