import { describe, expect, it } from "vitest"
import {
  ARM_PRIORITY,
  MAX_DISCOVERY_SEEDS,
  MAX_SLOT_MATES_PER_SLOT,
  convergenceConfig,
  discoverySeeds,
  groupSlotMates,
  unionArms,
  type ArmResult
} from "../../src/Arms.js"
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
  sessionKey: "s1",
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
    const report = unionArms(
      ["convergence", "sub:0", "sub:1", "sub:2"].map((label, a) =>
        arm(
          a === 0 ? "convergence" : "subQuestion",
          label,
          Array.from({ length: 50 }, (_, i) => claim({ ckey: `${label}-${String(i).padStart(3, "0")}` }))
        )
      )
    )
    expect(report.candidates).toHaveLength(120)
    expect(report.dropped).toHaveLength(80)
  })
})

describe("the per-arm cap", () => {
  it("trims a walking arm to 60 before the union cap sees it", () => {
    const report = unionArms([
      arm(
        "convergence",
        "convergence",
        Array.from({ length: 200 }, (_, i) => claim({ ckey: `c-${String(i).padStart(3, "0")}` }))
      )
    ])
    expect(report.candidates).toHaveLength(60)
    expect(report.dropped).toHaveLength(0)
    expect(report.counts["convergence"]).toBe(60)
  })

  it("keeps the highest-converging rows, not the first ones it saw", () => {
    const report = unionArms(
      [
        arm(
          "convergence",
          "convergence",
          Array.from({ length: 100 }, (_, i) =>
            claim({ ckey: `c-${String(i).padStart(3, "0")}`, convergence: i })
          )
        )
      ],
      { armCap: 3 }
    )
    expect(report.candidates.map((c) => c.ckey)).toEqual(["c-099", "c-098", "c-097"])
  })

  it("does not cap a probe or a slot-mate arm, whose reads are bounded already", () => {
    const rows = (label: string) =>
      Array.from({ length: 80 }, (_, i) => claim({ ckey: `${label}-${String(i).padStart(3, "0")}` }))
    const report = unionArms([
      arm("probe", "probe:me|age", rows("p")),
      arm("slotMate", "slotMate", rows("s"))
    ])
    expect(report.counts["probe:me|age"]).toBe(80)
    expect(report.counts["slotMate"]).toBe(80)
  })

  it("cuts as-of BEFORE its own cap, so a post-k claim never costs a place", () => {
    const report = unionArms(
      [
        arm(
          "convergence",
          "convergence",
          Array.from({ length: 10 }, (_, i) =>
            claim({ ckey: `c-${i}`, sessionOrd: i + 1, convergence: i + 1 })
          )
        )
      ],
      { asOf: 5, armCap: 5 }
    )
    expect(report.candidates.map((c) => c.ckey)).toEqual(["c-4", "c-3", "c-2", "c-1", "c-0"])
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

describe("the convergence config every anchor arm shares", () => {
  it("keeps the constant target selector that makes MSpaths return every pair", () => {
    const config = convergenceConfig("g3-abc", ["hamster", "pet"], 2)
    expect(config.targetProperty).toBe("kind")
    expect(config.targetValues).toEqual(["g3-abc|claim"])
    expect(config.sourceValues).toEqual(["g3-abc|t|hamster", "g3-abc|t|pet"])
    expect(config.pathCount).toBeUndefined()
  })
})

const path = (names: ReadonlyArray<string>) => ({
  nodes: names.map((name, i) => ({ id: i, key: `node:${i}`, labels: [], properties: { name } })),
  relationships: names.slice(1).map((_, i) => ({
    id: i,
    key: `node:${i}|MENTIONS|node:${i + 1}`,
    type: "MENTIONS",
    src: i,
    dst: i + 1,
    properties: {}
  }))
})

describe("discovery seeds", () => {
  it("takes the entity a two-hop path passed through", () => {
    const seeds = discoverySeeds([path(["tok", "wells fargo", "claim"])], [], new Set(["tok"]))
    expect(seeds).toContain("fargo")
    expect(seeds).toContain("well")
  })

  it("ignores a one-hop path, which passed through no entity", () => {
    expect(discoverySeeds([path(["tok", "claim"])], [], new Set())).toEqual([])
  })

  it("never seeds a term that was already an anchor — it would discover nothing", () => {
    const seeds = discoverySeeds(
      [path(["tok", "hamster", "claim"])],
      [claim({ ckey: "c1", text: "hamster named Nibbles" })],
      new Set(["hamster"])
    )
    expect(seeds).not.toContain("hamster")
    expect(seeds).toContain("nibbl")
  })

  it("prefers a term that discriminates between candidates over one they all share", () => {
    const top = [
      claim({ ckey: "c1", text: "mortgage from Wells Fargo" }),
      claim({ ckey: "c2", text: "mortgage rate rose" }),
      claim({ ckey: "c3", text: "mortgage on the Brooklyn flat" })
    ]
    const seeds = discoverySeeds([], top, new Set())
    expect(seeds.indexOf("brooklyn")).toBeLessThan(seeds.indexOf("mortgag"))
  })

  it("is capped and deterministic", () => {
    const top = Array.from({ length: 40 }, (_, i) =>
      claim({ ckey: `c${i}`, text: `alpha${i} beta${i} gamma${i}` })
    )
    const seeds = discoverySeeds([], top, new Set())
    expect(seeds.length).toBe(MAX_DISCOVERY_SEEDS)
    expect(seeds).toEqual(discoverySeeds([], top, new Set()))
  })
})

describe("slot-mate grouping", () => {
  const mate = (ckey: string, sessionOrd: number): ReachedClaim =>
    claim({ ckey, sessionOrd })

  it("spends the allowance across slots instead of on the longest history", () => {
    const weight = Array.from({ length: 10 }, (_, i) => mate(`w${i}`, 100 - i))
    const claims = [...weight, mate("residence", 50), mate("job", 49)]
    const slotOf = new Map<string, string>([
      ...weight.map((c) => [c.ckey, "u|s|me|weight"] as const),
      ["residence", "u|s|me|residence"],
      ["job", "u|s|me|job"]
    ])

    const grouped = groupSlotMates(claims, slotOf, new Set(), 40)

    const bySlot = new Map<string, number>()
    for (const c of grouped) {
      const slot = slotOf.get(c.ckey)!
      bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1)
    }
    expect(bySlot.get("u|s|me|weight")).toBe(MAX_SLOT_MATES_PER_SLOT)
    expect(bySlot.get("u|s|me|residence")).toBe(1)
    expect(bySlot.get("u|s|me|job")).toBe(1)
  })

  it("takes the newest five of a slot, not the oldest", () => {
    const claims = Array.from({ length: 8 }, (_, i) => mate(`c${i}`, i + 1))
    const slotOf = new Map(claims.map((c) => [c.ckey, "u|s|me|weight"] as const))

    const grouped = groupSlotMates(claims, slotOf, new Set(), 40)

    expect(grouped.map((c) => c.sessionOrd)).toEqual([8, 7, 6, 5, 4])
  })

  it("does not spend the allowance on a claim an arm already reached", () => {
    const claims = [mate("already", 9), mate("fresh", 8)]
    const slotOf = new Map(claims.map((c) => [c.ckey, "u|s|me|weight"] as const))

    const grouped = groupSlotMates(claims, slotOf, new Set(["already"]), 40)

    expect(grouped.map((c) => c.ckey)).toEqual(["fresh"])
  })

  it("groups claims whose slot the FILLS walk did not return into one bucket", () => {
    const claims = Array.from({ length: 9 }, (_, i) => mate(`c${i}`, i + 1))

    const grouped = groupSlotMates(claims, new Map(), new Set(), 40)

    expect(grouped).toHaveLength(MAX_SLOT_MATES_PER_SLOT)
  })

  it("applies the overall cap after the per-slot one", () => {
    const claims = Array.from({ length: 20 }, (_, i) => mate(`c${i}`, i + 1))
    const slotOf = new Map(claims.map((c, i) => [c.ckey, `slot-${Math.floor(i / 2)}`] as const))

    const grouped = groupSlotMates(claims, slotOf, new Set(), 6)

    expect(grouped).toHaveLength(6)
    expect(grouped.map((c) => c.sessionOrd)).toEqual([20, 19, 18, 17, 16, 15])
  })

  it("orders deterministically when two mates share a session", () => {
    const claims = [mate("b", 3), mate("a", 3)]

    expect(groupSlotMates(claims, new Map(), new Set(), 40).map((c) => c.ckey)).toEqual(["a", "b"])
  })
})
