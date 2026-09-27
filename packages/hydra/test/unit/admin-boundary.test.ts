import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { HydraAdmin, HydraAdminUnauthorized } from "../../src/Admin.js"

const httpLayerFor = (http?: HttpClient.HttpClient): Layer.Layer<HttpClient.HttpClient> =>
  http === undefined
    ? Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die(new Error("no HTTP expected")))
    )
    : Layer.succeed(HttpClient.HttpClient, http)

const runAdmin = <A, E>(
  env: Record<string, string>,
  effect: Effect.Effect<A, E, HydraAdmin>,
  http?: HttpClient.HttpClient
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(HydraAdmin.layer.pipe(Layer.provide(httpLayerFor(http)))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))
    )
  )

const currentAdmin = Effect.gen(function* () {
  return yield* HydraAdmin
})

describe("HydraAdmin boundary", () => {
  it("fails closed without an admin token", async () => {
    const failure = await runAdmin({}, currentAdmin).then(
      () => null,
      (error) => {
        // SAFETY: the admin layer only fails with HydraAdminUnauthorized; the assertion below checks the tag.
        return error as HydraAdminUnauthorized
      }
    )
    expect(failure).toBeInstanceOf(HydraAdminUnauthorized)
    expect(failure?.reason).toBe("HYDRA_ADMIN_TOKEN is not configured")
  })

  it("fails closed on an empty admin token", async () => {
    const failure = await runAdmin({ HYDRA_ADMIN_TOKEN: "  " }, currentAdmin).then(
      () => null,
      (error) => {
        // SAFETY: the admin layer only fails with HydraAdminUnauthorized; the assertion below checks the tag.
        return error as HydraAdminUnauthorized
      }
    )
    expect(failure).toBeInstanceOf(HydraAdminUnauthorized)
  })

  it("refuses an admin token equal to the service token", async () => {
    const failure = await runAdmin(
      { HYDRA_TOKEN: "shared-token", HYDRA_ADMIN_TOKEN: "shared-token" },
      currentAdmin
    ).then(
      () => null,
      (error) => {
        // SAFETY: the admin layer only fails with HydraAdminUnauthorized; the assertion below checks the tag.
        return error as HydraAdminUnauthorized
      }
    )
    expect(failure).toBeInstanceOf(HydraAdminUnauthorized)
    expect(failure?.reason).toBe("HYDRA_ADMIN_TOKEN must differ from the service token")
  })

  it("maps unrestricted results into admin rows", async () => {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              query_id: "query-1",
              columns: ["k", "n"],
              rows: [[{ type: "string", value: "a" }, { type: "null" }]],
              read_epoch: 1,
              next_cursor: null,
              bookmark: "bookmark-9"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
      )
    )
    const result = await runAdmin(
      { HYDRA_ADMIN_TOKEN: "admin-token" },
      Effect.gen(function* () {
        const admin = yield* HydraAdmin
        return yield* admin.query("MATCH (n) RETURN n.k AS k", {})
      }),
      http
    )
    expect(result.columns).toEqual(["k", "n"])
    expect(result.rows).toEqual([{ k: "a", n: null }])
    expect(result.bookmark).toBe("bookmark-9")
  })
})
