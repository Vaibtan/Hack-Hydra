import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { Schema } from "effect"

/** `runtime_config_sha256`: the running node's effective configuration via `docker inspect`; both phases run at a 120 s cap and differ in the read cache. */
const PROJECT = "palimpsest-hydradb-benchmark"
const SERVICE = "hydradb"
const CONFIG_PREFIXES = ["GRAPH_", "MALLOC_", "RUST_MIN_STACK"] as const
const EXCLUDED = new Set(["GRAPH_AUTH_TOKEN_FILE"])
/** The engine's own defaults when the variable is unset (`graph_node/config.rs`). */
const ENGINE_DEFAULT_CACHE_ENABLED = true
const ENGINE_DEFAULT_QUERY_RUNTIME_MS = 30_000

export interface HydraRuntimeConfig {
  readonly sha256: string
  readonly imageId: string
  readonly memoryLimitBytes: number
  readonly nanoCpus: number
  readonly readCacheEnabled: boolean
  readonly queryRuntimeMs: number
  readonly env: Readonly<Record<string, string>>
}

export interface HydraRuntimeConfigUnavailable {
  readonly sha256: null
  readonly reason: string
}

export type RuntimeConfigResult = HydraRuntimeConfig | HydraRuntimeConfigUnavailable

const docker = (args: ReadonlyArray<string>): string =>
  execFileSync("docker", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

export interface RuntimeConfigInput {
  readonly imageId: string
  readonly memoryLimitBytes: number
  readonly nanoCpus: number
  readonly env: Readonly<Record<string, string>>
}

interface RuntimeEnvironment {
  [name: string]: string
}

export const canonicalise = (input: RuntimeConfigInput): string =>
  JSON.stringify({
    env: Object.fromEntries(
      Object.entries(input.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    ),
    imageId: input.imageId,
    memoryLimitBytes: input.memoryLimitBytes,
    nanoCpus: input.nanoCpus,
    schema: "hydradb-runtime-config/v1"
  })

export const hashRuntimeConfig = (input: RuntimeConfigInput): string =>
  createHash("sha256").update(canonicalise(input), "utf8").digest("hex")

export const configEnv = (
  containerEnv: ReadonlyArray<string>
): RuntimeEnvironment => {
  const out: RuntimeEnvironment = {}
  for (const entry of containerEnv) {
    const eq = entry.indexOf("=")
    if (eq === -1) continue
    const name = entry.slice(0, eq)
    if (EXCLUDED.has(name)) continue
    if (!CONFIG_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    out[name] = entry.slice(eq + 1)
  }
  return out
}

export interface InspectedContainer {
  readonly Image: string
  readonly Config: { readonly Env: ReadonlyArray<string> }
  readonly HostConfig: {
    readonly Memory: number
    readonly NanoCpus: number
  }
}

const InspectedContainerSchema = Schema.Struct({
  Image: Schema.String,
  Config: Schema.Struct({ Env: Schema.Array(Schema.String) }),
  HostConfig: Schema.Struct({ Memory: Schema.Number, NanoCpus: Schema.Number })
})

export const fromInspected = (container: InspectedContainer): HydraRuntimeConfig => {
  const env = configEnv(container.Config.Env)
  return {
    sha256: hashRuntimeConfig({
      imageId: container.Image,
      memoryLimitBytes: container.HostConfig.Memory,
      nanoCpus: container.HostConfig.NanoCpus,
      env
    }),
    imageId: container.Image,
    memoryLimitBytes: container.HostConfig.Memory,
    nanoCpus: container.HostConfig.NanoCpus,
    readCacheEnabled:
      env["GRAPH_OBJECT_STORE_CACHE_ENABLED"] === undefined
        ? ENGINE_DEFAULT_CACHE_ENABLED
        : env["GRAPH_OBJECT_STORE_CACHE_ENABLED"] !== "false",
    queryRuntimeMs: Number(env["GRAPH_MAX_QUERY_RUNTIME_MS"] ?? ENGINE_DEFAULT_QUERY_RUNTIME_MS),
    env
  }
}

export const readRuntimeConfig = (): RuntimeConfigResult => {
  let ids: ReadonlyArray<string>
  try {
    ids = docker([
      "ps",
      "--filter",
      `label=com.docker.compose.project=${PROJECT}`,
      "--filter",
      `label=com.docker.compose.service=${SERVICE}`,
      "--format",
      "{{.ID}}"
    ])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch (error) {
    return { sha256: null, reason: `docker ps failed: ${String(error).slice(0, 200)}` }
  }
  if (ids.length !== 1) {
    return {
      sha256: null,
      reason: `expected exactly one running ${PROJECT}/${SERVICE} container, found ${ids.length}`
    }
  }
  try {
    const inspected = Schema.decodeUnknownSync(Schema.Array(InspectedContainerSchema))(
      JSON.parse(docker(["inspect", ids[0]!]))
    )
    if (inspected.length !== 1) {
      return { sha256: null, reason: `docker inspect returned ${inspected.length} containers` }
    }
    return fromInspected(inspected[0]!)
  } catch (error) {
    return { sha256: null, reason: `docker inspect failed: ${String(error).slice(0, 200)}` }
  }
}
