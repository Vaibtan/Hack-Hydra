import type { HydraPath } from "@palimpsest/hydra"
import { describe, expect, it } from "vitest"
import {
  applyAsOf,
  beforeAsOf,
  convergenceThreshold,
  decide,
  idf,
  orderEvidence,
  rank,
  scoreReached,
  type ReachedClaim
} from "../../src/index.js"

/** Builds the shape HydraDB actually returns: Token -> [Entity ->] Claim. */
const path = (
  anchor: { stem: string; df: number },
  claim: { ckey: string; sessionOrd?: number; tEvent?: number },
  viaEntity = false
): HydraPath => {
  const token = {
    id: 1,
    labels: ["Token"],
    properties: { stem: anchor.stem, tkey: `u|t|${anchor.stem}`, df: anchor.df }
  }
  const entity = { id: 2, labels: ["Entity"], properties: { ekey: "u|e|x" } }
  const target = {
    id: 3,
    labels: ["Claim"],
    properties: {
      ckey: claim.ckey,
      text: `text of ${claim.ckey}`,
      speaker: "user",
      ctype: "fact",
      session_ord: claim.sessionOrd ?? 1,
      session_date: 20230101,
      t_event: claim.tEvent ?? 0,
      t_prec: "none",
      sid: "s1",
      turn_idx: 0,
      cs: 0,
      ce: 5
    }
  }
  const nodes = viaEntity ? [token, entity, target] : [token, target]
  return {
    nodes,
    relationships: nodes.slice(1).map((node, i) => ({
      id: 100 + i,
      type: i === 0 && viaEntity ? "NAMES" : viaEntity ? "MENTIONS" : "HITS",
      src: nodes[i]!.id,
      dst: node.id,
      properties: {}
    }))
  }
}

describe("idf", () => {
  it("weighs a rare anchor above a common one", () => {
    expect(idf(1, 1000)).toBeGreaterThan(idf(500, 1000))
  })

  it("never returns a negative or infinite weight, even for df 0", () => {
    expect(idf(0, 1000)).toBeGreaterThan(0)
    expect(Number.isFinite(idf(0, 1000))).toBe(true)
  })
})

describe("scoreReached", () => {
  it("counts distinct anchors reaching a claim, not paths", () => {
    const reached = scoreReached(
      [
        path({ stem: "hamster", df: 3 }, { ckey: "c1" }),
        path({ stem: "hamster", df: 3 }, { ckey: "c1" }, true),
        path({ stem: "nibble", df: 1 }, { ckey: "c1" }),
        path({ stem: "hamster", df: 3 }, { ckey: "c2" })
      ],
      100
    )
    const c1 = reached.find((claim) => claim.ckey === "c1")!
    expect(c1.convergence).toBe(2)
    expect(c1.anchors).toEqual(["hamster", "nibble"])
    expect(reached.find((claim) => claim.ckey === "c2")!.convergence).toBe(1)
  })

  it("records the shortest route to a claim reached both directly and via an entity", () => {
    const reached = scoreReached(
      [
        path({ stem: "hamster", df: 3 }, { ckey: "c1" }, true),
        path({ stem: "hamster", df: 3 }, { ckey: "c1" })
      ],
      100
    )
    expect(reached[0]!.hops).toBe(1)
  })

  it("scores a claim reached by two rare anchors above one reached by two common ones", () => {
    const rare = scoreReached(
      [path({ stem: "a", df: 1 }, { ckey: "c1" }), path({ stem: "b", df: 1 }, { ckey: "c1" })],
      1000
    )
    const common = scoreReached(
      [path({ stem: "c", df: 900 }, { ckey: "c2" }), path({ stem: "d", df: 900 }, { ckey: "c2" })],
      1000
    )
    expect(rare[0]!.convergence).toBe(common[0]!.convergence)
    expect(rare[0]!.score).toBeGreaterThan(common[0]!.score)
  })

  it("carries the span and the clocks through, because the reader needs them", () => {
    const reached = scoreReached([path({ stem: "a", df: 1 }, { ckey: "c1", tEvent: 20230315 })], 10)
    expect(reached[0]).toMatchObject({ sid: "s1", turnIdx: 0, cs: 0, ce: 5, tEvent: 20230315 })
  })

  it("returns nothing for an empty path set", () => {
    expect(scoreReached([], 10)).toEqual([])
  })
})

