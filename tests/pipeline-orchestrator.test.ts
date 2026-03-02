import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import {
  resolveCommittablePathsFromStatus,
  runWorkflow,
  type StageExecutor,
} from "../src/pipeline/orchestrator.js"
import type { GithubAutomationAdapter } from "../src/github/automation.js"
import {
  createScriptedSubagentExecutor,
  type SubagentExecutor,
} from "../src/pipeline/subagent-executor.js"

const execFileAsync = promisify(execFile)

let tempDir = ""

const HANDOFF = {
  currentStatus: "ok",
  changedFiles: [],
  openRisks: [],
  nextAction: "continue",
}

async function createTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "opencode-team-pipeline-"))
  return tempDir
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ""
  }
})

describe("pipeline orchestrator", () => {
  it("filters generated and untracked non-code files from commit candidates", () => {
    const status = [
      " M src/runtime/mode-operations.ts",
      " D tests/obsolete.test.ts",
      "?? src/runtime/new-helper.ts",
      "?? docs/internal-notes.md",
      "?? .agent-guide/runtime/state/sessions/s1/workflow-state.json",
    ].join("\n")

    const paths = resolveCommittablePathsFromStatus(status)
    expect(paths).toContain("src/runtime/mode-operations.ts")
    expect(paths).toContain("tests/obsolete.test.ts")
    expect(paths).toContain("src/runtime/new-helper.ts")
    expect(paths).not.toContain("docs/internal-notes.md")
    expect(paths).not.toContain(".agent-guide/runtime/state/sessions/s1/workflow-state.json")
  })

  it("respects preferred commit paths when provided", () => {
    const status = [
      " M src/a.ts",
      " M src/b.ts",
      "?? src/c.ts",
    ].join("\n")

    const paths = resolveCommittablePathsFromStatus(status, ["src/b.ts"])
    expect(paths).toEqual(["src/b.ts"])
  })

  it("runs all stages in fixed order", async () => {
    const workingDirectory = await createTempDir()
    const order: string[] = []

    const executors: Partial<Record<string, StageExecutor>> = {
      requirements: async () => {
        order.push("requirements")
        return { status: "completed", artifacts: { req: "ok", requirementsTask: "build feature" } }
      },
      planning: async ({ artifacts }) => {
        order.push("planning")
        return {
          status: "completed",
          artifacts: {
            fromReq: artifacts.req,
            adrDecision: "use req",
            adrDrivers: ["driver-1"],
            handoff: HANDOFF,
          },
        }
      },
      issue: async () => {
        order.push("issue")
        return { status: "completed", artifacts: { issueNumber: 1 } }
      },
      development: async () => {
        order.push("development")
        return {
          status: "completed",
          artifacts: {
            implementationPlan: "impl",
            testingPlan: ["npm test"],
            developmentExecution: {
              mode: "script",
              scriptName: "opencode:develop",
              changedFiles: ["src/index.ts"],
              changeCount: 1,
            },
            handoff: HANDOFF,
          },
        }
      },
      testing: async () => {
        order.push("testing")
        return { status: "completed", artifacts: { verificationPassed: true, handoff: HANDOFF } }
      },
      merge: async () => {
        order.push("merge")
        return { status: "completed", artifacts: { mergeReady: true, handoff: HANDOFF } }
      },
    }

    const result = await runWorkflow(
      {
        task: "build feature",
        workingDirectory,
      },
      {
        executors,
      },
    )

    expect(result.status).toBe("completed")
    expect(order).toEqual([
      "requirements",
      "planning",
      "issue",
      "development",
      "testing",
      "merge",
    ])
    expect(result.artifacts.req).toBe("ok")
    expect(result.artifacts.fromReq).toBe("ok")
  })

  it("stops and persists failed stage", async () => {
    const workingDirectory = await createTempDir()

    const result = await runWorkflow(
      {
        task: "build feature",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({ status: "completed", artifacts: { requirementsTask: "build feature" } }),
          planning: async () => ({
            status: "completed",
            artifacts: {
              adrDecision: "decision",
              adrDrivers: ["driver"],
              handoff: HANDOFF,
            },
          }),
          issue: async () => ({ status: "completed", artifacts: { issueNumber: 101 } }),
          development: async () => ({
            status: "failed",
            error: "compile error",
          }),
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(result.failedStage).toBe("development")
    expect(result.error).toBe("compile error")

    const stateRaw = await readFile(result.stateFilePath, "utf8")
    expect(stateRaw).toContain("\"failedStage\": \"development\"")
  })

  it("policy_disabled: fails when auto profile is requested but policy is disabled", async () => {
    const workingDirectory = await createTempDir()
    await mkdir(join(workingDirectory, ".opencode"), { recursive: true })
    await writeFile(
      join(workingDirectory, ".opencode", "opencode-team.json"),
      `${JSON.stringify({ workflow: { policy_enabled: false } }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "policy disabled run",
        workingDirectory,
      },
      {
        workflowProfile: "auto",
        executors: {
          requirements: async () => ({ status: "completed", artifacts: { requirementsTask: "policy disabled run" } }),
          planning: async () => ({ status: "completed", artifacts: { adrDecision: "decision", adrDrivers: ["driver"], handoff: HANDOFF } }),
          issue: async () => ({ status: "completed", artifacts: { issueNumber: 501 } }),
          development: async () => ({
            status: "completed",
            artifacts: {
              implementationPlan: "impl",
              testingPlan: [],
              developmentExecution: {
                mode: "dry_run",
                scriptName: null,
                changedFiles: [],
                changeCount: 0,
              },
              handoff: HANDOFF,
            },
          }),
          testing: async () => ({ status: "completed", artifacts: { verificationPassed: true, handoff: HANDOFF } }),
          merge: async () => ({ status: "completed", artifacts: { mergeReady: false, handoff: HANDOFF } }),
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(String(result.error)).toContain("policy_disabled")
  })

  it("policy: persists explain + planHash and appends structured policy decision log", async () => {
    const workingDirectory = await createTempDir()
    await mkdir(join(workingDirectory, ".opencode"), { recursive: true })
    await writeFile(
      join(workingDirectory, ".opencode", "opencode-team.json"),
      `${JSON.stringify({ workflow: { policy_enabled: true } }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "policy enabled run",
        workingDirectory,
      },
      {
        workflowProfile: "auto",
        executors: {
          requirements: async () => ({ status: "completed", artifacts: { requirementsTask: "policy enabled run" } }),
          planning: async () => ({ status: "completed", artifacts: { adrDecision: "decision", adrDrivers: ["driver"], handoff: HANDOFF } }),
          issue: async () => ({ status: "completed", artifacts: { issueNumber: 502 } }),
          development: async () => ({
            status: "completed",
            artifacts: {
              implementationPlan: "impl",
              testingPlan: [],
              developmentExecution: {
                mode: "dry_run",
                scriptName: null,
                changedFiles: [],
                changeCount: 0,
              },
              handoff: HANDOFF,
            },
          }),
          testing: async () => ({ status: "completed", artifacts: { verificationPassed: true, handoff: HANDOFF } }),
          merge: async () => ({ status: "completed", artifacts: { mergeReady: false, handoff: HANDOFF } }),
        },
      },
    )

    expect(result.status).toBe("completed")
    const state = JSON.parse(await readFile(result.stateFilePath, "utf8")) as {
      workflowPolicyExplain?: { signals?: string[]; reasons?: string[] }
      workflowExecutionPlan?: { planHash?: string }
    }
    expect(state.workflowPolicyExplain?.signals?.length).toBeGreaterThan(0)
    expect(state.workflowPolicyExplain?.reasons?.length).toBeGreaterThan(0)
    expect(typeof state.workflowExecutionPlan?.planHash).toBe("string")

    const structuredLogPath = join(workingDirectory, ".agent-guide", "runtime", "structured-log.jsonl")
    const lines = (await readFile(structuredLogPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const policyEntries = lines
      .map((line) => JSON.parse(line) as { event?: string; planHash?: string })
      .filter((entry) => entry.event === "workflow_policy_decided")

    expect(policyEntries).toHaveLength(1)
    expect(policyEntries[0]?.planHash).toBe(state.workflowExecutionPlan?.planHash)
  })

  it("budget: fails fast with budget_exceeded when max_role_runs is exceeded", async () => {
    const workingDirectory = await createTempDir()
    await mkdir(join(workingDirectory, ".opencode"), { recursive: true })
    await writeFile(
      join(workingDirectory, ".opencode", "opencode-team.json"),
      `${JSON.stringify({
        workflow: {
          policy_enabled: true,
          budgets: {
            max_role_runs: 1,
            max_stage_failures: 1,
            max_total_latency_ms: 999_999,
            max_artifact_bytes: 2_000_000,
          },
        },
      }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "budget role runs",
        workingDirectory,
      },
      {
        workflowProfile: "auto",
      },
    )

    expect(result.status).toBe("failed")
    expect(String(result.error)).toContain("budget_exceeded")
    expect(String(result.error)).toContain("max_role_runs")
  })

  it("budget: fails fast with budget_exceeded when max_total_latency_ms is exceeded", async () => {
    const workingDirectory = await createTempDir()
    const baseExecutor = createScriptedSubagentExecutor()
    const latencyExecutor: SubagentExecutor = async <TContext, TPayload>(request: unknown) => {
      const result = await baseExecutor<TContext, TPayload>(request as never)
      return {
        ...result,
        latencyMs: 1,
      }
    }
    await mkdir(join(workingDirectory, ".opencode"), { recursive: true })
    await writeFile(
      join(workingDirectory, ".opencode", "opencode-team.json"),
      `${JSON.stringify({
        workflow: {
          policy_enabled: true,
          budgets: {
            max_role_runs: 999,
            max_stage_failures: 1,
            max_total_latency_ms: 1,
            max_artifact_bytes: 2_000_000,
          },
        },
      }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "budget latency",
        workingDirectory,
      },
      {
        workflowProfile: "auto",
        subagentExecutor: latencyExecutor,
      },
    )

    expect(result.status).toBe("failed")
    expect(String(result.error)).toContain("budget_exceeded")
    expect(String(result.error)).toContain("max_total_latency_ms")
  })

  it("budget: truncates workflow state agent runs when max_artifact_bytes is exceeded", async () => {
    const workingDirectory = await createTempDir()
    await mkdir(join(workingDirectory, ".opencode"), { recursive: true })
    await writeFile(
      join(workingDirectory, ".opencode", "opencode-team.json"),
      `${JSON.stringify({
        workflow: {
          policy_enabled: true,
          budgets: {
            max_role_runs: 999,
            max_stage_failures: 1,
            max_total_latency_ms: 999_999,
            max_artifact_bytes: 1200,
          },
        },
      }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "budget artifact bytes",
        workingDirectory,
      },
      {
        workflowProfile: "auto",
      },
    )

    expect(result.status).toBe("completed")

    const state = JSON.parse(await readFile(result.stateFilePath, "utf8")) as {
      agentRunsByStage?: Record<string, unknown[]>
      artifacts?: {
        agentRunsOversizePointer?: string
        agentRunsTruncated?: boolean
      }
    }

    expect(state.artifacts?.agentRunsTruncated).toBe(true)
    expect(typeof state.artifacts?.agentRunsOversizePointer).toBe("string")

    const pointerPath = join(workingDirectory, String(state.artifacts?.agentRunsOversizePointer ?? ""))
    const pointerRaw = await readFile(pointerPath, "utf8")
    const pointer = JSON.parse(pointerRaw) as {
      agentRunsByStage?: Record<string, unknown[]>
    }

    expect(Object.values(state.agentRunsByStage ?? {}).every((runs) => Array.isArray(runs) && runs.length === 0)).toBe(true)
    expect(Object.values(pointer.agentRunsByStage ?? {}).some((runs) => Array.isArray(runs) && runs.length > 0)).toBe(true)
  })

  it("resumes from last failed stage", async () => {
    const workingDirectory = await createTempDir()

    const firstRun = await runWorkflow(
      {
        task: "build feature",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({ status: "completed", artifacts: { requirementsTask: "build feature" } }),
          planning: async () => ({
            status: "completed",
            artifacts: {
              adrDecision: "decision",
              adrDrivers: ["driver"],
              handoff: HANDOFF,
            },
          }),
          issue: async () => ({ status: "completed", artifacts: { issueNumber: 102 } }),
          development: async () => ({
            status: "failed",
            error: "transient error",
          }),
        },
      },
    )

    expect(firstRun.status).toBe("failed")

    const order: string[] = []
    const secondRun = await runWorkflow(
      {
        task: "build feature",
        workingDirectory,
      },
      {
        resume: true,
        executors: {
          development: async () => {
            order.push("development")
            return {
              status: "completed",
              artifacts: {
                implementationPlan: "impl",
                testingPlan: ["npm test"],
                developmentExecution: {
                  mode: "script",
                  scriptName: "opencode:develop",
                  changedFiles: ["src/index.ts"],
                  changeCount: 1,
                },
                handoff: HANDOFF,
              },
            }
          },
          testing: async () => {
            order.push("testing")
            return { status: "completed", artifacts: { verificationPassed: true, handoff: HANDOFF } }
          },
          merge: async () => {
            order.push("merge")
            return { status: "completed", artifacts: { mergeReady: true, handoff: HANDOFF } }
          },
        },
      },
    )

    expect(secondRun.status).toBe("completed")
    expect(order).toEqual(["development", "testing", "merge"])
  })

  it("resumes from unfinished role node within development stage", async () => {
    const workingDirectory = await createTempDir()
    await execFileAsync("git", ["init"], { cwd: workingDirectory })
    await writeFile(
      join(workingDirectory, "package.json"),
      `${JSON.stringify({
        name: "workflow-test",
        version: "1.0.0",
        scripts: {
          "opencode:develop": "node -e \"const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/resume-node.ts','export const resumed = true\\n');\"",
        },
      }, null, 2)}\n`,
      "utf8",
    )

    let developerCalls = 0
    let documenterCalls = 0
    const baseExecutor = createScriptedSubagentExecutor()
    const executor: SubagentExecutor = async (request) => {
      if (request.role === "developer") {
        developerCalls += 1
      }
      if (request.role === "documenter") {
        documenterCalls += 1
        if (documenterCalls === 1) {
          return {
            status: "failure",
            decision: "request_changes",
            reasons: ["forced documenter failure"],
            evidence: ["forced documenter failure"],
            latencyMs: 1,
            attempts: 1,
            errorCode: "executor_failed",
            errorMessage: "forced documenter failure",
          }
        }
      }

      return baseExecutor(request)
    }

    const first = await runWorkflow(
      {
        task: "resume role node #808",
        workingDirectory,
      },
      {
        subagentExecutor: executor,
        executors: {
          testing: async () => ({
            status: "completed",
            artifacts: {
              verificationPassed: true,
              handoff: HANDOFF,
            },
          }),
          merge: async () => ({
            status: "completed",
            artifacts: {
              mergeReady: false,
              handoff: HANDOFF,
            },
          }),
        },
      },
    )

    expect(first.status).toBe("failed")
    expect(first.failedStage).toBe("development")

    const firstState = JSON.parse(await readFile(first.stateFilePath, "utf8")) as {
      version: number
      currentNode?: string
      roleProgressByStage?: { development?: number }
    }
    expect(firstState.version).toBe(2)
    expect(String(firstState.currentNode)).toContain("development:documenter")
    expect(firstState.roleProgressByStage?.development).toBe(1)

    const second = await runWorkflow(
      {
        task: "resume role node #808",
        workingDirectory,
      },
      {
        resume: true,
        subagentExecutor: executor,
        executors: {
          testing: async () => ({
            status: "completed",
            artifacts: {
              verificationPassed: true,
              handoff: HANDOFF,
            },
          }),
          merge: async () => ({
            status: "completed",
            artifacts: {
              mergeReady: false,
              handoff: HANDOFF,
            },
          }),
        },
      },
    )

    expect(second.status).toBe("completed")
    expect(developerCalls).toBe(1)
    expect(documenterCalls).toBe(2)
  })

  it("migrates v1 workflow state to v2 on resume", async () => {
    const workingDirectory = await createTempDir()
    const statePath = join(
      workingDirectory,
      ".agent-guide",
      "runtime",
      "state",
      "sessions",
      "default",
      "workflow-state.json",
    )
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        status: "failed",
        currentStage: "development",
        completedStages: ["requirements", "planning", "issue"],
        artifactsByStage: {
          requirements: { requirementsTask: "legacy migration" },
          planning: { adrDecision: "decision", adrDrivers: ["driver"], handoff: HANDOFF },
          issue: { issueNumber: 77 },
        },
        artifacts: {
          requirementsTask: "legacy migration",
          adrDecision: "decision",
          adrDrivers: ["driver"],
          issueNumber: 77,
        },
        failedStage: "development",
        error: "legacy failure",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "legacy migration",
        workingDirectory,
      },
      {
        resume: true,
        executors: {
          development: async () => ({
            status: "completed",
            artifacts: {
              implementationPlan: "impl",
              testingPlan: ["npm test"],
              developmentExecution: {
                mode: "dry_run",
                scriptName: null,
                changedFiles: ["src/index.ts"],
                changeCount: 1,
              },
              handoff: HANDOFF,
            },
          }),
          testing: async () => ({
            status: "completed",
            artifacts: {
              verificationPassed: true,
              handoff: HANDOFF,
            },
          }),
          merge: async () => ({
            status: "completed",
            artifacts: {
              mergeReady: false,
              handoff: HANDOFF,
            },
          }),
        },
      },
    )

    expect(result.status).toBe("completed")
    const migrated = JSON.parse(await readFile(result.stateFilePath, "utf8")) as {
      version: number
      currentNode: string | null
      roleProgressByStage?: Record<string, number>
    }
    expect(migrated.version).toBe(2)
    expect(migrated.currentNode).toBe(null)
    expect(typeof migrated.roleProgressByStage?.development).toBe("number")
  })

  it("injects AGENTS sections and persists default planning artifacts", async () => {
    const workingDirectory = await createTempDir()
    await writeFile(join(workingDirectory, "AGENTS.md"), `
# AGENTS

## 코딩 원칙
- keep it simple

## 메모리 규칙
- write context logs
`)

    const result = await runWorkflow({
      task: "default pipeline",
      workingDirectory,
    })

    expect(result.status).toBe("completed")
    expect(String(result.artifacts.systemInstructions)).toContain("## Engineering Principles")
    expect(String(result.artifacts.systemInstructions)).toContain("## Memory Policy")
    expect(String(result.artifacts.systemInstructions)).toContain("## 코딩 원칙")
    expect(String(result.artifacts.systemInstructions)).toContain("## 메모리 규칙")
    expect(String(result.artifacts.systemInstructions)).toContain("## Role Prompt (orchestrator)")
    expect(String(result.artifacts.systemInstructionSource)).toBe(join(workingDirectory, "AGENTS.md"))

    const planContent = await readFile(
      join(workingDirectory, ".agent-guide", "plans", "workflow-plan.md"),
      "utf8",
    )
    expect(planContent).toContain("## ADR")

    const documenterReport = await readFile(
      join(workingDirectory, ".agent-guide", "docs", "documentation-sync.md"),
      "utf8",
    )
    expect(documenterReport).toContain("doc coverage matrix")
    expect((result.artifacts.documentationSync as { summary?: string } | undefined)?.summary).toContain("document sync prepared")
  })

  it("uses built-in instructions when AGENTS.md is missing", async () => {
    const workingDirectory = await createTempDir()

    const result = await runWorkflow({
      task: "no agents file",
      workingDirectory,
    })

    expect(result.status).toBe("completed")
    expect(String(result.artifacts.systemInstructions)).toContain("## Engineering Principles")
    expect(String(result.artifacts.systemInstructions)).toContain("## Memory Policy")
    expect(String(result.artifacts.systemInstructions)).toContain("## Role Prompt (orchestrator)")
    expect(String(result.artifacts.systemInstructionSource)).toBe("builtin:core-system-prompt")
  })

  it("fails fast when stage artifacts violate contract", async () => {
    const workingDirectory = await createTempDir()

    await expect(runWorkflow(
      {
        task: "invalid artifacts",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: {},
          }),
        },
      },
    )).rejects.toThrow("Invalid stage artifact contract")
  })

  it("runs default stage executors through merge with github adapter", async () => {
    const workingDirectory = await createTempDir()
    let issueCalls = 0
    const adapter: GithubAutomationAdapter = {
      createIssue: async () => {
        issueCalls += 1
        return { number: 901, url: "https://example.com/issues/901" }
      },
      createBranch: async ({ name }) => ({ name }),
      createPullRequest: async () => ({ number: 902, url: "https://example.com/pulls/902" }),
      mergePullRequest: async () => ({ merged: true }),
    }

    const result = await runWorkflow(
      {
        task: "implement default flow #901",
        workingDirectory,
      },
      {
        githubAutomationAdapter: adapter,
        requireUserApproval: false,
        prepareLocalBranchForPullRequest: async () => ({ ok: true }),
      },
    )

    expect(result.status).toBe("completed")
    expect(result.artifacts.pullNumber).toBe(902)
    expect(result.artifacts.mergeDecision).toBe("auto_merged")
    expect(issueCalls).toBe(1)
  })

  it("fails merge stage when local branch preparation fails", async () => {
    const workingDirectory = await createTempDir()

    const adapter: GithubAutomationAdapter = {
      createIssue: async () => ({ number: 301, url: "https://example.com/issues/301" }),
      createBranch: async ({ name }) => ({ name }),
      createPullRequest: async () => ({ number: 11, url: "https://example.com/pulls/11" }),
      mergePullRequest: async () => ({ merged: true }),
    }

    const result = await runWorkflow(
      {
        task: "implement #301",
        workingDirectory,
      },
      {
        githubAutomationAdapter: adapter,
        prepareLocalBranchForPullRequest: async () => ({
          ok: false,
          reason: "no local changes",
        }),
      },
    )

    expect(result.status).toBe("failed")
    expect(result.failedStage).toBe("merge")
    expect(String(result.error)).toContain("merge prerequisites failed")
  })

  it("reports stage transition events in order", async () => {
    const workingDirectory = await createTempDir()
    const transitions: string[] = []

    const result = await runWorkflow(
      {
        task: "track transitions",
        workingDirectory,
      },
      {
        onStageTransition: async ({ stage, phase }) => {
          transitions.push(`${stage}:${phase}`)
        },
      },
    )

    expect(result.status).toBe("completed")
    expect(transitions[0]).toBe("requirements:starting")
    expect(transitions).toContain("merge:completed")
  })

  it("stops workflow when orchestrator cancel marker is created", async () => {
    const workingDirectory = await createTempDir()
    const sessionId = "cancel-me"
    const markerPath = join(
      workingDirectory,
      ".agent-guide",
      "runtime",
      "state",
      "sessions",
      sessionId,
      "orchestrator.cancel",
    )

    const result = await runWorkflow(
      {
        task: "cancel path",
        workingDirectory,
      },
      {
        sessionId,
        executors: {
          requirements: async () => {
            await mkdir(dirname(markerPath), { recursive: true })
            await writeFile(markerPath, "cancel\n", "utf8")
            return {
              status: "completed",
              artifacts: {
                requirementsTask: "cancel path",
              },
            }
          },
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(result.error).toBe("workflow cancelled")
  })

  it("fails testing stage when verification command fails", async () => {
    const workingDirectory = await createTempDir()

    const result = await runWorkflow(
      {
        task: "verification failure",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementsTask: "verification failure" },
          }),
          planning: async () => ({
            status: "completed",
            artifacts: { adrDecision: "decision", adrDrivers: ["driver"], handoff: HANDOFF },
          }),
          issue: async () => ({
            status: "completed",
            artifacts: { issueNumber: 201 },
          }),
          development: async () => ({
            status: "completed",
            artifacts: {
              implementationPlan: "impl",
              testingPlan: ["npm test"],
              developmentExecution: {
                mode: "script",
                scriptName: "opencode:develop",
                changedFiles: ["src/index.ts"],
                changeCount: 1,
              },
              handoff: HANDOFF,
            },
          }),
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(result.failedStage).toBe("testing")
    expect(String(result.error)).toContain("verification command failed")
  })

  it("rejects disallowed verification commands", async () => {
    const workingDirectory = await createTempDir()

    const result = await runWorkflow(
      {
        task: "disallowed verification",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementsTask: "disallowed verification" },
          }),
          planning: async () => ({
            status: "completed",
            artifacts: { adrDecision: "decision", adrDrivers: ["driver"], handoff: HANDOFF },
          }),
          issue: async () => ({
            status: "completed",
            artifacts: { issueNumber: 202 },
          }),
          development: async () => ({
            status: "completed",
            artifacts: {
              implementationPlan: "impl",
              testingPlan: ["rm -rf /tmp/something"],
              developmentExecution: {
                mode: "script",
                scriptName: "opencode:develop",
                changedFiles: ["src/index.ts"],
                changeCount: 1,
              },
              handoff: HANDOFF,
            },
          }),
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(result.failedStage).toBe("testing")
    expect(String(result.error)).toContain("verification command not allowed")
  })

  it("fails default development stage in git repo without code changes", async () => {
    const workingDirectory = await createTempDir()
    await execFileAsync("git", ["init"], { cwd: workingDirectory })

    const result = await runWorkflow(
      {
        task: "default development without edits",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementsTask: "default development without edits" },
          }),
          planning: async () => ({
            status: "completed",
            artifacts: {
              adrDecision: "decision",
              adrDrivers: ["driver"],
              handoff: HANDOFF,
            },
          }),
          issue: async () => ({
            status: "completed",
            artifacts: { issueNumber: 301 },
          }),
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(result.failedStage).toBe("development")
    expect(String(result.error)).toContain("no committable code changes")
  })

  it("fails default development stage when package has no development script", async () => {
    const workingDirectory = await createTempDir()
    await execFileAsync("git", ["init"], { cwd: workingDirectory })
    await writeFile(
      join(workingDirectory, "package.json"),
      `${JSON.stringify({
        name: "workflow-test",
        version: "1.0.0",
        scripts: {
          test: "node -e \"process.exit(0)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "default development without script",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementsTask: "default development without script" },
          }),
          planning: async () => ({
            status: "completed",
            artifacts: {
              adrDecision: "decision",
              adrDrivers: ["driver"],
              handoff: HANDOFF,
            },
          }),
          issue: async () => ({
            status: "completed",
            artifacts: { issueNumber: 302 },
          }),
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(result.failedStage).toBe("development")
    expect(String(result.error)).toContain("no development script")
  })

  it("runs configured development script and records changed files", async () => {
    const workingDirectory = await createTempDir()
    await execFileAsync("git", ["init"], { cwd: workingDirectory })
    await writeFile(
      join(workingDirectory, "package.json"),
      `${JSON.stringify({
        name: "workflow-test",
        version: "1.0.0",
        scripts: {
          "opencode:develop": "node -e \"const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/dev-output.ts','export const generated = true\\n');\"",
        },
      }, null, 2)}\n`,
      "utf8",
    )

    const result = await runWorkflow(
      {
        task: "default development with script",
        workingDirectory,
      },
      {
        executors: {
          requirements: async () => ({
            status: "completed",
            artifacts: { requirementsTask: "default development with script" },
          }),
          planning: async () => ({
            status: "completed",
            artifacts: {
              adrDecision: "decision",
              adrDrivers: ["driver"],
              handoff: HANDOFF,
            },
          }),
          issue: async () => ({
            status: "completed",
            artifacts: { issueNumber: 401 },
          }),
          testing: async () => ({
            status: "completed",
            artifacts: {
              verificationPassed: true,
              handoff: {
                currentStatus: "testing_complete",
                changedFiles: [],
                openRisks: [],
                nextAction: "run merge",
              },
            },
          }),
          merge: async () => ({
            status: "completed",
            artifacts: {
              mergeReady: true,
              handoff: {
                currentStatus: "merge_complete",
                changedFiles: [],
                openRisks: [],
                nextAction: "close workflow",
              },
            },
          }),
        },
      },
    )

    expect(result.status).toBe("completed")
    expect(result.artifacts.developmentScriptName).toBe("opencode:develop")

    const workflowState = JSON.parse(await readFile(result.stateFilePath, "utf8")) as {
      artifactsByStage?: { development?: { handoff?: { changedFiles?: string[] } } }
    }
    const changedFiles = workflowState.artifactsByStage?.development?.handoff?.changedFiles ?? []
    expect(changedFiles).toContain("src/dev-output.ts")
  })

  it("fails when workflow session lock is already held", async () => {
    const workingDirectory = await createTempDir()
    const lockPath = join(
      workingDirectory,
      ".agent-guide",
      "runtime",
      "state",
      "sessions",
      "locked",
      "session.lock",
    )
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, "{\"owner\":\"external\"}\n", "utf8")

    const result = await runWorkflow(
      {
        task: "locked workflow",
        workingDirectory,
      },
      {
        sessionId: "locked",
      },
    )

    expect(result.status).toBe("failed")
    expect(String(result.error)).toContain("session_locked")
  })
})
