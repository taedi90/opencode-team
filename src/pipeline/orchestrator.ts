import { execFile } from "node:child_process"
import { access, readFile, readdir, rm } from "node:fs/promises"
import { join, relative } from "node:path"
import { promisify } from "node:util"

import { runUltrawork } from "../execution/ultrawork.js"
import {
  runGithubAutomation,
  type GithubAutomationAdapter,
} from "../github/automation.js"
import { runRalphLoop } from "../execution/ralph-loop.js"
import {
  createDefaultPlanningArchitectReview,
  createDefaultPlanningCriticReview,
  createDefaultPlanningDraft,
  runConsensusPlanning,
  type ArchitectReview,
  type ConsensusPlanningHooks,
  type CriticReview,
  type PlanningDraft,
} from "../planning/index.js"
import {
  loadMergedConfig,
  type OpenCodeTeamConfig,
} from "../config/index.js"
import { writeTextFileAtomic } from "../runtime/atomic-write.js"
import { acquireSessionLock } from "../runtime/session-lock.js"
import { assertStageArtifactContract } from "./artifact-contract.js"
import { WORKFLOW_STAGES, type WorkflowStage } from "./stages.js"
import {
  WorkflowAgentExecutionError,
  runWorkflowAgent,
  toWorkflowAgentRunArtifact,
  type WorkflowAgentRun,
  type WorkflowAgentRunArtifact,
} from "./agent-runtime.js"
import {
  createScriptedSubagentExecutor,
  type SubagentExecutor,
} from "./subagent-executor.js"
import { resolveStageAgentSequence } from "./agent-graph.js"
import type {
  ToolAccessReasonCode,
  ToolPolicySource,
} from "../runtime/agent-tool-policy.js"

const execFileAsync = promisify(execFile)

export interface WorkflowInput {
  task: string
  workingDirectory: string
}

export type StageExecutionResult =
  | {
      status: "completed"
      artifacts?: Record<string, unknown>
      roleProgressCount?: number
      currentNode?: string | null
    }
  | {
      status: "failed"
      error: string
      artifacts?: Record<string, unknown>
      roleProgressCount?: number
      currentNode?: string | null
    }

export interface WorkflowState {
  version: 2
  status: "in_progress" | "completed" | "failed"
  currentStage: WorkflowStage | null
  currentNode: string | null
  completedStages: WorkflowStage[]
  roleProgressByStage: Partial<Record<WorkflowStage, number>>
  agentRunsByStage: Partial<Record<WorkflowStage, WorkflowAgentRunArtifact[]>>
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
  stageRoleStartIndex: number
}

export type StageExecutor = (
  context: StageExecutionContext,
) => Promise<StageExecutionResult> | StageExecutionResult

