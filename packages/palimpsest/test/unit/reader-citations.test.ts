import { HydraClient } from "@palimpsest/hydra"
import { NodeHttpClient } from "@effect/platform-node"
import { Llm } from "@palimpsest/llm"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Reader, type HydratedSpan } from "../../src/Reader.js"
import { NOT_IN_MEMORY } from "../../src/Routes.js"
import { behaviorFake, runWithBehaviorFakes } from "../BehaviorFake.js"

const span = (id: string): HydratedSpan => ({
  ckey: `u|c|${id}`,
  id,
  sid: "s1",
  sessionKey: "s1",
  turnIdx: 0,
  cs: 0,
  ce: 10,
  sessionOrd: 1,
  sessionDate: 20230101,
  tEvent: 0,
  speaker: "user",
  status: "CURRENT",
  atSession: null,
  excerpt: "I moved to Osaka in March",
  highlight: { start: 0, end: 10 }
})

interface Reply {
  readonly answer: string
  readonly cited_ids: ReadonlyArray<string>
  readonly reasoning?: string
  readonly premise_supported?: boolean
  readonly premise_note?: string
}

const stubLlm = (replies: ReadonlyArray<Reply>, prompts: Array<string>) => {
  let next = 0
  return Layer.succeed(Llm, behaviorFake<Llm>({
    model: "stub",
    cacheDir: "",
    concurrency: 1,
    generateObject: (options: { prompt: string; schema: Schema.Top }) =>
      Effect.sync(() => {
        prompts.push(options.prompt)
        const reply = replies[next++] ?? replies[replies.length - 1]!
        return {
          value: {
            answer: reply.answer,
            cited_ids: reply.cited_ids,
            reasoning: reply.reasoning ?? "",
            premise_supported: reply.premise_supported ?? true,
            premise_note: reply.premise_note ?? ""
          },
          cached: false,
          model: "stub",
          inputTokens: 10,
          outputTokens: 5
        }
      }),
    usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
    resetUsage: Effect.void
  }))
}

const read = async (
  spans: ReadonlyArray<HydratedSpan>,
  replies: ReadonlyArray<Reply>
): Promise<{
  readonly answer: string
  readonly notInMemory: boolean
  readonly citedIds: ReadonlyArray<string>
  readonly recited: boolean
  readonly prompts: ReadonlyArray<string>
}> => {
  const prompts: Array<string> = []
  const layer = Reader.layer.pipe(
    Layer.provide(stubLlm(replies, prompts)),
    Layer.provideMerge(HydraClient.layer),
    Layer.provide(NodeHttpClient.layerUndici)
  )
  const answer = await runWithBehaviorFakes(
    Effect.provide(
      Effect.gen(function* () {
        const reader = yield* Reader
        return yield* reader.readSpans("Where do I live?", "2023/05/01 (Mon) 10:00", spans)
      }),
      layer
    )
  )
  return { ...answer, prompts }
}

describe("an answer that cites what exists", () => {
  it("is returned as it stands, with one call", async () => {
    const result = await read(
      [span("aaaa1111"), span("bbbb2222")],
      [{ answer: "Osaka", cited_ids: ["aaaa1111"] }]
    )

    expect(result.answer).toBe("Osaka")
    expect(result.citedIds).toEqual(["aaaa1111"])
    expect(result.recited).toBe(false)
    expect(result.prompts).toHaveLength(1)
  })

  it("keeps only the ids that are in the pack", async () => {
    const result = await read(
      [span("aaaa1111")],
      [{ answer: "Osaka", cited_ids: ["aaaa1111", "ffff9999"] }]
    )

    expect(result.citedIds).toEqual(["aaaa1111"])
    expect(result.recited).toBe(false)
  })
})

describe("the one re-ask", () => {
  it("fires when nothing cited exists, and shows the model the ids it may use", async () => {
    const result = await read(
      [span("aaaa1111"), span("bbbb2222")],
      [
        { answer: "Osaka", cited_ids: ["ffff9999"] },
        { answer: "Osaka", cited_ids: ["bbbb2222"] }
      ]
    )

    expect(result.recited).toBe(true)
    expect(result.prompts).toHaveLength(2)
    expect(result.prompts[1]).toContain("cited no excerpt that exists")
    expect(result.prompts[1]).toContain("aaaa1111")
    expect(result.prompts[1]).toContain("bbbb2222")
    expect(result.answer).toBe("Osaka")
    expect(result.citedIds).toEqual(["bbbb2222"])
    expect(result.notInMemory).toBe(false)
  })

  it("fires when the model cited nothing at all", async () => {
    const result = await read(
      [span("aaaa1111")],
      [
        { answer: "Osaka", cited_ids: [] },
        { answer: "Osaka", cited_ids: ["aaaa1111"] }
      ]
    )

    expect(result.recited).toBe(true)
    expect(result.citedIds).toEqual(["aaaa1111"])
  })

  it("happens at most once, and a second failure becomes not-in-memory", async () => {
    const result = await read(
      [span("aaaa1111")],
      [
        { answer: "Osaka", cited_ids: ["ffff9999"] },
        { answer: "Osaka", cited_ids: ["ffff9999"] },
        { answer: "should never be asked for", cited_ids: ["aaaa1111"] }
      ]
    )

    expect(result.prompts).toHaveLength(2)
    expect(result.answer).toBe(NOT_IN_MEMORY)
    expect(result.notInMemory).toBe(true)
    expect(result.citedIds).toEqual([])
    expect(result.recited).toBe(true)
  })

  it("does not fire on an honest refusal, which has nothing to cite", async () => {
    const result = await read([span("aaaa1111")], [{ answer: NOT_IN_MEMORY, cited_ids: [] }])

    expect(result.prompts).toHaveLength(1)
    expect(result.recited).toBe(false)
    expect(result.notInMemory).toBe(true)
  })

  it("does not fire on a refusal that says more than the bare phrase", async () => {
    const result = await read(
      [span("aaaa1111")],
      [{ answer: `${NOT_IN_MEMORY} — nothing here mentions a residence.`, cited_ids: [] }]
    )

    expect(result.prompts).toHaveLength(1)
    expect(result.notInMemory).toBe(true)
  })
})

describe("an empty pack", () => {
  it("is a refusal without calling the reader at all", async () => {
    const result = await read([], [{ answer: "Osaka", cited_ids: [] }])

    expect(result.prompts).toEqual([])
    expect(result.answer).toBe(NOT_IN_MEMORY)
    expect(result.notInMemory).toBe(true)
  })
})
