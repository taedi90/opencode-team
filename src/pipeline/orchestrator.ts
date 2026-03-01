import { execFile } from "node:child_process"
import { access, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { buildAgentSystemInstructions } from "../agents/instructions.js"
import { runUltrawork } from "../execution/ultrawork.js"
import {
  runGithubAutomation,
  type GithubAutomationAdapter,
} from "../github/automation.js"
import { runRalphLoop } from "../execution/ralph-loop.js"
import { runConsensusPlanning } from "../planning/index.js"
import { loadMergedConfig } from "../config/index.js"
import { writeTextFileAtomic } from "../runtime/atomic-write.js"
import { acquireSessionLock } from "../runtime/session-lock.js"
import { assertStageArtifactContract } from "./artifact-contract.js"
import { WORKFLOW_STAGES, type WorkflowStage } from "./stages.js"

const execFileAsync = promisify(execFile)

export interface WorkflowInput {
  task: string
  workingDirectory: string
}

export type StageExecutionResult =
  | {
      status: "completed"
      artifacts?: Record<string, unknown>
    }
  | {
      status: "failed"
      error: string
      artifacts?: Record<string, unknown>
    }

export interface WorkflowState {
  version: 1
  status: "in_progress" | "completed" | "failed"
  currentStage: WorkflowStage | null
  completedStages: WorkflowStage[]
  artifactsByStage: Partial<Record<WorkflowStage, Record<string, unknown>>>
  artifacts: Record<string, unknown>
  failedStage?: WorkflowStage
  error?: string
  updatedAt: string
}

export interface StageExecutionContext {
  stage: WorkflowStage
  input: WorkflowInput
  artifacts: Record<string, unknown>
  state: WorkflowState
}

export type StageExecutor = (
  context: StageExecutionContext,
) => Promise<StageExecutionResult> | StageExecutionResult

export interface WorkflowRunOptions {
  stateFilePath?: string
  sessionId?: string
  resume?: boolean
  executors?: Partial<Record<WorkflowStage, StageExecutor>>
  githubAutomationAdapter?: GithubAutomationAdapter
  prepareLocalBranchForPullRequest?: (input: {
    workingDirectory: string
    branchName: string
    issueNumber: number
    task: string
    preferredPaths?: string[]
  }) => Promise<{
    ok: boolean
    reason?: string
  }>
  onStageTransition?: (input: {
    stage: WorkflowStage
    phase: "starting" | "completed" | "failed"
  }) => Promise<void> | void
  requireUserApproval?: boolean
  userApprovedMerge?: boolean
}

export interface WorkflowRunResult {
  status: "completed" | "failed"
  failedStage?: WorkflowStage
  error?: string
  completedStages: WorkflowStage[]
  artifacts: Record<string, unknown>
  stateFilePath: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function createInitialState(): WorkflowState {
  return {
    version: 1,
    status: "in_progress",
    currentStage: null,
    completedStages: [],
    artifactsByStage: {},
    artifacts: {},
    updatedAt: nowIso(),
  }
}

function createDefaultExecutor(): StageExecutor {
  return async () => ({ status: "completed" })
}

function parseIssueNumberFromTask(task: string): number | null {
  const match = task.match(/#(\d+)/)
  if (!match || !match[1]) {
    return null
  }
  const parsed = Number.parseInt(match[1], 10)
  return Number.isInteger(parsed) ? parsed : null
}

function sanitizeSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized.length > 0 ? normalized.slice(0, 48) : "workflow-task"
}

const GENERATED_COMMIT_PATH_PREFIXES = [
  ".agent-guide/runtime/",
  ".agent-guide/context/",
] as const

const UNTRACKED_COMMIT_PATH_PREFIXES = [
  "src/",
  "tests/",
  "scripts/",
  ".github/",
] as const

const UNTRACKED_COMMIT_FILES = new Set([
  ".gitignore",
  "README.md",
  "ARCHITECTURE.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
])

function unquotePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parsePorcelainPaths(pathField: string): string[] {
  const parts = pathField.split(" -> ").map((item) => unquotePath(item)).filter((item) => item.length > 0)
  if (parts.length === 0) {
    return []
  }
  if (parts.length === 1) {
    return [parts[0] as string]
  }
  const previous = parts[0]
  const next = parts[parts.length - 1]
  return [previous as string, next as string]
}

function isGeneratedCommitPath(path: string): boolean {
  return GENERATED_COMMIT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function isAllowedUntrackedCommitPath(path: string): boolean {
  if (UNTRACKED_COMMIT_FILES.has(path)) {
    return true
  }
  return UNTRACKED_COMMIT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export function resolveCommittablePathsFromStatus(
  statusOutput: string,
  preferredPaths: readonly string[] = [],
): string[] {
  const preferred = new Set(preferredPaths.map((item) => item.trim()).filter((item) => item.length > 0))
  const collected = new Set<string>()

  for (const line of statusOutput.split("\n")) {
    if (line.length < 4) {
      continue
    }

    const statusCode = line.slice(0, 2)
    const pathField = line.slice(3).trim()
    if (!pathField) {
      continue
    }

    const paths = parsePorcelainPaths(pathField)
    const isUntracked = statusCode === "??"

    for (const path of paths) {
      if (isGeneratedCommitPath(path)) {
        continue
      }
      if (preferred.size > 0 && !preferred.has(path)) {
        continue
      }
      if (isUntracked && !isAllowedUntrackedCommitPath(path)) {
        continue
      }
      collected.add(path)
    }
  }

  return [...collected]
}

function normalizePreferredPaths(workingDirectory: string, paths: readonly string[]): string[] {
  const normalized: string[] = []
  const workingPrefix = `${workingDirectory.replace(/\/$/, "")}/`

  for (const path of paths) {
    const trimmed = path.trim()
    if (trimmed.length === 0) {
      continue
    }

    if (trimmed.startsWith(workingPrefix)) {
      normalized.push(trimmed.slice(workingPrefix.length))
      continue
    }

    if (!trimmed.startsWith("/")) {
      normalized.push(trimmed)
    }
  }

  return [...new Set(normalized)]
}

function resolvePreferredCommitPaths(workingDirectory: string, artifacts: Record<string, unknown>): string[] {
  const handoff = artifacts.handoff
  if (!handoff || typeof handoff !== "object" || !Array.isArray((handoff as { changedFiles?: unknown }).changedFiles)) {
    return []
  }

  const changedFiles = (handoff as { changedFiles: unknown[] }).changedFiles
    .filter((item): item is string => typeof item === "string")

  return normalizePreferredPaths(workingDirectory, changedFiles)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function readPackageScripts(workingDirectory: string): Promise<Record<string, string>> {
  const packagePath = join(workingDirectory, "package.json")
  try {
    const raw = await readFile(packagePath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
      return {}
    }

    const scripts: Record<string, string> = {}
    for (const [name, command] of Object.entries(parsed.scripts)) {
      if (typeof command === "string" && command.trim().length > 0) {
        scripts[name] = command
      }
    }
    return scripts
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {}
    }
    throw error
  }
}

async function runDevelopmentScript(input: {
  workingDirectory: string
  scriptName: string
  task: string
  adrDecision: string
}): Promise<void> {
  await execFileAsync("npm", ["run", input.scriptName], {
    cwd: input.workingDirectory,
    env: {
      ...process.env,
      OPENCODE_TASK: input.task,
      OPENCODE_ADR_DECISION: input.adrDecision,
    },
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isGitRepository(workingDirectory: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workingDirectory,
    })
    return true
  } catch {
    return false
  }
}

async function listCommittableGitPaths(workingDirectory: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: workingDirectory,
  })
  return resolveCommittablePathsFromStatus(stdout)
}

function resolveCancelMarkerPath(workingDirectory: string, sessionId: string): string {
  return join(
    workingDirectory,
    ".agent-guide",
    "runtime",
    "state",
    "sessions",
    sessionId,
    "orchestrator.cancel",
  )
}

type AllowedVerificationCommand =
  | "npm test"
  | "npm run typecheck"
  | "npm run build"
  | "npm run release:gate"

function resolveAllowedVerificationCommand(command: string): {
  normalized: AllowedVerificationCommand | null
  executable?: string
  args?: string[]
} {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ")

  if (normalized === "npm test") {
    return {
      normalized,
      executable: "npm",
      args: ["test"],
    }
  }

  if (normalized === "npm run typecheck") {
    return {
      normalized,
      executable: "npm",
      args: ["run", "typecheck"],
    }
  }

  if (normalized === "npm run build") {
    return {
      normalized,
      executable: "npm",
      args: ["run", "build"],
    }
  }

  if (normalized === "npm run release:gate") {
    return {
      normalized,
      executable: "npm",
      args: ["run", "release:gate"],
    }
  }

  return {
    normalized: null,
  }
}

function shouldRetryMergeOperation(error: unknown): boolean {
  const text = String(error).toLowerCase()
  return text.includes("timeout")
    || text.includes("econn")
    || text.includes("tempor")
    || text.includes("rate limit")
    || text.includes("connection reset")
    || text.includes("service unavailable")
}

async function withMergeRetry<T>(task: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetryMergeOperation(error)) {
        throw error
      }
      const backoffMs = Math.min(2000, 200 * (2 ** attempt))
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
      attempt += 1
    }
  }
}

