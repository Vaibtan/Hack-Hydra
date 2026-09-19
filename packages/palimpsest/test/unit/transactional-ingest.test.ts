import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import { IngestCommitLock, IngestCommitLockLive, IngestCommitLockMemory } from "../../src/IngestCommitLock.js"
import { IngestManifestLayerMemory, type BeginSourceRevision, type SourceRevision } from "../../src/IngestManifest.js"
import { createExtractionGeneration } from "../../src/SourceIdentity.js"
import { INGEST_EXECUTION_STAGES, runTransactionalIngest, runTransactionalIngestToStage, type IngestExecutionStage, type TransactionalIngestStages } from "../../src/TransactionalIngest.js"

const extractionGeneration = createExtractionGeneration({
  extractor: { id: "test-extractor", revision: "git:test" },
  model: { id: "test-model", revision: "snapshot:test" },
  tokenizer: { id: "test-tokenizer", revision: "v1" },
  promptTemplate: "test extraction prompt",
  outputSchema: { type: "object", version: 1 }
})

const sourceRevision: BeginSourceRevision = {
  tenant: "default",
  uid: "user-a",
  logicalSessionId: "session-a",
  sourceDigest: "f".repeat(64),
  sourceBytes: 104,
  extractionGeneration: {
    id: extractionGeneration.id,
    canonicalJson: extractionGeneration.canonicalJson
  }
}

