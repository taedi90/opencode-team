import { describe, expect, it } from "vitest"

import {
  assertStageArtifactContract,
  validateStageArtifactContract,
} from "../src/pipeline/artifact-contract.js"

const HANDOFF = {
  currentStatus: "ok",
  changedFiles: [],
  openRisks: [],
  nextAction: "continue",
}

describe("stage artifact contract", () => {
  it("accepts valid requirements artifacts", () => {
    const result = validateStageArtifactContract("requirements", {
      requirementsTask: "implement foo",
      systemInstructions: "rules",
      systemInstructionSource: "builtin",
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("rejects planning artifacts without adrDrivers", () => {
    const result = validateStageArtifactContract("planning", {
      adrDecision: "choose option a",
      adrDrivers: [],
      handoff: HANDOFF,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("planning.adrDrivers must be a non-empty string array")
  })

  it("rejects issue artifacts without issueNumber or issueDraft", () => {
    const result = validateStageArtifactContract("issue", {
      titleOnly: true,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("issue stage requires issueNumber or issueDraft(title/body)")
  })

  it("accepts valid development execution artifacts", () => {
    const result = validateStageArtifactContract("development", {
      implementationPlan: "impl",
      testingPlan: ["npm test"],
      developmentExecution: {
        mode: "script",
        scriptName: "opencode:develop",
        changedFiles: ["src/index.ts"],
        changeCount: 1,
      },
      handoff: HANDOFF,
    })

    expect(result.valid).toBe(true)
  })

  it("rejects development artifacts without developmentExecution", () => {
    const result = validateStageArtifactContract("development", {
      implementationPlan: "impl",
      testingPlan: ["npm test"],
      handoff: HANDOFF,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("development.developmentExecution must be an object")
  })

  it("rejects development artifacts when changedFiles include directory paths", () => {
    const result = validateStageArtifactContract("development", {
      implementationPlan: "impl",
      testingPlan: ["npm test"],
      developmentExecution: {
        mode: "script",
        scriptName: "opencode:develop",
        changedFiles: ["src/"],
        changeCount: 1,
      },
      handoff: HANDOFF,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("development.developmentExecution.changedFiles must contain file paths only")
  })

  it("accepts issue artifacts with issueDraft", () => {
    const result = validateStageArtifactContract("issue", {
      issueDraft: {
        title: "Task: update pipeline",
        body: "details",
      },
    })

    expect(result.valid).toBe(true)
  })

  it("throws when stage artifacts violate contract", () => {
    expect(() => {
      assertStageArtifactContract("merge", {
        mergeReady: "yes",
        handoff: HANDOFF,
      })
    }).toThrow("Invalid stage artifact contract for merge")
  })

  it("rejects missing handoff for testing stage", () => {
    const result = validateStageArtifactContract("testing", {
      verificationPassed: true,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("testing.handoff must be an object")
  })
})
