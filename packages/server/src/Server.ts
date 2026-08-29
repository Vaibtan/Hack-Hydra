import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { NodeHttpClient } from "@effect/platform-node"
import type { LanguageModel } from "@effect/ai"
import { HydraClient } from "@palimpsest/hydra"
import { Llm, LlmLive } from "@palimpsest/llm"
import {
  ClaimGraph,
  Ingest,
  Reader,
  Retrieve,
  SourceIndex,
  SourceIndexLive,
  Supersede,
  Transcript
} from "@palimpsest/palimpsest"
import { Layer } from "effect"
import { createServer } from "node:http"
import { PalimpsestApi } from "./Api.js"
import { UsersLive } from "./Handlers.js"

/**
 * The whole application, as one layer.
 *
 * One `HydraClient` owns the protocol adapter. Its causal context is fiber-
 * scoped, so callers carry a bookmark from ingest to ask rather than inheriting
 * another request's last write or relying on process affinity.
 */
/** Legacy read stack plus the bounded transactional source/index capability. */
// Reuse these exact layer values below. Effect memoizes one layer graph, so the
// source-index service and legacy services receive one Hydra client.
const HttpLive = NodeHttpClient.layerUndici
const HydraLive = HydraClient.Default.pipe(Layer.provide(HttpLive))
const LlmStackLive = LlmLive().pipe(Layer.provide(HttpLive))
const SourceIndexStackLive = SourceIndexLive.pipe(Layer.provide(HydraLive))
const RuntimeLive = Layer.mergeAll(HydraLive, LlmStackLive, SourceIndexStackLive)

const LegacyAppLive = Ingest.Default.pipe(
  Layer.provideMerge(Retrieve.Default),
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Transcript.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(Supersede.Default)
)

const LegacyAppWithRuntime = LegacyAppLive.pipe(Layer.provide(RuntimeLive))

type AppServices =
  | ClaimGraph
  | HydraClient
  | Ingest
  | LanguageModel.LanguageModel
  | Llm
  | Reader
  | Retrieve
  | SourceIndex
  | Supersede
  | Transcript

/** Complete server capability context with no external service requirement. */
export const AppLive: Layer.Layer<AppServices, unknown, never> = Layer.mergeAll(
  RuntimeLive,
  LegacyAppWithRuntime
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
