import { type Etag, type HttpPlatform, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { NodeHttpClient } from "@effect/platform-node"
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
import { type FileSystem, Layer, type Path } from "effect"
import { createServer } from "node:http"
import { PalimpsestApi } from "./Api.js"
import { UsersLive } from "./Handlers.js"

const HttpLive = NodeHttpClient.layerUndici
const HydraLive = HydraClient.layer.pipe(Layer.provide(HttpLive))
const LlmStackLive = LlmLive().pipe(Layer.provide(HttpLive))
const SourceIndexStackLive = SourceIndexLive.pipe(Layer.provide(HydraLive))
const RuntimeLive = Layer.mergeAll(HydraLive, LlmStackLive, SourceIndexStackLive)

const LegacyAppLive = Ingest.layer.pipe(
  Layer.provideMerge(Retrieve.layer),
  Layer.provideMerge(Reader.layer),
  Layer.provideMerge(Transcript.layer),
  Layer.provideMerge(ClaimGraph.layer),
  Layer.provideMerge(Supersede.layer)
)

const LegacyAppWithRuntime = LegacyAppLive.pipe(Layer.provide(RuntimeLive))

type AppServices =
  | ClaimGraph
  | HydraClient
  | Ingest
  | Llm
  | Reader
  | Retrieve
  | SourceIndex
  | Supersede
  | Transcript

export const AppLive: Layer.Layer<AppServices, unknown, never> = Layer.mergeAll(
  RuntimeLive,
  LegacyAppWithRuntime
)

const UsersWithApp = UsersLive.pipe(
  Layer.provide(AppLive),
  HttpRouter.provideRequest(AppLive)
)

type ApiInfrastructure =
  | Etag.Generator
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | HttpRouter.HttpRouter
  | Path.Path

export const ApiLive: Layer.Layer<never, unknown, ApiInfrastructure> = HttpApiBuilder.layer(PalimpsestApi).pipe(
  Layer.provide(UsersWithApp)
)

export const ServerLive = (port: number): Layer.Layer<never, unknown, never> =>
  HttpRouter.serve(Layer.mergeAll(ApiLive, HttpRouter.cors())).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port }))
  )

export const serve: (port: number) => Layer.Layer<never, unknown, never> = ServerLive
