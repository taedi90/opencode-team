import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, it } from "vitest"

import {
  classifyPlanningRisk,
  runConsensusPlanning,
  type ConsensusPlanningHooks,
} from "../src/planning/index.js"

let planningTempRoot = ""

const HANDOFF = {
  currentStatus: "ok",
  changedFiles: [],
  openRisks: [],
  nextAction: "continue",
}

async function createPlanningTempRoot(): Promise<string> {
  planningTempRoot = await mkdtemp(join(tmpdir(), "opencode-team-planning-"))
  return planningTempRoot
}

describe("consensus planning", () => {
  it("runs planner -> architect -> critic in strict sequence", async () => {
    const order: string[] = []

    const hooks: ConsensusPlanningHooks = {
      createDraft: async () => {
        order.push("planner")
        return {
          principles: ["p1", "p2", "p3"],
          decisionDrivers: ["d1", "d2", "d3"],
          alternatives: [
            { id: "a", summary: "option a", pros: ["p"], cons: ["c"] },
            { id: "b", summary: "option b", pros: ["p"], cons: ["c"] },
          ],
          selectedOptionId: "a",
          acceptanceCriteria: ["ac1"],
          verificationPlan: ["verify-1"],
          handoff: HANDOFF,
        }
      },
      reviewArchitecture: async () => {
        order.push("architect")
        return {
          antithesis: "strong counter",
          tradeoffTension: "speed vs safety",
          synthesis: "balanced",
          handoff: HANDOFF,
        }
      },
      reviewCritic: async () => {
        order.push("critic")
        return { decision: "approve", handoff: HANDOFF }
      },
    }

    const result = await runConsensusPlanning(
      {
        problem: "ship feature",
      },
      {
        hooks,
      },
    )

    expect(order).toEqual(["planner", "architect", "critic"])
    expect(result.status).toBe("approved")
  })

  it("retries up to max iterations when critic rejects", async () => {
    let criticCallCount = 0

    const hooks: ConsensusPlanningHooks = {
      createDraft: async () => ({
        principles: ["p1", "p2", "p3"],
        decisionDrivers: ["d1", "d2", "d3"],
        alternatives: [
          { id: "a", summary: "option a", pros: ["p"], cons: ["c"] },
          { id: "b", summary: "option b", pros: ["p"], cons: ["c"] },
        ],
        selectedOptionId: "a",
        acceptanceCriteria: ["ac1"],
        verificationPlan: ["verify-1"],
        handoff: HANDOFF,
      }),
      reviewArchitecture: async () => ({
        antithesis: "strong counter",
        tradeoffTension: "speed vs safety",
        synthesis: "balanced",
        handoff: HANDOFF,
      }),
      reviewCritic: async () => {
        criticCallCount += 1
        if (criticCallCount < 3) {
          return { decision: "reject", reasons: ["alternatives too shallow"], handoff: HANDOFF }
        }
        return { decision: "approve", handoff: HANDOFF }
      },
    }

    const result = await runConsensusPlanning(
      {
        problem: "ship feature",
      },
      {
        hooks,
        maxIterations: 5,
      },
    )

    expect(result.status).toBe("approved")
    expect(result.iterations).toBe(3)
  })

  it("fails with reason when max iterations are exhausted", async () => {
    const hooks: ConsensusPlanningHooks = {
      createDraft: async () => ({
        principles: ["p1", "p2", "p3"],
        decisionDrivers: ["d1", "d2", "d3"],
        alternatives: [
          { id: "a", summary: "option a", pros: ["p"], cons: ["c"] },
          { id: "b", summary: "option b", pros: ["p"], cons: ["c"] },
        ],
        selectedOptionId: "a",
        acceptanceCriteria: ["ac1"],
        verificationPlan: ["verify-1"],
        handoff: HANDOFF,
      }),
      reviewArchitecture: async () => ({
        antithesis: "strong counter",
        tradeoffTension: "speed vs safety",
        handoff: HANDOFF,
      }),
      reviewCritic: async () => ({
        decision: "reject",
        reasons: ["verification plan is weak"],
        handoff: HANDOFF,
      }),
    }

    const result = await runConsensusPlanning(
      {
        problem: "ship feature",
      },
      {
        hooks,
        maxIterations: 2,
      },
    )

    expect(result.status).toBe("rejected")
    expect(result.iterations).toBe(2)
    expect(result.lastRejectReasons).toEqual(["verification plan is weak"])
  })

  it("always returns ADR fields on approval", async () => {
    const result = await runConsensusPlanning({
      problem: "ship feature",
    })

    expect(result.status).toBe("approved")
    if (result.status !== "approved") {
      throw new Error("consensus planning must approve default path")
    }

    expect(result.adr.decision.length).toBeGreaterThan(0)
    expect(result.adr.drivers.length).toBeGreaterThan(0)
    expect(result.adr.alternatives.length).toBeGreaterThan(0)
    expect(result.adr.whyChosen.length).toBeGreaterThan(0)
    expect(result.adr.consequences.length).toBeGreaterThan(0)
    expect(result.adr.followUps.length).toBeGreaterThan(0)
  })

  it("writes draft, note, and plan artifacts under .agent-guide", async () => {
    const workspaceRoot = await createPlanningTempRoot()

    const result = await runConsensusPlanning(
      { problem: "persist artifacts" },
      { workspaceRoot, artifactName: "persist-artifacts" },
    )

    expect(result.status).toBe("approved")

    const draftContent = await readFile(
      join(workspaceRoot, ".agent-guide", "drafts", "persist-artifacts-iter-01.json"),
      "utf8",
    )
    const noteContent = await readFile(
      join(workspaceRoot, ".agent-guide", "notes", "persist-artifacts.md"),
      "utf8",
    )
    const planContent = await readFile(
      join(workspaceRoot, ".agent-guide", "plans", "persist-artifacts.md"),
      "utf8",
    )

    expect(draftContent).toContain("\"selectedOptionId\": \"minimal-copy\"")
    expect(draftContent).toContain("\"roleOutputs\"")
    expect(draftContent).toContain("\"role\": \"critic\"")
    expect(noteContent).toContain("## Iteration 1")
    expect(planContent).toContain("## ADR")

    await rm(workspaceRoot, { recursive: true, force: true })
    planningTempRoot = ""
  })

  it("classifies high risk inputs and emits deliberate evidence", async () => {
    expect(classifyPlanningRisk({ problem: "production migration with billing changes" })).toBe("high")

    const result = await runConsensusPlanning({
      problem: "production migration with billing changes",
    })
    expect(result.status).toBe("approved")
    if (result.status !== "approved") {
      return
    }
    expect(result.adr.consequences.join(" ")).toContain("위험도: high")
    expect(result.adr.consequences.join(" ")).toContain("deliberate")
  })

  it("rejects high risk draft when deliberate section is missing", async () => {
    const hooks: ConsensusPlanningHooks = {
      createDraft: async () => ({
        principles: ["p1", "p2", "p3"],
        decisionDrivers: ["d1", "d2", "d3"],
        alternatives: [
          { id: "a", summary: "option a", pros: ["p"], cons: ["c"] },
          { id: "b", summary: "option b", pros: ["p"], cons: ["c"] },
        ],
        selectedOptionId: "a",
        acceptanceCriteria: ["ac1"],
        verificationPlan: ["verify-1"],
        handoff: HANDOFF,
      }),
      reviewArchitecture: async () => ({
        antithesis: "strong counter",
        tradeoffTension: "speed vs safety",
        handoff: HANDOFF,
      }),
      reviewCritic: async ({ riskLevel, draft, validationErrors }) => {
        if (riskLevel === "high" && !draft.deliberate) {
          return {
            decision: "reject",
            reasons: ["high-risk input requires deliberate output"],
            handoff: HANDOFF,
          }
        }
        if (validationErrors.length > 0) {
          return {
            decision: "reject",
            reasons: validationErrors,
            handoff: HANDOFF,
          }
        }
        return { decision: "approve", handoff: HANDOFF }
      },
    }

    const result = await runConsensusPlanning(
      { problem: "delete production table" },
      { hooks, maxIterations: 1 },
    )

    expect(result.status).toBe("rejected")
    expect(result.lastRejectReasons.join(" ")).toContain("high-risk")
  })

  it("retries once when draft contract is invalid then recovers", async () => {
    let attempts = 0
    const hooks: ConsensusPlanningHooks = {
      createDraft: async () => {
        attempts += 1
        if (attempts === 1) {
          return {
            principles: ["p1", "p2", "p3"],
            decisionDrivers: ["d1", "d2", "d3"],
            alternatives: [
              { id: "a", summary: "option a", pros: ["p"], cons: ["c"] },
              { id: "b", summary: "option b", pros: ["p"], cons: ["c"] },
            ],
            selectedOptionId: "a",
            acceptanceCriteria: ["ac1"],
            verificationPlan: ["verify-1"],
          } as unknown as ReturnType<ConsensusPlanningHooks["createDraft"]>
        }

        return {
          principles: ["p1", "p2", "p3"],
          decisionDrivers: ["d1", "d2", "d3"],
          alternatives: [
            { id: "a", summary: "option a", pros: ["p"], cons: ["c"] },
            { id: "b", summary: "option b", pros: ["p"], cons: ["c"] },
          ],
          selectedOptionId: "a",
          acceptanceCriteria: ["ac1"],
          verificationPlan: ["verify-1"],
          handoff: HANDOFF,
        }
      },
      reviewArchitecture: async () => ({
        antithesis: "strong counter",
        tradeoffTension: "speed vs safety",
        handoff: HANDOFF,
      }),
      reviewCritic: async () => ({
        decision: "approve",
        handoff: HANDOFF,
      }),
    }

    const result = await runConsensusPlanning(
      { problem: "recover from contract error" },
      { hooks, contractRetries: 1 },
    )

    expect(result.status).toBe("approved")
    expect(attempts).toBe(2)
  })

  it("rejects with decision_invalid when critic decision is malformed", async () => {
    const hooks: ConsensusPlanningHooks = {
      createDraft: async () => ({
        principles: ["p1", "p2", "p3"],
        decisionDrivers: ["d1", "d2", "d3"],
        alternatives: [
          { id: "a", summary: "option a", pros: ["p"], cons: ["c"] },
          { id: "b", summary: "option b", pros: ["p"], cons: ["c"] },
        ],
        selectedOptionId: "a",
        acceptanceCriteria: ["ac1"],
        verificationPlan: ["verify-1"],
        handoff: HANDOFF,
      }),
      reviewArchitecture: async () => ({
        antithesis: "strong counter",
        tradeoffTension: "speed vs safety",
        handoff: HANDOFF,
      }),
      reviewCritic: async () => ({
        decision: "maybe",
        handoff: HANDOFF,
      } as unknown as ReturnType<ConsensusPlanningHooks["reviewCritic"]>),
    }

    const result = await runConsensusPlanning(
      { problem: "bad critic output" },
      { hooks, contractRetries: 0 },
    )

    expect(result.status).toBe("rejected")
    expect(result.lastRejectReasons.join(" ")).toContain("decision_invalid")
  })
})
