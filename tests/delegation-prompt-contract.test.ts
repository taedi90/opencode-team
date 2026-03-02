import { describe, expect, it } from "vitest"

import {
  buildDelegationPrompt,
  summarizeDelegationPrompt,
} from "../src/pipeline/delegation-prompt-contract.js"

describe("delegation prompt contract", () => {
  it("builds prompt with all required sections", () => {
    const prompt = buildDelegationPrompt({
      task: "execute planning role",
      expectedOutcome: "return approved planning payload",
      requiredTools: ["read", "glob"],
      mustDo: ["preserve contract"],
      mustNotDo: ["skip handoff"],
      context: ["stage=planning", "role=plan"],
    })

    expect(prompt).toContain("1. TASK:")
    expect(prompt).toContain("2. EXPECTED OUTCOME:")
    expect(prompt).toContain("3. REQUIRED TOOLS:")
    expect(prompt).toContain("4. MUST DO:")
    expect(prompt).toContain("5. MUST NOT DO:")
    expect(prompt).toContain("6. CONTEXT:")
  })

  it("summarizes prompt deterministically", () => {
    const prompt = buildDelegationPrompt({
      task: "execute review role",
      expectedOutcome: "return gate decision",
      requiredTools: ["read"],
      mustDo: ["report open risks"],
      mustNotDo: ["mutate unrelated state"],
      context: ["stage=merge", "role=reviewer"],
    })

    const first = summarizeDelegationPrompt(prompt)
    const second = summarizeDelegationPrompt(prompt)

    expect(first.hash).toBe(second.hash)
    expect(first.lineCount).toBe(second.lineCount)
    expect(first.lineCount).toBeGreaterThan(6)
  })
})
