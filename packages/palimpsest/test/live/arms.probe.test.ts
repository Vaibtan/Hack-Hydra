import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadDataset } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { claimKind, slotKey, turnKey } from "../../src/Keys.js"
import { readUserStats } from "../../src/User.js"
import {
  Reader,
  Retrieve,
  Supersede,
  probeArm,
  unionArms,
  type ReachedClaim
} from "../../src/index.js"

/**
 * The v2 arms, against the real graph.
 *
 * Two claims in the tickets are only checkable here, because both are about
 * what the *engine* does with a key that is not there:
 *
 *  - #27: a Slot probe for a slot that does not exist is an **empty arm**, not
 *    an error. The whole probe arm rests on this — the model proposes an
 *    `(entity, attribute)` pair and the graph decides whether it is there, so
 *    a missing pair has to be an ordinary answer rather than a failure that
 *    takes the ask down with it.
 *  - #28: a whole-turn hydration asks for the turn **and the one before it**,
 *    and turn 0 has no predecessor. A missing neighbour has to produce no path
 *    rather than an error, or every conversation-opening claim would fail.
 *
 * Both are asserted against a real node because a mock would be asserting my
 * belief about the engine, and that belief has been wrong four times on this
 * runtime already.
 */
const hasDataset = existsSync(datasetPath("s"))
const splitPath = resolve(import.meta.dirname, "../../../../data/splits/retrieval-v2.json")
const hasSplit = existsSync(splitPath)

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, AppLive) as unknown as Effect.Effect<A, E, never>)

interface Split {
  readonly prefix: string
  readonly dev: ReadonlyArray<string>
}

const split: Split | null = hasSplit
  ? (JSON.parse(readFileSync(splitPath, "utf8")) as Split)
  : null

/**
 * The same rule `ingest-slice` and `eval` use. It was `${prefix}${questionId}`
 * here, with no separator, which names a user the graph does not hold — and a
 * probe for a user that is not there returns an empty arm, which is exactly what
 * one of these tests asserts is *correct* behaviour. So the whole file would
 * have passed while testing nothing.
 */
const uidFor = (questionId: string): string =>
  split!.prefix === "" ? questionId : `${split!.prefix}-${questionId}`

/**
 * A dev user that is actually in the graph.
 *
 * The population is ingested in cycles and a run can be resumed, so "the first
 * dev id" is not necessarily a user with any claims — and a probe against a
 * missing user is indistinguishable from a probe against a missing slot.
 */
const firstIngestedDevUser = Effect.gen(function* () {
  const hydra = yield* HydraClient
  for (const questionId of split!.dev) {
    const uid = uidFor(questionId)
    const stats = yield* readUserStats(hydra, uid)
    if (stats._tag === "Some" && stats.value.claims > 0) {
      return { uid, questionId, claims: stats.value.claims }
    }
  }
  return null
})

