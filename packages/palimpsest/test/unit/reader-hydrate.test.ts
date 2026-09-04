import { HydraClient, type HydraPath, type MsPathsConfig } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { turnKey } from "../../src/Keys.js"
import { Reader, SPAN_CONTEXT, type ReadAnswer } from "../../src/Reader.js"
import type { AsOfLabelled } from "../../src/Scoring.js"

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
const HEAD = "H".repeat(700)
const TAIL = "T".repeat(500)
const WHOLE = HEAD + TAIL

const claim = (ckey: string, turnIdx: number, cs: number, ce: number): AsOfLabelled => ({
  ckey,
  text: "",
  speaker: "user",
  ctype: "state",
  sessionOrd: 2,
  sessionDate: 20230102,
  tEvent: 0,
  tPrec: "none",
  sid: "s2",
  sessionKey: "s2",
  turnIdx,
  cs,
  ce,
  anchors: [],
  convergence: 0,
  score: 0,
  hops: 1,
  status: "CURRENT",
  supersededBy: null,
  atSession: null
})

/** Turn 1 spilled into a second chunk; turn 0 is a short assistant turn; `u|c|ghost` has no EVIDENCE edge. */
const graph = (config: MsPathsConfig, calls: Array<string>): ReadonlyArray<HydraPath> => {
  calls.push(`${config.sourceLabel}:${config.relTypes.join("+")}`)
  const turn1 = node(11, "Turn", { turn: turnKey(UID, "s2", 1), text: HEAD, chunks: 2, role: "user" })
  const turn0 = node(10, "Turn", { turn: turnKey(UID, "s2", 0), text: "Tell me.", chunks: 1, role: "assistant" })
  const chunk = node(21, "TurnChunk", { chunk_idx: 1, text: TAIL })
  const claimA = node(1, "Claim", { ckey: "u|c|a" })
  const claimB = node(1, "Claim", { ckey: "u|c|b" })

  if (config.sourceLabel === "Claim" && config.relTypes.length === 1) {
    return config.sourceValues.flatMap((ckey) =>
      ckey === "u|c|a"
        ? [pathOf([claimA, turn1], ["EVIDENCE"])]
        : ckey === "u|c|b"
          ? [pathOf([claimB, turn1], ["EVIDENCE"])]
          : []
    )
  }
  if (config.sourceLabel === "Claim") {
    return config.sourceValues.flatMap((ckey) =>
      ckey === "u|c|a"
        ? [pathOf([claimA, turn1, chunk], ["EVIDENCE", "HAS_CHUNK"])]
        : ckey === "u|c|b"
          ? [pathOf([claimB, turn1, chunk], ["EVIDENCE", "HAS_CHUNK"])]
          : []
    )
  }
  if (config.relTypes[0] === "HAS_TURN") {
    const session = node(30, "Session", { sess: "u|sess|s2" })
    return config.sourceValues.flatMap((key) =>
      key === turnKey(UID, "s2", 1)
        ? [pathOf([turn1, session], ["HAS_TURN"])]
        : key === turnKey(UID, "s2", 0)
          ? [pathOf([turn0, session], ["HAS_TURN"])]
          : []
    )
  }
  return config.sourceValues.flatMap((key) =>
    key === turnKey(UID, "s2", 1) ? [pathOf([turn1, chunk], ["HAS_CHUNK"])] : []
  )
}

const stubLlm = Layer.succeed(Llm, {
  model: "stub",
  cacheDir: "",
  concurrency: 1,
  generateObject: () =>
    Effect.succeed({
      value: { answer: "x", cited_ids: ["u|c|a".slice(-8)], reasoning: "" },
      cached: true,
      model: "stub",
      inputTokens: 0,
      outputTokens: 0
    }),
  usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
  resetUsage: Effect.void
} as unknown as Llm)

const read = async (
  evidence: ReadonlyArray<AsOfLabelled>,
  route: "fact" | "assistant_output"
): Promise<{ readonly answer: ReadAnswer; readonly calls: ReadonlyArray<string> }> => {
  const calls: Array<string> = []
  const hydra = Layer.succeed(HydraClient, {
    msPaths: (config: MsPathsConfig) => Effect.sync(() => graph(config, calls))
  } as unknown as HydraClient)
  const answer = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const reader = yield* Reader
        return yield* reader.read("q", "2023/05/01 (Mon) 10:00", evidence, { route })
      }),
      Reader.Default.pipe(Layer.provide(hydra), Layer.provide(stubLlm))
    ) as unknown as Effect.Effect<ReadAnswer, never, never>
  )
  return { answer, calls }
}

describe("hydration of a spilled turn", () => {
  it("reassembles the tail at span granularity only when the span reaches into it", async () => {
    const reaching = claim("u|c|a", 1, 690, 720)
    const { answer, calls } = await read([reaching], "fact")
    const [span] = answer.spans
    expect(span!.excerpt).toBe(WHOLE.slice(690 - SPAN_CONTEXT, 720 + SPAN_CONTEXT))
    expect(span!.excerpt.slice(span!.highlight.start, span!.highlight.end)).toBe(WHOLE.slice(690, 720))
    expect(calls).toEqual(["Claim:EVIDENCE", "Claim:EVIDENCE+HAS_CHUNK"])

    const early = await read([claim("u|c|a", 1, 10, 20)], "fact")
    expect(early.calls).toEqual(["Claim:EVIDENCE"])
    expect(early.answer.spans[0]!.excerpt).toBe(HEAD.slice(0, 20 + SPAN_CONTEXT))
  })

  it("reassembles every spilled turn at turn granularity and prefixes the turn before", async () => {
    const { answer, calls } = await read([claim("u|c|a", 1, 10, 20)], "assistant_output")
    const [span] = answer.spans
    const prefix = "(assistant said) Tell me.\n\n"
    expect(span!.excerpt).toBe(prefix + WHOLE)
    expect(span!.highlight).toEqual({ start: prefix.length + 10, end: prefix.length + 20 })
    expect(calls).toEqual(["Turn:HAS_TURN", "Turn:HAS_CHUNK"])
    expect(answer.granularity).toBe("turn")
  })
})

describe("a claim whose walk returned no turn", () => {
  it("is dropped silently at both granularities, and the rest is read", async () => {
    for (const route of ["fact", "assistant_output"] as const) {
      const { answer } = await read([claim("u|c|ghost", 5, 0, 4), claim("u|c|a", 1, 10, 20)], route)
      expect(answer.spans.map((span) => span.ckey)).toEqual(["u|c|a"])
      expect(answer.pack).not.toBeNull()
      expect(answer.pack!.kept).toHaveLength(1)
    }
  })

  it("reads nothing when every claim is unreachable", async () => {
    const { answer } = await read([claim("u|c|ghost", 5, 0, 4)], "fact")
    expect(answer.spans).toEqual([])
    expect(answer.notInMemory).toBe(true)
  })
})

describe("two spans of one turn", () => {
  it("collapse into one excerpt when the retained window covers both", async () => {
    const { answer } = await read([claim("u|c|a", 1, 10, 20), claim("u|c|b", 1, 30, 40)], "fact")
    expect(answer.spans).toHaveLength(1)
    expect(answer.spans[0]).toMatchObject({ ckey: "u|c|b", cs: 10, ce: 40 })
  })

  it("stay two rows when their windows are disjoint", async () => {
    const { answer } = await read([claim("u|c|a", 1, 0, 20), claim("u|c|b", 1, 1000, 1100)], "fact")
    expect(answer.spans.map((span) => span.ckey)).toEqual(["u|c|a", "u|c|b"])
  })
})
