import { describe, expect, it } from "vitest"

import {
  assertModeStateContract,
  resolveModeStateFilePath,
  validateModeStateContract,
  type ModeState,
} from "../src/runtime/mode-state-contract.js"

describe("mode state contract", () => {
  it("accepts a valid active ralph state", () => {
    const state: ModeState = {
      version: 1,
      mode: "ralph",
      sessionId: "session-1",
      active: true,
      currentPhase: "executing",
      startedAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:01:00.000Z",
      iteration: 2,
      maxIterations: 10,
    }

    const result = validateModeStateContract(state)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("rejects phase not allowed by mode", () => {
    const result = validateModeStateContract({
      version: 1,
      mode: "ultrawork",
      sessionId: "session-1",
      active: true,
      currentPhase: "requirements",
      startedAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:01:00.000Z",
    })

    expect(result.valid).toBe(false)
    expect(result.errors.join(" ")).toContain("currentPhase is not allowed")
  })

  it("rejects active ralph state without iteration fields", () => {
    const result = validateModeStateContract({
      version: 1,
      mode: "ralph",
      sessionId: "session-1",
      active: true,
      currentPhase: "executing",
      startedAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:01:00.000Z",
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("ralph active state requires iteration")
    expect(result.errors).toContain("ralph active state requires maxIterations")
  })

  it("rejects terminal phase with active=true", () => {
    const result = validateModeStateContract({
      version: 1,
      mode: "orchestrator",
      sessionId: "session-1",
      active: true,
      currentPhase: "complete",
      startedAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:01:00.000Z",
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("terminal currentPhase requires active=false")
    expect(result.errors).toContain("terminal currentPhase requires completedAt")
  })

  it("throws when asserting an invalid state", () => {
    expect(() => {
      assertModeStateContract({
        version: 1,
        mode: "ralph",
        sessionId: "session-1",
        active: true,
        currentPhase: "executing",
        startedAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:01:00.000Z",
      })
    }).toThrow("Invalid mode state contract")
  })

  it("resolves session scoped state file path", () => {
    const path = resolveModeStateFilePath({
      workspaceRoot: "/workspace/project",
      sessionId: "session-123",
      mode: "ralph",
    })

    expect(path).toBe(
      "/workspace/project/.agent-guide/runtime/state/sessions/session-123/ralph-state.json",
    )
  })
})
