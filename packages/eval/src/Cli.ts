import { DATASET_FILES, type DatasetName } from "@palimpsest/dataset"
import type { SplitName } from "./Splits.js"

export const arg = (name: string, fallback: string, argv: ReadonlyArray<string> = process.argv): string => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (argv[index + 1] ?? fallback)
}

export const flag = (name: string, argv: ReadonlyArray<string> = process.argv): boolean =>
  argv.includes(`--${name}`)

export class CliError extends Error {}

export interface Batch {
  readonly index: number
  readonly count: number
}

export const parseBatch = (value: string): Batch | null => {
  if (value === "") return null
  const match = /^(\d+)\/(\d+)$/.exec(value.trim())
  if (match === null) throw new CliError(`--batch must look like 3/12, not ${JSON.stringify(value)}`)
  const index = Number(match[1])
  const count = Number(match[2])
  if (index < 1 || count < 1 || index > count) {
    throw new CliError(`--batch ${value}: the index must be between 1 and the count`)
  }
  return { index, count }
}

export const parseProfile = (value: string): "full" | "fast" => {
  if (value === "full" || value === "fast") return value
  throw new CliError(`--profile must be full or fast, not ${JSON.stringify(value)}`)
}

const isDatasetName = (value: string): value is DatasetName => Object.hasOwn(DATASET_FILES, value)

export const parseDataset = (value: string): DatasetName => {
  if (isDatasetName(value)) return value
  throw new CliError(`--dataset must be one of ${Object.keys(DATASET_FILES).join(", ")}, not ${JSON.stringify(value)}`)
}

export const parseSplit = (value: string): SplitName | null => {
  if (value === "") return null
  if (value === "dev" || value === "test") return value
  throw new CliError(`--split must be dev or test, not ${JSON.stringify(value)}`)
}

export const parseGranularity = (value: string): "span" | "turn" | null => {
  if (value === "") return null
  if (value === "span" || value === "turn") return value
  throw new CliError(`--granularity must be span or turn, not ${JSON.stringify(value)}`)
}

export interface AblationFlags {
  readonly noDecompose?: true
  readonly noDiscovery?: true
  readonly noTimeScope?: true
  readonly noSelect?: true
  readonly noSufficiency?: true
  readonly noReaderRoute?: true
}

const ABLATION_FLAGS: ReadonlyArray<readonly [keyof AblationFlags, (argv: ReadonlyArray<string>) => boolean]> = [
  ["noDecompose", (argv) => flag("no-decompose", argv)],
  ["noDiscovery", (argv) => flag("no-discovery", argv)],
  ["noTimeScope", (argv) => flag("no-time-scope", argv)],
  ["noSelect", (argv) => flag("no-select", argv)],
  ["noSufficiency", (argv) => flag("no-sufficiency", argv)],
  ["noReaderRoute", (argv) => arg("reader-route", "on", argv) === "off"]
]

export const parseAblations = (argv: ReadonlyArray<string> = process.argv): AblationFlags =>
  Object.fromEntries(ABLATION_FLAGS.filter(([, on]) => on(argv)).map(([name]) => [name, true]))

export const ablationNames = (flags: AblationFlags): ReadonlyArray<string> => Object.keys(flags).sort()

/** Runs `parse`, printing a `CliError` as a two-line refusal with exit 2. */
export const orExit = <A>(parse: () => A): A => {
  try {
    return parse()
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}