describe("runTransactionalIngest", () => {
  it("resumes from every failed stage without applying its commit effect twice", async () => {
    for (const failingStage of INGEST_EXECUTION_STAGES) {
      const calls = new Map<IngestExecutionStage, number>()
      const applied = new Set<string>()
      let shouldFail = true
      const work = (stage: IngestExecutionStage) => (revision: SourceRevision) =>
        Effect.suspend(() => {
          calls.set(stage, (calls.get(stage) ?? 0) + 1)
          applied.add(`${revision.commitId}:${stage}`)
          if (stage === failingStage && shouldFail) {
            shouldFail = false
            return Effect.fail(new Error(`injected-${stage}`))
          }
          return Effect.void
        })
      const stages: TransactionalIngestStages<Error, never> = {
        SOURCE_DURABLE: work("SOURCE_DURABLE"),
        INDEXED: work("INDEXED"),
        ENRICHED: work("ENRICHED"),
        CONSOLIDATED: work("CONSOLIDATED"),
        COMMITTED: work("COMMITTED")
      }

      const input = {
        sourceRevision,
        stages,
        classifyFailure: () => ({ code: "FAULT_INJECTED", retryable: true })
      }
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* runTransactionalIngest(input).pipe(Effect.result)
            const second = yield* runTransactionalIngest(input)
            const repeated = yield* runTransactionalIngest(input)
            return { first, second, repeated }
          }).pipe(Effect.provide(IngestManifestLayerMemory), Effect.provide(IngestCommitLockMemory))
        )
      )

      expect(outcome.first).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "IngestStageFailed", stage: failingStage }
      })
      expect(outcome.second.revision.state).toBe("COMMITTED")
      expect(outcome.second.alreadyCommitted).toBe(false)
      expect(applied).toHaveLength(INGEST_EXECUTION_STAGES.length)
      for (const stage of INGEST_EXECUTION_STAGES) {
        expect(calls.get(stage)).toBe(stage === failingStage ? 2 : 1)
      }
      expect(outcome.repeated.alreadyCommitted).toBe(true)
      expect(calls.get(failingStage)).toBe(2)
    }
  })

  it("records a terminal failure and refuses to replay that incomplete revision", async () => {
    let calls = 0
    const terminal = () =>
      Effect.suspend(() => {
        calls += 1
        return Effect.fail(new Error("terminal"))
      })
    const stages: TransactionalIngestStages<Error, never> = {
      SOURCE_DURABLE: terminal,
      INDEXED: terminal,
      ENRICHED: terminal,
      CONSOLIDATED: terminal,
      COMMITTED: terminal
    }
    const input = {
      sourceRevision: { ...sourceRevision, sourceDigest: "e".repeat(64) },
      stages,
      classifyFailure: () => ({ code: "POLICY_REJECTED", retryable: false })
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* runTransactionalIngest(input).pipe(Effect.result)
          const retry = yield* runTransactionalIngest(input).pipe(Effect.result)
          return { first, retry }
        }).pipe(Effect.provide(IngestManifestLayerMemory), Effect.provide(IngestCommitLockMemory))
      )
    )

    expect(outcome.first).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IngestStageFailed", retryable: false }
    })
    expect(outcome.retry).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IngestRetryBlocked", code: "POLICY_REJECTED" }
    })
    expect(calls).toBe(1)
  })

  it("can durably stop at INDEXED without executing later stages", async () => {
    const calls: Array<IngestExecutionStage> = []
    const work = (stage: IngestExecutionStage) => () =>
      Effect.sync(() => {
        calls.push(stage)
      })
    const stages: TransactionalIngestStages<never, never> = {
      SOURCE_DURABLE: work("SOURCE_DURABLE"),
      INDEXED: work("INDEXED"),
      ENRICHED: work("ENRICHED"),
      CONSOLIDATED: work("CONSOLIDATED"),
      COMMITTED: work("COMMITTED")
    }
    const input = {
      sourceRevision: { ...sourceRevision, sourceDigest: "d".repeat(64) },
      stages,
      classifyFailure: () => ({ code: "UNREACHABLE", retryable: false }),
      target: "INDEXED" as const
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* runTransactionalIngestToStage(input)
          const repeat = yield* runTransactionalIngestToStage(input)
          return { first, repeat }
        }).pipe(Effect.provide(IngestManifestLayerMemory), Effect.provide(IngestCommitLockMemory))
      )
    )

    expect(result.first.revision.state).toBe("INDEXED")
    expect(result.first.alreadyAtTarget).toBe(false)
    expect(result.repeat.alreadyAtTarget).toBe(true)
    expect(calls).toEqual(["SOURCE_DURABLE", "INDEXED"])
  })

  it("returns a typed conflict instead of interleaving a same-user commit", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const lock = yield* IngestCommitLock
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const scope = { tenant: "default", uid: "user-a" }
        const holder = yield* Effect.forkChild(
          lock.withUserLock(
            scope,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          )
        )
        yield* Deferred.await(entered)
        const contender = yield* lock.withUserLock(scope, Effect.void).pipe(Effect.result)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        return contender
      }).pipe(Effect.provide(IngestCommitLockMemory))
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IngestCommitLockUnavailable", reason: "held", uid: "user-a" }
    })
  })

  it("allows only one of 32 concurrent same-source requests to execute commit effects", async () => {
    const applied = new Set<string>()
    const work = (stage: IngestExecutionStage) => (revision: SourceRevision) =>
      Effect.yieldNow.pipe(
        Effect.andThen(Effect.sync(() => applied.add(`${revision.commitId}:${stage}`))),
        Effect.asVoid
      )
    const stages: TransactionalIngestStages<never, never> = {
      SOURCE_DURABLE: work("SOURCE_DURABLE"),
      INDEXED: work("INDEXED"),
      ENRICHED: work("ENRICHED"),
      CONSOLIDATED: work("CONSOLIDATED"),
      COMMITTED: work("COMMITTED")
    }
    const input = {
      sourceRevision: { ...sourceRevision, sourceDigest: "c".repeat(64) },
      stages,
      classifyFailure: () => ({ code: "UNREACHABLE", retryable: false })
    }
    const outcomes = await Effect.runPromise(
      Effect.scoped(
        Effect.all(
          Array.from({ length: 32 }, () => runTransactionalIngest(input).pipe(Effect.result)),
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(IngestManifestLayerMemory), Effect.provide(IngestCommitLockMemory))
      )
    )

    expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(31)
    expect(applied).toHaveLength(INGEST_EXECUTION_STAGES.length)
  })

  it("uses a durable lock file across independently built live layers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-ingest-lock-"))
    const previousPath = process.env["PALIMPSEST_INGEST_MANIFEST_PATH"]
    process.env["PALIMPSEST_INGEST_MANIFEST_PATH"] = join(directory, "manifest.sqlite")
    let markEntered: () => void = () => undefined
    let releaseHolder: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    const scope = { tenant: "default", uid: "user-a" }
    let holderPromise: Promise<void> | undefined

    try {
      const holder = Effect.gen(function* () {
        const lock = yield* IngestCommitLock
        return yield* lock.withUserLock(
          scope,
          Effect.sync(markEntered).pipe(Effect.andThen(Effect.promise(() => released)))
        )
      }).pipe(Effect.provide(IngestCommitLockLive))
      holderPromise = Effect.runPromise(holder)
      await entered

      const contender = await Effect.runPromise(
        Effect.gen(function* () {
          const lock = yield* IngestCommitLock
          return yield* lock.withUserLock(scope, Effect.void).pipe(Effect.result)
        }).pipe(Effect.provide(IngestCommitLockLive))
      )
      expect(contender).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "IngestCommitLockUnavailable", reason: "unavailable", uid: "user-a" }
      })
    } finally {
      releaseHolder()
      await holderPromise
      if (previousPath === undefined) delete process.env["PALIMPSEST_INGEST_MANIFEST_PATH"]
      else process.env["PALIMPSEST_INGEST_MANIFEST_PATH"] = previousPath
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
