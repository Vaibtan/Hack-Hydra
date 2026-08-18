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
