import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..", "..", "..", "..")

/**
 * The typed memory-operation surface production code may use. Everything else
 * the hydra package exports — the engine client, Cypher renderers, decoded
 * rows/paths/cells, paging, and the admin escape hatch — stays behind the
 * adapter or in admin/test-only tooling.
 */
const SRC_ALLOWLIST = new Set([
  "HydraMemory",
  "HydraMemoryLive",
  "HydraError",
  "HydraEngineError",
  "HydraIdentityIntegrityError",
  "HydraLimitError",
  "HydraParseError",
  "HydraUnavailable",
  "MemoryEdge",
  "MemoryNode",
  "MemoryPath",
  "MemoryProperties",
  "PropertyValue",
  "PropertyValueSchema",
  "DiscoveryInput",
  "DiscoveryResult",
  "ExecutionPlan",
  "ExecutionPlanDiagnostic",
  "VertexWrite",
  "EdgeWrite",
  "CommitReport",
  "NodeLookup",
  "KeyScan",
  "RelDirection",
  "edgeId",
  "vertexId",
  "NumericIdForKey"
])

/** Tooling may additionally reach the authenticated, audited admin boundary. */
const BIN_ALLOWLIST = new Set([
  ...SRC_ALLOWLIST,
  "HydraAdmin",
  "HydraAdminUnauthorized",
  "AdminCell",
  "AdminRow",
  "AdminResult"
])

/** Application orchestration may see typed errors and plan diagnostics, not graph protocol values. */
const APPLICATION_ALLOWLIST = new Set(["HydraError", "ExecutionPlanDiagnostic"])

const listSources = (dir: string): Array<string> => {
  const out: Array<string> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listSources(full))
    else if (entry.endsWith(".ts")) out.push(full)
  }
  return out
}

const IMPORT_FROM = /(?:import|export)\s+(?:type\s+)?(?:\{([^}]*)\}|([A-Za-z0-9_]+))\s+from\s+["']([^"']+)["']/g

interface Violation {
  readonly file: string
  readonly imported: string
  readonly from: string
}

const violationsIn = (files: ReadonlyArray<string>, allowlist: ReadonlySet<string>): Array<Violation> => {
  const violations: Array<Violation> = []
  for (const file of files) {
    const content = readFileSync(file, "utf8")
    for (const match of content.matchAll(IMPORT_FROM)) {
      const [, braced, single, from] = match
      if (from === undefined) continue
      if (from === "@palimpsest/hydra/testing") {
        violations.push({ file, imported: "(engine test surface)", from })
        continue
      }
      if (from !== "@palimpsest/hydra") {
        if (from.includes("hydra/src") || from.includes("packages/hydra")) {
          violations.push({ file, imported: "(deep import)", from })
        }
        continue
      }
      const names = braced === undefined ? [single!] : braced.split(",")
      for (let name of names) {
        name = name.trim().replace(/^type\s+/, "")
        const imported = name.includes(" as ") ? name.split(" as ")[0]!.trim() : name
        if (imported !== "" && !allowlist.has(imported)) {
          violations.push({ file, imported, from })
        }
      }
    }
  }
  return violations
}

describe("hydra import boundary (S05B)", () => {
  it("keeps the raw client, Cypher, decoder, transport context, and JSON protocol off the package root", () => {
    const publicIndex = readFileSync(join(root, "packages", "hydra", "src", "index.ts"), "utf8")
    for (const rawExport of [
      "HydraClient",
      "renderMsPathsQuery",
      "FULL_KEY_PROPERTY",
      "isHydraPath",
      "HydraPath",
      "QueryResult",
      "CurrentHydraBookmark",
      "JsonObject"
    ]) {
      expect(publicIndex, `raw '${rawExport}' leaked from @palimpsest/hydra`).not.toContain(rawExport)
    }
  })

  it("keeps raw storage types out of production packages", () => {
    const files = [
      ...listSources(join(root, "packages", "palimpsest", "src")),
      ...listSources(join(root, "packages", "server", "src")),
      ...listSources(join(root, "packages", "eval", "src"))
    ]
    expect(files.length).toBeGreaterThan(0)
    const violations = violationsIn(files, SRC_ALLOWLIST)
    expect(
      violations.map((violation) =>
        `${violation.file}: imports banned '${violation.imported}' from '${violation.from}'`
      )
    ).toEqual([])
  })

  it("keeps retrieval orchestration behind the snapshot-search capability", () => {
    const files = ["Retrieve.ts", "Answer.ts", "Plan.ts"].map((file) =>
      join(root, "packages", "palimpsest", "src", file)
    )
    const violations = violationsIn(files, APPLICATION_ALLOWLIST)
    expect(
      violations.map((violation) =>
        `${violation.file}: imports storage-level '${violation.imported}' from '${violation.from}'`
      )
    ).toEqual([])
  })

  it("keeps bins on the memory or admin surface, never raw engine types", () => {
    const existing = [
      join(root, "packages", "palimpsest", "bin"),
      join(root, "packages", "eval", "bin")
    ].flatMap(listSources)
    expect(existing.length).toBeGreaterThan(0)
    const violations = violationsIn(existing, BIN_ALLOWLIST)
    expect(
      violations.map((violation) =>
        `${violation.file}: imports banned '${violation.imported}' from '${violation.from}'`
      )
    ).toEqual([])
  })
})
