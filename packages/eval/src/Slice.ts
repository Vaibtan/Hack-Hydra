import type { DatasetQuestion } from "@palimpsest/dataset"

/**
 * A deterministic, stratified slice of the benchmark.
 *
 * Deterministic because every measurement in this repo has to be re-runnable
 * from the same numbers; stratified because the six question types stress very
 * different parts of the design (assistant output, preference polarity,
 * temporal arithmetic, knowledge updates), and a random 20 would miss some
 * entirely. Types are taken round-robin, each in `question_id` order.
 */
export const stratifiedSlice = (
  questions: ReadonlyArray<DatasetQuestion>,
  size: number
): ReadonlyArray<DatasetQuestion> => {
  const byType = new Map<string, Array<DatasetQuestion>>()
  for (const question of [...questions].sort((a, b) => a.questionId.localeCompare(b.questionId))) {
    const bucket = byType.get(question.questionType)
    if (bucket === undefined) byType.set(question.questionType, [question])
    else bucket.push(question)
  }

  const types = [...byType.keys()].sort()
  const picked: Array<DatasetQuestion> = []
  for (let round = 0; picked.length < size; round++) {
    let progressed = false
    for (const type of types) {
      if (picked.length >= size) break
      const candidate = byType.get(type)![round]
      if (candidate !== undefined) {
        picked.push(candidate)
        progressed = true
      }
    }
    if (!progressed) break
  }
  return picked
}

/**
 * The slice the answer-accuracy harness runs on: **every** abstention question,
 * plus a stratified sample of the answerable ones.
 *
 * `stratifiedSlice` alone will not do. It round-robins the six
 * `question_type`s in `question_id` order and the 30 `_abs` questions share
 * their base type, so a 100-slice picks up whichever `_abs` ids happen to sort
 * early — the 20-slice got 2 of 30. Abstention is the thing this benchmark is
 * for, and a metric computed on an arbitrary 2 of its 30 cases is not a
 * measurement.
 *
 * `stratifiedSlice` is left exactly as it was, because the day-1 and day-3 gate
 * numbers were measured with it.
 */
export const evalSlice = (
  questions: ReadonlyArray<DatasetQuestion>,
  options: { readonly answerable: number; readonly allAbstention?: boolean }
): ReadonlyArray<DatasetQuestion> => {
  const abstention = questions.filter((question) => question.isAbstention)
  const answerable = stratifiedSlice(
    questions.filter((question) => !question.isAbstention),
    options.answerable
  )
  const picked = options.allAbstention === false ? answerable : [...answerable, ...abstention]
  // One stable order for every consumer, independent of how the two halves were
  // gathered, so a results file diffs against the previous run line for line.
  return [...picked].sort((a, b) => a.questionId.localeCompare(b.questionId))
}

/**
 * What `--slice N` means, everywhere: ingest, the retrieval gate and the answer
 * harness must agree on *which* N questions, or the harness asks about users
 * the ingest never wrote.
 *
 * Below 30 there is no room for the abstention set and this is the gate's own
 * `stratifiedSlice`, unchanged — so the day-1 and day-3 numbers keep meaning
 * what they meant. At 30 and above it is `evalSlice`: all 30 `_abs` plus a
 * stratified remainder. At or above the file size it is the whole benchmark.
 */
export const benchmarkSlice = (
  questions: ReadonlyArray<DatasetQuestion>,
  size: number
): ReadonlyArray<DatasetQuestion> => {
  if (size >= questions.length) {
    return [...questions].sort((a, b) => a.questionId.localeCompare(b.questionId))
  }
  const abstention = questions.filter((question) => question.isAbstention).length
  return size <= abstention
    ? stratifiedSlice(questions, size)
    : evalSlice(questions, { answerable: size - abstention })
}
