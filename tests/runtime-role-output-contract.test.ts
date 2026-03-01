import { describe, expect, it } from "vitest"

import {
  buildRoleOutputEnvelope,
  parseWithRuntimeContractRetry,
  validateRuntimeHandoff,
} from "../src/runtime/role-output-contract.js"

describe("runtime role output contract", () => {
  it("validates handoff payload", () => {
    const result = validateRuntimeHandoff({
      currentStatus: "ok",
      changedFiles: ["src/a.ts"],
      openRisks: [],
      nextAction: "continue",
    })

    expect(result.valid).toBe(true)
  })

  it("retries parse and succeeds on second attempt", async () => {
    let attempts = 0
    const result = await parseWithRuntimeContractRetry({
      role: "critic",
      retries: 1,
      producer: async () => {
        attempts += 1
        if (attempts === 1) {
          return { invalid: true }
        }
        return {
          currentStatus: "ok",
          changedFiles: [],
          openRisks: [],
          nextAction: "continue",
        }
      },
      validate: validateRuntimeHandoff,
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
  })

  it("fails with error after retries are exhausted", async () => {
    const result = await parseWithRuntimeContractRetry({
      role: "critic",
      retries: 1,
      producer: async () => ({ invalid: true }),
      validate: validateRuntimeHandoff,
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("handoff_missing")
    expect(result.attempts).toBe(2)
  })

  it("does not retry non-retriable contract errors", async () => {
    const result = await parseWithRuntimeContractRetry({
      role: "critic",
      retries: 3,
      retryPolicy: {
        nonRetriableCodes: ["handoff_missing"],
      },
      producer: async () => ({ invalid: true }),
      validate: validateRuntimeHandoff,
    })

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.error?.code).toBe("handoff_missing")
  })

  it("builds standardized role output envelope", () => {
    const handoff = {
      currentStatus: "approve",
      changedFiles: [],
      openRisks: [],
      nextAction: "continue",
    }

    const envelope = buildRoleOutputEnvelope({
      role: "critic",
      payload: { decision: "approve" },
      handoff,
      attempts: 2,
      maxAttempts: 3,
      decision: "approve",
      evidence: ["all checks green"],
    })

    expect(envelope.role).toBe("critic")
    expect(envelope.status).toBe("ok")
    expect(envelope.retry.attempts).toBe(2)
    expect(envelope.handoff.currentStatus).toBe("approve")
  })
})
