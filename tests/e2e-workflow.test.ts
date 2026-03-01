import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { runConsensusPlanning } from "../src/planning/index.js"
import {
  runGithubAutomation,
  type GithubAutomationAdapter,
} from "../src/github/automation.js"
import { runRalphLoop } from "../src/execution/ralph-loop.js"
import { runUltrawork } from "../src/execution/ultrawork.js"
import { runWorkflow } from "../src/pipeline/orchestrator.js"

let tempDir = ""

const HANDOFF = {
  currentStatus: "ok",
  changedFiles: [],
  openRisks: [],
  nextAction: "continue",
}

async function createTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "opencode-team-e2e-"))
  return tempDir
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ""
  }
})

function createMockAdapter(): GithubAutomationAdapter {
  return {
    createIssue: async () => ({ number: 501, url: "https://example.com/issues/501" }),
    createBranch: async ({ name }) => ({ name }),
    createPullRequest: async () => ({ number: 601, url: "https://example.com/pull/601" }),
    mergePullRequest: async () => ({ merged: true }),
  }
}

describe("e2e workflow", () => {
  it("runs planning -> ultrawork -> ralph -> github merge pipeline", async () => {
    const workingDirectory = await createTempDir()
    const adapter = createMockAdapter()

    const result = await runWorkflow(
      {
        task: "ship workflow",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementReady: true, requirementsTask: "ship workflow" },
          }),
          planning: async () => {
            const plan = await runConsensusPlanning({ problem: "ship workflow" })
            if (plan.status !== "approved") {
              return {
                status: "failed",
                error: "planning failed",
              }
            }

            return {
              status: "completed",
              artifacts: {
                adrDecision: plan.adr.decision,
                adrDrivers: plan.adr.drivers,
                handoff: HANDOFF,
              },
            }
          },
          issue: async () => ({
            status: "completed",
            artifacts: {
              issueNumber: 501,
            },
          }),
          development: async () => {
            const execution = await runUltrawork([
              {
                id: "impl",
                run: async () => ({ status: "completed", output: { implDone: true } }),
              },
              {
                id: "tests",
                dependsOn: ["impl"],
                run: async () => ({ status: "completed", output: { testsAdded: true } }),
              },
            ])

            if (execution.status !== "completed") {
              return {
                status: "failed",
                error: execution.error ?? "ultrawork failed",
              }
            }

            return {
              status: "completed",
              artifacts: {
                ...execution.outputs,
                implementationPlan: "workflow implementation",
                testingPlan: ["npm test"],
                developmentExecution: {
                  mode: "script",
                  scriptName: "opencode:develop",
                  changedFiles: ["src/workflow.ts"],
                  changeCount: 1,
                },
                handoff: HANDOFF,
              },
            }
          },
          testing: async () => {
            const verify = await runRalphLoop(
              async () => ({
                signals: {
                  todosDone: true,
                  testsPassed: true,
                  buildPassed: true,
                  reviewApproved: true,
                },
              }),
              {
                maxIterations: 3,
              },
            )

            if (verify.status !== "completed") {
              return {
                status: "failed",
                error: verify.reason,
              }
            }

            return {
              status: "completed",
              artifacts: {
                verified: true,
                verificationPassed: true,
                handoff: HANDOFF,
              },
            }
          },
          merge: async ({ artifacts }) => {
            const automation = await runGithubAutomation(
              adapter,
              {
                workingDirectory,
                issueTitle: "workflow issue",
                issueBody: "workflow body",
                branchName: "task/501-workflow",
                prTitle: "workflow pr",
                summary: [String(artifacts.adrDecision ?? "adr")],
                verification: ["npm test", "npm run typecheck", "npm run build"],
              },
              {
                requireUserApproval: false,
              },
            )

            return {
              status: "completed",
              artifacts: {
                merged: automation.merged,
                mergeDecision: automation.mergeDecision,
                mergeReady: true,
                handoff: HANDOFF,
              },
            }
          },
        },
      },
    )

    expect(result.status).toBe("completed")
    expect(result.artifacts.merged).toBe(true)
    expect(result.artifacts.mergeDecision).toBe("auto_merged")
  })

  it("provides an operator guide document for manual verification", async () => {
    const content = await readFile("docs/user-guide.md", "utf8")
    expect(content).toContain("# 사용자 가이드")
    expect(content).toContain("## 2) 원샷 orchestrator")
    expect(content).toContain("## 6) Merge Policy")
    expect(content).toContain("## 7) MCP / Tool Policy")
    expect(content).toContain("## 10) 트러블슈팅")
  })

  it("recovers from one planning contract failure and proceeds", async () => {
    const workingDirectory = await createTempDir()
    let draftAttempts = 0

    const result = await runWorkflow(
      {
        task: "recover planning contract",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementsTask: "recover planning contract" },
          }),
          planning: async () => {
            const plan = await runConsensusPlanning(
              { problem: "recover planning contract" },
              {
                contractRetries: 1,
                hooks: {
                  createDraft: async () => {
                    draftAttempts += 1
                    if (draftAttempts === 1) {
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
                      } as never
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
                },
              },
            )

            if (plan.status !== "approved") {
              return {
                status: "failed",
                error: plan.lastRejectReasons.join(", "),
              }
            }

            return {
              status: "completed",
              artifacts: {
                adrDecision: plan.adr.decision,
                adrDrivers: plan.adr.drivers,
                handoff: HANDOFF,
              },
            }
          },
        },
      },
    )

    expect(result.status).toBe("completed")
    expect(draftAttempts).toBe(2)
  })

  it("fails with decision_invalid on unrecoverable critic contract error", async () => {
    const workingDirectory = await createTempDir()

    const result = await runWorkflow(
      {
        task: "critic decision invalid",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementsTask: "critic decision invalid" },
          }),
          planning: async () => {
            const plan = await runConsensusPlanning(
              { problem: "critic decision invalid" },
              {
                contractRetries: 0,
                hooks: {
                  reviewCritic: async () => ({
                    decision: "maybe",
                    handoff: HANDOFF,
                  } as never),
                },
              },
            )

            if (plan.status !== "approved") {
              return {
                status: "failed",
                error: plan.lastRejectReasons.join(", "),
              }
            }

            return {
              status: "completed",
              artifacts: {
                adrDecision: plan.adr.decision,
                adrDrivers: plan.adr.drivers,
                handoff: HANDOFF,
              },
            }
          },
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(String(result.error)).toContain("decision_invalid")
  })
})