async function executeVerificationCommand(workingDirectory: string, command: string): Promise<void> {
  const resolved = resolveAllowedVerificationCommand(command)
  if (!resolved.normalized || !resolved.executable || !resolved.args) {
    throw new Error(`verification command not allowed: ${command}`)
  }

  await execFileAsync(resolved.executable, resolved.args, {
    cwd: workingDirectory,
  })
}

function isAllowedVerificationCommand(command: string): boolean {
  return resolveAllowedVerificationCommand(command).normalized !== null
}

async function defaultPrepareLocalBranchForPullRequest(input: {
  workingDirectory: string
  branchName: string
  issueNumber: number
  task: string
  preferredPaths?: string[]
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: input.workingDirectory,
    })
  } catch {
    return { ok: false, reason: "working directory is not a git repository" }
  }

  await execFileAsync("git", ["checkout", "-B", input.branchName], {
    cwd: input.workingDirectory,
  })

  const { stdout: beforeAdd } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: input.workingDirectory,
  })
  if (beforeAdd.trim().length === 0) {
    return { ok: false, reason: "no local changes to commit before pull request" }
  }

  const committablePaths = resolveCommittablePathsFromStatus(beforeAdd, input.preferredPaths ?? [])
  if (committablePaths.length === 0) {
    return { ok: false, reason: "no committable changes after filtering generated/untracked files" }
  }

  await execFileAsync("git", ["add", "--", ...committablePaths], {
    cwd: input.workingDirectory,
  })

  const commitMessage = `feat: implement issue #${input.issueNumber} (${input.task.slice(0, 40)})`
  try {
    await execFileAsync("git", ["commit", "-m", commitMessage], {
      cwd: input.workingDirectory,
    })
  } catch (error) {
    const errorText = String(error)
    if (!errorText.includes("nothing to commit")) {
      throw error
    }
    return { ok: false, reason: "no committable changes after staging" }
  }

  await withMergeRetry(async () => {
    await execFileAsync("git", ["push", "-u", "origin", input.branchName], {
      cwd: input.workingDirectory,
    })
  })

  return { ok: true }
}

