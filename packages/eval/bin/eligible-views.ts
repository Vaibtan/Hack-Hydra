import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  ELIGIBLE_VIEW_DIR,
  FREEZE_FILE,
  arg,
  deriveEligibleView,
  flag,
  freezeFindings,
  observeFreeze,
  readEvaluationFreeze,
  renderEligibleView,
  workspaceRoot
} from "../src/index.js"

/**
 * `eligible-views [--manifest data/splits/retrieval-v2.freeze.json] [--out-dir results/views] [--check]`
 *
 * Derives the eligible-population view of every already-read test arm from its committed
 * 140-row artifact, after the freeze integrity check passes. Never calls a provider, never
 * touches the source artifacts, and never overwrites a view; `--check` recomputes and compares.
 */

const refuse = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const main = async (): Promise<number> => {
  const root = workspaceRoot()
  const manifest = readEvaluationFreeze(root, arg("manifest", FREEZE_FILE))
  const outDir = arg("out-dir", ELIGIBLE_VIEW_DIR)
  const checkOnly = flag("check")
  const observation = await observeFreeze(root, manifest, resolve(root, manifest.dataset.path))
  const findings = freezeFindings(manifest, observation, "integrity")
  if (findings.length > 0) {
    console.error("refusing to derive views: the freeze integrity check fails")
    for (const finding of findings) console.error(`  - [${finding.code}] ${finding.subject}: ${finding.detail}`)
    return 1
  }

  let problems = 0
  for (const arm of manifest.alreadyRead.filter((candidate) => candidate.split === "test")) {
    const envelope = observation.envelopes.get(arm.artifact.path)
    if (envelope === undefined) return refuse(`${arm.artifact.path} was not observed`)
    const outcome = deriveEligibleView(
      { path: arm.artifact.path, sha256: arm.artifact.sha256, envelope },
      {
        split: "test",
        original: observation.split.test,
        eligible: manifest.population.eligible.test,
        exclusions: manifest.population.exclusions
      }
    )
    if (outcome._tag === "Refused") {
      console.error(`refused ${arm.artifact.path}:`)
      for (const reason of outcome.reasons) console.error(`  - ${reason}`)
      problems++
      continue
    }
    const text = renderEligibleView(outcome.view)
    const target = `${outDir}/${arm.system}-test.eligible.json`
    const path = resolve(root, target)
    const summary = `${outcome.view.view.rows.length} of ${outcome.view.source.rows} rows, ${outcome.view.excluded.length} excluded`
    if (checkOnly) {
      const existing = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null
      const verdict = existing === null ? "missing" : existing === text ? "matches" : "DIFFERS"
      if (verdict !== "matches") problems++
      console.log(`${verdict.padEnd(8)} ${target}  (${summary})`)
      continue
    }
    mkdirSync(resolve(root, outDir), { recursive: true })
    try {
      writeFileSync(path, text, { encoding: "utf8", flag: "wx" })
    } catch {
      return refuse(`${target} already exists; views are never overwritten — run with --check to verify it`)
    }
    console.log(`wrote    ${target}  (${summary})`)
  }
  return problems
}

main()
  .then((problems) => {
    if (problems > 0) process.exitCode = 1
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  })
