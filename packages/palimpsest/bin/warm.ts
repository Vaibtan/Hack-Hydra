import { NodeHttpClient } from "@effect/platform-node"
import { HydraClient } from "@palimpsest/hydra"
import { loadDotEnv } from "@palimpsest/llm"
import { Effect, Layer, Option } from "effect"
import { userKey } from "../src/Keys.js"
import { warmUser } from "../src/User.js"

/** `warm --uid g3-001be529 [--uid …] [--deep] [--budget-ms 15000]` */
loadDotEnv()

const uids = process.argv.reduce<Array<string>>((acc, value, index) => {
  if (value === "--uid" && process.argv[index + 1] !== undefined) acc.push(process.argv[index + 1]!)
  return acc
}, [])
const deep = process.argv.includes("--deep")
const budgetArg = process.argv.indexOf("--budget-ms")
const budgetMs =
  budgetArg === -1 ? undefined : Number(process.argv[budgetArg + 1] ?? "")

if (uids.length === 0) {
  console.error("usage: warm --uid <uid> [--uid <uid> …] [--deep] [--budget-ms 15000]")
  process.exit(2)
}

const AppLive = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const program = Effect.gen(function* () {
  const hydra = yield* HydraClient

  for (const uid of uids) {
    const report = yield* warmUser(hydra, uid, {
      deep,
      ...(budgetMs === undefined || !Number.isFinite(budgetMs) ? {} : { budgetMs })
    })
    if (Option.isNone(report)) {
      console.log(`${uid.padEnd(24)} no User vertex — nothing to warm`)
      continue
    }
    const it = report.value
    console.log(
      `${uid.padEnd(24)} ${String(it.entities).padStart(4)} entities  ` +
        `${String(it.slots).padStart(4)} slots  ${String(it.sessions).padStart(3)} sessions  ` +
        `${String(it.tokens).padStart(5)} tokens  ${String(it.slotClaims).padStart(5)} slot claims  ` +
        `${String(it.turns).padStart(5)} turns` +
        (deep ? `  ${String(it.hitClaims).padStart(6)} claims via HITS` : "") +
        `  ${it.ms} ms` +
        (it.truncated ? "  TRUNCATED (budget)" : "") +
        (it.failed > 0 ? `  ${it.failed} walk(s) FAILED` : "") +
        `  (root key ${userKey(uid)})`
    )
  }
})

Effect.runPromise(Effect.provide(program, AppLive) as Effect.Effect<void, unknown, never>).catch(
  (error) => {
    console.error(String(error))
    process.exit(1)
  }
)