function createDefaultExecutors(
  input: WorkflowInput,
  options: WorkflowRunOptions,
): Record<WorkflowStage, StageExecutor> {
  return {
    requirements: async () => {
      try {
        const instructions = await buildAgentSystemInstructions({
          workspaceRoot: input.workingDirectory,
          role: "orchestrator",
          sessionId: "requirements",
        })
        return {
          status: "completed",
          artifacts: {
            requirementsTask: input.task,
            systemInstructions: instructions.content,
            systemInstructionSource: instructions.sourcePath,
            systemInstructionSources: instructions.sources,
            systemInstructionSessionFile: instructions.sessionFilePath,
          },
        }
      } catch (error) {
        return {
          status: "completed",
          artifacts: {
            requirementsTask: input.task,
            systemInstructions: "",
            systemInstructionWarning: `failed to compose system instructions: ${String(error)}`,
          },
        }
      }
    },
    planning: async ({ artifacts }) => {
      const plan = await runConsensusPlanning(
        {
          problem: String(artifacts.requirementsTask ?? input.task),
        },
        {
          workspaceRoot: input.workingDirectory,
          artifactName: "workflow-plan",
        },
      )

      if (plan.status !== "approved") {
        return {
          status: "failed",
          error: `consensus planning rejected: ${plan.lastRejectReasons.join(", ") || "no reasons"}`,
        }
      }

      return {
        status: "completed",
        artifacts: {
          adrDecision: plan.adr.decision,
          adrDrivers: plan.adr.drivers,
          handoff: {
            currentStatus: "planning_approved",
            changedFiles: [join(input.workingDirectory, ".agent-guide", "plans", "workflow-plan.md")],
            openRisks: plan.lastRejectReasons,
            nextAction: "create or link issue",
          },
        },
      }
    },
    issue: async ({ artifacts }) => {
      const requirementTask = String(artifacts.requirementsTask ?? input.task)
      const issueTitle = `Task: ${requirementTask}`
      const issueBody = `Decision: ${String(artifacts.adrDecision ?? "n/a")}`

      if (!options.githubAutomationAdapter) {
        return {
          status: "completed",
          artifacts: {
            issueNumber: parseIssueNumberFromTask(requirementTask),
            issueTitle,
            issueBody,
            issueDraft: {
              title: issueTitle,
              body: issueBody,
            },
          },
        }
      }

      const issue = await options.githubAutomationAdapter.createIssue({
        title: issueTitle,
        body: issueBody,
      })

      return {
        status: "completed",
        artifacts: {
          issueNumber: issue.number,
          issueUrl: issue.url,
          issueTitle,
          issueBody,
        },
      }
    },
    development: async ({ artifacts }) => {
      const hasPackageJson = await pathExists(join(input.workingDirectory, "package.json"))
      const testingPlan = hasPackageJson
        ? ["npm test", "npm run typecheck", "npm run build"]
        : []
      const packageScripts = hasPackageJson
        ? await readPackageScripts(input.workingDirectory)
        : {}
      const developmentScriptName = ["opencode:develop", "develop:opencode", "develop"]
        .find((name) => Boolean(packageScripts[name]))

      if (hasPackageJson && !developmentScriptName && await isGitRepository(input.workingDirectory)) {
        return {
          status: "failed",
          error: "schema_validation_failed: package.json exists but no development script (opencode:develop/develop:opencode/develop) is configured",
        }
      }

      const execution = await runUltrawork([
        {
          id: "implement",
          run: async () => {
            if (developmentScriptName) {
              try {
                await runDevelopmentScript({
                  workingDirectory: input.workingDirectory,
                  scriptName: developmentScriptName,
                  task: String(artifacts.requirementsTask ?? input.task),
                  adrDecision: String(artifacts.adrDecision ?? input.task),
                })
              } catch (error) {
                return {
                  status: "failed",
                  error: `development script failed: ${String(error)}`,
                }
              }
            }

            return {
              status: "completed",
              output: {
                implementationPlan: String(artifacts.adrDecision ?? input.task),
                ...(developmentScriptName ? { developmentScriptName } : {}),
              },
            }
          },
        },
        {
          id: "write-tests",
          dependsOn: ["implement"],
          run: async () => ({
              status: "completed",
              output: {
                testingPlan,
              },
            }),
          },
      ])

      if (execution.status !== "completed") {
        return {
          status: "failed",
          error: `schema_validation_failed: ${execution.error ?? "ultrawork execution failed"}`,
          artifacts: execution.outputs,
        }
      }

      const gitRepo = await isGitRepository(input.workingDirectory)
      const changedFiles = gitRepo
        ? await listCommittableGitPaths(input.workingDirectory)
        : []

      if (gitRepo && changedFiles.length === 0) {
        return {
          status: "failed",
          error: "handoff_missing: development stage produced no committable code changes",
        }
      }

      return {
        status: "completed",
        artifacts: {
          ...execution.outputs,
          developmentExecution: {
            mode: developmentScriptName ? "script" : "dry_run",
            scriptName: developmentScriptName ?? null,
            changedFiles,
            changeCount: changedFiles.length,
          },
          handoff: {
            currentStatus: "development_complete",
            changedFiles,
            openRisks: [],
            nextAction: "run testing stage",
          },
        },
      }
    },
    testing: async ({ artifacts }) => {
      const testingPlan = Array.isArray(artifacts.testingPlan)
        ? artifacts.testingPlan.map((item) => String(item))
        : []

      for (const command of testingPlan) {
        if (!isAllowedVerificationCommand(command)) {
          return {
            status: "failed",
            error: `schema_validation_failed: verification command not allowed: ${command}`,
            artifacts: {
              verificationPassed: false,
              verificationFailedCommand: command,
              handoff: {
                currentStatus: "testing_failed",
                changedFiles: [],
                openRisks: [`disallowed verification command: ${command}`],
                nextAction: "replace with allowlisted verification command",
              },
            },
          }
        }

        try {
          await executeVerificationCommand(input.workingDirectory, command)
        } catch (error) {
          return {
            status: "failed",
            error: `schema_validation_failed: verification command failed: ${command} (${String(error)})`,
            artifacts: {
              verificationPassed: false,
              verificationFailedCommand: command,
              handoff: {
                currentStatus: "testing_failed",
                changedFiles: [],
                openRisks: [`verification command failed: ${command}`],
                nextAction: "fix failing command and retry",
              },
            },
          }
        }
      }

      const verify = await runRalphLoop(async () => ({
        signals: {
          todosDone: typeof artifacts.implementationPlan === "string" && artifacts.implementationPlan.length > 0,
          testsPassed: testingPlan.length === 0 || testingPlan.some((item) => item.includes("npm test")),
          buildPassed: testingPlan.length === 0 || testingPlan.some((item) => item.includes("npm run build")),
          reviewApproved: typeof artifacts.adrDecision === "string" && artifacts.adrDecision.length > 0,
        },
      }), { maxIterations: 1 })

      if (verify.status !== "completed") {
        return {
          status: "failed",
          error: `schema_validation_failed: ${verify.reason}`,
          artifacts: {
            verificationPassed: false,
            handoff: {
              currentStatus: "testing_failed",
              changedFiles: [],
              openRisks: [verify.reason],
              nextAction: "resolve ralph verification signals and retry",
            },
          },
        }
      }

      return {
        status: "completed",
        artifacts: {
          verificationPassed: true,
          handoff: {
            currentStatus: "testing_passed",
            changedFiles: [],
            openRisks: [],
            nextAction: "continue to merge stage",
          },
        },
      }
    },
    merge: async ({ artifacts }) => {
      if (!options.githubAutomationAdapter) {
        return {
          status: "completed",
          artifacts: {
            mergeReady: false,
            handoff: {
              currentStatus: "merge_skipped",
              changedFiles: [],
              openRisks: ["github automation adapter missing"],
              nextAction: "configure github adapter or merge manually",
            },
          },
        }
      }

      const config = await loadMergedConfig({
        projectDir: input.workingDirectory,
      })
      const requireUserApproval = options.requireUserApproval
        ?? config.config.merge_policy.require_user_approval
      const issueNumber = typeof artifacts.issueNumber === "number"
        ? artifacts.issueNumber
        : parseIssueNumberFromTask(String(artifacts.requirementsTask ?? input.task))
      const issueReference = issueNumber ?? 0
      const branchName = `task/${issueReference}-${sanitizeSlug(String(artifacts.requirementsTask ?? input.task))}`

      const prepareLocalBranchForPullRequest = options.prepareLocalBranchForPullRequest
        ?? defaultPrepareLocalBranchForPullRequest
      const preferredPaths = resolvePreferredCommitPaths(input.workingDirectory, artifacts)
      const prepare = await prepareLocalBranchForPullRequest({
        workingDirectory: input.workingDirectory,
        branchName,
        issueNumber: issueReference,
        task: String(artifacts.requirementsTask ?? input.task),
        ...(preferredPaths.length > 0 ? { preferredPaths } : {}),
      })
      if (!prepare.ok) {
        return {
          status: "failed",
          error: `handoff_missing: merge prerequisites failed: ${prepare.reason ?? "unknown reason"}`,
          artifacts: {
            mergeReady: false,
            handoff: {
              currentStatus: "merge_blocked",
              changedFiles: [],
              openRisks: [prepare.reason ?? "unknown merge prerequisite failure"],
              nextAction: "resolve prerequisites and retry merge",
            },
          },
        }
      }

      const automation = await runGithubAutomation(
        options.githubAutomationAdapter,
        {
          workingDirectory: input.workingDirectory,
          issueTitle: String(artifacts.issueTitle ?? `Task: ${input.task}`),
          issueBody: String(artifacts.issueBody ?? `Decision: ${String(artifacts.adrDecision ?? "n/a")}`),
          ...(typeof artifacts.issueNumber === "number" && typeof artifacts.issueUrl === "string"
            ? {
              issueNumber: artifacts.issueNumber,
              issueUrl: artifacts.issueUrl,
            }
            : {}),
          branchName,
          prTitle: String(artifacts.issueTitle ?? `Task: ${input.task}`),
          summary: [
            String(artifacts.adrDecision ?? "workflow decision"),
            `implementation: ${String(artifacts.implementationPlan ?? "n/a")}`,
          ],
          verification: ["npm test", "npm run typecheck", "npm run build"],
        },
        {
          requireUserApproval,
          ...(options.userApprovedMerge !== undefined
            ? { userApprovedMerge: options.userApprovedMerge }
            : {}),
        },
      )

      return {
        status: "completed",
        artifacts: {
          mergeReady: true,
          issueNumber: automation.issueNumber,
          pullNumber: automation.pullNumber,
          pullUrl: automation.pullUrl,
          mergeDecision: automation.mergeDecision,
          merged: automation.merged,
          handoff: {
            currentStatus: automation.merged ? "merge_complete" : "merge_pending",
            changedFiles: [],
            openRisks: automation.merged ? [] : ["merge did not execute automatically"],
            nextAction: automation.merged ? "close workflow" : "collect manual merge approval",
          },
        },
      }
    },
  }
}

