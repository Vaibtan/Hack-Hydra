/** Linear-interpolated quantile (R type 7); `q = 0.5` is the mean-of-middle median the gate record was computed with. */
export const quantile = (values: ReadonlyArray<number>, q: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  const weight = position - low
  return sorted[low]! * (1 - weight) + sorted[high]! * weight
}

export const median = (values: ReadonlyArray<number>): number => quantile(values, 0.5)

export const pct = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)} %`

export const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator
