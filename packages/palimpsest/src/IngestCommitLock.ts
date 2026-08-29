import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { basename, dirname, join } from "node:path"
import { Config, Context, Data, Effect, Layer, Option } from "effect"

/** The only scope a durable ingest commit may serialize. */
export interface IngestCommitScope {
  readonly tenant: string
  readonly uid: string
}

/** A different request currently owns this user's commit serialization slot. */
export class IngestCommitLockUnavailable extends Data.TaggedError("IngestCommitLockUnavailable")<{
  readonly tenant: string
  readonly uid: string
  readonly reason: "held" | "unavailable"
}> {
  override get message(): string {
    return `Ingest commit lock for ${this.tenant}/${this.uid} is ${this.reason}`
  }
}

export class IngestCommitLock extends Context.Tag("palimpsest/IngestCommitLock")<
  IngestCommitLock,
  IngestCommitLockService
>() {}

/**
 * Cross-process serialization for one user's source-revision commit.
 *
 * The production implementation holds an exclusive transaction on a dedicated
 * per-user SQLite lock file while caller-supplied stage effects run. Process
 * termination releases the operating-system lock; the manifest then resumes
 * the same commit id. A contender receives a typed conflict instead of racing
 * graph projections or blocking the Node event loop on SQLite's busy timeout.
 */
export interface IngestCommitLockService {
  readonly withUserLock: <A, Error, Requirements>(
    scope: IngestCommitScope,
    effect: Effect.Effect<A, Error, Requirements>
  ) => Effect.Effect<A, Error | IngestCommitLockUnavailable, Requirements>
}

const keyFor = (scope: IngestCommitScope): string =>
  createHash("sha256")
    .update(scope.tenant, "utf8")
    .update("\u001f", "utf8")
    .update(scope.uid, "utf8")
    .digest("hex")

const unavailable = (
  scope: IngestCommitScope,
  reason: IngestCommitLockUnavailable["reason"]
): IngestCommitLockUnavailable => new IngestCommitLockUnavailable({ ...scope, reason })

const releaseLock = (database: DatabaseSync): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      database.exec("ROLLBACK")
    } finally {
      database.close()
    }
  }).pipe(Effect.catchAll(() => Effect.void))

const makeService = (acquireExternalLock: (scope: IngestCommitScope) => DatabaseSync) => {
  const localLocks = new Map<string, Effect.Semaphore>()

  const semaphoreFor = (scope: IngestCommitScope): Effect.Semaphore => {
    const key = keyFor(scope)
    const existing = localLocks.get(key)
    if (existing !== undefined) return existing
    const created = Effect.unsafeMakeSemaphore(1)
    localLocks.set(key, created)
    return created
  }

  const withUserLock: IngestCommitLockService["withUserLock"] = (scope, effect) =>
    semaphoreFor(scope)
      .withPermitsIfAvailable(1)(
        Effect.acquireUseRelease(
          Effect.try({
            try: () => acquireExternalLock(scope),
            catch: () => unavailable(scope, "unavailable")
          }),
          () => effect,
          (database) => releaseLock(database)
        )
      )
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(unavailable(scope, "held")),
            onSome: (value) => Effect.succeed(value)
          })
        )
      )

  return { withUserLock } as const
}

const openProductionLock = (lockDirectory: string) => (scope: IngestCommitScope): DatabaseSync => {
  mkdirSync(lockDirectory, { recursive: true })
  const database = new DatabaseSync(join(lockDirectory, `${keyFor(scope)}.sqlite`), { timeout: 0 })
  try {
    // The lock database is distinct from the manifest database, so holding this
    // transaction does not nest SQLite transactions used by manifest updates.
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = 0;
      CREATE TABLE IF NOT EXISTS ingest_commit_lock (id INTEGER PRIMARY KEY CHECK (id = 1)) STRICT;
      BEGIN EXCLUSIVE;
    `)
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

/** Production layer: dedicated per-user SQLite files beside the manifest. */
export const IngestCommitLockLive = Layer.effect(
  IngestCommitLock,
  Config.string("PALIMPSEST_INGEST_MANIFEST_PATH").pipe(
    Config.withDefault(".palimpsest/ingest-manifest.sqlite"),
    Effect.map((manifestPath) =>
      makeService(openProductionLock(join(dirname(manifestPath), `${basename(manifestPath)}.locks`)))
    )
  )
)

/** Hermetic layer with the same non-blocking same-user serialization contract. */
export const IngestCommitLockMemory = Layer.succeed(
  IngestCommitLock,
  makeService(() => {
    const database = new DatabaseSync(":memory:")
    database.exec("BEGIN EXCLUSIVE")
    return database
  })
)
