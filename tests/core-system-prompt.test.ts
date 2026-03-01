import { describe, expect, it } from "vitest"

import {
  assertCoreSystemPromptContract,
  assertMemoryPolicyPromptContract,
  CORE_SYSTEM_PROMPT,
  MEMORY_POLICY_PROMPT,
} from "../src/agents/core-system-prompt.js"

describe("core system prompt contract", () => {
  it("passes for default core system prompt", () => {
    expect(() => assertCoreSystemPromptContract(CORE_SYSTEM_PROMPT)).not.toThrow()
  })

  it("fails when required markers are missing", () => {
    const invalid = CORE_SYSTEM_PROMPT.replace("## Engineering Principles", "## principles")

    expect(() => assertCoreSystemPromptContract(invalid)).toThrow(
      "core system prompt contract violation",
    )
  })

  it("passes for default memory policy prompt", () => {
    expect(() => assertMemoryPolicyPromptContract(MEMORY_POLICY_PROMPT)).not.toThrow()
  })

  it("fails when memory policy markers are missing", () => {
    const invalid = MEMORY_POLICY_PROMPT.replace("### Memory Usage Flow", "### Memory Flow")

    expect(() => assertMemoryPolicyPromptContract(invalid)).toThrow(
      "memory policy prompt contract violation",
    )
  })
})
