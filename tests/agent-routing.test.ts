import { describe, expect, it } from "vitest"

import { DEFAULT_CONFIG } from "../src/config/index.js"
import {
  AGENT_DEFINITIONS,
  CORE_AGENT_ROLES,
  resolveAgentRoute,
} from "../src/agents/index.js"

describe("agent routing", () => {
  it("defines 9 required agent roles", () => {
    expect(CORE_AGENT_ROLES).toEqual([
      "orchestrator",
      "plan",
      "architect",
      "critic",
      "researcher",
      "developer",
      "tester",
      "reviewer",
      "documenter",
    ])
  })

  it("maps developer to STANDARD tier with default model", () => {
    const route = resolveAgentRoute("developer")

    expect(route.tier).toBe("STANDARD")
    expect(route.model).toBe(DEFAULT_CONFIG.models.standard)
    expect(route.reasoningEffort).toBe("medium")
  })

  it("maps architect to THOROUGH tier with default model", () => {
    const route = resolveAgentRoute("architect")

    expect(route.tier).toBe("THOROUGH")
    expect(route.model).toBe(DEFAULT_CONFIG.models.thorough)
    expect(route.reasoningEffort).toBe("high")
  })

  it("maps researcher to THOROUGH tier with default model", () => {
    const route = resolveAgentRoute("researcher")

    expect(route.tier).toBe("THOROUGH")
    expect(route.model).toBe(DEFAULT_CONFIG.models.thorough)
    expect(route.reasoningEffort).toBe("high")
  })

  it("applies model overrides from config", () => {
    const route = resolveAgentRoute("tester", {
      ...DEFAULT_CONFIG,
      models: {
        ...DEFAULT_CONFIG.models,
        standard: "openai/gpt-5.3-codex-mini",
      },
    })

    expect(route.model).toBe("openai/gpt-5.3-codex-mini")
  })

  it("keeps role metadata in AGENT_DEFINITIONS", () => {
    expect(AGENT_DEFINITIONS.plan.kind).toBe("core")
    expect(AGENT_DEFINITIONS.architect.kind).toBe("planning-sub")
    expect(AGENT_DEFINITIONS.critic.kind).toBe("planning-sub")
    expect(AGENT_DEFINITIONS.researcher.kind).toBe("core")
    expect(AGENT_DEFINITIONS.documenter.kind).toBe("core")
  })
})
