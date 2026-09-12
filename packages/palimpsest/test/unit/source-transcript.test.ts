import type { DatasetSession } from "@palimpsest/dataset"
import type { SourceRevision } from "../../src/IngestManifest.js"
import { memoryScopeKey, parseMemoryScope } from "../../src/MemoryScope.js"
import {
  planSourceTranscriptWrite,
  sourceSessionKey,
  sourceTurnKey
} from "../../src/SourceTranscript.js"
import { canonicalSessionSource } from "../../src/SourceIdentity.js"
import { Either } from "effect"
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

    expect(first._tag).toBe("Right")
    expect(second._tag).toBe("Right")
    if (first._tag === "Left" || second._tag === "Left") return

    expect(first.right.session.key).toBe(
      sourceSessionKey(Either.getOrThrow(parseMemoryScope("default", "user-a")), "session-a", first.right.sourceDigest)
    )
    expect(first.right.turns[0]?.key).toBe(
      sourceTurnKey(Either.getOrThrow(parseMemoryScope("default", "user-a")), "session-a", first.right.sourceDigest, 0)
    )
    expect(first.right.session.key).not.toBe(second.right.session.key)
    expect(first.right.session.properties["source_digest"]).toBe(first.right.sourceDigest)
    expect(second.right.session.properties["source_digest"]).toBe(second.right.sourceDigest)
    expect(first.right.turns[1]?.properties["text"]).toBe("world")
    expect(second.right.turns[1]?.properties["text"]).toBe("revised")
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

    expect(byteMismatch).toMatchObject({ _tag: "Left", left: { field: "sourceDigest" } })
    expect(logicalIdMismatch).toMatchObject({
      _tag: "Left",
      left: { field: "logicalSessionId" }
    })
  })

  it("links each source revision to its tenant-scoped memory root", () => {
    const sameUser = Either.getOrThrow(parseMemoryScope("default", "user-a"))
    const otherTenant = Either.getOrThrow(parseMemoryScope("other", "user-a"))
    const digest = canonicalSessionSource(session).sourceDigest

    expect(sourceSessionKey(sameUser, "session-a", digest)).not.toBe(
      sourceSessionKey(otherTenant, "session-a", digest)
    )
    const planned = planSourceTranscriptWrite(revisionFor(session), session)
    if (planned._tag === "Left") return expect.unreachable()
    expect(planned.right.scope.key).toBe(memoryScopeKey(sameUser))
    expect(planned.right.session.key).toBe(sourceSessionKey(sameUser, "session-a", digest))
    expect(planned.right.relations).toContainEqual({
      type: "HAS_SOURCE_REVISION",
      srcLabel: "MemoryScope",
      srcKey: memoryScopeKey(sameUser),
      dstLabel: "SourceSession",
      dstKey: planned.right.session.key
    })

    const otherRevision = { ...revisionFor(session), tenant: "other" }
    const otherPlanned = planSourceTranscriptWrite(otherRevision, session)
    if (otherPlanned._tag === "Left") return expect.unreachable()
    expect(otherPlanned.right.scope.key).not.toBe(planned.right.scope.key)
  })
})
