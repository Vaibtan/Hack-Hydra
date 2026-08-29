import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { HydraClient } from "../../src/index.js"

const HydraTestLive = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

describe("HydraClient causal context", () => {
  it("keeps caller-supplied bookmarks local to their request fibers", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const within = yield* Effect.all(
          [
            hydra.withCausalBookmark("bookmark-user-a", hydra.lastBookmark),
            hydra.withCausalBookmark("bookmark-user-b", hydra.lastBookmark)
          ],
          { concurrency: "unbounded" }
        )
        const after = yield* hydra.lastBookmark
        return { within: within.map(Option.getOrNull), after: Option.getOrNull(after) }
      }).pipe(Effect.provide(HydraTestLive))
    )

    expect(result).toEqual({
      within: ["bookmark-user-a", "bookmark-user-b"],
      after: null
    })
  })
})
