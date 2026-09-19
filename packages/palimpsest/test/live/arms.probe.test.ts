import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadDataset } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer, Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { claimKind, slotKey, turnKey } from "../../src/Keys.js"
import { readUserStats } from "../../src/User.js"
import { probeArm, unionArms } from "../../src/Arms.js"
import { Reader } from "../../src/Reader.js"
import { Retrieve } from "../../src/Retrieve.js"
import type { ReachedClaim } from "../../src/Scoring.js"
import { Supersede } from "../../src/Supersede.js"

const hasDataset = existsSync(datasetPath("s"))
const splitPath = resolve(import.meta.dirname, "../../../../data/splits/retrieval-v2.json")
const hasSplit = existsSync(splitPath)

const AppLive = Retrieve.layer.pipe(
  Layer.provideMerge(Reader.layer),
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(HydraClient.layer),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof AppLive>>) =>
  Effect.runPromise(Effect.provide(effect, AppLive))

const Split = Schema.Struct({ prefix: Schema.String, dev: Schema.Array(Schema.String) })
type Split = typeof Split.Type

const split: Split | null = hasSplit
  ? Schema.decodeUnknownSync(Split)(JSON.parse(readFileSync(splitPath, "utf8")))
  : null

const uidFor = (questionId: string): string =>
  split!.prefix === "" ? questionId : `${split!.prefix}-${questionId}`

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
    const subject = await run(firstIngestedDevUser)
    expect(subject, "no dev user is ingested; run pnpm ingest-slice first").not.toBeNull()
    const uid = subject!.uid

    const measured = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const total = subject!.claims
        const paths = yield* hydra.msPaths({
          sourceLabel: "Claim",
          sourceProperty: "kind",
          sourceValues: [claimKind(uid)],
          relTypes: ["FILLS"],
          relDirection: "outgoing",
          maxLen: 1
        })
        const arms = yield* Effect.all(
          ["residence", "occupation", "age", "name"].map((attr) =>
            probeArm(hydra, uid, { entityCanon: "me", attr }, total)
          ),
          { concurrency: 2 }
        )
        return { paths, arms }
      })
    )

    expect(measured.paths.length).toBeGreaterThan(1024)
    const ckeys = measured.paths.map((path) => String(path.nodes[0]?.properties["ckey"] ?? ""))
    expect(new Set(ckeys).size).toBe(ckeys.length)
    expect(measured.paths.length % 1024).not.toBe(0)

    const reached = measured.arms.filter((arm) => arm.claims.length > 0)
    expect(reached.length).toBeGreaterThan(0)
    for (const arm of reached) {
      expect(arm.claims.every((claim: ReachedClaim) => claim.convergence === 0)).toBe(true)
      expect(arm.claims.every((claim: ReachedClaim) => claim.ckey.startsWith(`${uid}|c|`))).toBe(
        true
      )
      expect(new Set(arm.claims.map((claim: ReachedClaim) => claim.ckey)).size).toBe(
        arm.claims.length
      )
    }
    const largest = Math.max(...reached.map((arm) => arm.claims.length))
    console.log(
      `largest (me, *) slot on ${uid}: ${largest} claims; FILLS walk: ${measured.paths.length} paths`
    )
    expect(largest).toBeLessThan(1024)
  }, 180_000)

  it("keys the probe by canon and attribute, exactly as ingest wrote it", async () => {
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
    expect(turns.has(turnKey(uid, sessionKey, -1))).toBe(false)
    expect(turns.get(turnKey(uid, sessionKey, 0))!.length).toBeGreaterThan(0)
  }, 180_000)

  it("builds turn keys from the session KEY, not the bare sid", async () => {
    const questions = await Effect.runPromise(loadDataset("s"))
    const dev = new Set(split!.dev)
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

    expect(found!.seen.has(turnKey(found!.uid, found!.doubled.key, 0))).toBe(true)
    expect(found!.seen.has(turnKey(found!.uid, found!.doubled.sid, 0))).toBe(true)
    expect(found!.byKey.get(turnKey(found!.uid, found!.doubled.key, 0))).not.toBe(
      found!.byKey.get(turnKey(found!.uid, found!.doubled.sid, 0))
    )
  }, 180_000)
})

describe.runIf(hasDataset && split !== null)("the union", () => {
  it("puts a probe hit ahead of a convergence hit of the same claim", async () => {
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
    expect(report.candidates.every((candidate) => candidate.convergence === 3)).toBe(true)
    expect(report.candidates.every((candidate) => candidate.arms.length === 2)).toBe(true)
  }, 180_000)
})

describe.runIf(hasDataset && split !== null)("the two-fact comparison question", () => {
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

    expect(outcome!.probe.claims.length).toBeGreaterThan(0)
    expect(outcome!.probe.kind).toBe("probe")
    for (const claim of outcome!.probe.claims) {
      expect(claim.ckey.startsWith(`${outcome!.uid}|c|`)).toBe(true)
    }

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