describe.runIf(hasDataset && split !== null)("the Slot probe arm", () => {
  it("returns an empty arm for a slot that does not exist, not an error", async () => {
    const subject = await run(firstIngestedDevUser)
    expect(subject, "no dev user is ingested; run pnpm ingest-slice first").not.toBeNull()
    const uid = subject!.uid
    const arm = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const stats = yield* readUserStats(hydra, uid)
        expect(stats._tag).toBe("Some")
        return yield* probeArm(
          hydra,
          uid,
          // A pair no extractor would ever produce. If a missing Slot were an
          // error rather than an empty result, the probe arm could not exist:
          // the model proposes pairs and most of them will not be there.
          { entityCanon: "nonexistent-entity-zzz", attr: "nonexistent-attribute-zzz" },
          stats._tag === "Some" ? stats.value.claims : 1
        )
      })
    )
    expect(arm.claims).toEqual([])
    expect(arm.paths).toBe(0)
    expect(arm.kind).toBe("probe")
  }, 120_000)

  it("returns a slot's whole history, and exhausts the cursor where a page is exceeded", async () => {
    // The engine caps a response at 1024 rows with a `next_cursor` and
    // `MSpaths` cannot take SKIP/LIMIT, so a read that stopped at the first
    // page would silently return part of an answer.
    //
    // **A single Slot does not exceed one page on this population** — the
    // largest slot measured here is reported below and is two orders of
    // magnitude short of 1024 — so this test cannot observe cursor exhaustion
    // through a probe, and the earlier version of it pretended otherwise by
    // asserting only that no ckey was duplicated, which is true of a truncated
    // read as well. The paging is therefore asserted where it *is* observable:
    // the `FILLS` walk from the user's whole claim set, which returns one path
    // per claim and is thousands of rows on any dev user. Same client, same
    // cursor loop.
    const subject = await run(firstIngestedDevUser)
    expect(subject, "no dev user is ingested; run pnpm ingest-slice first").not.toBeNull()
    const uid = subject!.uid

    const measured = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const total = subject!.claims
        // One path per Claim that fills a Slot. On a ~2 000-claim user this is
        // well past 1024 and needs the cursor.
        const paths = yield* hydra.msPaths({
          sourceLabel: "Claim",
          sourceProperty: "kind",
          sourceValues: [claimKind(uid)],
          relTypes: ["FILLS"],
          relDirection: "outgoing",
          maxLen: 1
        })
        // `me` is the one canon every haystack has, and these are the
        // attributes the extractor produces most.
        const arms = yield* Effect.all(
          ["residence", "occupation", "age", "name"].map((attr) =>
            probeArm(hydra, uid, { entityCanon: "me", attr }, total)
          ),
          { concurrency: 2 }
        )
        return { paths, arms }
      })
    )

    // The cursor claim, on a read that genuinely crosses a page.
    expect(measured.paths.length).toBeGreaterThan(1024)
    const ckeys = measured.paths.map((path) => String(path.nodes[0]?.properties["ckey"] ?? ""))
    // A cursor loop that re-requested a page would duplicate; one that dropped a
    // page would come back at exactly a multiple of 1024.
    expect(new Set(ckeys).size).toBe(ckeys.length)
    expect(measured.paths.length % 1024).not.toBe(0)

    // At least one of the four slots exists on a 40-session user; if none does,
    // the probe arm is reaching nothing at all and that is the finding.
    const reached = measured.arms.filter((arm) => arm.claims.length > 0)
    expect(reached.length).toBeGreaterThan(0)
    for (const arm of reached) {
      // Scored with zero anchors by construction: a probe hit was named, not
      // converged on, and must never outrank a claim the question reached.
      expect(arm.claims.every((claim: ReachedClaim) => claim.convergence === 0)).toBe(true)
      expect(arm.claims.every((claim: ReachedClaim) => claim.ckey.startsWith(`${uid}|c|`))).toBe(
        true
      )
      expect(new Set(arm.claims.map((claim: ReachedClaim) => claim.ckey)).size).toBe(
        arm.claims.length
      )
    }
    // Recorded rather than asserted: the reason the paging claim is made on the
    // walk above and not on a probe.
    const largest = Math.max(...reached.map((arm) => arm.claims.length))
    console.log(
      `largest (me, *) slot on ${uid}: ${largest} claims; FILLS walk: ${measured.paths.length} paths`
    )
    expect(largest).toBeLessThan(1024)
  }, 180_000)

  it("keys the probe by canon and attribute, exactly as ingest wrote it", async () => {
    // A probe that built its key differently from ingest would return nothing
    // and be indistinguishable from a slot that does not exist -- the worst
    // possible failure, because it looks like a correct empty answer.
    const subject = await run(firstIngestedDevUser)
    expect(subject, "no dev user is ingested; run pnpm ingest-slice first").not.toBeNull()
    const uid = subject!.uid
    const skeys = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const paths = yield* hydra.msPaths({
          sourceLabel: "Claim",
          sourceProperty: "kind",
          sourceValues: [claimKind(uid)],
          relTypes: ["FILLS"],
          relDirection: "outgoing",
          maxLen: 1
        })
        return [
          ...new Set(
            paths.map((path) => String(path.nodes[path.nodes.length - 1]?.properties["skey"] ?? ""))
          )
        ].filter((skey) => skey !== "")
      })
    )
    expect(skeys.length).toBeGreaterThan(0)
    // Every skey the graph holds is one `slotKey(uid, canon, attr)` would build.
    for (const skey of skeys.slice(0, 20)) {
      const rest = skey.slice(`${uid}|s|`.length)
      const at = rest.indexOf("|")
      expect(at).toBeGreaterThan(0)
      expect(slotKey(uid, rest.slice(0, at), rest.slice(at + 1))).toBe(skey)
    }
  }, 180_000)
})

