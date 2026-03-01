import { describe, expect, it } from "vitest"

import { CORE_AGENT_ROLES } from "../src/agents/index.js"
import { DEFAULT_CONFIG } from "../src/config/index.js"
import { EXECUTION_FEATURES } from "../src/execution/index.js"
import { GITHUB_AUTOMATION_STAGES } from "../src/github/index.js"
import { WORKFLOW_STAGES } from "../src/pipeline/index.js"

describe("bootstrap contracts", () => {
  it("defines core workflow stages", () => {
    expect(WORKFLOW_STAGES).toEqual([
      "requirements",
      "planning",
      "issue",
      "development",
      "testing",
      "merge",
    ])
  })

  it("uses merge policy B by default", () => {
    expect(DEFAULT_CONFIG.merge_policy.require_user_approval).toBe(true)
  })

  it("defines core and planning agents", () => {
    expect(CORE_AGENT_ROLES).toEqual([
      "orchestrator",
      "plan",
      "architect",
      "critic",
      "researcher",
      "developer",
      "tester",
      "reviewer",
    ])
  })

  it("exposes execution and github stage placeholders", () => {
    expect(EXECUTION_FEATURES).toEqual(["ultrawork", "ralph_loop"])
    expect(GITHUB_AUTOMATION_STAGES).toEqual([
      "create_issue",
      "create_branch",
      "create_pr",
      "merge",
    ])
  })
})
