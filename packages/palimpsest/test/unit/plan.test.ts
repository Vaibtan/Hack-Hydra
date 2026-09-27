import { describe, expect, it } from "vitest"
import { emptyArm, type LiveArm, type SlotMateArm } from "../../src/Arms.js"
import {
  abstentionReason,
  planFromArms,
  questionDateInt,
  type PlanInput,
  type TemporalPlanInput
} from "../../src/Plan.js"
import type { ReachedClaim } from "../../src/Scoring.js"
import type { Understood } from "../../src/Understand.js"

const claim = (over: Partial<ReachedClaim> & { ckey: string }): ReachedClaim => ({
  text: "",
  speaker: "user",
  ctype: "state",
  sessionOrd: 1,
  sessionDate: 20230101,
  acceptedAtMs: Date.UTC(2023, 0, 1),
  tEvent: 0,
  sid: "s1",
  sessionKey: "s1",
  tPrec: "none",
  turnIdx: 0,
  cs: 0,
  ce: 1,
  anchors: [],
  convergence: 0,
  score: 0,
  hops: 1,
  ...over
})

const live = (arm: LiveArm, claims: ReadonlyArray<ReachedClaim>): LiveArm => ({
  ...arm,
  claims,
  paths: claims.length,
  query: claims.length === 0 ? null : `walk:${arm.label}`
})

const understood = (over: Partial<Understood> = {}): Understood => ({
  terms: ["mortgag", "wells"],
  historical: false,
  route: "fact",
  routeReason: "model",
  flags: { wantsCount: false, hasTimeRef: false, needsDecomposition: false },
  timeRef: null,
  timeInterval: null,
  subQuestions: [],
  probes: [],
  expanded: [],
  cached: true,
  ...over
})

const noSlotMates: SlotMateArm = { ...emptyArm("slotMate", "slotMate"), slotOf: new Map() }

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  uid: "u",
  query1Plan: null,
  question: "q",
  understood: understood(),
  terms: ["mortgag", "wells"],
  extraTerms: [],
  total: 100,
  historical: false,
  profile: "full",
  maxLen: 2,
  topK: 25,
  questionDate: 20230520,
  asOf: undefined,
  ablations: {},
  models: { reader: "m", select: "m", sufficiency: "m" },
  reaching: [emptyArm("convergence", "convergence")],
  discovery: emptyArm("discovery", "discovery"),
  slotMate: noSlotMates,
  ...over
})