describe.runIf(hasDataset && split !== null)("whole-turn hydration", () => {
  it("reads a turn and its predecessor by key, and turn 0's missing neighbour is empty", async () => {
    const subject = await run(firstIngestedDevUser)
    expect(subject, "no dev user is ingested; run pnpm ingest-slice first").not.toBeNull()
    const uid = subject!.uid
    const questions = await Effect.runPromise(loadDataset("s"))
    const question = questions.find((q) => q.questionId === split!.dev[0]!)
    expect(question).toBeDefined()

    const sessionKey = question!.sessions[0]!.key
    const keys = [
      turnKey(uid, sessionKey, 0),
      turnKey(uid, sessionKey, 1),
      // One that cannot exist. It must contribute nothing rather than error.
      turnKey(uid, sessionKey, -1)
    ]

    const turns = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const paths = yield* hydra.msPaths({
          sourceLabel: "Turn",
          sourceProperty: "turn",
          sourceValues: keys,
          relTypes: ["HAS_TURN"],
          relDirection: "incoming",
          maxLen: 1
        })
        const found = new Map<string, string>()
        for (const path of paths) {
          const node = path.nodes[0]
          const key = String(node?.properties["turn"] ?? "")
          if (key !== "") found.set(key, String(node?.properties["text"] ?? ""))
        }
        return found
      })
    )

    expect(turns.has(turnKey(uid, sessionKey, 0))).toBe(true)
    expect(turns.has(turnKey(uid, sessionKey, 1))).toBe(true)
    // The whole of the missing-neighbour handling: the walk asks for keys, and
    // a key that does not exist contributes nothing.
    expect(turns.has(turnKey(uid, sessionKey, -1))).toBe(false)
    expect(turns.get(turnKey(uid, sessionKey, 0))!.length).toBeGreaterThan(0)
  }, 180_000)

  it("builds turn keys from the session KEY, not the bare sid", async () => {
    // Thirteen haystacks list one session id twice at different dates. The bare
    // id names two conversations, and hydrating by it reads the wrong one
    // without erroring -- so the check is that the key form the graph holds is
    // the one built from `session.key`.
    const questions = await Effect.runPromise(loadDataset("s"))
    const dev = new Set(split!.dev)
    // Within the dev split, and ingested. The earlier version searched the whole
    // dataset, which can name a user this graph does not hold, and then returned
    // early on a `expect(questions.length).toBeGreaterThan(0)` that asserts
    // nothing about turn keys -- a pass for the wrong reason either way.
    const candidates = questions.filter(
      (q) => dev.has(q.questionId) && q.sessions.some((session) => session.key !== session.sid)
    )
    expect(
      candidates.length,
      "the dev split holds no question with a repeated session id; the 13 that do are all in test"
    ).toBeGreaterThan(0)

    const found = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        for (const question of candidates) {
          const uid = uidFor(question.questionId)
          const stats = yield* readUserStats(hydra, uid)
          if (stats._tag !== "Some" || stats.value.claims === 0) continue
          const doubled = question.sessions.find((session) => session.key !== session.sid)!
          const paths = yield* hydra.msPaths({
            sourceLabel: "Turn",
            sourceProperty: "turn",
            sourceValues: [turnKey(uid, doubled.key, 0), turnKey(uid, doubled.sid, 0)],
            relTypes: ["HAS_TURN"],
            relDirection: "incoming",
            maxLen: 1
          })
          const byKey = new Map<string, string>()
          for (const path of paths) {
            const key = String(path.nodes[0]?.properties["turn"] ?? "")
            if (key !== "") byKey.set(key, String(path.nodes[0]?.properties["text"] ?? ""))
          }
          return { uid, doubled, seen: new Set(byKey.keys()), byKey }
        }
        return null
      })
    )
    expect(
      found,
      "no repeated-sid dev user is ingested yet; run the ingest to completion first"
    ).not.toBeNull()

    // Both keys exist, and that is the hazard rather than a contradiction of
    // it. A repeated session id appears twice in the haystack: the first
    // occurrence is keyed by the bare id and the second by `id#2`, so
    // `turnKey(uid, sid, 0)` names a real turn — of the *other* conversation.
    // Hydrating by the bare id therefore reads the wrong session and does not
    // error, which is exactly why Turn keys are built from `session.key`.
    expect(found!.seen.has(turnKey(found!.uid, found!.doubled.key, 0))).toBe(true)
    expect(found!.seen.has(turnKey(found!.uid, found!.doubled.sid, 0))).toBe(true)
    // And they are different turns. If they were the same vertex the
    // distinction would not matter and neither would the key rule.
    expect(found!.byKey.get(turnKey(found!.uid, found!.doubled.key, 0))).not.toBe(
      found!.byKey.get(turnKey(found!.uid, found!.doubled.sid, 0))
    )
  }, 180_000)
})

