import { describe, expect, it } from "vitest"
import {
  canonicalise,
  configEnv,
  fromInspected,
  hashRuntimeConfig,
  type InspectedContainer
} from "../../src/RuntimeConfig.js"

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

describe("runtime fingerprint", () => {
  it("is order-stable and changes for every runtime setting that affects measurements", () => {
    const baseline = fromInspected(container(EVAL_ENV)).sha256
    expect(fromInspected(container([...EVAL_ENV].reverse())).sha256).toBe(baseline)

    const variants: ReadonlyArray<readonly [string, InspectedContainer]> = [
      ["ingest phase", container(INGEST_ENV)],
      ["runtime image", container(EVAL_ENV, { Image: "sha256:different" })],
      [
        "memory limit",
        container(EVAL_ENV, {
          HostConfig: { Memory: 6 * 1024 ** 3, NanoCpus: 4_000_000_000 }
        })
      ],
      [
        "storage buffer",
        container([
          ...EVAL_ENV.filter((entry) => !entry.startsWith("GRAPH_MAX_UNFLUSHED_BYTES")),
          "GRAPH_MAX_UNFLUSHED_BYTES=67108864"
        ])
      ]
    ]
    for (const [name, variant] of variants) {
      expect(fromInspected(variant).sha256, name).not.toBe(baseline)
    }
  })

  it("ignores credentials and unrelated environment while selecting engine settings", () => {
    const before = container([
      ...EVAL_ENV,
      "AWS_SECRET_ACCESS_KEY=one",
      "PATH=/usr/bin",
      "GRAPH_AUTH_TOKEN_FILE=/run/secrets/a"
    ])
    const after = container([
      ...EVAL_ENV,
      "AWS_SECRET_ACCESS_KEY=two",
      "PATH=/bin",
      "GRAPH_AUTH_TOKEN_FILE=/run/secrets/b"
    ])
    expect(fromInspected(before).sha256).toBe(fromInspected(after).sha256)
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

  it("reports phase settings and engine defaults beside the hash", () => {
    const config = fromInspected(container(INGEST_ENV))
    expect(config.readCacheEnabled).toBe(false)
    expect(config.queryRuntimeMs).toBe(120_000)
    expect(fromInspected(container(["MALLOC_ARENA_MAX=2"]))).toMatchObject({
      readCacheEnabled: true,
      queryRuntimeMs: 30_000
    })
  })

  it("hashes the exact canonical, environment-sorted preimage", () => {
    const input = {
      imageId: "sha256:a",
      memoryLimitBytes: 1,
      nanoCpus: 2,
      env: { B: "2", A: "1" }
    }
    expect(canonicalise(input)).toBe(
      '{"env":{"A":"1","B":"2"},"imageId":"sha256:a","memoryLimitBytes":1,"nanoCpus":2,' +
        '"schema":"hydradb-runtime-config/v1"}'
    )
    expect(hashRuntimeConfig(input)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRuntimeConfig(input)).toBe(hashRuntimeConfig({ ...input, env: { A: "1", B: "2" } }))
  })
})
