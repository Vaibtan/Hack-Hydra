import { describe, expect, it } from "vitest"
import { judgeLabel, judgePrompt, judgeTemplate } from "../../src/index.js"

/**
 * The judge is the measuring instrument, so the thing to test is fidelity to
 * upstream, not cleverness. The strings below were copied out of
 * `src/evaluation/evaluate_qa.py` in `github.com/xiaowu0162/LongMemEval` at the
 * same time as the port; if either drifts, this fails.
 */
const question = (type: string, abs = false) => ({
  questionType: type,
  isAbstention: abs
})

describe("judgeTemplate", () => {
  it("routes the three plain types to the default template", () => {
    expect(judgeTemplate(question("single-session-user"))).toBe("default")
    expect(judgeTemplate(question("single-session-assistant"))).toBe("default")
    expect(judgeTemplate(question("multi-session"))).toBe("default")
  })

  it("gives temporal, knowledge-update and preference their own", () => {
    expect(judgeTemplate(question("temporal-reasoning"))).toBe("temporal-reasoning")
    expect(judgeTemplate(question("knowledge-update"))).toBe("knowledge-update")
    expect(judgeTemplate(question("single-session-preference"))).toBe("single-session-preference")
  })

  it("routes every abstention question to the abstention template, whatever its type", () => {
    // The 30 `_abs` questions carry their base type, so the abstention branch
    // has to win — upstream decides on `'_abs' in question_id` alone.
    for (const type of ["multi-session", "temporal-reasoning", "knowledge-update"]) {
      expect(judgeTemplate(question(type, true))).toBe("abstention")
    }
  })

  it("refuses an unknown type rather than scoring it by the wrong rubric", () => {
    expect(() => judgeTemplate(question("something-new"))).toThrow(/no LongMemEval judge template/)
  })
})

describe("judgePrompt", () => {
  it("matches upstream's default template exactly", () => {
    expect(judgePrompt("default", "Q", "A", "R")).toBe(
      "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: Q\n\nCorrect Answer: A\n\nModel Response: R\n\nIs the model response correct? Answer yes or no only."
    )
  })

  it("keeps the temporal template's off-by-one tolerance", () => {
    expect(judgePrompt("temporal-reasoning", "Q", "A", "R")).toContain(
      "do not penalize off-by-one errors for the number of days"
    )
  })

  it("keeps the knowledge-update template's allowance for the previous value", () => {
    expect(judgePrompt("knowledge-update", "Q", "A", "R")).toContain(
      "If the response contains some previous information along with an updated answer"
    )
  })

  it("labels the preference template's answer field a rubric, as upstream does", () => {
    const prompt = judgePrompt("single-session-preference", "Q", "A", "R")
    expect(prompt).toContain("Rubric: A")
    expect(prompt).not.toContain("Correct Answer:")
  })

  it("labels the abstention template's answer field an explanation", () => {
    const prompt = judgePrompt("abstention", "Q", "A", "R")
    expect(prompt).toContain("I will give you an unanswerable question")
    expect(prompt).toContain("Explanation: A")
    expect(prompt).toContain("Does the model correctly identify the question as unanswerable?")
  })
})

describe("judgeLabel", () => {
  it("is upstream's rule: yes appears in the lowercased reply", () => {
    expect(judgeLabel("Yes")).toBe(true)
    expect(judgeLabel("yes.")).toBe(true)
    expect(judgeLabel("No")).toBe(false)
    expect(judgeLabel("no, the response is wrong")).toBe(false)
  })

  it("inherits upstream's quirk rather than correcting it", () => {
    // "yes" inside a longer sentence counts, which is why the templates end
    // "Answer yes or no only". Silently fixing this would make our numbers
    // incomparable to every published LongMemEval result.
    expect(judgeLabel("I would not say yes to this")).toBe(true)
  })
})
