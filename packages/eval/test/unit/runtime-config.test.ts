import { describe, expect, it } from "vitest"
import {
  canonicalise,
  configEnv,
  fromInspected,
  hashRuntimeConfig,
  type InspectedContainer
} from "../../src/RuntimeConfig.js"

/**
 * `runtime_config_sha256` exists to make one thing checkable after the fact:
 * which *phase* a result was measured in. The object-store read cache is off
 * while ingesting and on while evaluating, and the query cap is 120 s while
 * ingesting and 30 s while evaluating — two settings that change a cold read
 * from 11 s to 68 ms and a lost user into a slow one. A results envelope that
 * did not distinguish them would put an ingest-phase latency number and a
 * gate-phase one in the same table looking alike.
 *
 * So the tests are about what is *in* the preimage and what is not.
 */

const container = (env: ReadonlyArray<string>, over: Partial<InspectedContainer> = {}): InspectedContainer => ({
  Image: "sha256:514349a17890bf2a35e5e5eb81b41c09b771b07e497fa3f51eb22e7727d66081",
  Config: { Env: env },
  HostConfig: { Memory: 4 * 1024 ** 3, NanoCpus: 4_000_000_000 },
  ...over
})

const INGEST_ENV = [
  "GRAPH_OBJECT_STORE_CACHE_ENABLED=false",
  "GRAPH_MAX_QUERY_RUNTIME_MS=120000",
  "GRAPH_MAX_UNFLUSHED_BYTES=268435456",
  "MALLOC_ARENA_MAX=2",
  "RUST_MIN_STACK=33554432"
]

const EVAL_ENV = [
  "GRAPH_OBJECT_STORE_CACHE_ENABLED=true",
  "GRAPH_MAX_QUERY_RUNTIME_MS=30000",
  "GRAPH_MAX_UNFLUSHED_BYTES=268435456",
  "MALLOC_ARENA_MAX=2",
  "RUST_MIN_STACK=33554432"
]

describe("what the hash covers", () => {
  it("separates the ingest phase from the eval phase", () => {
    expect(fromInspected(container(INGEST_ENV)).sha256).not.toBe(
      fromInspected(container(EVAL_ENV)).sha256
    )
  })

  it("is stable across a restart that changed nothing", () => {
    expect(fromInspected(container(EVAL_ENV)).sha256).toBe(
      fromInspected(container([...EVAL_ENV].reverse())).sha256
    )
  })

  it("changes when the runtime image is rebuilt", () => {
    expect(fromInspected(container(EVAL_ENV, { Image: "sha256:different" })).sha256).not.toBe(
      fromInspected(container(EVAL_ENV)).sha256
    )
  })

  it("changes when the container's memory limit moves", () => {
    // The limit is what the capacity gate measures against, and the step-load
    // curve is the thing that sets it — a number measured under a 6 GiB limit
    // is not the same measurement as one under 4 GiB.
    const raised = container(EVAL_ENV, {
      HostConfig: { Memory: 6 * 1024 ** 3, NanoCpus: 4_000_000_000 }
    })
    expect(fromInspected(raised).sha256).not.toBe(fromInspected(container(EVAL_ENV)).sha256)
  })

  it("changes when a storage buffer moves", () => {
    const tuned = container([
      ...EVAL_ENV.filter((entry) => !entry.startsWith("GRAPH_MAX_UNFLUSHED_BYTES")),
      "GRAPH_MAX_UNFLUSHED_BYTES=67108864"
    ])
    expect(fromInspected(tuned).sha256).not.toBe(fromInspected(container(EVAL_ENV)).sha256)
  })
})

describe("what the hash deliberately ignores", () => {
  it("does not change when object-store credentials are rotated", () => {
    const before = container([...EVAL_ENV, "AWS_SECRET_ACCESS_KEY=one", "PATH=/usr/bin"])
    const after = container([...EVAL_ENV, "AWS_SECRET_ACCESS_KEY=two", "PATH=/bin"])
    expect(fromInspected(before).sha256).toBe(fromInspected(after).sha256)
  })

  it("does not change when the auth-token file moves", () => {
    // A path to a secret is provenance, not behaviour.
    const before = container([...EVAL_ENV, "GRAPH_AUTH_TOKEN_FILE=/run/secrets/a"])
    const after = container([...EVAL_ENV, "GRAPH_AUTH_TOKEN_FILE=/run/secrets/b"])
    expect(fromInspected(before).sha256).toBe(fromInspected(after).sha256)
  })

  it("selects only the engine's own variables", () => {
    expect(
      configEnv([
        "GRAPH_WRITER_LEASE_MS=30000",
        "MALLOC_TRIM_THRESHOLD_=67108864",
        "RUST_MIN_STACK=33554432",
        "HOSTNAME=abc123",
        "AWS_BUCKET_NAME=palimpsest-benchmark-v1",
        "GRAPH_AUTH_TOKEN_FILE=/run/secrets/hydradb_auth_token",
        "malformed-entry"
      ])
    ).toEqual({
      GRAPH_WRITER_LEASE_MS: "30000",
      MALLOC_TRIM_THRESHOLD_: "67108864",
      RUST_MIN_STACK: "33554432"
    })
  })
})

describe("the phase, in the clear beside the hash", () => {
  it("reports the ingest phase's two settings without a Docker daemon", () => {
    const config = fromInspected(container(INGEST_ENV))
    expect(config.readCacheEnabled).toBe(false)
    expect(config.queryRuntimeMs).toBe(120_000)
  })

  it("reports the engine's own defaults when neither variable is set", () => {
    // Compose defaults the cache to on and the cap to 30 s, so an unset
    // variable must report what the node is running with, not `null`.
    const config = fromInspected(container(["MALLOC_ARENA_MAX=2"]))
    expect(config.readCacheEnabled).toBe(true)
    expect(config.queryRuntimeMs).toBe(30_000)
  })
})

describe("the canonical preimage", () => {
  it("sorts the environment so map order cannot change a hash", () => {
    expect(
      canonicalise({
        imageId: "sha256:a",
        memoryLimitBytes: 1,
        nanoCpus: 2,
        env: { B: "2", A: "1" }
      })
    ).toBe(
      '{"env":{"A":"1","B":"2"},"imageId":"sha256:a","memoryLimitBytes":1,"nanoCpus":2,' +
        '"schema":"hydradb-runtime-config/v1"}'
    )
  })

  it("is a sha256 of exactly that string", () => {
    const input = { imageId: "sha256:a", memoryLimitBytes: 1, nanoCpus: 2, env: { A: "1" } }
    expect(hashRuntimeConfig(input)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRuntimeConfig(input)).toBe(hashRuntimeConfig({ ...input, env: { A: "1" } }))
  })
})
