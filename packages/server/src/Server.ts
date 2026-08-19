import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { ClaimGraph, Ingest, Reader, Retrieve, Supersede, Transcript } from "@palimpsest/palimpsest"
import { Layer } from "effect"
import { createServer } from "node:http"
import { PalimpsestApi } from "./Api.js"
import { UsersLive } from "./Handlers.js"

/**
 * The whole application, as one layer.
 *
 * There is exactly one `HydraClient` in the process on purpose: it holds the
 * bookmark from the last write and replays it into the next read, so an ask
 * that follows an ingest is read-your-writes without either endpoint knowing.
 * Two clients would break that silently.
 */
export const AppLive = Ingest.Default.pipe(
  Layer.provideMerge(Retrieve.Default),
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Transcript.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

export const ApiLive = HttpApiBuilder.api(PalimpsestApi).pipe(
  Layer.provide(UsersLive),
  Layer.provide(AppLive)
)

/**
 * CORS is wide open because the demo is a local Vite dev server on a different
 * port and this API is not reachable from anywhere else.
 */
export const ServerLive = (port: number) =>
  HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
    Layer.provide(HttpApiBuilder.middlewareCors()),
    Layer.provide(ApiLive),
    HttpServer.withLogAddress,
    Layer.provide(NodeHttpServer.layer(createServer, { port }))
  )

export const serve = ServerLive
