import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { decodeResponse, RawResponseSchema, type RawResponse } from "../../src/Decode.js"

/** Oracle: verbatim response bodies captured from HydraDB 0.1.0 during the #1 probe run. */
const SCALAR_RESPONSE = {
  query_id: "http-query-6",
  columns: ["id", "k", "v"],
  rows: [
    [
      { type: "vertex_id", value: 1 },
      { type: "string", value: "a" },
      { type: "integer", value: 10 }
    ]
  ],
  read_epoch: 47,
  next_cursor: null,
  bookmark: "sgk:1:64656661756c74:64656661756c74:63656c6c2d30:47"
} as const satisfies RawResponse

const PATH_RESPONSE = {
  query_id: "http-query-14",
  columns: ["path"],
  rows: [
    [
      {
        type: "path",
        value: {
          nodes: [
            { id: 101, labels: ["Token"], properties: { tkey: { String: "u|t|cat" } } },
            {
              id: 202,
              labels: ["Claim"],
              properties: {
                ckey: { String: "u|c|2" },
                session_ord: { Integer: 11 },
                score: { Float: 1.5 },
                ok: { Bool: true }
              }
            }
          ],
          relationships: [
            {
              id: 20,
              edge_type: "HITS",
              src: 101,
              dst: 202,
              properties: { id: { Integer: 1001 }, at_session: { SignedInteger: -3 } }
            }
          ]
        }
      }
    ]
  ],
  read_epoch: 59,
  next_cursor: null,
  bookmark: "bm-59"
} as const satisfies RawResponse

describe("decodeResponse", () => {
  it("turns typed scalar cells into plain values keyed by column", () => {
    const result = decodeResponse(SCALAR_RESPONSE)
    expect(result.rows).toEqual([{ id: 1, k: "a", v: 10 }])
    expect(result.bookmark).toBe("sgk:1:64656661756c74:64656661756c74:63656c6c2d30:47")
  })

  it("decodes a path cell into plain nodes and relationships", () => {
    const result = decodeResponse(PATH_RESPONSE)
    expect(result.rows).toHaveLength(1)
    const path = result.rows[0]!["path"]
    expect(path).toEqual({
      nodes: [
        { id: 101, labels: ["Token"], properties: { tkey: "u|t|cat" } },
        {
          id: 202,
          labels: ["Claim"],
          properties: { ckey: "u|c|2", session_ord: 11, score: 1.5, ok: true }
        }
      ],
      relationships: [
        {
          id: 20,
          type: "HITS",
          src: 101,
          dst: 202,
          properties: { id: 1001, at_session: -3 }
        }
      ]
    })
  })

  it("reports an empty result set without inventing rows", () => {
    const result = decodeResponse({ ...SCALAR_RESPONSE, columns: ["c"], rows: [] })
    expect(result.rows).toEqual([])
  })

  it("rejects missing envelopes, mismatched cell variants, and malformed row widths", () => {
    const malformed = [
      {},
      {
        ...SCALAR_RESPONSE,
        rows: [[{ type: "integer", value: "10" }, { type: "string", value: "a" }, { type: "integer", value: 10 }]]
      },
      {
        ...SCALAR_RESPONSE,
        rows: [[{ type: "boolean", value: "true" }, { type: "string", value: "a" }, { type: "integer", value: 10 }]]
      },
      { ...SCALAR_RESPONSE, rows: [[{ type: "string", value: "only-one-cell" }]] }
    ]

    for (const response of malformed) {
      expect(Result.isFailure(Schema.decodeUnknownResult(RawResponseSchema)(response))).toBe(true)
    }
  })

  it("decodes discriminated boolean and null cells", () => {
    const parsed = Schema.decodeUnknownSync(RawResponseSchema)({
      ...SCALAR_RESPONSE,
      columns: ["enabled", "missing"],
      rows: [[{ type: "boolean", value: true }, { type: "null" }]]
    })

    expect(decodeResponse(parsed).rows).toEqual([{ enabled: true, missing: null }])
  })
})
