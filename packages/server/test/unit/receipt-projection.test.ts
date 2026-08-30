import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Receipt as RetrievalReceipt } from "@palimpsest/palimpsest"
import { Receipt, projectRetrievalReceipt } from "../../src/index.js"

const receipt = (): RetrievalReceipt => ({
  question: "Where did I move?",
  uid: "user-a",
  pipeline: "v1",
  profile: "full",
  asOf: null,
  anchorTerms: ["move"],
  anchorsReachingClaims: ["move"],
  anchorsReachingNothing: [],
  historical: false,
  wantsCount: false,
  timeRef: null,
  convergenceThreshold: 1,
  totalClaims: 4,
  query1: "CALL algo.MSpaths($source) YIELD path RETURN path",
  query1Params: { maxLen: 2, pathCount: 100 },
  query1Paths: 2,
  query2: null,
  query2Paths: 0,
  models: { reader: "gpt-5.6-luna", select: "gpt-5.6-luna", sufficiency: "gpt-5.6-luna" },
  convergence: [
    { ckey: "user-a|c|one", convergence: 1, score: 1.2, anchors: ["move"] }
  ]
})

describe("projectRetrievalReceipt", () => {
  it("preserves serialisable Query 1 parameters in the HTTP receipt", () => {
    const result = projectRetrievalReceipt(receipt())

    expect(result.query1Params).toEqual({ maxLen: 2, pathCount: 100 })
    expect(JSON.parse(JSON.stringify(result.query1Params))).toEqual(result.query1Params)
    expect(Schema.decodeUnknownEither(Receipt)(result)).toMatchObject({ _tag: "Right" })
  })

  it("rejects a receipt that drops the Query 1 parameters needed for replay", () => {
    const { query1Params: _query1Params, ...withoutParameters } = projectRetrievalReceipt(receipt())

    expect(Schema.decodeUnknownEither(Receipt)(withoutParameters)._tag).toBe("Left")
  })
})
