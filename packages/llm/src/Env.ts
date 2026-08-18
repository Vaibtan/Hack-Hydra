import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * Reads the workspace's gitignored `.env` into `process.env`, which is where
 * Effect's default `ConfigProvider` looks. Called explicitly by CLIs and by the
 * test setup — never as an import side effect, so a library consumer keeps
 * control of its own configuration.
 *
 * Existing environment variables win, so `OPENAI_API_KEY=… pnpm …` still works.
 */
export const loadDotEnv = (startDir = process.cwd()): void => {
  let dir = resolve(startDir)
  for (let depth = 0; depth < 8; depth++) {
    const candidate = resolve(dir, ".env")
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === "" || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq <= 0) continue
        const key = trimmed.slice(0, eq).trim()
        if (process.env[key] !== undefined) continue
        const raw = trimmed.slice(eq + 1).trim()
        process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2")
      }
      return
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}
