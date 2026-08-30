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

describe.runIf(hasDataset && split !== null)("the Slot probe arm", () => {
  it("returns an empty arm for a slot that does not exist, not an error", async () => {
    const uid = `${split!.prefix}${split!.dev[0]!}`
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

  it("returns every claim of a slot that does exist, past the 1024-row page", async () => {
    // The engine caps a response at 1024 rows with a `next_cursor`, and
    // `MSpaths` cannot take SKIP/LIMIT. A probe that stopped at the first page
    // would silently return part of a slot's history -- which on a
    // knowledge-update question is the difference between seeing the value that
    // was replaced and not.
    const uid = `${split!.prefix}${split!.dev[0]!}`
    const found = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const stats = yield* readUserStats(hydra, uid)
        const total = stats._tag === "Some" ? stats.value.claims : 1
        // `me` is the one canon every haystack has, and `residence` /
        // `occupation` are the attributes the extractor produces most.
        const arms = yield* Effect.all(
          ["residence", "occupation", "age", "name"].map((attr) =>
            probeArm(hydra, uid, { entityCanon: "me", attr }, total)
          ),
          { concurrency: 2 }
        )
        return arms
      })
    )
    // At least one of the four exists on a 40-session user; if none does, the
    // probe arm is reaching nothing at all and that is the finding.
    const reached = found.filter((arm) => arm.claims.length > 0)
    expect(reached.length).toBeGreaterThan(0)
    for (const arm of reached) {
      // Scored with zero anchors by construction: a probe hit was named, not
      // converged on, and must never outrank a claim the question reached.
      expect(arm.claims.every((claim: ReachedClaim) => claim.convergence === 0)).toBe(true)
      expect(arm.claims.every((claim: ReachedClaim) => claim.ckey.startsWith(`${uid}|c|`))).toBe(
        true
      )
      // Every claim is distinct: a paged read that re-requested a page would
      // duplicate, and a `Set` is the cheapest way to see it.
      expect(new Set(arm.claims.map((claim: ReachedClaim) => claim.ckey)).size).toBe(
        arm.claims.length
      )
    }
  }, 180_000)

  it("keys the probe by canon and attribute, exactly as ingest wrote it", async () => {
    // A probe that built its key differently from ingest would return nothing
    // and be indistinguishable from a slot that does not exist -- the worst
    // possible failure, because it looks like a correct empty answer.
    const uid = `${split!.prefix}${split!.dev[0]!}`
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
    const uid = `${split!.prefix}${split!.dev[0]!}`
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
    const repeated = questions.find((q) => q.sessions.some((s) => s.key !== s.sid))
    if (repeated === undefined) {
      // Nothing to check on this dataset build; say so rather than passing
      // silently on an assertion that never ran.
      expect(questions.length).toBeGreaterThan(0)
      return
    }
    const uid = `${split!.prefix}${repeated.questionId}`
    const doubled = repeated.sessions.find((s) => s.key !== s.sid)!

    const seen = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const paths = yield* hydra.msPaths({
          sourceLabel: "Turn",
          sourceProperty: "turn",
          sourceValues: [turnKey(uid, doubled.key, 0), turnKey(uid, doubled.sid, 0)],
          relTypes: ["HAS_TURN"],
          relDirection: "incoming",
          maxLen: 1
        })
        return new Set(paths.map((path) => String(path.nodes[0]?.properties["turn"] ?? "")))
      })
    )
    expect(seen.has(turnKey(uid, doubled.key, 0))).toBe(true)
  }, 180_000)
})

describe.runIf(hasDataset && split !== null)("the union", () => {
  it("puts a probe hit ahead of a convergence hit of the same claim", async () => {
    // Arm priority, on real rows rather than fixtures: a claim both a probe and
    // the convergence walk reached is a probe hit, and keeps the convergence
    // the walk measured.
    const uid = `${split!.prefix}${split!.dev[0]!}`
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
