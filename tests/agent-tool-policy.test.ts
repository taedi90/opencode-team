import { describe, expect, it } from "vitest"

import {
  DEFAULT_CONFIG,
  type OpenCodeTeamConfig,
} from "../src/config/index.js"
import {
  createToolPolicyAuditLog,
  evaluateToolAccess,
  resolveAgentToolPolicy,
} from "../src/runtime/agent-tool-policy.js"

describe("agent tool policy", () => {
  it("allows tools in allowlist", () => {
    const decision = evaluateToolAccess({
      agentRole: "developer",
      toolName: "bash",
    })

    expect(decision.allowed).toBe(true)
    expect(decision.reason_code).toBe("allowed")
    expect(decision.policy_source).toBe("default")
  })

  it("rejects explicitly denied tools", () => {
    const decision = evaluateToolAccess({
      agentRole: "reviewer",
      toolName: "bash",
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason_code).toBe("tool_explicitly_denied")
  })

  it("rejects unknown agents", () => {
    const decision = evaluateToolAccess({
      agentRole: "unknown-agent",
      toolName: "read",
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason_code).toBe("agent_unknown")
  })

  it("resolves config source when policy is overridden", () => {
    const overridden: OpenCodeTeamConfig = {
      ...DEFAULT_CONFIG,
      agent_tools: {
        ...DEFAULT_CONFIG.agent_tools,
        reviewer: {
          allow: ["read", "bash"],
          deny: [],
        },
      },
    }

    const policy = resolveAgentToolPolicy("reviewer", overridden)
    expect(policy.source).toBe("config")

    const decision = evaluateToolAccess({
      agentRole: "reviewer",
      toolName: "bash",
      config: overridden,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.policy_source).toBe("config")
  })

  it("creates audit log with required fields", () => {
    const decision = evaluateToolAccess({
      agentRole: "plan",
      toolName: "github",
      now: "2026-03-01T10:00:00.000Z",
    })

    const log = createToolPolicyAuditLog(decision, {
      sessionId: "session-1",
      stage: "planning",
    })

    expect(log.reason_code).toBe("tool_explicitly_denied")
    expect(log.agent).toBe("plan")
    expect(log.tool).toBe("github")
    expect(log.policy_source).toBe("default")
    expect(log.session_id).toBe("session-1")
    expect(log.stage).toBe("planning")
  })

  it("allows researcher web tools and blocks write tools", () => {
    const webSearch = evaluateToolAccess({
      agentRole: "researcher",
      toolName: "web_search",
    })
    const context7 = evaluateToolAccess({
      agentRole: "researcher",
      toolName: "context7_query-docs",
    })
    const write = evaluateToolAccess({
      agentRole: "researcher",
      toolName: "write",
    })

    expect(webSearch.allowed).toBe(true)
    expect(context7.allowed).toBe(true)
    expect(write.allowed).toBe(false)
    expect(write.reason_code).toBe("tool_explicitly_denied")
  })
})