describe("planFromArms", () => {
  it("grounds a verdict on a probe hit alone, with no anchor converging", () => {
    const probe = live(emptyArm("probe", "probe:me|residence"), [claim({ ckey: "u|c|p1" })])
    const planned = planFromArms(input({ reaching: [emptyArm("convergence", "convergence"), probe] }))

    expect(planned.grounded.map((candidate) => candidate.ckey)).toEqual(["u|c|p1"])
    expect(planned.resolved.size).toBe(0)
    expect(planned.plan.arms.find((arm) => arm.kind === "probe")).toMatchObject({
      claims: 1,
      timedOut: false
    })
  })

  it("names A1 when nothing resolved and A2 when anchors reached claims below the threshold", () => {
    expect(abstentionReason(planFromArms(input()))).toBe("A1_no_anchors")

    const weak = live(emptyArm("convergence", "convergence"), [
      claim({ ckey: "u|c|w", anchors: ["mortgag"], convergence: 1, score: 1 })
    ])
    const planned = planFromArms(input({ reaching: [weak] }))
    expect(planned.threshold).toBe(1)
    expect(planned.grounded).toHaveLength(1)
    const twoAnchors = live(emptyArm("convergence", "convergence"), [
      claim({ ckey: "u|c|a", anchors: ["mortgag"], convergence: 1, score: 1 }),
      claim({ ckey: "u|c|b", anchors: ["wells"], convergence: 1, score: 1 })
    ])
    const split = planFromArms(input({ reaching: [twoAnchors] }))
    expect(split.threshold).toBe(2)
    expect(split.grounded).toHaveLength(0)
    expect(abstentionReason(split)).toBe("A2_no_convergence")
  })

  it("reports a timed-out slot expansion on the plan and keeps the evidence it had", () => {
    const convergence = live(emptyArm("convergence", "convergence"), [
      claim({ ckey: "u|c|a", anchors: ["mortgag", "wells"], convergence: 2, score: 2 })
    ])
    const timedOut: SlotMateArm = { ...emptyArm("slotMate", "slotMate", true), slotOf: new Map() }
    const planned = planFromArms(input({ reaching: [convergence], slotMate: timedOut }))

    expect(planned.plan.arms.find((arm) => arm.kind === "slotMate")).toMatchObject({
      timedOut: true,
      claims: 0,
      query: null
    })
    expect(planned.grounded.map((candidate) => candidate.ckey)).toEqual(["u|c|a"])
    expect(planned.receipt.query2).toBeNull()
    expect(planned.receipt.query2Paths).toBe(0)
  })

  it("keeps a candidate's slot in plan.slots when only the FILLS walk resolved it", () => {
    const convergence = live(emptyArm("convergence", "convergence"), [
      claim({ ckey: "u|c|a", anchors: ["mortgag", "wells"], convergence: 2, score: 2 })
    ])
    const slotMate: SlotMateArm = {
      ...live(emptyArm("slotMate", "slotMate"), [claim({ ckey: "u|c|mate", sessionOrd: 3 })]),
      slotOf: new Map([
        ["u|c|a", "u|s|me|mortgage"],
        ["u|c|mate", "u|s|me|mortgage"],
        ["u|c|absent", "u|s|me|other"]
      ])
    }
    const planned = planFromArms(input({ reaching: [convergence], slotMate }))

    expect(planned.plan.slots).toEqual({
      "u|c|a": "u|s|me|mortgage",
      "u|c|mate": "u|s|me|mortgage"
    })
    expect(planned.plan.unionSessions).toEqual(["s1"])
    expect(planned.receipt.query2).toBe("walk:slotMate")
  })

  it("applies the time scope only when the question is dated and the ablation is off", () => {
    const interval = { start: 20230501, end: 20230601, precision: "month" as const, phrase: "in May" }
    const dated = understood({ timeRef: "in May", timeInterval: interval })
    const convergence = live(emptyArm("convergence", "convergence"), [
      claim({ ckey: "u|c|a", anchors: ["mortgag", "wells"], convergence: 2, score: 2, tEvent: 20230510 })
    ])

    expect(planFromArms(input({ understood: dated, reaching: [convergence] })).interval).toEqual(interval)
    expect(planFromArms(input({ understood: dated, reaching: [convergence], questionDate: 0 })).interval).toBeNull()
    expect(
      planFromArms(input({ understood: dated, reaching: [convergence], ablations: { noTimeScope: true } })).interval
    ).toBeNull()
  })

  it("types the arm kinds it reports", () => {
    const kinds = planFromArms(input()).plan.arms.map((arm) => arm.kind)
    expect(kinds).toEqual(["convergence", "discovery", "slotMate"])
  })
})

describe("questionDateInt", () => {
  it("reads the dataset's date form and nothing else", () => {
    expect(questionDateInt("2023/04/10 (Mon) 17:50")).toBe(20230410)
    expect(questionDateInt("2023-4-1")).toBe(20230401)
    expect(questionDateInt("unknown")).toBe(0)
    expect(questionDateInt(undefined)).toBe(0)
  })
})