export interface WorkflowRunOptions {
  stateFilePath?: string
  sessionId?: string
  resume?: boolean
  subagentExecutor?: SubagentExecutor
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
  onToolPolicyEvaluated?: (input: {
    stage: WorkflowStage
    nodeId: string
    sessionId: string
    agentRole: string
    toolName: string
    allowed: boolean
    reasonCode: ToolAccessReasonCode
    policySource: ToolPolicySource
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
    version: 2,
    status: "in_progress",
    currentStage: null,
    currentNode: null,
    completedStages: [],
    roleProgressByStage: {},
    agentRunsByStage: {},
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

async function listMarkdownFilesRecursive(rootDirectory: string, baseDirectory: string): Promise<string[]> {
  const entries = await readdir(rootDirectory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = join(rootDirectory, entry.name)
    if (entry.isDirectory()) {
      const nested = await listMarkdownFilesRecursive(entryPath, baseDirectory)
      files.push(...nested)
      continue
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(relative(baseDirectory, entryPath))
    }
  }

  return files
}

async function runDocumenterSync(input: {
  workingDirectory: string
  task: string
  adrDecision: string
  changedFiles: string[]
}): Promise<{
  role: "documenter"
  summary: string
  updatedDocs: string[]
  reportPath: string
  sourceOfTruth: string[]
}> {
  const updatedDocs: string[] = []
  const readmePath = join(input.workingDirectory, "README.md")
  const architecturePath = join(input.workingDirectory, "ARCHITECTURE.md")
  const docsDirectory = join(input.workingDirectory, "docs")

  if (await pathExists(readmePath)) {
    updatedDocs.push("README.md")
  }
  if (await pathExists(architecturePath)) {
    updatedDocs.push("ARCHITECTURE.md")
  }
  if (await pathExists(docsDirectory)) {
    const docsMarkdownFiles = await listMarkdownFilesRecursive(docsDirectory, input.workingDirectory)
    updatedDocs.push(...docsMarkdownFiles)
  }

  const reportPath = join(input.workingDirectory, ".agent-guide", "docs", "documentation-sync.md")
  const reportBody = [
    "# Documentation Sync Report",
    "",
    "## source-of-truth",
    "- Workflow behavior in src/ and tests/ is source of truth.",
    "- README.md and ARCHITECTURE.md describe operator-level behavior.",
    "- docs/**/*.md provide runtime and release procedures.",
    "",
    "## doc coverage matrix",
    ...updatedDocs.map((path) => `- ${path} | status: tracked`),
    "",
    "## Sync Inputs",
    `- Task: ${input.task}`,
    `- ADR Decision: ${input.adrDecision}`,
    `- Changed Files: ${input.changedFiles.join(", ") || "none"}`,
    "",
    "## Handoff",
    "- Current Status: synced",
    "- Changed Files: documentation report only",
    "- Open Risks: manual content edits may still be required for major feature changes",
    "- Next Action: reviewer validates docs sync before merge",
    "",
  ].join("\n")
  await writeTextFileAtomic(reportPath, reportBody)

  return {
    role: "documenter",
    summary: `document sync prepared for ${updatedDocs.length} markdown files`,
    updatedDocs,
    reportPath,
    sourceOfTruth: ["src/", "tests/", "README.md", "ARCHITECTURE.md", "docs/"],
  }
}

function createRoleSessionId(stage: WorkflowStage, role: string, suffix?: string): string {
  const base = `${stage}-${role}`
  return suffix ? `${base}-${suffix}` : base
}

async function collectResearchContextPaths(workingDirectory: string): Promise<string[]> {
  const sources: string[] = []
  const readmePath = join(workingDirectory, "README.md")
  const architecturePath = join(workingDirectory, "ARCHITECTURE.md")
  const docsDirectory = join(workingDirectory, "docs")

  if (await pathExists(readmePath)) {
    sources.push("README.md")
  }
  if (await pathExists(architecturePath)) {
    sources.push("ARCHITECTURE.md")
  }
  if (await pathExists(docsDirectory)) {
    const docsMarkdownFiles = await listMarkdownFilesRecursive(docsDirectory, workingDirectory)
    sources.push(...docsMarkdownFiles)
  }

  return [...new Set(sources)]
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return String(error)
}

function resolveNodeId(stage: WorkflowStage, role: string, index: number, suffix?: string): string {
  const base = `${stage}:${role}:${String(index + 1).padStart(2, "0")}`
  return suffix ? `${base}:${suffix}` : base
}

function normalizeRoleStartIndex(value: number, max: number): number {
  const clamped = Number.isInteger(value) ? value : 0
  if (clamped < 0) {
    return 0
  }
  if (clamped > max) {
    return max
  }
  return clamped
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
  const subagentExecutor = options.subagentExecutor ?? createScriptedSubagentExecutor()
  let runtimeConfigPromise: Promise<OpenCodeTeamConfig | undefined> | undefined

  async function resolveRuntimeConfig(): Promise<OpenCodeTeamConfig | undefined> {
    if (!runtimeConfigPromise) {
      runtimeConfigPromise = loadMergedConfig({
        projectDir: input.workingDirectory,
      }).then((loaded) => loaded.config).catch(() => undefined)
    }
    return runtimeConfigPromise
  }

  async function runRole<TPayload>(inputRole: {
    stage: WorkflowStage
    role: "orchestrator" | "plan" | "architect" | "critic" | "researcher" | "developer" | "tester" | "reviewer" | "documenter"
    index: number
    contextSuffix?: string
    requestedTools?: string[]
    execute: () => Promise<{
      decision: string
      payload: TPayload
      handoff: {
        currentStatus: string
        changedFiles: string[]
        openRisks: string[]
        nextAction: string
      }
      reasons?: string[]
      evidence?: string[]
    }>
  }): Promise<WorkflowAgentRun<TPayload>> {
    const runtimeConfig = await resolveRuntimeConfig()
    const nodeId = resolveNodeId(inputRole.stage, inputRole.role, inputRole.index, inputRole.contextSuffix)

    return runWorkflowAgent<{
      requestedTools: string[]
      execute: () => Promise<{
        decision: string
        payload: TPayload
        handoff: {
          currentStatus: string
          changedFiles: string[]
          openRisks: string[]
          nextAction: string
        }
        reasons?: string[]
        evidence?: string[]
      }>
    }, TPayload>({
      role: inputRole.role,
      stage: inputRole.stage,
      nodeId,
      workspaceRoot: input.workingDirectory,
      sessionId: createRoleSessionId(inputRole.stage, inputRole.role, inputRole.contextSuffix),
      context: {
        requestedTools: inputRole.requestedTools ?? [],
        execute: inputRole.execute,
      },
      executor: subagentExecutor,
      ...(runtimeConfig ? { config: runtimeConfig } : {}),
      ...(options.onToolPolicyEvaluated
        ? { onToolPolicyEvaluated: options.onToolPolicyEvaluated }
        : {}),
    })
  }

  return {
    requirements: async (context) => {
      const stage = "requirements"
      const roles = resolveStageAgentSequence(stage)
      const startIndex = normalizeRoleStartIndex(context.stageRoleStartIndex, roles.length)
      const newRuns: WorkflowAgentRunArtifact[] = []
      let completedRoleCount = startIndex
      let currentNode: string | null = `${stage}:stage`

      let requirementsTask = String(context.artifacts.requirementsTask ?? input.task)
      let researchContext = Array.isArray(context.artifacts.researchContext)
        ? context.artifacts.researchContext.map((item) => String(item))
        : []
      let systemInstructions = String(context.artifacts.systemInstructions ?? "")
      let systemInstructionSource = typeof context.artifacts.systemInstructionSource === "string"
        ? context.artifacts.systemInstructionSource
        : undefined
      let systemInstructionSources = Array.isArray(context.artifacts.systemInstructionSources)
        ? context.artifacts.systemInstructionSources.map((item) => String(item))
        : undefined
      let systemInstructionSessionFile = typeof context.artifacts.systemInstructionSessionFile === "string"
        ? context.artifacts.systemInstructionSessionFile
        : undefined

      for (let index = startIndex; index < roles.length; index += 1) {
        const role = roles[index]
        if (!role) {
          continue
        }

        currentNode = resolveNodeId(stage, role, index)

        try {
          if (role === "orchestrator") {
            const roleRun = await runRole<{
              requirementsTask: string
            }>({
              stage,
              role,
              index,
              requestedTools: ["read"],
              execute: async () => ({
                decision: "requirements_defined",
                payload: {
                  requirementsTask,
                },
                handoff: {
                  currentStatus: "requirements_defined",
                  changedFiles: [],
                  openRisks: [],
                  nextAction: "collect supporting context and proceed to planning",
                },
                evidence: [`task_length=${String(input.task.length)}`],
              }),
            })

            newRuns.push(toWorkflowAgentRunArtifact(roleRun))
            requirementsTask = roleRun.envelope.payload.requirementsTask
            systemInstructions = roleRun.instructions.content
            systemInstructionSource = roleRun.instructions.sourcePath
            systemInstructionSources = roleRun.instructions.sources
            systemInstructionSessionFile = roleRun.instructions.sessionFilePath
            completedRoleCount = index + 1
            continue
          }

          if (role === "researcher") {
            const roleRun = await runRole<{
              researchContext: string[]
            }>({
              stage,
              role,
              index,
              requestedTools: ["read", "glob", "grep"],
              execute: async () => {
                const collected = await collectResearchContextPaths(input.workingDirectory)
                return {
                  decision: "context_collected",
                  payload: {
                    researchContext: collected,
                  },
                  handoff: {
                    currentStatus: "research_context_ready",
                    changedFiles: [],
                    openRisks: [],
                    nextAction: "planning consumes collected context",
                  },
                  evidence: [`context_files=${String(collected.length)}`],
                }
              },
            })

            newRuns.push(toWorkflowAgentRunArtifact(roleRun))
            researchContext = roleRun.envelope.payload.researchContext
            completedRoleCount = index + 1
            continue
          }

          return {
            status: "failed",
            error: `subagent_graph_invalid: unsupported role '${role}' in requirements stage`,
            artifacts: {
              requirementsTask,
              researchContext,
              ...(systemInstructions.length > 0 ? { systemInstructions } : {}),
              ...(systemInstructionSource ? { systemInstructionSource } : {}),
              ...(systemInstructionSources ? { systemInstructionSources } : {}),
              ...(systemInstructionSessionFile ? { systemInstructionSessionFile } : {}),
              agentRuns: newRuns,
            },
            roleProgressCount: completedRoleCount,
            currentNode,
          }
        } catch (error) {
          const message = toErrorMessage(error)
          return {
            status: "failed",
            error: `subagent_failed: ${message}`,
            artifacts: {
              requirementsTask,
              researchContext,
              ...(systemInstructions.length > 0 ? { systemInstructions } : {}),
              ...(systemInstructionSource ? { systemInstructionSource } : {}),
              ...(systemInstructionSources ? { systemInstructionSources } : {}),
              ...(systemInstructionSessionFile ? { systemInstructionSessionFile } : {}),
              agentRuns: newRuns,
            },
            roleProgressCount: completedRoleCount,
            currentNode,
          }
        }
      }

      return {
        status: "completed",
        artifacts: {
          requirementsTask,
          researchContext,
          ...(systemInstructions.length > 0 ? { systemInstructions } : {}),
          ...(systemInstructionSource ? { systemInstructionSource } : {}),
          ...(systemInstructionSources ? { systemInstructionSources } : {}),
          ...(systemInstructionSessionFile ? { systemInstructionSessionFile } : {}),
          agentRuns: newRuns,
        },
        roleProgressCount: roles.length,
        currentNode: null,
      }
    },
    planning: async (context) => {
      const stage = "planning"
      const roles = resolveStageAgentSequence(stage)
      const newRuns: WorkflowAgentRunArtifact[] = []
      let completedRoleCount = 0
      let currentNode: string | null = `${stage}:stage`

      const roleIndexByName = new Map<string, number>()
      roles.forEach((role, index) => {
        roleIndexByName.set(role, index)
      })

      const planningHooks: Partial<ConsensusPlanningHooks> = {
        createDraft: async (planningContext) => {
          const role = "plan"
          const roleIndex = roleIndexByName.get(role)
          if (roleIndex === undefined) {
            throw new Error("planning graph missing plan role")
          }
          const nodeSuffix = `iter-${planningContext.iteration}`
          currentNode = resolveNodeId(stage, role, roleIndex, nodeSuffix)

          const roleRun = await runRole<PlanningDraft>({
            stage,
            role,
            index: roleIndex,
            contextSuffix: nodeSuffix,
            requestedTools: ["read", "glob", "grep"],
            execute: async () => {
              const draft = createDefaultPlanningDraft(planningContext)
              return {
                decision: "draft_ready",
                payload: draft,
                handoff: draft.handoff,
                evidence: [
                  `iteration=${String(planningContext.iteration)}`,
                  `risk=${planningContext.riskLevel}`,
                ],
              }
            },
          })

          newRuns.push(toWorkflowAgentRunArtifact(roleRun))
          completedRoleCount = Math.max(completedRoleCount, roleIndex + 1)
          return roleRun.envelope.payload
        },
        reviewArchitecture: async (planningContext) => {
          const role = "architect"
          const roleIndex = roleIndexByName.get(role)
          if (roleIndex === undefined) {
            throw new Error("planning graph missing architect role")
          }
          const nodeSuffix = `iter-${planningContext.iteration}`
          currentNode = resolveNodeId(stage, role, roleIndex, nodeSuffix)

          const roleRun = await runRole<ArchitectReview>({
            stage,
            role,
            index: roleIndex,
            contextSuffix: nodeSuffix,
            requestedTools: ["read", "glob", "grep"],
            execute: async () => {
              const review = createDefaultPlanningArchitectReview(planningContext)
              return {
                decision: "review_ready",
                payload: review,
                handoff: review.handoff,
                evidence: [
                  `iteration=${String(planningContext.iteration)}`,
                  `tension=${review.tradeoffTension}`,
                ],
              }
            },
          })

          newRuns.push(toWorkflowAgentRunArtifact(roleRun))
          completedRoleCount = Math.max(completedRoleCount, roleIndex + 1)
          return roleRun.envelope.payload
        },
        reviewCritic: async (planningContext) => {
          const role = "critic"
          const roleIndex = roleIndexByName.get(role)
          if (roleIndex === undefined) {
            throw new Error("planning graph missing critic role")
          }
          const nodeSuffix = `iter-${planningContext.iteration}`
          currentNode = resolveNodeId(stage, role, roleIndex, nodeSuffix)

          const roleRun = await runRole<CriticReview>({
            stage,
            role,
            index: roleIndex,
            contextSuffix: nodeSuffix,
            requestedTools: ["read", "glob", "grep"],
            execute: async () => {
              const review = createDefaultPlanningCriticReview(planningContext)
              return {
                decision: review.decision,
                payload: review,
                handoff: review.handoff,
                reasons: review.decision === "reject" ? review.reasons : [],
                evidence: [
                  `iteration=${String(planningContext.iteration)}`,
                  `validation_errors=${String(planningContext.validationErrors.length)}`,
                ],
              }
            },
          })

          newRuns.push(toWorkflowAgentRunArtifact(roleRun))
          completedRoleCount = Math.max(completedRoleCount, roleIndex + 1)
          return roleRun.envelope.payload
        },
      }

      try {
        const plan = await runConsensusPlanning(
          {
            problem: String(context.artifacts.requirementsTask ?? input.task),
          },
          {
            workspaceRoot: input.workingDirectory,
            artifactName: "workflow-plan",
            hooks: planningHooks,
          },
        )

        if (plan.status !== "approved") {
          return {
            status: "failed",
            error: `consensus planning rejected: ${plan.lastRejectReasons.join(", ") || "no reasons"}`,
            artifacts: {
              adrDecision: "planning_rejected",
              adrDrivers: ["consensus planning rejected"],
              handoff: {
                currentStatus: "planning_rejected",
                changedFiles: [],
                openRisks: plan.lastRejectReasons,
                nextAction: "resolve critic feedback and rerun planning",
              },
              agentRuns: newRuns,
            },
            roleProgressCount: completedRoleCount,
            currentNode,
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
            agentRuns: newRuns,
          },
          roleProgressCount: roles.length,
          currentNode: null,
        }
      } catch (error) {
        const message = toErrorMessage(error)
        return {
          status: "failed",
          error: `subagent_failed: ${message}`,
          artifacts: {
            adrDecision: String(context.artifacts.adrDecision ?? "planning_error"),
            adrDrivers: Array.isArray(context.artifacts.adrDrivers)
              ? context.artifacts.adrDrivers.map((item) => String(item))
              : ["planning role execution failed"],
            handoff: {
              currentStatus: "planning_failed",
              changedFiles: [],
              openRisks: [message],
              nextAction: "fix planning role execution and retry",
            },
            agentRuns: newRuns,
          },
          roleProgressCount: completedRoleCount,
          currentNode,
        }
      }
    },
    issue: async (context) => {
      const stage = "issue"
      const roles = resolveStageAgentSequence(stage)
      const startIndex = normalizeRoleStartIndex(context.stageRoleStartIndex, roles.length)
      const newRuns: WorkflowAgentRunArtifact[] = []
      let completedRoleCount = startIndex
      let currentNode: string | null = `${stage}:stage`

      let issueNumber = typeof context.artifacts.issueNumber === "number"
        ? context.artifacts.issueNumber
        : parseIssueNumberFromTask(String(context.artifacts.requirementsTask ?? input.task))
      const issueTitle = `Task: ${String(context.artifacts.requirementsTask ?? input.task)}`
      const issueBody = `Decision: ${String(context.artifacts.adrDecision ?? "n/a")}`

      for (let index = startIndex; index < roles.length; index += 1) {
        const role = roles[index]
        if (!role) continue
        currentNode = resolveNodeId(stage, role, index)

        if (role !== "orchestrator") {
          return {
            status: "failed",
            error: `subagent_graph_invalid: unsupported role '${role}' in issue stage`,
            artifacts: {
              ...(issueNumber !== null ? { issueNumber } : {}),
              issueTitle,
              issueBody,
              agentRuns: newRuns,
            },
            roleProgressCount: completedRoleCount,
            currentNode,
          }
        }

        try {
          const roleRun = await runRole<{
            issueNumber: number | null
            issueTitle: string
            issueBody: string
          }>({
            stage,
            role,
            index,
            requestedTools: options.githubAutomationAdapter ? ["github"] : ["read"],
            execute: async () => ({
              decision: "issue_drafted",
              payload: {
                issueNumber,
                issueTitle,
                issueBody,
              },
              handoff: {
                currentStatus: "issue_drafted",
                changedFiles: [],
                openRisks: [],
                nextAction: options.githubAutomationAdapter ? "create github issue" : "use issue draft",
              },
              evidence: [`task_ref=${String(context.artifacts.requirementsTask ?? input.task)}`],
            }),
          })

          newRuns.push(toWorkflowAgentRunArtifact(roleRun))
          issueNumber = roleRun.envelope.payload.issueNumber
          completedRoleCount = index + 1
        } catch (error) {
          const message = toErrorMessage(error)
          return {
            status: "failed",
            error: `subagent_failed: ${message}`,
            artifacts: {
              ...(issueNumber !== null ? { issueNumber } : {}),
              issueTitle,
              issueBody,
              issueDraft: {
                title: issueTitle,
                body: issueBody,
              },
              agentRuns: newRuns,
            },
            roleProgressCount: completedRoleCount,
            currentNode,
          }
        }
      }

      if (!options.githubAutomationAdapter) {
        return {
          status: "completed",
          artifacts: {
            ...(issueNumber !== null ? { issueNumber } : {}),
            issueTitle,
            issueBody,
            issueDraft: {
              title: issueTitle,
              body: issueBody,
            },
            agentRuns: newRuns,
          },
          roleProgressCount: roles.length,
          currentNode: null,
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
          agentRuns: newRuns,
        },
        roleProgressCount: roles.length,
        currentNode: null,
      }
    },
    development: async (context) => {
      const stage = "development"
      const roles = resolveStageAgentSequence(stage)
      const startIndex = normalizeRoleStartIndex(context.stageRoleStartIndex, roles.length)
      const newRuns: WorkflowAgentRunArtifact[] = []
      let completedRoleCount = startIndex
      let currentNode: string | null = `${stage}:stage`

      type DeveloperPayload = {
        status: "completed"
        implementationPlan: string
        testingPlan: string[]
        developmentExecution: {
          mode: "script" | "dry_run"
          scriptName: string | null
          changedFiles: string[]
          changeCount: number
        }
      } | {
        status: "blocked"
        reason: string
      }

      let developerOutput: {
        implementationPlan: string
        testingPlan: string[]
        developmentExecution: {
          mode: "script" | "dry_run"
          scriptName: string | null
          changedFiles: string[]
          changeCount: number
        }
        handoff: {
          currentStatus: string
          changedFiles: string[]
          openRisks: string[]
          nextAction: string
        }
      } | null = null

      if (startIndex > 0
        && typeof context.artifacts.implementationPlan === "string"
        && Array.isArray(context.artifacts.testingPlan)
        && isRecord(context.artifacts.developmentExecution)
        && Array.isArray(context.artifacts.developmentExecution.changedFiles)
        && typeof context.artifacts.developmentExecution.changeCount === "number"
      ) {
        developerOutput = {
          implementationPlan: context.artifacts.implementationPlan,
          testingPlan: context.artifacts.testingPlan.map((item) => String(item)),
          developmentExecution: {
            mode: context.artifacts.developmentExecution.mode === "script" ? "script" : "dry_run",
            scriptName: typeof context.artifacts.developmentExecution.scriptName === "string"
              ? context.artifacts.developmentExecution.scriptName
              : null,
            changedFiles: context.artifacts.developmentExecution.changedFiles.map((item) => String(item)),
            changeCount: Number(context.artifacts.developmentExecution.changeCount),
          },
          handoff: {
            currentStatus: "development_complete",
            changedFiles: context.artifacts.developmentExecution.changedFiles.map((item) => String(item)),
            openRisks: [],
            nextAction: "run testing stage",
          },
        }
      }

      let documentationSync = isRecord(context.artifacts.documentationSync)
        ? context.artifacts.documentationSync
        : undefined

      for (let index = startIndex; index < roles.length; index += 1) {
        const role = roles[index]
        if (!role) continue
        currentNode = resolveNodeId(stage, role, index)

        if (role === "developer") {
          try {
            const roleRun = await runRole<DeveloperPayload>({
              stage,
              role,
              index,
              requestedTools: ["read", "glob", "grep", "bash", "write", "edit"],
              execute: async () => {
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
                  const reason = "package.json exists but no development script (opencode:develop/develop:opencode/develop) is configured"
                  return {
                    decision: "request_changes",
                    payload: {
                      status: "blocked",
                      reason,
                    },
                    handoff: {
                      currentStatus: "development_blocked",
                      changedFiles: [],
                      openRisks: [reason],
                      nextAction: "add development script and rerun",
                    },
                    reasons: [reason],
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
                            task: String(context.artifacts.requirementsTask ?? input.task),
                            adrDecision: String(context.artifacts.adrDecision ?? input.task),
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
                          implementationPlan: String(context.artifacts.adrDecision ?? input.task),
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
                  const reason = execution.error ?? "ultrawork execution failed"
                  return {
                    decision: "request_changes",
                    payload: {
                      status: "blocked",
                      reason,
                    },
                    handoff: {
                      currentStatus: "development_blocked",
                      changedFiles: [],
                      openRisks: [reason],
                      nextAction: "fix development execution failure and retry",
                    },
                    reasons: [reason],
                  }
                }

                const gitRepo = await isGitRepository(input.workingDirectory)
                const changedFiles = gitRepo
                  ? await listCommittableGitPaths(input.workingDirectory)
                  : []

                if (gitRepo && changedFiles.length === 0) {
                  const reason = "development stage produced no committable code changes"
                  return {
                    decision: "request_changes",
                    payload: {
                      status: "blocked",
                      reason,
                    },
                    handoff: {
                      currentStatus: "development_blocked",
                      changedFiles: [],
                      openRisks: [reason],
                      nextAction: "produce committable changes and retry",
                    },
                    reasons: [reason],
                  }
                }

                return {
                  decision: "implementation_complete",
                  payload: {
                    status: "completed",
                    implementationPlan: String(context.artifacts.adrDecision ?? input.task),
                    testingPlan,
                    developmentExecution: {
                      mode: developmentScriptName ? "script" : "dry_run",
                      scriptName: developmentScriptName ?? null,
                      changedFiles,
                      changeCount: changedFiles.length,
                    },
                  },
                  handoff: {
                    currentStatus: "development_complete",
                    changedFiles,
                    openRisks: [],
                    nextAction: "run document sync and testing stage",
                  },
                  evidence: [
                    `changed_files=${String(changedFiles.length)}`,
                    `mode=${developmentScriptName ? "script" : "dry_run"}`,
                  ],
                }
              },
            })

            newRuns.push(toWorkflowAgentRunArtifact(roleRun))
            const payload = roleRun.envelope.payload
            if (payload.status === "blocked") {
              return {
                status: "failed",
                error: `schema_validation_failed: ${payload.reason}`,
                ...(developerOutput
                  ? {
                    artifacts: {
                      implementationPlan: developerOutput.implementationPlan,
                      testingPlan: developerOutput.testingPlan,
                      developmentExecution: developerOutput.developmentExecution,
                      handoff: developerOutput.handoff,
                      ...(documentationSync ? { documentationSync } : {}),
                      agentRuns: newRuns,
                    },
                  }
                  : {}),
                roleProgressCount: completedRoleCount,
                currentNode,
              }
            }

            developerOutput = {
              implementationPlan: payload.implementationPlan,
              testingPlan: payload.testingPlan,
              developmentExecution: payload.developmentExecution,
              handoff: roleRun.envelope.handoff,
            }
            completedRoleCount = index + 1
            continue
          } catch (error) {
            const message = toErrorMessage(error)
            return {
              status: "failed",
              error: `subagent_failed: ${message}`,
              ...(developerOutput
                ? {
                  artifacts: {
                    implementationPlan: developerOutput.implementationPlan,
                    testingPlan: developerOutput.testingPlan,
                    developmentExecution: developerOutput.developmentExecution,
                    handoff: developerOutput.handoff,
                    ...(documentationSync ? { documentationSync } : {}),
                    agentRuns: newRuns,
                  },
                }
                : {}),
              roleProgressCount: completedRoleCount,
              currentNode,
            }
          }
        }

        if (role === "documenter") {
          if (!developerOutput) {
            return {
              status: "failed",
              error: "schema_validation_failed: documenter requires developer output",
              roleProgressCount: completedRoleCount,
              currentNode,
            }
          }

          const stableDeveloperOutput = developerOutput

          try {
            const roleRun = await runRole<{
              role: "documenter"
              summary: string
              updatedDocs: string[]
              reportPath: string
              sourceOfTruth: string[]
            }>({
              stage,
              role,
              index,
              requestedTools: ["read", "glob", "grep", "write", "edit"],
              execute: async () => {
                const sync = await runDocumenterSync({
                  workingDirectory: input.workingDirectory,
                  task: String(context.artifacts.requirementsTask ?? input.task),
                  adrDecision: String(context.artifacts.adrDecision ?? input.task),
                  changedFiles: stableDeveloperOutput.developmentExecution.changedFiles,
                })

                return {
                  decision: "docs_synced",
                  payload: sync,
                  handoff: {
                    currentStatus: "docs_synced",
                    changedFiles: [sync.reportPath],
                    openRisks: [],
                    nextAction: "run testing stage",
                  },
                  evidence: [`updated_docs=${String(sync.updatedDocs.length)}`],
                }
              },
            })

            newRuns.push(toWorkflowAgentRunArtifact(roleRun))
            documentationSync = roleRun.envelope.payload
            completedRoleCount = index + 1
            continue
          } catch (error) {
            const message = toErrorMessage(error)
            return {
              status: "failed",
              error: `subagent_failed: ${message}`,
              artifacts: {
                implementationPlan: developerOutput.implementationPlan,
                testingPlan: developerOutput.testingPlan,
                ...(developerOutput.developmentExecution.scriptName
                  ? { developmentScriptName: developerOutput.developmentExecution.scriptName }
                  : {}),
                developmentExecution: developerOutput.developmentExecution,
                handoff: developerOutput.handoff,
                ...(documentationSync ? { documentationSync } : {}),
                agentRuns: newRuns,
              },
              roleProgressCount: completedRoleCount,
              currentNode,
            }
          }
        }

        return {
          status: "failed",
          error: `subagent_graph_invalid: unsupported role '${role}' in development stage`,
          ...(developerOutput
            ? {
              artifacts: {
                implementationPlan: developerOutput.implementationPlan,
                testingPlan: developerOutput.testingPlan,
                developmentExecution: developerOutput.developmentExecution,
                handoff: developerOutput.handoff,
                ...(documentationSync ? { documentationSync } : {}),
                agentRuns: newRuns,
              },
            }
            : {}),
          roleProgressCount: completedRoleCount,
          currentNode,
        }
      }

      if (!developerOutput) {
        return {
          status: "failed",
          error: "schema_validation_failed: development output missing",
          roleProgressCount: completedRoleCount,
          currentNode,
        }
      }

      return {
        status: "completed",
        artifacts: {
          implementationPlan: developerOutput.implementationPlan,
          testingPlan: developerOutput.testingPlan,
          ...(developerOutput.developmentExecution.scriptName
            ? { developmentScriptName: developerOutput.developmentExecution.scriptName }
            : {}),
          developmentExecution: developerOutput.developmentExecution,
          handoff: developerOutput.handoff,
          ...(documentationSync ? { documentationSync } : {}),
          agentRuns: newRuns,
        },
        roleProgressCount: roles.length,
        currentNode: null,
      }
    },
    testing: async (context) => {
      const stage = "testing"
      const roles = resolveStageAgentSequence(stage)
      const startIndex = normalizeRoleStartIndex(context.stageRoleStartIndex, roles.length)
      const newRuns: WorkflowAgentRunArtifact[] = []
      let completedRoleCount = startIndex
      let currentNode: string | null = `${stage}:stage`

      const testingPlan = Array.isArray(context.artifacts.testingPlan)
        ? context.artifacts.testingPlan.map((item) => String(item))
        : []

      for (let index = startIndex; index < roles.length; index += 1) {
        const role = roles[index]
        if (!role) continue
        currentNode = resolveNodeId(stage, role, index)

        if (role !== "tester") {
          return {
            status: "failed",
            error: `subagent_graph_invalid: unsupported role '${role}' in testing stage`,
            artifacts: {
              verificationPassed: false,
              handoff: {
                currentStatus: "testing_failed",
                changedFiles: [],
                openRisks: [`unsupported testing role: ${role}`],
                nextAction: "fix stage role graph",
              },
              agentRuns: newRuns,
            },
            roleProgressCount: completedRoleCount,
            currentNode,
          }
        }

        try {
          const roleRun = await runRole<{
            verificationPassed: boolean
            verificationFailedCommand?: string
          }>({
            stage,
            role,
            index,
            requestedTools: ["bash", "read", "glob", "grep"],
            execute: async () => {
              for (const command of testingPlan) {
                if (!isAllowedVerificationCommand(command)) {
                  return {
                    decision: "request_changes",
                    payload: {
                      verificationPassed: false,
                      verificationFailedCommand: command,
                    },
                    handoff: {
                      currentStatus: "testing_failed",
                      changedFiles: [],
                      openRisks: [`disallowed verification command: ${command}`],
                      nextAction: "replace with allowlisted verification command",
                    },
                    reasons: [`disallowed verification command: ${command}`],
                  }
                }

                try {
                  await executeVerificationCommand(input.workingDirectory, command)
                } catch (error) {
                  return {
                    decision: "request_changes",
                    payload: {
                      verificationPassed: false,
                      verificationFailedCommand: command,
                    },
                    handoff: {
                      currentStatus: "testing_failed",
                      changedFiles: [],
                      openRisks: [`verification command failed: ${command}`],
                      nextAction: "fix failing command and retry",
                    },
                    reasons: [`verification command failed: ${command}`],
                    evidence: [String(error)],
                  }
                }
              }

              const verify = await runRalphLoop(async () => ({
                signals: {
                  todosDone: typeof context.artifacts.implementationPlan === "string"
                    && context.artifacts.implementationPlan.length > 0,
                  testsPassed: testingPlan.length === 0 || testingPlan.some((item) => item.includes("npm test")),
                  buildPassed: testingPlan.length === 0 || testingPlan.some((item) => item.includes("npm run build")),
                  reviewApproved: typeof context.artifacts.adrDecision === "string"
                    && context.artifacts.adrDecision.length > 0,
                },
              }), { maxIterations: 1 })

              if (verify.status !== "completed") {
                return {
                  decision: "request_changes",
                  payload: {
                    verificationPassed: false,
                  },
                  handoff: {
                    currentStatus: "testing_failed",
                    changedFiles: [],
                    openRisks: [verify.reason],
                    nextAction: "resolve ralph verification signals and retry",
                  },
                  reasons: [verify.reason],
                }
              }

              return {
                decision: "approve",
                payload: {
                  verificationPassed: true,
                },
                handoff: {
                  currentStatus: "testing_passed",
                  changedFiles: [],
                  openRisks: [],
                  nextAction: "continue to merge stage",
                },
                evidence: [`commands=${String(testingPlan.length)}`],
              }
            },
          })

          newRuns.push(toWorkflowAgentRunArtifact(roleRun))
          const failedCommand = roleRun.envelope.payload.verificationFailedCommand

          if (!roleRun.envelope.payload.verificationPassed) {
            const disallowedReason = roleRun.envelope.reasons.find((reason) => reason.startsWith("disallowed verification command:"))
            return {
              status: "failed",
              error: disallowedReason
                ? `schema_validation_failed: verification command not allowed: ${failedCommand ?? disallowedReason}`
                : (failedCommand
                  ? `schema_validation_failed: verification command failed: ${failedCommand}`
                  : `schema_validation_failed: ${roleRun.envelope.reasons.join(", ") || "testing verification failed"}`),
              artifacts: {
                verificationPassed: false,
                ...(failedCommand ? { verificationFailedCommand: failedCommand } : {}),
                handoff: roleRun.envelope.handoff,
                agentRuns: newRuns,
              },
              roleProgressCount: completedRoleCount,
              currentNode,
            }
          }

          completedRoleCount = index + 1
        } catch (error) {
          const message = toErrorMessage(error)
          const isPolicyError = error instanceof WorkflowAgentExecutionError && error.code === "tool_policy_denied"
          return {
            status: "failed",
            error: `${isPolicyError ? "schema_validation_failed" : "subagent_failed"}: ${message}`,
            artifacts: {
              verificationPassed: false,
              handoff: {
                currentStatus: "testing_failed",
                changedFiles: [],
                openRisks: [message],
                nextAction: "fix testing role failure and retry",
              },
              agentRuns: newRuns,
            },
            roleProgressCount: completedRoleCount,
            currentNode,
          }
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
          agentRuns: newRuns,
        },
        roleProgressCount: roles.length,
        currentNode: null,
      }
    },
    merge: async (context) => {
      const stage = "merge"
      const roles = resolveStageAgentSequence(stage)
      const startIndex = normalizeRoleStartIndex(context.stageRoleStartIndex, roles.length)
      const newRuns: WorkflowAgentRunArtifact[] = []
      let completedRoleCount = startIndex
      let currentNode: string | null = `${stage}:stage`

      let gateDecision = context.artifacts.reviewGateDecision === "request_changes"
        ? "request_changes"
        : (context.artifacts.reviewGateDecision === "approve" ? "approve" : null)
      let reviewerHandoff = isRecord(context.artifacts.handoff)
        ? {
          currentStatus: String(context.artifacts.handoff.currentStatus ?? "review_pending"),
          changedFiles: Array.isArray(context.artifacts.handoff.changedFiles)
            ? context.artifacts.handoff.changedFiles.map((item) => String(item))
            : [],
          openRisks: Array.isArray(context.artifacts.handoff.openRisks)
            ? context.artifacts.handoff.openRisks.map((item) => String(item))
            : [],
          nextAction: String(context.artifacts.handoff.nextAction ?? "continue merge"),
        }
        : {
          currentStatus: "review_pending",
          changedFiles: [],
          openRisks: [],
          nextAction: "run reviewer gate",
        }

      for (let index = startIndex; index < roles.length; index += 1) {
        const role = roles[index]
        if (!role) continue
        currentNode = resolveNodeId(stage, role, index)

        if (role === "reviewer") {
          try {
            const roleRun = await runRole<{ gateDecision: "approve" | "request_changes" }>({
              stage,
              role,
              index,
              requestedTools: ["read", "glob", "grep"],
              execute: async () => {
                const openRisks: string[] = []
                if (context.artifacts.verificationPassed !== true) {
                  openRisks.push("testing stage did not pass")
                }
                if (!context.artifacts.documentationSync || typeof context.artifacts.documentationSync !== "object") {
                  openRisks.push("documentation sync result missing")
                }

                const decision = openRisks.length > 0 ? "request_changes" : "approve"
                return {
                  decision,
                  payload: {
                    gateDecision: decision,
                  },
                  handoff: {
                    currentStatus: decision === "approve" ? "review_approved" : "review_changes_requested",
                    changedFiles: [],
                    openRisks,
                    nextAction: decision === "approve"
                      ? "proceed to merge execution"
                      : "resolve review risks before merge",
                  },
                  reasons: openRisks,
                }
              },
            })

            newRuns.push(toWorkflowAgentRunArtifact(roleRun))
            gateDecision = roleRun.envelope.payload.gateDecision
            reviewerHandoff = roleRun.envelope.handoff
            completedRoleCount = index + 1
            continue
          } catch (error) {
            const message = toErrorMessage(error)
            return {
              status: "failed",
              error: `subagent_failed: ${message}`,
              artifacts: {
                mergeReady: false,
                reviewGateDecision: gateDecision ?? "request_changes",
                handoff: reviewerHandoff,
                agentRuns: newRuns,
              },
              roleProgressCount: completedRoleCount,
              currentNode,
            }
          }
        }

        if (role === "orchestrator") {
          try {
            const roleRun = await runRole<{ mergeStrategy: string }>({
              stage,
              role,
              index,
              requestedTools: options.githubAutomationAdapter ? ["github", "bash"] : ["read"],
              execute: async () => ({
                decision: "merge_plan_ready",
                payload: {
                  mergeStrategy: "github_automation",
                },
                handoff: {
                  currentStatus: "merge_ready",
                  changedFiles: [],
                  openRisks: reviewerHandoff.openRisks,
                  nextAction: "run merge adapter",
                },
                evidence: [`review_decision=${gateDecision ?? "unknown"}`],
              }),
            })

            newRuns.push(toWorkflowAgentRunArtifact(roleRun))
            completedRoleCount = index + 1
            continue
          } catch (error) {
            const message = toErrorMessage(error)
            return {
              status: "failed",
              error: `subagent_failed: ${message}`,
              artifacts: {
                mergeReady: false,
                reviewGateDecision: gateDecision ?? "request_changes",
                handoff: reviewerHandoff,
                agentRuns: newRuns,
              },
              roleProgressCount: completedRoleCount,
              currentNode,
            }
          }
        }

        return {
          status: "failed",
          error: `subagent_graph_invalid: unsupported role '${role}' in merge stage`,
          artifacts: {
            mergeReady: false,
            reviewGateDecision: gateDecision ?? "request_changes",
            handoff: reviewerHandoff,
            agentRuns: newRuns,
          },
          roleProgressCount: completedRoleCount,
          currentNode,
        }
      }

      if (gateDecision !== "approve") {
        return {
          status: "failed",
          error: `schema_validation_failed: merge gate rejected: ${reviewerHandoff.openRisks.join(", ")}`,
          artifacts: {
            mergeReady: false,
            reviewGateDecision: gateDecision ?? "request_changes",
            handoff: reviewerHandoff,
            agentRuns: newRuns,
          },
          roleProgressCount: completedRoleCount,
          currentNode,
        }
      }

      if (!options.githubAutomationAdapter) {
        return {
          status: "completed",
          artifacts: {
            mergeReady: false,
            reviewGateDecision: gateDecision,
            handoff: {
              currentStatus: "merge_skipped",
              changedFiles: [],
              openRisks: ["github automation adapter missing"],
              nextAction: "configure github adapter or merge manually",
            },
            agentRuns: newRuns,
          },
          roleProgressCount: roles.length,
          currentNode: null,
        }
      }

      const config = await loadMergedConfig({
        projectDir: input.workingDirectory,
      })
      const requireUserApproval = options.requireUserApproval
        ?? config.config.merge_policy.require_user_approval
      const issueNumber = typeof context.artifacts.issueNumber === "number"
        ? context.artifacts.issueNumber
        : parseIssueNumberFromTask(String(context.artifacts.requirementsTask ?? input.task))
      const issueReference = issueNumber ?? 0
      const branchName = `task/${issueReference}-${sanitizeSlug(String(context.artifacts.requirementsTask ?? input.task))}`

      const prepareLocalBranchForPullRequest = options.prepareLocalBranchForPullRequest
        ?? defaultPrepareLocalBranchForPullRequest
      const preferredPaths = resolvePreferredCommitPaths(input.workingDirectory, context.artifacts)
      const prepare = await prepareLocalBranchForPullRequest({
        workingDirectory: input.workingDirectory,
        branchName,
        issueNumber: issueReference,
        task: String(context.artifacts.requirementsTask ?? input.task),
        ...(preferredPaths.length > 0 ? { preferredPaths } : {}),
      })
      if (!prepare.ok) {
        return {
          status: "failed",
          error: `handoff_missing: merge prerequisites failed: ${prepare.reason ?? "unknown reason"}`,
          artifacts: {
            mergeReady: false,
            reviewGateDecision: gateDecision,
            handoff: {
              currentStatus: "merge_blocked",
              changedFiles: [],
              openRisks: [prepare.reason ?? "unknown merge prerequisite failure"],
              nextAction: "resolve prerequisites and retry merge",
            },
            agentRuns: newRuns,
          },
          roleProgressCount: roles.length,
          currentNode,
        }
      }

      const automation = await runGithubAutomation(
        options.githubAutomationAdapter,
        {
          workingDirectory: input.workingDirectory,
          issueTitle: String(context.artifacts.issueTitle ?? `Task: ${input.task}`),
          issueBody: String(context.artifacts.issueBody ?? `Decision: ${String(context.artifacts.adrDecision ?? "n/a")}`),
          ...(typeof context.artifacts.issueNumber === "number" && typeof context.artifacts.issueUrl === "string"
            ? {
              issueNumber: context.artifacts.issueNumber,
              issueUrl: context.artifacts.issueUrl,
            }
            : {}),
          branchName,
          prTitle: String(context.artifacts.issueTitle ?? `Task: ${input.task}`),
          summary: [
            String(context.artifacts.adrDecision ?? "workflow decision"),
            `implementation: ${String(context.artifacts.implementationPlan ?? "n/a")}`,
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
          reviewGateDecision: gateDecision,
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
          agentRuns: newRuns,
        },
        roleProgressCount: roles.length,
        currentNode: null,
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

interface WorkflowStateV1 {
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

function isWorkflowStage(value: unknown): value is WorkflowStage {
  return typeof value === "string" && WORKFLOW_STAGES.includes(value as WorkflowStage)
}

function isWorkflowStateV1(value: unknown): value is WorkflowStateV1 {
  if (!isRecord(value)) {
    return false
  }
  return value.version === 1
    && (value.status === "in_progress" || value.status === "completed" || value.status === "failed")
    && (value.currentStage === null || isWorkflowStage(value.currentStage))
    && Array.isArray(value.completedStages)
}

function parseStageFromNode(node: string | null): WorkflowStage | null {
  if (!node) {
    return null
  }
  const [stage] = node.split(":")
  if (!stage || !isWorkflowStage(stage)) {
    return null
  }
  return stage
}

function flattenAgentRunsByStage(
  byStage: Partial<Record<WorkflowStage, WorkflowAgentRunArtifact[]>>,
): WorkflowAgentRunArtifact[] {
  const flattened: WorkflowAgentRunArtifact[] = []
  for (const stage of WORKFLOW_STAGES) {
    const stageRuns = byStage[stage]
    if (stageRuns && stageRuns.length > 0) {
      flattened.push(...stageRuns)
    }
  }
  return flattened
}

function migrateWorkflowState(raw: WorkflowState | WorkflowStateV1): WorkflowState {
  if (!isPrefix(raw.completedStages, WORKFLOW_STAGES)) {
    throw new Error("Invalid workflow state: completedStages are not a valid stage prefix")
  }

  if (raw.version === 2) {
    const rawRoleProgress = isRecord(raw.roleProgressByStage)
      ? raw.roleProgressByStage as Partial<Record<WorkflowStage, number>>
      : {}
    const rawRunsByStage = isRecord(raw.agentRunsByStage)
      ? raw.agentRunsByStage as Partial<Record<WorkflowStage, WorkflowAgentRunArtifact[]>>
      : {}

    const mergedAgentRunsByStage: Partial<Record<WorkflowStage, WorkflowAgentRunArtifact[]>> = {}
    for (const stage of WORKFLOW_STAGES) {
      mergedAgentRunsByStage[stage] = [...(rawRunsByStage[stage] ?? [])]
    }

    return {
      ...raw,
      currentNode: raw.currentNode ?? null,
      roleProgressByStage: { ...rawRoleProgress },
      agentRunsByStage: mergedAgentRunsByStage,
      artifacts: {
        ...raw.artifacts,
        agentRunsByStage: mergedAgentRunsByStage,
        agentRuns: flattenAgentRunsByStage(mergedAgentRunsByStage),
      },
    }
  }

  const roleProgressByStage: Partial<Record<WorkflowStage, number>> = {}
  for (const stage of WORKFLOW_STAGES) {
    if (raw.completedStages.includes(stage)) {
      roleProgressByStage[stage] = resolveStageAgentSequence(stage).length
    }
  }

  const agentRunsByStage: Partial<Record<WorkflowStage, WorkflowAgentRunArtifact[]>> = {}
  for (const stage of WORKFLOW_STAGES) {
    const stageArtifacts = raw.artifactsByStage[stage]
    if (stageArtifacts && Array.isArray(stageArtifacts.agentRuns)) {
      agentRunsByStage[stage] = stageArtifacts.agentRuns as WorkflowAgentRunArtifact[]
    }
  }

  const currentNode = raw.currentStage ? `${raw.currentStage}:stage` : null
  if (raw.currentStage && roleProgressByStage[raw.currentStage] === undefined) {
    roleProgressByStage[raw.currentStage] = 0
  }

  return {
    version: 2,
    status: raw.status,
    currentStage: raw.currentStage,
    currentNode,
    completedStages: [...raw.completedStages],
    roleProgressByStage,
    agentRunsByStage,
    artifactsByStage: { ...raw.artifactsByStage },
    artifacts: {
      ...raw.artifacts,
      agentRunsByStage,
      agentRuns: flattenAgentRunsByStage(agentRunsByStage),
    },
    ...(raw.failedStage ? { failedStage: raw.failedStage } : {}),
    ...(raw.error ? { error: raw.error } : {}),
    updatedAt: raw.updatedAt,
  }
}

function mergeAgentRunsForStage(input: {
  state: WorkflowState
  stage: WorkflowStage
  stageArtifacts: Record<string, unknown>
}): {
  mergedByStage: Partial<Record<WorkflowStage, WorkflowAgentRunArtifact[]>>
  mergedStageArtifacts: Record<string, unknown>
} {
  const previousRuns = input.state.agentRunsByStage[input.stage] ?? []
  const incomingRuns = Array.isArray(input.stageArtifacts.agentRuns)
    ? input.stageArtifacts.agentRuns as WorkflowAgentRunArtifact[]
    : []
  const mergedStageRuns = [...previousRuns, ...incomingRuns]

  const mergedByStage: Partial<Record<WorkflowStage, WorkflowAgentRunArtifact[]>> = {
    ...input.state.agentRunsByStage,
    [input.stage]: mergedStageRuns,
  }

  return {
    mergedByStage,
    mergedStageArtifacts: {
      ...input.stageArtifacts,
      agentRuns: incomingRuns,
    },
  }
}

async function writeWorkflowState(path: string, state: WorkflowState): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`)
}

async function readWorkflowState(path: string): Promise<WorkflowState | null> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (isWorkflowStateV1(parsed) || (isRecord(parsed) && parsed.version === 2)) {
      return migrateWorkflowState(parsed as WorkflowState | WorkflowStateV1)
    }
    throw new Error("Invalid workflow state payload")
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
  if (state.status === "completed") {
    return WORKFLOW_STAGES.length
  }

  const nodeStage = parseStageFromNode(state.currentNode)
  if (nodeStage) {
    return WORKFLOW_STAGES.indexOf(nodeStage)
  }

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

    const stageRoleStartIndex = shouldResume && i === startIndex
      ? normalizeRoleStartIndex(state.roleProgressByStage[stage] ?? 0, resolveStageAgentSequence(stage).length)
      : 0

    const stageNode = `${stage}:stage`

    state = {
      ...stateWithoutFailure,
      status: "in_progress",
      currentStage: stage,
      currentNode: stageNode,
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
      stageRoleStartIndex,
    })

    const stageArtifactsRaw = executionResult.artifacts ?? {}
    const { mergedByStage, mergedStageArtifacts } = mergeAgentRunsForStage({
      state,
      stage,
      stageArtifacts: stageArtifactsRaw,
    })

    const stageArtifacts = mergedStageArtifacts
    if (executionResult.status === "completed" || executionResult.artifacts !== undefined) {
      assertStageArtifactContract(stage, stageArtifacts)
    }

    const flattenedAgentRuns = flattenAgentRunsByStage(mergedByStage)
    const stageRoleCount = resolveStageAgentSequence(stage).length
    const nextRoleProgress = executionResult.roleProgressCount !== undefined
      ? normalizeRoleStartIndex(executionResult.roleProgressCount, stageRoleCount)
      : (executionResult.status === "completed" ? stageRoleCount : (state.roleProgressByStage[stage] ?? 0))

    state = {
      ...state,
      currentNode: executionResult.currentNode === undefined
        ? state.currentNode
        : executionResult.currentNode,
      roleProgressByStage: {
        ...state.roleProgressByStage,
        [stage]: nextRoleProgress,
      },
      agentRunsByStage: mergedByStage,
      artifactsByStage: {
        ...state.artifactsByStage,
        [stage]: stageArtifacts,
      },
      artifacts: {
        ...state.artifacts,
        ...stageArtifacts,
        agentRunsByStage: mergedByStage,
        agentRuns: flattenedAgentRuns,
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
        currentNode: executionResult.currentNode ?? state.currentNode ?? stageNode,
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
      currentNode: null,
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
    currentNode: null,
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
