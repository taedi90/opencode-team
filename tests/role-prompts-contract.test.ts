import { describe, expect, it } from "vitest"

import { loadRoleSystemPrompt } from "../src/agents/prompt-loader.js"
import type { CoreAgentRole } from "../src/agents/index.js"

const ROLES: CoreAgentRole[] = [
  "orchestrator",
  "plan",
  "architect",
  "critic",
  "developer",
  "tester",
  "reviewer",
  "researcher",
  "documenter",
]

const ROLE_SPECIFIC_MARKERS: Record<CoreAgentRole, string[]> = {
  orchestrator: ["stage status", "pending|running|completed|failed"],
  plan: ["selected option ID", "acceptance criteria"],
  architect: ["Antithesis", "Trade-offs"],
  critic: ["exactly `approve` or `reject`", "Required Fixes"],
  developer: ["executed commands", "Validation"],
  tester: ["Execution Evidence", "pass/fail outcomes"],
  reviewer: ["approve` or `request_changes`", "Gate Decision"],
  researcher: ["verified` or `assumption`", "Sources"],
  documenter: ["doc coverage matrix", "source-of-truth"],
}

describe("role prompt contract", () => {
  it("ensures all role prompts contain required output and handoff sections", async () => {
    for (const role of ROLES) {
      const prompt = await loadRoleSystemPrompt(role)
      expect(prompt.content).toContain("## Required Output")
      expect(prompt.content).toContain("## Do Not")
      expect(prompt.content).toContain("## Handoff")

      for (const marker of ROLE_SPECIFIC_MARKERS[role]) {
        expect(prompt.content).toContain(marker)
      }
    }
  })
})