describe("temporal statements", () => {
  const temporalInput = (over: Partial<TemporalPlanInput> = {}): TemporalPlanInput => ({
    perspective: "recorded-time",
    snapshotId: "snapshot-a",
    coverage: { revisionsCovered: 1, scopeRevisions: 1, uncommitted: 0 },
    stats: { snapshotId: "snapshot-a", totalClaims: 100 },
    upstreamFiltered: 0,
    ...over
  })

  it("leaves the temporal statement null on the legacy lane", () => {
    const planned = planFromArms(input())

    expect(planned.plan.temporal).toBeNull()
    expect(planned.receipt.temporal).toBeNull()
  })

  it("keeps the legacy recall fallback when no temporal input is present", () => {
    const january = { start: 20230101, end: 20230201, precision: "month" as const, phrase: "in january" }
    const claims = [
      claim({ ckey: "u|c|in", tEvent: 20230115, tPrec: "day" }),
      claim({ ckey: "u|c|out", tEvent: 20230601, tPrec: "day" })
    ]
    const planned = planFromArms(
      input({
        understood: understood({ timeRef: "in january", timeInterval: january }),
        reaching: [live(emptyArm("convergence", "convergence"), claims)]
      })
    )

    expect(planned.scoped.claims).toHaveLength(2)
    expect(planned.plan.temporal).toBeNull()
  })

  it("cuts pre-union claims by perspective and states the cut", () => {
    const claims = [
      claim({
        ckey: "u|c|in",
        tEvent: 20230115,
        tPrec: "day",
        sessionDate: 20230620,
        acceptedAtMs: Date.UTC(2023, 0, 20),
        sessionOrd: 3
      }),
      claim({
        ckey: "u|c|future",
        tEvent: 20230115,
        tPrec: "day",
        sessionDate: 20230101,
        acceptedAtMs: Date.UTC(2023, 5, 1),
        sessionOrd: 9
      })
    ]
    const planned = planFromArms(
      input({
        reaching: [live(emptyArm("convergence", "convergence"), claims)],
        temporal: temporalInput({ upstreamFiltered: 2 })
      })
    )

    expect(planned.scoped.claims.map((candidate) => candidate.ckey)).toEqual(["u|c|in"])
    expect(planned.plan.temporal).toMatchObject({
      perspective: "recorded-time",
      snapshotId: "snapshot-a",
      watermark: "COMMITTED",
      coverage: { revisionsCovered: 1, scopeRevisions: 1, uncommitted: 0 },
      caps: { topK: 25, maxLen: 2, unionCap: 120, armCap: 60 },
      stats: { snapshotId: "snapshot-a", totalClaims: 100 },
      completeness: {
        complete: true,
        timedOutArms: [],
        unionDropped: 0,
        slotMateCapped: false,
        perspectiveFiltered: 3
      }
    })
    expect(planned.receipt.temporal).toEqual(planned.plan.temporal)
  })

  it("marks the search incomplete on timeouts, union drops, and capped slot expansion", () => {
    const timedOut: SlotMateArm = { ...emptyArm("slotMate", "slotMate", true), slotOf: new Map() }
    const timedOutPlanned = planFromArms(input({ slotMate: timedOut, temporal: temporalInput() }))
    expect(timedOutPlanned.plan.temporal?.completeness).toMatchObject({
      complete: false,
      timedOutArms: ["slotMate"]
    })

    const probes = Array.from(
      { length: 121 },
      (_, index) => claim({ ckey: `u|c|p${index}`, sessionDate: 20230101 })
    )
    const dropped = planFromArms(
      input({
        reaching: [live(emptyArm("probe", "probe"), probes)],
        temporal: temporalInput()
      })
    )
    expect(dropped.plan.temporal?.completeness).toMatchObject({ complete: false, unionDropped: 1 })

    const capped: SlotMateArm = { ...noSlotMates, capped: true }
    const cappedPlanned = planFromArms(input({ slotMate: capped, temporal: temporalInput() }))
    expect(cappedPlanned.plan.temporal?.completeness).toMatchObject({
      complete: false,
      slotMateCapped: true
    })
  })
})
