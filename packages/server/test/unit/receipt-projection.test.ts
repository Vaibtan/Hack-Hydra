import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Receipt as RetrievalReceipt } from "@palimpsest/palimpsest"
import { Receipt } from "../../src/index.js"

const receipt = (): RetrievalReceipt => ({
  question: "Where did I move?",
  uid: "user-a",
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
  ],
  temporal: null
})

describe("Receipt schema", () => {
  it("accepts the retrieval receipt as-is, Query 1 parameters included", () => {
    const result = receipt()

    expect(JSON.parse(JSON.stringify(result.query1Params))).toEqual(result.query1Params)
    expect(Schema.decodeUnknownResult(Receipt)(result)).toMatchObject({ _tag: "Success" })
  })

  it("rejects a receipt that drops the Query 1 parameters needed for replay", () => {
    const { query1Params: _query1Params, ...withoutParameters } = receipt()

    expect(Schema.decodeUnknownResult(Receipt)(withoutParameters)._tag).toBe("Failure")
  })

  it("accepts a snapshot receipt carrying the D7 temporal statement", () => {
    const snapshot = {
      ...receipt(),
      temporal: {
        perspective: "recorded-time",
        snapshotId: "snapshot-a",
        watermark: "COMMITTED",
        coverage: { revisionsCovered: 1, scopeRevisions: 1, uncommitted: 0 },
        caps: { topK: 25, maxLen: 2, unionCap: 120, armCap: 60 },
        stats: { snapshotId: "snapshot-a", totalClaims: 4 },
        completeness: {
          complete: true,
          timedOutArms: [],
          unionDropped: 0,
          slotMateCapped: false,
          perspectiveFiltered: 0
        }
      }
    }

    expect(Schema.decodeUnknownResult(Receipt)(snapshot)).toMatchObject({ _tag: "Success" })
  })
})
