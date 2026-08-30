import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

/**
 * `runtime_config_sha256` — the field `ops/hydradb/runtime-manifest.v1.json`
 * requires in every result manifest, computed here rather than asserted.
 *
 * Two settings are chosen **per phase**, not once (`ops/hydradb/step-load-2026-08.md`,
 * *Two settings are chosen per phase*): the object-store read cache is off
 * while ingesting and on while evaluating, and the query runtime cap is 120 s
 * while ingesting and the shipped 30 s while evaluating. Both change how a read
 * is served, never what is stored. A results envelope that did not record which
 * of the two it ran under would let an ingest-phase latency number and an
 * eval-phase one sit in the same table looking alike, so the hash is what makes
 * the phase a property of the result instead of a thing someone remembers.
 *
 * **It is read from the running container, not from the Compose file.** The
 * Compose file says what was intended; `docker inspect` says what the node is
 * actually running with, which is the only thing a latency number was measured
 * against. A node left up from a previous phase — exactly the state the
 * benchmark was found in on 2026-08-31 — differs from the file and agrees with
 * itself.
 *
 * The node exposes no configuration endpoint (`/livez`, `/readyz`, `/metrics`
 * are the whole admin surface, `vendor/hydradb/src/bin/graph_node/admin.rs`),
 * so Docker is the only place the effective environment can be read from.
 */

/** The Compose labels that name the one benchmark node. */
const PROJECT = "palimpsest-hydradb-benchmark"
const SERVICE = "hydradb"

/**
 * Environment variables that change how the engine behaves.
 *
 * A prefix allow-list rather than the whole environment: `PATH`, `HOSTNAME` and
 * the injected object-store credentials are not runtime configuration, and a
 * credential rotation must not read as a different runtime. Everything the ops
 * note and the Compose file argue about — the read cache, the query cap, the
 * writer lease, the storage buffers, tier A's allocator tunables — starts with
 * one of these.
 */
const CONFIG_PREFIXES = ["GRAPH_", "MALLOC_", "RUST_MIN_STACK"] as const

/** A path to a secret is provenance, not behaviour; never hashed. */
const EXCLUDED = new Set(["GRAPH_AUTH_TOKEN_FILE"])

export interface HydraRuntimeConfig {
  /** sha256 over the canonical form below. The manifest field. */
  readonly sha256: string
  /** Resolved image id, so a rebuilt runtime is a different configuration. */
  readonly imageId: string
  /** Container memory limit in bytes — what the capacity gate measures against. */
  readonly memoryLimitBytes: number
  readonly nanoCpus: number
  /**
   * The two phase-selected settings, echoed in the clear so a reader of a
   * results file can tell an ingest-phase result from an eval-phase one without
   * a Docker daemon or a table of hashes.
   */
  readonly readCacheEnabled: boolean
  readonly queryRuntimeMs: number
  /** Every hashed variable, sorted. The hash's preimage, minus the framing. */
  readonly env: Readonly<Record<string, string>>
}

/** Why no configuration could be read. Recorded rather than thrown. */
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

/**
 * The canonical preimage: one JSON object with sorted keys and no whitespace.
 *
 * Written out rather than hashing `JSON.stringify(config)` directly so that
 * adding a reporting field to `HydraRuntimeConfig` later cannot silently change
 * every historical hash.
 */
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

/**
 * Selects the configuration variables out of a container's whole environment.
 *
 * Exported for the unit test: the interesting behaviour is *which* variables
 * are in the preimage, and that is decidable without a Docker daemon.
 */
export const configEnv = (
  containerEnv: ReadonlyArray<string>
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
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

/** The shape `docker inspect` returns, narrowed to what is read. */
export interface InspectedContainer {
  readonly Image: string
  readonly Config: { readonly Env: ReadonlyArray<string> }
  readonly HostConfig: {
    readonly Memory: number
    readonly NanoCpus: number
  }
}

/**
 * Builds the runtime configuration from an already-inspected container, so the
 * whole derivation is testable and only the two `docker` calls are not.
 */
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
    // The Compose default for each, so an unset variable reports the value the
    // node is actually running with rather than `null`.
    readCacheEnabled: (env["GRAPH_OBJECT_STORE_CACHE_ENABLED"] ?? "true") !== "false",
    queryRuntimeMs: Number(env["GRAPH_MAX_QUERY_RUNTIME_MS"] ?? "30000"),
    env
  }
}

/**
 * Reads the running benchmark node's effective configuration.
 *
 * **Never throws.** A missing Docker daemon, a stopped node or a second
 * matching container is recorded as `{ sha256: null, reason }` and the run
 * continues: the field is provenance, and refusing to evaluate because Docker
 * is not on this host would make the harness unusable against a remote node for
 * a reason that has nothing to do with the numbers. A `null` in a committed
 * envelope is visible and answerable; a fabricated hash would not be.
 */
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
    const inspected = JSON.parse(docker(["inspect", ids[0]!])) as ReadonlyArray<InspectedContainer>
    if (inspected.length !== 1) {
      return { sha256: null, reason: `docker inspect returned ${inspected.length} containers` }
    }
    return fromInspected(inspected[0]!)
  } catch (error) {
    return { sha256: null, reason: `docker inspect failed: ${String(error).slice(0, 200)}` }
  }
}
