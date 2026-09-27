import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { HydraClient } from "../../src/Client.js"
import { createTransport } from "../../src/Transport.js"

const HydraTestLive = HydraClient.layer.pipe(Layer.provide(NodeHttpClient.layerUndici))

describe("HydraClient causal context", () => {
  it("does not share a mutable default bookmark across independent runtimes", async () => {
    const observedBookmarks: Array<string | null> = []
    let responseNumber = 0
    const RequestBody = Schema.Struct({ bookmark: Schema.optionalKey(Schema.String) })
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") throw new Error("expected a JSON request body")
        const body = Schema.decodeUnknownSync(RequestBody)(
          JSON.parse(new TextDecoder().decode(request.body.body))
        )
        observedBookmarks.push(body.bookmark ?? null)
        responseNumber++
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              query_id: `query-${responseNumber}`,
              columns: [],
              rows: [],
              read_epoch: responseNumber,
              next_cursor: null,
              bookmark: `bookmark-${responseNumber}`
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
      })
    )
    const send = createTransport({
      baseUrl: "http://hydra.test",
      token: "test-token",
      graph: "test-graph",
      cellId: "cell-0",
      http
    })

    await Effect.runPromise(send("RETURN 1", {}))
    await Effect.runPromise(send("RETURN 1", {}))
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* send("RETURN 1", {})
        yield* send("RETURN 1", {})
      })
    )

    expect(observedBookmarks).toEqual([null, null, null, "bookmark-3"])
  })

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

  it("starts an unspecified request with an empty causal floor", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* hydra.withCausalBookmark(
          "outer-bookmark",
          Effect.gen(function* () {
            const withinEmptyRequest = yield* hydra.withCausalBookmark(undefined, hydra.lastBookmark)
            const afterEmptyRequest = yield* hydra.lastBookmark
            return {
              withinEmptyRequest: Option.getOrNull(withinEmptyRequest),
              afterEmptyRequest: Option.getOrNull(afterEmptyRequest)
            }
          })
        )
      }).pipe(Effect.provide(HydraTestLive))
    )

    expect(result).toEqual({ withinEmptyRequest: null, afterEmptyRequest: "outer-bookmark" })
  })
})
