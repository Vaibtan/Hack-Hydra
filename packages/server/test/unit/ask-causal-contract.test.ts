import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AskRequest } from "../../src/index.js"

describe("ask causal contract", () => {
  it("accepts an optional caller-held causal bookmark without making it mandatory", () => {
    const decode = Schema.decodeUnknownResult(AskRequest)

    expect(decode({ question: "Where did I move?" })).toMatchObject({ _tag: "Success" })
    expect(decode({ question: "Where did I move?", bookmark: "sgk:1:scope:cell:42" })).toMatchObject({
      _tag: "Success",
      success: { bookmark: "sgk:1:scope:cell:42" }
    })
  })
})
