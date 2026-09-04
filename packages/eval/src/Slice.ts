import type { DatasetQuestion } from "@palimpsest/dataset"

/** Question types taken round-robin, each in `question_id` order. */
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

/** Every abstention question plus a stratified sample of the answerable ones. */
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
  return [...picked].sort((a, b) => a.questionId.localeCompare(b.questionId))
}

/** What `--slice N` means everywhere; see docs/design-rationale.md ("Slices"). */
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