describe.runIf(hasDataset && split !== null)("the union", () => {
  it("puts a probe hit ahead of a convergence hit of the same claim", async () => {
    // Arm priority, on real rows rather than fixtures: a claim both a probe and
    // the convergence walk reached is a probe hit, and keeps the convergence
    // the walk measured.
    const subject = await run(firstIngestedDevUser)
    expect(subject, "no dev user is ingested; run pnpm ingest-slice first").not.toBeNull()
    const uid = subject!.uid
    const report = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const stats = yield* readUserStats(hydra, uid)
        const total = stats._tag === "Some" ? stats.value.claims : 1
        const probe = yield* probeArm(hydra, uid, { entityCanon: "me", attr: "residence" }, total)
        if (probe.claims.length === 0) return null
        // The same claims, presented as if a convergence walk had found them.
        const asConvergence = {
          kind: "convergence" as const,
          label: "convergence",
          claims: probe.claims.map((claim: ReachedClaim) => ({ ...claim, convergence: 3, score: 9 }))
        }
        return unionArms([asConvergence, probe])
      })
    )
    if (report === null) return
    expect(report.candidates.every((candidate) => candidate.kind === "probe")).toBe(true)
    // and it kept the convergence the walk measured, not the probe's zero
    expect(report.candidates.every((candidate) => candidate.convergence === 3)).toBe(true)
    expect(report.candidates.every((candidate) => candidate.arms.length === 2)).toBe(true)
  }, 180_000)
})

describe.runIf(hasDataset && split !== null)("the two-fact comparison question", () => {
  /**
   * #27's last box: *the grandma/age two-fact dev question has the `(me, age)`
   * claim in its union*.
   *
   * It is the question the whole arm design exists for. "How many years older
   * is my grandma than me" needs two facts stated in two different sessions,
   * and v1 lost it because the convergence walk ranks by how many of the
   * question's anchors reach a claim: "grandma" and "birthday" reach the
   * grandmother's claim from several directions, and the person's own age is
   * one claim reached by one anchor, sitting far enough down the ranking to be
   * cut. The Slot probe exists so that `(me, age)` is fetched **by key**,
   * regardless of what the lexical walk ranks it.
   *
   * Asserted on the union rather than on the answer, because that is what the
   * box says and because the answer also depends on the selector and the
   * reader, which have their own tickets.
   */
  it("has the person's own age in the union, not only the grandmother's", async () => {
    const questions = await Effect.runPromise(loadDataset("s"))
    const dev = new Set(split!.dev)
    const candidates = questions.filter(
      (question) =>
        dev.has(question.questionId) &&
        /\b(grandma|grandmother|grandpa|grandfather)\b/i.test(question.question) &&
        /\b(older|younger|age|years)\b/i.test(question.question)
    )
    expect(
      candidates.length,
      "the dev split holds no grandparent age-comparison question"
    ).toBeGreaterThan(0)

    const outcome = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        for (const question of candidates) {
          const uid = uidFor(question.questionId)
          const stats = yield* readUserStats(hydra, uid)
          if (stats._tag !== "Some" || stats.value.claims === 0) continue
          // The probe arm on its own, which is the arm the box is about. A
          // union that contained `(me, age)` only because the convergence walk
          // happened to reach it would not be evidence for the probe.
          const probe = yield* probeArm(
            hydra,
            uid,
            { entityCanon: "me", attr: "age" },
            stats.value.claims
          )
          return { uid, question, probe }
        }
        return null
      })
    )
    expect(
      outcome,
      "no grandparent age-comparison dev user is ingested yet; run the ingest to completion"
    ).not.toBeNull()

    // The Slot exists and the probe reached it by key.
    expect(outcome!.probe.claims.length).toBeGreaterThan(0)
    expect(outcome!.probe.kind).toBe("probe")
    for (const claim of outcome!.probe.claims) {
      expect(claim.ckey.startsWith(`${outcome!.uid}|c|`)).toBe(true)
    }

    // And the union keeps it: probe outranks convergence, so a claim the walk
    // did not reach is still a candidate rather than being capped away.
    const union = unionArms([
      { kind: "convergence" as const, label: "convergence", claims: [] },
      outcome!.probe
    ])
    const probed = new Set(outcome!.probe.claims.map((claim) => claim.ckey))
    expect(union.candidates.filter((candidate) => probed.has(candidate.ckey)).length).toBe(
      probed.size
    )
    console.log(
      `${outcome!.question.questionId}: (me, age) probe returned ${outcome!.probe.claims.length} claim(s)`
    )
  }, 180_000)
})
