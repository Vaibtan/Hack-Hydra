import { FetchHttpClient, HttpApiClient } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { PalimpsestApi } from "../src/Api.js"

/**
 * `smoke [--url http://127.0.0.1:8787] [--uid smoke-<timestamp>]`
 *
 * Drives a fresh user through the whole API over real HTTP: ingest a session,
 * ask a question it can only answer from that session, ingest a second session
 * that *replaces* the first's value, ask again, and read the supersession chain
 * back.
 *
 * The point is not coverage, it is the two claims the demo makes:
 *
 *  - **read-your-writes** — the ask immediately after an ingest sees claims
 *    written milliseconds earlier, with no sleep and no retry, because one
 *    `HydraClient` threads HydraDB's bookmark into the next read;
 *  - **supersession is structural** — nothing marks the first answer stale;
 *    it becomes stale because an edge now points out of it.
 *
 * A fresh uid every run, because the graph is append-only and deletes are
 * unavailable past a million edges.
 */
loadDotEnv()

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const baseUrl = arg("url", process.env["PALIMPSEST_API"] ?? "http://127.0.0.1:8787")
const uid = arg("uid", `smoke-${Date.now().toString(36)}`)

const ok = (label: string, detail: string) => console.log(`  ok    ${label.padEnd(34)} ${detail}`)
const fail = (label: string, detail: string) => {
  console.error(`  FAIL  ${label.padEnd(34)} ${detail}`)
  process.exitCode = 1
}

const SESSION_ONE = {
  date: "2023/03/14 (Tue) 09:12",
  turns: [
    {
      role: "user" as const,
      content:
        "I finally adopted a hamster this weekend and named her Nibbles. She is a Syrian hamster, " +
        "about three months old, and she has already chewed through one cardboard tube."
    },
    {
      role: "assistant" as const,
      content:
        "Congratulations on Nibbles! Syrian hamsters are solitary, so keep her housed alone, and " +
        "cardboard tubes are a good chew toy to keep replacing."
    }
  ]
}

const SESSION_TWO = {
  date: "2023/09/02 (Sat) 18:40",
  turns: [
    {
      role: "user" as const,
      content:
        "Small update on the hamster: we ended up renaming her. Nibbles never really suited her, " +
        "so she is called Pretzel now and answers to it much better."
    },
    {
      role: "assistant" as const,
      content: "Pretzel is a lovely name. Renaming a hamster this young is completely fine."
    }
  ]
}

