import type { DatabaseSync } from "node:sqlite"
import { frameSegment, scopePrefix, type MemoryScope } from "../MemoryScope.js"
import { INGEST_STATES, type IngestState, type SourceRevision, type SourceRevisionIdentity } from "./Types.js"

export type DatabaseRow = Readonly<Record<string, string | number | bigint | null | Uint8Array>>

export const text = (row: DatabaseRow, column: string): string => {
  const value = row[column]
  if (typeof value !== "string") throw new Error(`manifest column ${column} was not text`)
  return value
}

export const integer = (row: DatabaseRow, column: string): number => {
  const value = row[column]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`manifest column ${column} was not a safe integer`)
  }
  return value
}

export const nullableText = (row: DatabaseRow, column: string): string | null => {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== "string") throw new Error(`manifest column ${column} was not nullable text`)
  return value
}

export const nullableBoolean = (row: DatabaseRow, column: string): boolean | null => {
  const value = row[column]
  if (value === null) return null
  if (value === 0) return false
  if (value === 1) return true
  throw new Error(`manifest column ${column} was not nullable boolean`)
}

const isIngestState = (value: unknown): value is IngestState =>
  typeof value === "string" && INGEST_STATES.some((state) => state === value)

/** Fields appended to a parsed memory scope to identify one source revision. */
export type ScopedSourceRevisionIdentity = Pick<
  SourceRevisionIdentity,
  "extractionGeneration" | "logicalSessionId" | "sourceDigest"
>

/** Canonical, prefix-free identity of one tenant-scoped source revision. */
export const revisionKey = (scope: MemoryScope, input: ScopedSourceRevisionIdentity): string =>
  `${scopePrefix(scope)}|revision|${frameSegment(input.logicalSessionId)}|${frameSegment(input.sourceDigest)}|${frameSegment(input.extractionGeneration)}`

export const decodeRevision = (row: DatabaseRow): SourceRevision => {
  const state = text(row, "state")
  if (!isIngestState(state)) throw new Error(`manifest state ${state} was invalid`)
  return {
    tenant: text(row, "tenant"),
    uid: text(row, "uid"),
    logicalSessionId: text(row, "logical_session_id"),
    sourceDigest: text(row, "source_digest"),
    sourceBytes: integer(row, "source_bytes"),
    extractionGeneration: text(row, "extraction_generation"),
    sessionOrdinal: integer(row, "session_ordinal"),
    commitId: text(row, "commit_id"),
    state,
    manifestVersion: integer(row, "manifest_version"),
    failureCode: nullableText(row, "failure_code"),
    failureRetryable: nullableBoolean(row, "failure_retryable")
  }
}

const REVISION_COLUMNS = `tenant, uid, logical_session_id, source_digest, source_bytes, extraction_generation,
              session_ordinal, commit_id, state, manifest_version, failure_code, failure_retryable`

export const selectRevision = (database: DatabaseSync, key: string): SourceRevision | undefined => {
  const row = database
    .prepare(`SELECT ${REVISION_COLUMNS} FROM source_revisions WHERE revision_key = ?`)
    .get(key)
  return row === undefined ? undefined : decodeRevision(row)
}

export const selectRevisionByCommitId = (
  database: DatabaseSync,
  commitId: string
): SourceRevision | undefined => {
  const row = database
    .prepare(`SELECT ${REVISION_COLUMNS} FROM source_revisions WHERE commit_id = ?`)
    .get(commitId)
  return row === undefined ? undefined : decodeRevision(row)
}

export const transaction = <A>(database: DatabaseSync, operation: () => A): A => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = operation()
    database.exec("COMMIT")
    return result
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}
