import { describe, expect, it } from "vitest"

import { createScriptedSubagentExecutor } from "../src/pipeline/subagent-executor.js"

describe("scripted subagent executor", () => {
  it("retries transient failures up to maxRetries", async () => {
    const executor = createScriptedSubagentExecutor()
    let attempt = 0

    const result = await executor({
      role: "researcher",
      stage: "requirements",
      nodeId: "requirements:researcher:retry",
      sessionId: "session-retry",
      workspaceRoot: "/tmp/workspace",
      model: "gpt-5",
      reasoningEffort: "medium",
      instructions: "test",
      maxRetries: 1,
      context: {
        requestedTools: ["read"],
        execute: async () => {
          attempt += 1
          if (attempt === 1) {
            throw new Error("temporary failure")
          }

          return {
            decision: "context_collected",
            payload: { ok: true },
            handoff: {
              currentStatus: "ready",
              changedFiles: [],
              openRisks: [],
              nextAction: "continue",
            },
          }
        },
      },
    })

    expect(result.status).toBe("success")
    expect(result.attempts).toBe(2)
    expect(result.errorCode).toBeUndefined()
  })

  it("returns timeout status when timeout is exceeded", async () => {
    const executor = createScriptedSubagentExecutor()

    const result = await executor({
      role: "developer",
      stage: "development",
      nodeId: "development:developer:timeout",
      sessionId: "session-timeout",
      workspaceRoot: "/tmp/workspace",
      model: "gpt-5",
      reasoningEffort: "medium",
      instructions: "test",
      timeoutMs: 5,
      maxRetries: 1,
      context: {
        execute: async () => await new Promise(() => {
        }),
      },
    })

    expect(result.status).toBe("timeout")
    expect(result.errorCode).toBe("timeout")
    expect(result.attempts).toBe(2)
    expect(result.decision).toBe("request_changes")
  })
})
