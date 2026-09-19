import { HydraClient, type HydraPath, type MsPathsConfig } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { claimKind, slotKey, userKey } from "../../src/Keys.js"
import { Retrieve } from "../../src/Retrieve.js"
import { shortId } from "../../src/Select.js"
import { Supersede } from "../../src/Supersede.js"
import { behaviorFake, runWithBehaviorFakes } from "../BehaviorFake.js"

type Node = HydraPath["nodes"][number]

const node = (id: number, label: string, properties: Node["properties"]): Node => ({
  id,
  labels: [label],
  properties
})

const pathOf = (nodes: ReadonlyArray<Node>, types: ReadonlyArray<string>): HydraPath => ({
  nodes,
  relationships: types.map((type, i) => ({
    id: 100 + i,
    type,
    src: nodes[i]?.id ?? 0,
    dst: nodes[i + 1]?.id ?? 0,
    properties: {}
  }))
})

const UID = "u"

const claimNode = (id: number, ckey: string, turnIdx: number): Node =>
  node(id, "Claim", {
    ckey,
    kind: claimKind(UID),
    text: `claim ${ckey}`,
    speaker: "user",
    ctype: "state",
    session_ord: 1,
    session_date: 20230101,
    t_event: 0,
    t_prec: "none",
    sid: "s1",
    source_session_id: "s1",
    turn_idx: turnIdx,
    cs: 0,
    ce: 5
  })

/** Two anchors both reach c1 and c2; a probe on `me|residence` reaches p1, which no anchor does. */
const graph = (config: MsPathsConfig): ReadonlyArray<HydraPath> => {
  if (config.sourceLabel === "Token") {
    return config.sourceValues.flatMap((tkey, i) => {
      const stem = tkey.slice(tkey.lastIndexOf("|") + 1)
      const token = node(1 + i, "Token", { tkey, stem, df: 2 })
      return [
        pathOf([token, claimNode(10, "u|c|c1", 0)], ["HITS"]),
        pathOf([token, claimNode(11, "u|c|c2", 1)], ["HITS"])
      ]
    })
  }
  if (config.sourceLabel === "Slot" && config.sourceValues.includes(slotKey(UID, "me", "residence"))) {
    const slot = node(20, "Slot", { skey: slotKey(UID, "me", "residence") })
    return [pathOf([slot, claimNode(12, "u|c|p1", 2)], ["FILLS"])]
  }
  return []
}

const understanding = {
  anchor_terms: ["mortgage", "wells"],
  historical: false,
  wants_count: false,
  time_ref: null,
  route: "fact",
  sub_questions: [],
  probes: [{ entity_canon: "me", attr: "residence" }]
}

const ask = async (ablations: { readonly noSelect?: boolean }) => {
  const kinds: Array<string> = []
  const llm = Layer.succeed(Llm, behaviorFake<Llm>({
    model: "stub",
    cacheDir: "",
    concurrency: 1,
    generateObject: (options: { kind: string }) =>
      Effect.sync(() => {
        kinds.push(options.kind)
        return {
          value: options.kind === "anchors" ? understanding : { keep: [{ id: shortId("u|c|c1"), reason: "x" }] },
          cached: true,
          model: "stub",
          inputTokens: 0,
          outputTokens: 0
        }
      }),
    usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
    resetUsage: Effect.void
  }))
  const hydra = Layer.succeed(HydraClient, behaviorFake<HydraClient>({
    msPaths: (config: MsPathsConfig) => Effect.sync(() => graph(config)),
    getById: (_label: string, key: string) =>
      Effect.succeed(key === userKey(UID) ? Option.some({ n_claims: 100 }) : Option.none())
  }))
  const supersede = Layer.succeed(Supersede, behaviorFake<Supersede>({
    readEdges: () => Effect.succeed(new Map())
  }))

  const result = await runWithBehaviorFakes(
    Effect.provide(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        return yield* retrieve.ask(UID, "Where do I live?", {
          questionDate: "2023/05/01 (Mon) 10:00",
          ablations
        })
      }),
      Retrieve.layer.pipe(Layer.provideMerge(hydra), Layer.provideMerge(supersede), Layer.provideMerge(llm))
    )
  )
  return { result, kinds }
}

describe("the no-select ablation", () => {
  it("keeps every candidate the selector would have seen, without calling it", async () => {
    const { result, kinds } = await ask({ noSelect: true })

    expect(kinds).toEqual(["anchors"])
    expect(result.verdict).toBe("ANSWER")
    expect(result.evidence.map((claim) => claim.ckey).sort()).toEqual(["u|c|c1", "u|c|c2", "u|c|p1"])
    expect(result.plan.selection).toMatchObject({ dropped: [], reasons: {}, fallback: false })
    expect([...result.plan.selection.kept].sort()).toEqual(
      ["u|c|c1", "u|c|c2", "u|c|p1"].map(shortId).sort()
    )
  })

  it("still protects the probe hits from the budget", async () => {
    const { result } = await ask({ noSelect: true })
    expect(result.plan.protectedKeys).toEqual(["u|c|p1"])
  })

  it("is the only thing that differs from the selected path", async () => {
    const { result, kinds } = await ask({})
    expect(kinds).toEqual(["anchors", "select"])
    expect(result.plan.protectedKeys).toEqual(["u|c|p1"])
    expect(result.plan.selection.reasons).toEqual({ [shortId("u|c|c1")]: "x" })
    expect(result.plan.selection.dropped).toEqual([])
  })
})
