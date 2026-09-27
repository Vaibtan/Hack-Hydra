import { HttpClient } from "effect/unstable/http"
import { Config, Context, Data, Effect, Layer } from "effect"
import { isHydraPath } from "./Decode.js"
import type { HydraError } from "./Errors.js"
import type { JsonObject } from "./JsonValue.js"
import { memoryPathFromHydra, type MemoryPath, type PropertyValue } from "./Memory.js"
import { createTransport } from "./Transport.js"

/**
 * Admin/test-only escape hatch. Production layers must never provide this
 * service: normal API principals cannot reach unrestricted querying.
 */
export class HydraAdminUnauthorized extends Data.TaggedError("HydraAdminUnauthorized")<{
  readonly reason: string
}> {
  override get message(): string {
    return `Hydra admin access refused: ${this.reason}`
  }
}

export type AdminCell = PropertyValue | MemoryPath | null
export type AdminRow = Readonly<Record<string, AdminCell>>

export interface AdminResult {
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<AdminRow>
  readonly bookmark: string | null
}

const unauthorized = (reason: string): HydraAdminUnauthorized => new HydraAdminUnauthorized({ reason })

const make = Effect.gen(function* () {
  const baseUrl = yield* Config.string("HYDRA_URL").pipe(
    Config.withDefault("http://127.0.0.1:8443")
  )
  const serviceToken = yield* Config.string("HYDRA_TOKEN").pipe(
    Config.withDefault("local-development-token-32-bytes")
  )
  const adminToken = yield* Config.string("HYDRA_ADMIN_TOKEN").pipe(
    Effect.mapError(() => unauthorized("HYDRA_ADMIN_TOKEN is not configured"))
  )
  if (adminToken.trim() === "") {
    return yield* unauthorized("HYDRA_ADMIN_TOKEN must not be empty")
  }
  if (adminToken === serviceToken) {
    return yield* unauthorized("HYDRA_ADMIN_TOKEN must differ from the service token")
  }
  const graph = yield* Config.string("HYDRA_GRAPH").pipe(Config.withDefault("default"))
  const cellId = yield* Config.string("HYDRA_CELL").pipe(Config.withDefault("cell-0"))
  const http = yield* HttpClient.HttpClient
  const send = createTransport({ baseUrl, token: adminToken, graph, cellId, http })

  const query = (
    cypher: string,
    parameters: JsonObject = {}
  ): Effect.Effect<AdminResult, HydraError> =>
    Effect.gen(function* () {
      const result = yield* send(cypher, parameters, {})
      yield* Effect.logInfo("hydra admin query executed", {
        query: cypher,
        rows: result.rows.length
      })
      return {
        columns: result.columns,
        rows: result.rows.map((row) => {
          const out: Record<string, AdminCell> = {}
          for (const [column, cell] of Object.entries(row)) {
            if (cell === null) {
              out[column] = null
              continue
            }
            out[column] = isHydraPath(cell) ? memoryPathFromHydra(cell) : cell
          }
          return out
        }),
        bookmark: result.bookmark
      }
    })

  return { query } as const
})

export type HydraAdmin = Effect.Success<typeof make>
const HydraAdminTag = Context.Service<HydraAdmin>("palimpsest/HydraAdmin")
export const HydraAdmin = Object.assign(HydraAdminTag, { layer: Layer.effect(HydraAdminTag, make) })
