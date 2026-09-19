import type { DatasetSession } from "@palimpsest/dataset"
import type { SourceRevision } from "../../src/IngestManifest.js"
import { memoryScopeKey, parseMemoryScope } from "../../src/MemoryScope.js"
import {
  planSourceTranscriptWrite,
  sourceSessionKey,
  sourceTurnKey
} from "../../src/SourceTranscript.js"
import { canonicalSessionSource } from "../../src/SourceIdentity.js"
import { Result } from "effect"
import { describe, expect, it } from "vitest"

const session: DatasetSession = {
  sid: "session-a",
  key: "session-a",
  sessionOrd: 4,
  date: { raw: "2026-08-20", dateInt: 20260820, ts: 1_755_657_600_000 },
  turns: [
    { turnIdx: 0, role: "user", text: "hello", hasAnswer: false },
    { turnIdx: 1, role: "assistant", text: "world", hasAnswer: false }
  ]
}

const revisionFor = (source: DatasetSession): SourceRevision => {
  const canonical = canonicalSessionSource(source)
  return {
    tenant: "default",
    uid: "user-a",
    logicalSessionId: source.key,
    sourceDigest: canonical.sourceDigest,
    sourceBytes: canonical.sourceBytes,
    extractionGeneration: "extract-v1-test",
    sessionOrdinal: source.sessionOrd,
    commitId: "ingest-test",
    state: "RECEIVED",
    manifestVersion: 0,
    failureCode: null,
    failureRetryable: null
  }
}

describe("planSourceTranscriptWrite", () => {
  it("makes source keys contain the full digest and retains old source bytes when a logical id changes", () => {
    const first = planSourceTranscriptWrite(revisionFor(session), session)
    const replacement: DatasetSession = {
      ...session,
      turns: [
        ...session.turns.slice(0, 1),
        { turnIdx: 1, role: "assistant", text: "revised", hasAnswer: false }
      ]
    }
    const second = planSourceTranscriptWrite(revisionFor(replacement), replacement)

    expect(first._tag).toBe("Success")
    expect(second._tag).toBe("Success")
    if (first._tag === "Failure" || second._tag === "Failure") return

    expect(first.success.session.key).toBe(
      sourceSessionKey(Result.getOrThrow(parseMemoryScope("default", "user-a")), "session-a", first.success.sourceDigest)
    )
    expect(first.success.turns[0]?.key).toBe(
      sourceTurnKey(Result.getOrThrow(parseMemoryScope("default", "user-a")), "session-a", first.success.sourceDigest, 0)
    )
    expect(first.success.session.key).not.toBe(second.success.session.key)
    expect(first.success.session.properties["source_digest"]).toBe(first.success.sourceDigest)
    expect(second.success.session.properties["source_digest"]).toBe(second.success.sourceDigest)
    expect(first.success.turns[1]?.properties["text"]).toBe("world")
    expect(second.success.turns[1]?.properties["text"]).toBe("revised")
  })

  it("rejects a session whose bytes or logical id do not name the claimed source revision", () => {
    const changedBytes: DatasetSession = {
      ...session,
      turns: [
        ...session.turns.slice(0, 1),
        { turnIdx: 1, role: "assistant", text: "changed", hasAnswer: false }
      ]
    }
    const byteMismatch = planSourceTranscriptWrite(revisionFor(session), changedBytes)
    const logicalIdMismatch = planSourceTranscriptWrite(revisionFor(session), {
      ...session,
      key: "other-session"
    })

    expect(byteMismatch).toMatchObject({ _tag: "Failure", failure: { field: "sourceDigest" } })
    expect(logicalIdMismatch).toMatchObject({
      _tag: "Failure",
      failure: { field: "logicalSessionId" }
    })
  })

  it("links each source revision to its tenant-scoped memory root", () => {
    const sameUser = Result.getOrThrow(parseMemoryScope("default", "user-a"))
    const otherTenant = Result.getOrThrow(parseMemoryScope("other", "user-a"))
    const digest = canonicalSessionSource(session).sourceDigest

    expect(sourceSessionKey(sameUser, "session-a", digest)).not.toBe(
      sourceSessionKey(otherTenant, "session-a", digest)
    )
    const planned = planSourceTranscriptWrite(revisionFor(session), session)
    if (planned._tag === "Failure") return expect.unreachable()
    expect(planned.success.scope.key).toBe(memoryScopeKey(sameUser))
    expect(planned.success.session.key).toBe(sourceSessionKey(sameUser, "session-a", digest))
    expect(planned.success.relations).toContainEqual({
      type: "HAS_SOURCE_REVISION",
      srcLabel: "MemoryScope",
      srcKey: memoryScopeKey(sameUser),
      dstLabel: "SourceSession",
      dstKey: planned.success.session.key
    })

    const otherRevision = { ...revisionFor(session), tenant: "other" }
    const otherPlanned = planSourceTranscriptWrite(otherRevision, session)
    if (otherPlanned._tag === "Failure") return expect.unreachable()
    expect(otherPlanned.success.scope.key).not.toBe(planned.success.scope.key)
  })
})