describe("convergenceThreshold", () => {
  it("asks for two anchors when the question produced two or more", () => {
    expect(convergenceThreshold(2)).toBe(2)
    expect(convergenceThreshold(9)).toBe(2)
  })

  it("falls back to one so a single-anchor question can still be answered", () => {
    expect(convergenceThreshold(1)).toBe(1)
  })
})

const reached = (ckey: string, convergence: number, score: number, extra: Partial<ReachedClaim> = {}): ReachedClaim => ({
  ckey,
  text: ckey,
  speaker: "user",
  ctype: "fact",
  sessionOrd: 1,
  sessionDate: 20230101,
  tEvent: 0,
  tPrec: "none",
  sid: "s1",
  turnIdx: 0,
  cs: 0,
  ce: 1,
  anchors: Array.from({ length: convergence }, (_, i) => `a${i}`),
  convergence,
  score,
  hops: 1,
  ...extra
})

describe("decide", () => {
  it("abstains with A1 when the question resolved no anchor at all", () => {
    const verdict = decide([], 0)
    expect(verdict).toMatchObject({ kind: "ABSENT", reason: "A1_no_anchors" })
    expect(verdict.candidates).toEqual([])
  })

  it("abstains with A2 when anchors exist but nothing converges", () => {
    const verdict = decide([reached("c1", 1, 5)], 4)
    expect(verdict).toMatchObject({ kind: "ABSENT", reason: "A2_no_convergence", threshold: 2 })
  })

  it("answers when a claim meets the threshold, and prints the threshold used", () => {
    const verdict = decide([reached("c1", 2, 5), reached("c2", 1, 9)], 3)
    expect(verdict.kind).toBe("ANSWER")
    expect(verdict.threshold).toBe(2)
    expect(verdict.candidates.map((c) => c.ckey)).toEqual(["c1"])
  })

  it("answers a single-anchor question rather than abstaining by construction", () => {
    expect(decide([reached("c1", 1, 5)], 1).kind).toBe("ANSWER")
  })

  it("keeps at most K candidates", () => {
    const many = Array.from({ length: 40 }, (_, i) => reached(`c${i}`, 2, 40 - i))
    expect(decide(many, 5, 25).candidates).toHaveLength(25)
  })
})

describe("rank", () => {
  it("puts convergence first and idf mass second", () => {
    const ordered = rank([reached("low", 1, 100), reached("a", 3, 1), reached("b", 3, 2)])
    expect(ordered.map((c) => c.ckey)).toEqual(["b", "a", "low"])
  })

  it("is total, so the determinism hash never depends on iteration order", () => {
    const a = reached("x", 2, 5)
    const b = reached("y", 2, 5)
    expect(rank([a, b]).map((c) => c.ckey)).toEqual(rank([b, a]).map((c) => c.ckey))
  })
})

describe("applyAsOf", () => {
  const claims = [
    reached("old", 2, 1, { sessionOrd: 3 }),
    reached("new", 2, 1, { sessionOrd: 37 })
  ]
  const edges = new Map([["old", { newer: "new", atSession: 37 }]])

  it("labels the replaced claim SUPERSEDED and the survivor CURRENT", () => {
    const labelled = applyAsOf(claims, edges)
    expect(labelled.map((c) => [c.ckey, c.status])).toEqual([
      ["old", "SUPERSEDED"],
      ["new", "CURRENT"]
    ])
    expect(labelled[0]!.atSession).toBe(37)
  })

  it("as of an earlier session, the later claim does not exist and the older is current", () => {
    const labelled = applyAsOf(claims, edges, 4)
    expect(labelled.map((c) => c.ckey)).toEqual(["old"])
    expect(labelled[0]!.status).toBe("CURRENT")
    expect(labelled[0]!.supersededBy).toBeNull()
  })

  it("ignores an edge written after the as-of session even when both claims are visible", () => {
    const labelled = applyAsOf(claims, new Map([["old", { newer: "new", atSession: 40 }]]), 38)
    expect(labelled.find((c) => c.ckey === "old")!.status).toBe("CURRENT")
  })
})

