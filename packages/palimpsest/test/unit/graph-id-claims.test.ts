import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { HydraClient, vertexId } from "@palimpsest/hydra"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { recoverGraphIdCollision } from "../../src/GraphIdClaims.js"
import {
  IngestManifest,
  IngestManifestLayerMemory,
  type IngestManifestError
} from "../../src/IngestManifest.js"
import { makeGraphClaimOperations } from "../../src/IngestManifest/GraphClaims.js"
import { createDatabase } from "../../src/IngestManifest/Schema.js"

const execFileAsync = promisify(execFile)

const runMemory = <A>(effect: Effect.Effect<A, IngestManifestError, IngestManifest>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(IngestManifestLayerMemory))))

const claim = (canonicalIdentity: string, kind: "relationship" | "vertex" = "vertex") => ({
  reducedId: vertexId(canonicalIdentity),
  kind,
  canonicalIdentity
})

describe("graph id claims", () => {
  it("claims a reduced id once and re-claims the same identity idempotently", async () => {
    const identity = "t7:default|u6:user-a|srcsess|abc|1:s"
    const input = claim(identity)
    const result = await runMemory(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        const first = yield* manifest.claimGraphId(input)
        const second = yield* manifest.claimGraphId(input)
        const stored = yield* manifest.readGraphIdClaim(input)
        const missing = yield* manifest.readGraphIdClaim({ reducedId: input.reducedId + 1, kind: "vertex" })
        return { first, second, stored, missing }
      })
    )

    expect(result.first).toBe("claimed")
    expect(result.second).toBe("idempotent")
    expect(result.stored).toMatchObject(input)
    expect(result.missing).toBeNull()
  })

  it("tracks vertex and relationship ids in separate namespaces", async () => {
    const identity = "same-canonical-key"
    const result = await runMemory(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        yield* manifest.claimGraphId(claim(identity, "vertex"))
        return yield* manifest.claimGraphId(claim(identity, "relationship"))
      })
    )

    expect(result).toBe("claimed")
  })

  it("rejects a reduced id that was not derived from its canonical identity", async () => {
    const outcome = await runMemory(
      Effect.gen(function* () {
        const manifest = yield* IngestManifest
        return yield* manifest
          .claimGraphId({ reducedId: 42, kind: "vertex", canonicalIdentity: "identity-a" })
          .pipe(Effect.either)
      })
    )

    expect(outcome).toMatchObject({ _tag: "Left", left: { _tag: "InvalidGraphIdClaim" } })
  })

  it("quarantines a deterministic same-id/different-identity collision", async () => {
    const database = createDatabase(":memory:")
    const claims = makeGraphClaimOperations(database, () => 99)
    try {
      await Effect.runPromise(
        claims.claimGraphId({ reducedId: 99, kind: "vertex", canonicalIdentity: "identity-a" })
      )
      const collision = await Effect.runPromise(
        claims
          .claimGraphId({ reducedId: 99, kind: "vertex", canonicalIdentity: "identity-b" })
          .pipe(Effect.either)
      )
      const stored = await Effect.runPromise(claims.readGraphIdClaim({ reducedId: 99, kind: "vertex" }))
      const quarantine = await Effect.runPromise(claims.listGraphIdQuarantine())

      expect(collision).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "GraphIdCollision",
          reducedId: 99,
          existingIdentity: "identity-a",
          rejectedIdentity: "identity-b"
        }
      })
      expect(stored?.canonicalIdentity).toBe("identity-a")
      expect(quarantine).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it("rekeys, verifies graph read-back, and only then resolves quarantine", async () => {
    const database = createDatabase(":memory:")
    const collisionReducer = (key: string): number =>
      key === "identity-a" || key === "identity-b" ? 5 : vertexId(key)
    const claims = makeGraphClaimOperations(database, collisionReducer)
    const storedGraph = new Map<number, ReadonlyArray<string>>()
    const hydra = {
      readGraphIdentities: (_kind: "relationship" | "vertex", reducedId: number) =>
        Effect.succeed(storedGraph.get(reducedId) ?? [])
    } as unknown as HydraClient
    try {
      await Effect.runPromise(
        claims.claimGraphId({ reducedId: 5, kind: "vertex", canonicalIdentity: "identity-a" })
      )
      await Effect.runPromise(
        claims
          .claimGraphId({ reducedId: 5, kind: "vertex", canonicalIdentity: "identity-b" })
          .pipe(Effect.either)
      )

      const target = await Effect.runPromise(
        recoverGraphIdCollision(claims, hydra, {
          reducedId: 5,
          kind: "vertex",
          rejectedIdentity: "identity-b",
          replacementCanonicalIdentity: "identity-b|rekey|namespace-2",
          rebuild: (replacement) =>
            Effect.sync(() => storedGraph.set(replacement.reducedId, [replacement.canonicalIdentity]))
        })
      )

      expect(target.reducedId).toBe(vertexId("identity-b|rekey|namespace-2"))
      expect(await Effect.runPromise(claims.listGraphIdQuarantine())).toHaveLength(0)
    } finally {
      database.close()
    }
  })

  it("keeps quarantine when replacement graph read-back is absent", async () => {
    const database = createDatabase(":memory:")
    const collisionReducer = (key: string): number =>
      key === "identity-a" || key === "identity-b" ? 5 : vertexId(key)
    const claims = makeGraphClaimOperations(database, collisionReducer)
    const hydra = {
      readGraphIdentities: () => Effect.succeed([])
    } as unknown as HydraClient
    try {
      await Effect.runPromise(
        claims.claimGraphId({ reducedId: 5, kind: "vertex", canonicalIdentity: "identity-a" })
      )
      await Effect.runPromise(
        claims
          .claimGraphId({ reducedId: 5, kind: "vertex", canonicalIdentity: "identity-b" })
          .pipe(Effect.either)
      )
      const outcome = await Effect.runPromise(
        recoverGraphIdCollision(claims, hydra, {
          reducedId: 5,
          kind: "vertex",
          rejectedIdentity: "identity-b",
          replacementCanonicalIdentity: "identity-b|rekey|namespace-2",
          rebuild: () => Effect.void
        }).pipe(Effect.either)
      )

      expect(outcome).toMatchObject({
        _tag: "Left",
        left: { _tag: "GraphIdRecoveryRejected", reason: "readBackMismatch" }
      })
      expect(await Effect.runPromise(claims.listGraphIdQuarantine())).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it("serializes a real two-process collision and preserves its quarantine", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graph-claims-"))
    const path = join(directory, "manifest.sqlite")
    const worker = join(process.cwd(), "packages", "palimpsest", "test", "fixtures", "graph-claim-worker.ts")
    try {
      createDatabase(path).close()
      const runWorker = (identity: string) =>
        execFileAsync(process.execPath, ["--import", "tsx", worker, path, identity], {
          cwd: process.cwd(),
          windowsHide: true
        })
      const outcomes = await Promise.all([runWorker("identity-a"), runWorker("identity-b")])
      expect(outcomes.map(({ stdout }) => stdout.trim()).sort()).toEqual([
        "GraphIdCollision",
        "claimed"
      ])

      const database = createDatabase(path)
      const claims = makeGraphClaimOperations(database, () => 4242)
      try {
        const stored = await Effect.runPromise(
          claims.readGraphIdClaim({ reducedId: 4242, kind: "relationship" })
        )
        const quarantine = await Effect.runPromise(claims.listGraphIdQuarantine())
        expect(["identity-a", "identity-b"]).toContain(stored?.canonicalIdentity)
        expect(quarantine).toHaveLength(1)
      } finally {
        database.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
