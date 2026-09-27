import { describe, expect, it } from "vitest"
import { JUDGE_PROTOCOL, judgeLabel, judgePrompt, judgeTemplate } from "../../src/index.js"

const question = (type: string, abs = false) => ({
  questionType: type,
  isAbstention: abs
})

describe("judgeTemplate", () => {
  it("routes every supported question type to its rubric", () => {
    const cases = [
      ["single-session-user", "default"],
      ["single-session-assistant", "default"],
      ["multi-session", "default"],
      ["temporal-reasoning", "temporal-reasoning"],
      ["knowledge-update", "knowledge-update"],
      ["single-session-preference", "single-session-preference"]
    ] as const
    for (const [type, template] of cases) {
      expect(judgeTemplate(question(type)), type).toBe(template)
    }
  })

  it("routes abstentions explicitly and refuses unknown types", () => {
    for (const type of ["multi-session", "temporal-reasoning", "knowledge-update"]) {
      expect(judgeTemplate(question(type, true))).toBe("abstention")
    }
    expect(() => judgeTemplate(question("something-new"))).toThrow(/no LongMemEval judge template/)
  })
})

describe("judgePrompt", () => {
  it("matches upstream's default template exactly", () => {
    expect(judgePrompt("default", "Q", "A", "R")).toBe(
      "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: Q\n\nCorrect Answer: A\n\nModel Response: R\n\nIs the model response correct? Answer yes or no only."
    )
  })

  it("preserves each specialized upstream rubric", () => {
    const cases: ReadonlyArray<readonly [Parameters<typeof judgePrompt>[0], ReadonlyArray<string>]> = [
      ["temporal-reasoning", ["do not penalize off-by-one errors for the number of days"]],
      ["knowledge-update", ["If the response contains some previous information along with an updated answer"]],
      ["single-session-preference", ["Rubric: A"]],
      [
        "abstention",
        [
          "I will give you an unanswerable question",
          "Explanation: A",
          "Does the model correctly identify the question as unanswerable?"
        ]
      ]
    ]
    for (const [template, fragments] of cases) {
      const prompt = judgePrompt(template, "Q", "A", "R")
      for (const fragment of fragments) expect(prompt, template).toContain(fragment)
    }
    expect(judgePrompt("single-session-preference", "Q", "A", "R")).not.toContain("Correct Answer:")
  })
})

describe("judgeLabel", () => {
  it("keeps upstream's substring rule, including its known false positive", () => {
    expect(judgeLabel("Yes")).toBe(true)
    expect(judgeLabel("yes.")).toBe(true)
    expect(judgeLabel("No")).toBe(false)
    expect(judgeLabel("no, the response is wrong")).toBe(false)
    expect(judgeLabel("I would not say yes to this")).toBe(true)
  })
})

describe("upstream scoring protocol", () => {
  it("pins the exact LongMemEval request contract", () => {
    expect(JUDGE_PROTOCOL).toEqual({
      endpoint: "chat-completions",
      model: "gpt-4o-2024-08-06",
      temperature: 0,
      maxTokens: 10,
      n: 1
    })
  })
})