describe("orderEvidence", () => {
  const current = { ...reached("cur", 2, 1, { tEvent: 20230501 }), status: "CURRENT" as const, supersededBy: null, atSession: null }
  const superseded = { ...reached("old", 2, 1, { tEvent: 20230101 }), status: "SUPERSEDED" as const, supersededBy: "cur", atSession: 9 }
  const undated = { ...reached("undated", 2, 1, { tEvent: 0 }), status: "CURRENT" as const, supersededBy: null, atSession: null }

  it("demotes superseded claims for a present-tense question", () => {
    expect(orderEvidence([superseded, current], false).map((c) => c.ckey)).toEqual(["cur", "old"])
  })

  it("keeps chronological order for a historical question", () => {
    expect(orderEvidence([current, superseded], true).map((c) => c.ckey)).toEqual(["old", "cur"])
  })

  it("puts claims with no event date last, so date arithmetic reads in order", () => {
    expect(orderEvidence([undated, current], false).map((c) => c.ckey)).toEqual(["cur", "undated"])
  })
})


describe("beforeAsOf", () => {
  /**
   * The audit's §2.2 case, exactly: a claim from the future that converges
   * harder than anything the memory actually held at `k`. Filtering after the
   * verdict let it decide A1/A2, fill the convergence table the receipt prints,
   * and eat a top-K slot — so an as-of receipt described a memory that did not
   * exist yet, and early-`k` recall degraded with nothing to show for it.
   */
  const reached = scoreReached(
    [
      path({ stem: "mortgage", df: 2 }, { ckey: "past", sessionOrd: 3 }),
      path({ stem: "wells", df: 2 }, { ckey: "past", sessionOrd: 3 }),
      path({ stem: "mortgage", df: 2 }, { ckey: "future", sessionOrd: 37 }),
      path({ stem: "wells", df: 2 }, { ckey: "future", sessionOrd: 37 }),
      path({ stem: "loan", df: 2 }, { ckey: "future", sessionOrd: 37 }),
      path({ stem: "approval", df: 2 }, { ckey: "future", sessionOrd: 37 }),
      path({ stem: "amount", df: 2 }, { ckey: "future", sessionOrd: 37 })
    ],
    100
  )

  it("keeps every claim when no as-of is given", () => {
    expect(beforeAsOf(reached).map((claim) => claim.ckey).sort()).toEqual(["future", "past"])
  })

  it("removes a future claim from the candidates even when it converges hardest", () => {
    const future = reached.find((claim) => claim.ckey === "future")!
    expect(future.convergence).toBe(5)

    const asOf3 = beforeAsOf(reached, 3)
    expect(asOf3.map((claim) => claim.ckey)).toEqual(["past"])

    const verdict = decide(asOf3, new Set(asOf3.flatMap((claim) => claim.anchors)).size)
    expect(verdict.kind).toBe("ANSWER")
    expect(verdict.candidates.map((claim) => claim.ckey)).toEqual(["past"])
  })

  it("removes it from the receipt's convergence table too", () => {
    const table = rank(beforeAsOf(reached, 3)).map((claim) => claim.ckey)
    expect(table).not.toContain("future")
  })

  it("can abstain as of k on a question it would answer today", () => {
    // Before session 3 the memory holds nothing about this at all, and the
    // honest receipt says so rather than reporting anchors that resolved
    // against a claim from session 37.
    const asOf2 = beforeAsOf(reached, 2)
    const verdict = decide(asOf2, new Set(asOf2.flatMap((claim) => claim.anchors)).size)
    expect(verdict.kind).toBe("ABSENT")
    expect(verdict.reason).toBe("A1_no_anchors")
  })
})