function isPrefix(list: readonly string[], target: readonly string[]): boolean {
  if (list.length > target.length) return false
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] !== target[i]) return false
  }
  return true
}

async function writeWorkflowState(path: string, state: WorkflowState): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`)
}

async function readWorkflowState(path: string): Promise<WorkflowState | null> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as WorkflowState
    return parsed
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

function resolveStateFilePath(input: WorkflowInput, options: WorkflowRunOptions): string {
  if (options.stateFilePath) return options.stateFilePath
  if (options.sessionId) {
    return join(
      input.workingDirectory,
      ".agent-guide",
      "runtime",
      "state",
      "sessions",
      options.sessionId,
      "workflow-state.json",
    )
  }
  return join(input.workingDirectory, ".agent-guide", "runtime", "workflow-state.json")
}

function resolveStartIndex(state: WorkflowState): number {
  if (!isPrefix(state.completedStages, WORKFLOW_STAGES)) {
    throw new Error("Invalid workflow state: completedStages are not a valid stage prefix")
  }

  return state.completedStages.length
}

export async function runWorkflow(
  input: WorkflowInput,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  const sessionId = options.sessionId ?? "default"
  const sessionLock = await acquireSessionLock({
    workspaceRoot: input.workingDirectory,
    sessionId,
    owner: "workflow:orchestrator",
  })
  const stateFilePath = resolveStateFilePath(input, options)
  if (!sessionLock.acquired) {
    return {
      status: "failed",
      error: `session_locked: ${sessionLock.holder ?? "session lock is already held"}`,
      completedStages: [],
      artifacts: {},
      stateFilePath,
    }
  }

  try {
  const shouldResume = options.resume ?? false

  let state = createInitialState()
  const cancelMarkerPath = options.sessionId
    ? resolveCancelMarkerPath(input.workingDirectory, options.sessionId)
    : undefined

  if (!shouldResume && cancelMarkerPath) {
    await rm(cancelMarkerPath, { force: true })
  }

  if (shouldResume) {
    const existingState = await readWorkflowState(stateFilePath)
    if (existingState) {
      state = existingState
      if (existingState.status === "completed") {
        return {
          status: "completed",
          completedStages: existingState.completedStages,
          artifacts: existingState.artifacts,
          stateFilePath,
        }
      }
    }
  }

  let startIndex = 0
  if (shouldResume) {
    startIndex = resolveStartIndex(state)
  }

  const defaultExecutors = createDefaultExecutors(input, options)
  const executors = {
    ...defaultExecutors,
    ...(options.executors ?? {}),
  }

  for (let i = startIndex; i < WORKFLOW_STAGES.length; i += 1) {
    if (cancelMarkerPath && await pathExists(cancelMarkerPath)) {
      state = {
        ...state,
        status: "failed",
        error: "workflow cancelled",
        updatedAt: nowIso(),
      }
      await writeWorkflowState(stateFilePath, state)
      return {
        status: "failed",
        ...(state.currentStage ? { failedStage: state.currentStage } : {}),
        error: "workflow cancelled",
        completedStages: state.completedStages,
        artifacts: state.artifacts,
        stateFilePath,
      }
    }

    const stage = WORKFLOW_STAGES[i]
    if (!stage) {
      throw new Error(`Workflow stage is undefined at index ${i}`)
    }

    const {
      failedStage: _failedStage,
      error: _error,
      ...stateWithoutFailure
    } = state

    state = {
      ...stateWithoutFailure,
      status: "in_progress",
      currentStage: stage,
      updatedAt: nowIso(),
    }
    await writeWorkflowState(stateFilePath, state)
    await options.onStageTransition?.({
      stage,
      phase: "starting",
    })

    const executor = executors[stage] ?? createDefaultExecutor()
    const executionResult = await executor({
      stage,
      input,
      artifacts: state.artifacts,
      state,
    })

    const stageArtifacts = executionResult.artifacts ?? {}
    if (executionResult.status === "completed" || executionResult.artifacts !== undefined) {
      assertStageArtifactContract(stage, stageArtifacts)
    }
    state = {
      ...state,
      artifactsByStage: {
        ...state.artifactsByStage,
        [stage]: stageArtifacts,
      },
      artifacts: {
        ...state.artifacts,
        ...stageArtifacts,
      },
      updatedAt: nowIso(),
    }

    if (executionResult.status === "failed") {
      await options.onStageTransition?.({
        stage,
        phase: "failed",
      })
      state = {
        ...state,
        status: "failed",
        failedStage: stage,
        error: executionResult.error,
        updatedAt: nowIso(),
      }
      await writeWorkflowState(stateFilePath, state)
      return {
        status: "failed",
        failedStage: stage,
        error: executionResult.error,
        completedStages: state.completedStages,
        artifacts: state.artifacts,
        stateFilePath,
      }
    }

    state = {
      ...state,
      completedStages: [...state.completedStages, stage],
      updatedAt: nowIso(),
    }
    await writeWorkflowState(stateFilePath, state)
    await options.onStageTransition?.({
      stage,
      phase: "completed",
    })
  }

  const {
    failedStage: _finalFailedStage,
    error: _finalError,
    ...stateWithoutFailure
  } = state

  state = {
    ...stateWithoutFailure,
    status: "completed",
    currentStage: null,
    updatedAt: nowIso(),
  }
  await writeWorkflowState(stateFilePath, state)

  return {
    status: "completed",
    completedStages: state.completedStages,
    artifacts: state.artifacts,
    stateFilePath,
  }
  } finally {
    await sessionLock.release()
  }
}