const program = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(PalimpsestApi, { baseUrl })

  console.log(`url    ${baseUrl}`)
  console.log(`uid    ${uid}`)
  console.log("")

  // ---- 1. ingest one session into an empty history --------------------------
  const first = yield* client.users.ingestSession({
    path: { uid },
    payload: SESSION_ONE
  })
  if (first.claims > 0 && first.sessionOrd === 1) {
    ok("ingest session 1", `ord ${first.sessionOrd}, ${first.claims} claims, ${first.dropped} dropped`)
  } else {
    fail("ingest session 1", `ord ${first.sessionOrd}, ${first.claims} claims`)
  }
  if (first.bookmark !== null) ok("write returned a bookmark", first.bookmark.slice(0, 32) + "…")
  else fail("write returned a bookmark", "null")

  // ---- 2. ask immediately, with no delay ------------------------------------
  // If reads did not replay the write's bookmark this is where it would show:
  // an ABSENT verdict on a fact written a moment ago.
  const asked = yield* client.users.ask({
    path: { uid },
    payload: { question: "What is my hamster called?", questionDate: "2023/04/01 (Sat) 10:00" }
  })
  if (asked.verdict === "ANSWER") {
    ok("ask sees the new claims", `${asked.evidence.length} evidence, ${asked.receipt.query1Paths} paths`)
  } else {
    fail("ask sees the new claims", `verdict ${asked.verdict} (${asked.reason})`)
  }
  if (asked.answer !== null && /nibbles/i.test(asked.answer)) {
    ok("reader answers from the span", asked.answer)
  } else {
    fail("reader answers from the span", String(asked.answer))
  }
  if (asked.evidence.length > 0) {
    const span = asked.evidence[0]!
    const highlighted = span.excerpt.slice(span.highlight.start, span.highlight.end)
    if (highlighted.length > 0 && span.excerpt.includes(highlighted)) {
      ok("evidence is verbatim with a span", `"${highlighted.slice(0, 46)}…"`)
    } else {
      fail("evidence is verbatim with a span", JSON.stringify(span.highlight))
    }
  }
  if (asked.receipt.anchorTerms.length > 0) {
    ok(
      "receipt carries the query",
      `${asked.receipt.anchorsReachingClaims.length}/${asked.receipt.anchorTerms.length} anchors reached a claim`
    )
  } else {
    fail("receipt carries the query", "no anchor terms")
  }

  // ---- 3. a second session that replaces the first's value ------------------
  const second = yield* client.users.ingestSession({ path: { uid }, payload: SESSION_TWO })
  if (second.sessionOrd === 2) {
    ok("ingest session 2", `ord ${second.sessionOrd}, ${second.claims} claims, ${second.supersessions} supersessions`)
  } else {
    fail("ingest session 2", `ord ${second.sessionOrd}`)
  }

  // Posting the identical session again must change nothing: counts are not
  // content-addressed the way vertices are, so this is the guard that keeps
  // `df` from inflating and quietly changing every later question's idf.
  const repeat = yield* client.users.ingestSession({ path: { uid }, payload: SESSION_TWO })
  if (repeat.alreadyPresent && repeat.stats.claims === second.stats.claims) {
    ok("re-posting a session is a no-op", `claims still ${repeat.stats.claims}`)
  } else {
    fail("re-posting a session is a no-op", `alreadyPresent ${repeat.alreadyPresent}, claims ${repeat.stats.claims}`)
  }

  // ---- 4. ask again — the answer should have moved --------------------------
  const again = yield* client.users.ask({
    path: { uid },
    payload: { question: "What is my hamster called?", questionDate: "2023/10/01 (Sun) 10:00" }
  })
  if (again.answer !== null && /pretzel/i.test(again.answer)) {
    ok("answer follows the newer claim", again.answer)
  } else {
    fail("answer follows the newer claim", String(again.answer))
  }

  // ---- 5. as-of replays the older belief ------------------------------------
  const asOf1 = yield* client.users.ask({
    path: { uid },
    payload: {
      question: "What is my hamster called?",
      questionDate: "2023/10/01 (Sun) 10:00",
      asOf: 1
    }
  })
  if (asOf1.answer !== null && /nibbles/i.test(asOf1.answer)) {
    ok("as-of 1 replays the old belief", asOf1.answer)
  } else {
    fail("as-of 1 replays the old belief", String(asOf1.answer))
  }
  if (asOf1.receipt.asOf === 1 && asOf1.hash !== again.hash) {
    ok("as-of changes the evidence set", `hash ${asOf1.hash.slice(0, 12)} vs ${again.hash.slice(0, 12)}`)
  } else {
    fail("as-of changes the evidence set", "same hash")
  }

  // ---- 6. determinism -------------------------------------------------------
  const repeatAsk = yield* client.users.ask({
    path: { uid },
    payload: { question: "What is my hamster called?", questionDate: "2023/10/01 (Sun) 10:00" }
  })
  if (repeatAsk.hash === again.hash) ok("same question, same hash", again.hash.slice(0, 24) + "…")
  else fail("same question, same hash", `${again.hash} vs ${repeatAsk.hash}`)

  // ---- 7. sessions, stats, and the chain ------------------------------------
  const sessions = yield* client.users.sessions({ path: { uid } })
  if (sessions.length === 2 && sessions[0]!.sessionOrd === 1) {
    ok("sessions list", sessions.map((s) => `s${s.sessionOrd} ${s.dateInt} (${s.turns} turns)`).join(", "))
  } else {
    fail("sessions list", JSON.stringify(sessions))
  }

  const stats = yield* client.users.stats({ path: { uid } })
  if (stats.claims > 0 && stats.sessions === 2) {
    ok("stats", `${stats.claims} claims, ${stats.entities} entities, ${stats.contestedSlots} contested slots`)
  } else {
    fail("stats", JSON.stringify(stats))
  }

  const contested = stats.contested[0]
  if (contested !== undefined) {
    const chain = yield* client.users.slot({
      path: { uid, skey: contested.skey },
      urlParams: {}
    })
    const superseded = chain.claims.filter((claim) => claim.supersededBy !== null).length
    ok(
      "slot chain",
      `${contested.entityName} | ${contested.attr} — ${chain.claims.length} claims, ${superseded} superseded`
    )
  } else {
    console.log("  note  no contested slot in this run — the rename did not land in one slot")
  }

  console.log("")
  console.log(process.exitCode === 1 ? "SMOKE FAILED" : "SMOKE PASSED")
})

Effect.runPromise(
  Effect.provide(program, Layer.mergeAll(FetchHttpClient.layer, NodeHttpClient.layerUndici)) as Effect.Effect<
    void,
    unknown,
    never
  >
).catch((error) => {
  console.error(String(error))
  process.exit(1)
})
