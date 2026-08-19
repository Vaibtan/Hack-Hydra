import type { LanguageModel } from "@effect/ai"
import type { DatasetQuestion } from "@palimpsest/dataset"
import { Llm } from "@palimpsest/llm"
import { Effect } from "effect"

/**
 * The official LongMemEval judge.
 *
 * The five templates below are copied **verbatim** from
 * `src/evaluation/evaluate_qa.py` in `github.com/xiaowu0162/LongMemEval`
 * (fetched, not typed from memory), including their whitespace and their
 * trailing "Answer yes or no only." Scoring is upstream's:
 * `'yes' in response.lower()`.
 *
 * Which template applies is a property of the question, not of the system under
 * test, so all three systems are scored by the same judge on the same prompt —
 * that is the only way the comparison means anything.
 *
 * Deviations from upstream, both stated in the writeup:
 *
 *  - upstream pins `gpt-4o-2024-08-06`; this asks for whatever the account's
 *    `gpt-4o` alias resolves to, and records the model in every results row;
 *  - upstream caps the reply at `max_tokens: 10`. The reply is free text here
 *    and is scored the same way, so a longer reply containing "yes" scores the
 *    same as upstream's truncated one would.
 */
export const JUDGE_MODEL = "gpt-4o"

/** Which of the five templates a question is scored by. */
export type JudgeTemplate =
  | "default"
  | "temporal-reasoning"
  | "knowledge-update"
  | "single-session-preference"
  | "abstention"

export const judgeTemplate = (question: {
  readonly questionType: string
  readonly isAbstention: boolean
}): JudgeTemplate => {
  if (question.isAbstention) return "abstention"
  switch (question.questionType) {
    case "temporal-reasoning":
      return "temporal-reasoning"
    case "knowledge-update":
      return "knowledge-update"
    case "single-session-preference":
      return "single-session-preference"
    case "single-session-user":
    case "single-session-assistant":
    case "multi-session":
      return "default"
    default:
      // Upstream raises NotImplementedError here. A silent fallback would score
      // an unknown type by the wrong rubric and never say so.
      throw new Error(`no LongMemEval judge template for question type ${question.questionType}`)
  }
}

/** `get_anscheck_prompt`, one branch per template, verbatim. */
export const judgePrompt = (
  template: JudgeTemplate,
  question: string,
  answer: string,
  response: string
): string => {
  switch (template) {
    case "default":
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
    case "temporal-reasoning":
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
    case "knowledge-update":
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
    case "single-session-preference":
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
    case "abstention":
      return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
  }
}

/** Upstream's scoring rule, and nothing more clever than it. */
export const judgeLabel = (reply: string): boolean => reply.toLowerCase().includes("yes")

export interface Judgement {
  readonly correct: boolean
  readonly template: JudgeTemplate
  readonly reply: string
  readonly model: string
  readonly cached: boolean
}

/**
 * Scores one response. Cached on disk under the `judge` kind by
 * model + prompt, so a re-run of any table costs $0 and returns the same
 * labels — which matters more here than anywhere else, because a judge that
 * drifts makes two runs of the same system incomparable.
 */
export const judge = (
  question: DatasetQuestion,
  response: string,
  model: string = JUDGE_MODEL
): Effect.Effect<Judgement, never, LanguageModel.LanguageModel | Llm> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const template = judgeTemplate(question)
    const prompt = judgePrompt(template, question.question, question.answer, response)
    const generated = yield* llm
      .generateText({ kind: "judge", prompt, model })
      .pipe(Effect.orDie)
    return {
      correct: judgeLabel(generated.value),
      template,
      reply: generated.value.trim(),
      model: generated.model,
      cached: generated.cached
    }
  })
