import { describe, expect, it } from "vitest"
import { ARM_PRIORITY, UNION_CAP, unionArms, type ArmResult } from "../../src/Arms.js"
import type { ReachedClaim } from "../../src/Scoring.js"

const claim = (over: Partial<ReachedClaim> & { ckey: string }): ReachedClaim => ({
  text: "",
  speaker: "user",
  ctype: "state",
  sessionOrd: 1,
  sessionDate: 20230101,
  tEvent: 0,
  tPrec: "none",
  sid: "s1",
  turnIdx: 0,
  cs: 0,
  ce: 1,
  anchors: [],
  convergence: 0,
  score: 0,
  hops: 1,
  ...over
})

const arm = (kind: ArmResult["kind"], label: string, claims: ReadonlyArray<ReachedClaim>): ArmResult => ({
  kind,
  label,
  claims
})

describe("union by claim key", () => {
  it("records every arm that reached a claim, in declaration order", () => {
    const shared = claim({ ckey: "c1" })
    const report = unionArms([
      arm("convergence", "convergence", [shared]),
      arm("probe", "probe:me|age", [shared]),
      arm("slotMate", "slot:me|age", [shared])
    ])
    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]!.arms).toEqual(["convergence", "probe:me|age", "slot:me|age"])
  })

  it("keeps the best of each measure across arms", () => {
    const report = unionArms([
      arm("slotMate", "slot", [claim({ ckey: "c1", convergence: 0, score: 0, hops: 2 })]),
      arm("convergence", "convergence", [
        claim({ ckey: "c1", convergence: 3, score: 4.5, hops: 1, anchors: ["a", "b", "c"] })
      ])
    ])
    expect(report.candidates[0]).toMatchObject({
      convergence: 3,
      score: 4.5,
      hops: 1,
      anchors: ["a", "b", "c"]
    })
  })

  it("takes the most preferred arm kind that reached it", () => {
    const report = unionArms([
      arm("slotMate", "slot", [claim({ ckey: "c1" })]),
      arm("probe", "probe:me|age", [claim({ ckey: "c1" })]),
      arm("discovery", "discovery", [claim({ ckey: "c1" })])
    ])
    expect(report.candidates[0]!.kind).toBe("probe")
  })
})

describe("as-of before every cap", () => {
  it("drops post-k claims before the union cap, not after", () => {
    // Two visible claims and 200 from the future. v1 cut the slot expansion to
    // 40 *first*, so the future claims consumed the budget and were then
    // discarded; here the cut comes first and both visible claims survive.
    const future = Array.from({ length: 200 }, (_, i) =>
      claim({ ckey: `future-${String(i).padStart(3, "0")}`, sessionOrd: 50 })
    )
    const visible = [claim({ ckey: "old-1", sessionOrd: 2 }), claim({ ckey: "old-2", sessionOrd: 3 })]
    const report = unionArms([arm("slotMate", "slot", [...future, ...visible])], { asOf: 10 })
    expect(report.candidates.map((c) => c.ckey).sort()).toEqual(["old-1", "old-2"])
    expect(report.counts["slot"]).toBe(2)
  })

  it("counts each arm after the as-of cut", () => {
    const report = unionArms(
      [
        arm("convergence", "convergence", [
          claim({ ckey: "a", sessionOrd: 1 }),
          claim({ ckey: "b", sessionOrd: 9 })
        ])
      ],
      { asOf: 5 }
    )
    expect(report.counts["convergence"]).toBe(1)
  })
})

describe("the union cap", () => {
  it("keeps probes and sub-questions ahead of convergence, discovery and slot-mates", () => {
    const many = (kind: ArmResult["kind"], label: string, n: number, prefix: string) =>
      arm(
        kind,
        label,
        Array.from({ length: n }, (_, i) => claim({ ckey: `${prefix}-${String(i).padStart(3, "0")}` }))
      )
    const report = unionArms(
      [
        many("slotMate", "slot", 100, "slot"),
        many("discovery", "discovery", 100, "disc"),
        many("convergence", "convergence", 100, "conv"),
        many("subQuestion", "sub:1", 5, "sub"),
        many("probe", "probe:me|age", 3, "probe")
      ],
      { cap: 10 }
    )
    expect(report.candidates.map((c) => c.kind)).toEqual([
      "probe",
      "probe",
      "probe",
      "subQuestion",
      "subQuestion",
      "subQuestion",
      "subQuestion",
      "subQuestion",
      "convergence",
      "convergence"
    ])
    expect(report.dropped.length).toBeGreaterThan(0)
    expect(report.dropped[0]!.kind).toBe("convergence")
  })

  it("breaks ties inside a kind by convergence, then score, then key", () => {
    const report = unionArms([
      arm("convergence", "convergence", [
        claim({ ckey: "low", convergence: 1, score: 9 }),
        claim({ ckey: "high", convergence: 3, score: 1 }),
        claim({ ckey: "mid", convergence: 1, score: 9.5 })
      ])
    ])
    expect(report.candidates.map((c) => c.ckey)).toEqual(["high", "mid", "low"])
  })

  it("defaults to 120", () => {
    expect(UNION_CAP).toBe(120)
    const report = unionArms([
      arm(
        "convergence",
        "convergence",
        Array.from({ length: 200 }, (_, i) => claim({ ckey: `c-${String(i).padStart(3, "0")}` }))
      )
    ])
    expect(report.candidates).toHaveLength(120)
    expect(report.dropped).toHaveLength(80)
  })
})

describe("arm priority", () => {
  it("is the order the union cap reads", () => {
    expect([...ARM_PRIORITY]).toEqual([
      "probe",
      "subQuestion",
      "convergence",
      "discovery",
      "slotMate"
    ])
  })
})
