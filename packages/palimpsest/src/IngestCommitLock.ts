import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { basename, dirname, join } from "node:path"
import { Config, Context, Data, Effect, Layer, Option, Semaphore } from "effect"

export interface IngestCommitScope {
  readonly tenant: string
  readonly uid: string
}

export class IngestCommitLockUnavailable extends Data.TaggedError("IngestCommitLockUnavailable")<{
  readonly tenant: string
  readonly uid: string
  readonly reason: "held" | "unavailable"
}> {
  override get message(): string {
    return `Ingest commit lock for ${this.tenant}/${this.uid} is ${this.reason}`
  }
}

export class IngestCommitLock extends Context.Service<
  IngestCommitLock,
  IngestCommitLockService
>()("palimpsest/IngestCommitLock") {}

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
  }).pipe(Effect.catch(() => Effect.void))

const makeService = (acquireExternalLock: (scope: IngestCommitScope) => DatabaseSync) => {
  const localLocks = new Map<string, Semaphore.Semaphore>()

  const semaphoreFor = (scope: IngestCommitScope): Semaphore.Semaphore => {
    const key = keyFor(scope)
    const existing = localLocks.get(key)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
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

export const IngestCommitLockLive = Layer.effect(
  IngestCommitLock,
  Config.string("PALIMPSEST_INGEST_MANIFEST_PATH").pipe(
    Config.withDefault(".palimpsest/ingest-manifest.sqlite"),
    Effect.map((manifestPath) =>
      makeService(openProductionLock(join(dirname(manifestPath), `${basename(manifestPath)}.locks`)))
    )
  )
)

export const IngestCommitLockMemory = Layer.succeed(
  IngestCommitLock,
  makeService(() => {
    const database = new DatabaseSync(":memory:")
    database.exec("BEGIN EXCLUSIVE")
    return database
  })
)
