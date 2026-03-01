import { describe, expect, it } from "vitest"

import { WORKFLOW_STAGE_AGENT_GRAPH, resolveStageAgentSequence } from "../src/pipeline/agent-graph.js"

describe("workflow stage agent graph", () => {
  it("maps each stage to required agent sequence", () => {
    expect(WORKFLOW_STAGE_AGENT_GRAPH).toEqual({
      requirements: ["orchestrator", "researcher"],
      planning: ["plan", "architect", "critic"],
      issue: ["orchestrator"],
      development: ["developer", "documenter"],
      testing: ["tester"],
      merge: ["reviewer", "orchestrator"],
    })
  })

  it("returns a copy of stage sequence", () => {
    const sequence = resolveStageAgentSequence("development")
    sequence.push("developer")

    expect(resolveStageAgentSequence("development")).toEqual(["developer", "documenter"])
  })
})
