import { describe, expect, it } from "vitest"

import {
  applyCancelModeContract,
  type ModeState,
} from "../src/runtime/mode-state-contract.js"

function activeState(input: {
  mode: "orchestrator" | "ultrawork" | "ralph"
  sessionId: string
  currentPhase: string
  linkedMode?: "orchestrator" | "ultrawork" | "ralph"
}): ModeState {
  return {
    version: 1,
    mode: input.mode,
    sessionId: input.sessionId,
    active: true,
    currentPhase: input.currentPhase,
    startedAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...(input.linkedMode ? { linkedMode: input.linkedMode } : {}),
  }
}

describe("cancel contract", () => {
  it("cancels linked ultrawork before ralph in the same session", () => {
    const states: ModeState[] = [
      activeState({ mode: "ultrawork", sessionId: "s1", currentPhase: "executing" }),
      activeState({ mode: "ralph", sessionId: "s1", currentPhase: "verifying", linkedMode: "ultrawork" }),
    ]

    const result = applyCancelModeContract(states, {
      targetMode: "ralph",
      sessionId: "s1",
      now: "2026-03-01T00:10:00.000Z",
    })

    expect(result.cancelledModes).toEqual(["ultrawork", "ralph"])

    const ultrawork = result.states.find((item) => item.mode === "ultrawork")
    const ralph = result.states.find((item) => item.mode === "ralph")

    expect(ultrawork?.active).toBe(false)
    expect(ultrawork?.currentPhase).toBe("cancelled")
    expect(ralph?.active).toBe(false)
    expect(ralph?.currentPhase).toBe("cancelled")
    expect(ralph?.linkedModeTerminalPhase).toBe("cancelled")
    expect(ralph?.linkedModeTerminalAt).toBe("2026-03-01T00:10:00.000Z")
  })

  it("cancels orchestrator session in fixed order", () => {
    const states: ModeState[] = [
      activeState({ mode: "orchestrator", sessionId: "s1", currentPhase: "planning" }),
      activeState({ mode: "ultrawork", sessionId: "s1", currentPhase: "executing" }),
      activeState({ mode: "ralph", sessionId: "s1", currentPhase: "fixing" }),
    ]

    const result = applyCancelModeContract(states, {
      targetMode: "orchestrator",
      sessionId: "s1",
      now: "2026-03-01T00:20:00.000Z",
    })

    expect(result.cancelledModes).toEqual(["ultrawork", "ralph", "orchestrator"])
    for (const state of result.states) {
      expect(state.active).toBe(false)
      expect(state.currentPhase).toBe("cancelled")
      expect(state.completedAt).toBe("2026-03-01T00:20:00.000Z")
    }
  })

  it("does not mutate unrelated sessions", () => {
    const states: ModeState[] = [
      activeState({ mode: "orchestrator", sessionId: "target", currentPhase: "planning" }),
      activeState({ mode: "ultrawork", sessionId: "other", currentPhase: "executing" }),
    ]

    const result = applyCancelModeContract(states, {
      targetMode: "orchestrator",
      sessionId: "target",
      now: "2026-03-01T00:30:00.000Z",
    })

    const target = result.states.find((item) => item.sessionId === "target")
    const other = result.states.find((item) => item.sessionId === "other")

    expect(target?.active).toBe(false)
    expect(target?.currentPhase).toBe("cancelled")
    expect(other?.active).toBe(true)
    expect(other?.currentPhase).toBe("executing")
    expect(other?.completedAt).toBeUndefined()
  })
})
