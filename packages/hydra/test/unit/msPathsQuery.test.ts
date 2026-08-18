import { describe, expect, it } from "vitest"
import { renderMsPathsQuery } from "../../src/index.js"

/**
 * Oracle: the query text below is the exact statement accepted by the live
 * HydraDB 0.1.0 node during the probe run recorded in
 * `docs/review-2026-08-17-palimpsest-plan.md` §7 ("constant-property target
 * selector" row). String lists must be inlined literals; scalar config keys
 * take `$params`.
 */
describe("renderMsPathsQuery", () => {
  it("renders the convergence query with lists inlined and scalars as params", () => {
    const { query, parameters } = renderMsPathsQuery({
      sourceLabel: "Token",
      sourceProperty: "tkey",
      sourceValues: ["u|t|cat", "u|t|vet"],
      targetLabel: "Claim",
      targetProperty: "kind",
      targetValues: ["u|claim"],
      relTypes: ["HITS", "NAMES", "MENTIONS"],
      relDirection: "outgoing",
      maxLen: 2
    })

    expect(query).toBe(
      "CALL algo.MSpaths({sourceLabel:'Token', sourceProperty:'tkey', " +
        "sourceValues:['u|t|cat','u|t|vet'], targetLabel:'Claim', targetProperty:'kind', " +
        "targetValues:['u|claim'], relTypes:['HITS','NAMES','MENTIONS'], " +
        "relDirection:$relDirection, maxLen:$maxLen}) YIELD path RETURN path"
    )
    expect(parameters).toEqual({ relDirection: "outgoing", maxLen: 2 })
  })

  it("passes optional scalar config through as parameters only when given", () => {
    const withCounts = renderMsPathsQuery({
      sourceLabel: "Token",
      sourceProperty: "tkey",
      sourceValues: ["u|t|cat"],
      relTypes: ["HITS"],
      relDirection: "outgoing",
      maxLen: 1,
      pathCount: 10
    })
    expect(withCounts.query).toBe(
      "CALL algo.MSpaths({sourceLabel:'Token', sourceProperty:'tkey', " +
        "sourceValues:['u|t|cat'], relTypes:['HITS'], relDirection:$relDirection, " +
        "maxLen:$maxLen, pathCount:$pathCount}) YIELD path RETURN path"
    )
    expect(withCounts.parameters).toEqual({ relDirection: "outgoing", maxLen: 1, pathCount: 10 })
  })

  it("escapes quotes and backslashes inside inlined string lists", () => {
    const { query } = renderMsPathsQuery({
      sourceLabel: "Token",
      sourceProperty: "tkey",
      sourceValues: ["u|t|o'brien", "u|t|back\\slash"],
      relTypes: ["HITS"],
      relDirection: "outgoing",
      maxLen: 1
    })
    expect(query).toContain("sourceValues:['u|t|o\\'brien','u|t|back\\\\slash']")
  })

  it("rejects a maxLen above the server's traversal cap before a round trip", () => {
    expect(() =>
      renderMsPathsQuery({
        sourceLabel: "Token",
        sourceProperty: "tkey",
        sourceValues: ["u|t|cat"],
        relTypes: ["HITS"],
        relDirection: "outgoing",
        maxLen: 17
      })
    ).toThrowError(/maxLen/)
  })

  it("rejects a target selector without target values, as the engine does", () => {
    expect(() =>
      renderMsPathsQuery({
        sourceLabel: "Token",
        sourceProperty: "tkey",
        sourceValues: ["u|t|cat"],
        targetLabel: "Claim",
        relTypes: ["HITS"],
        relDirection: "outgoing",
        maxLen: 1
      })
    ).toThrowError(/targetValues/)
  })
})
