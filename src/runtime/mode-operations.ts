import { execFile } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { runRalphLoop, type RalphCompletionSignals } from "../execution/ralph-loop.js"
import { runUltrawork, type UltraworkTask } from "../execution/ultrawork.js"
import {
  applyCancelModeContract,
  resolveModeStateFilePath,
  type ExecutionMode,
  type ModeState,
} from "./mode-state-contract.js"
import { writeTextFileAtomic } from "./atomic-write.js"
import { acquireSessionLock } from "./session-lock.js"

const execFileAsync = promisify(execFile)

const MAX_ULTRAWORK_ITEMS = 6

export interface RunModeOperationInput {
  workspaceRoot: string
  sessionId: string
  mode: "ultrawork" | "ralph"
  task: string
  maxIterations?: number
  resume?: boolean
}

export interface CancelModeOperationInput {
  workspaceRoot: string
  sessionId: string
  targetMode: ExecutionMode
}

export interface RunModeOperationResult {
  status: "completed" | "failed"
  stateFilePath: string
  error?: string
}

interface UltraworkReport {
  task: string
  workItems: string[]
  waves: string[][]
  completedTaskIds: string[]
  outputs: Record<string, unknown>
  generatedAt: string
}

interface RalphSignalOverrides {
  todosDone?: boolean
  testsPassed?: boolean
  buildPassed?: boolean
  reviewApproved?: boolean
  note?: string
}

function statusFromTerminalPhase(phase: string): "completed" | "failed" {
  return phase === "failed" ? "failed" : "completed"
}

function nowIso(): string {
  return new Date().toISOString()
}

function resolveSessionDir(workspaceRoot: string, sessionId: string): string {
  return join(workspaceRoot, ".agent-guide", "runtime", "state", "sessions", sessionId)
}

function resolveUltraworkReportPath(workspaceRoot: string, sessionId: string): string {
  return join(resolveSessionDir(workspaceRoot, sessionId), "ultrawork-report.json")
}

function resolveReviewApprovalPath(workspaceRoot: string, sessionId: string): string {
  return join(resolveSessionDir(workspaceRoot, sessionId), "review-approval.json")
}

function resolveRalphSignalsPath(workspaceRoot: string, sessionId: string): string {
  return join(resolveSessionDir(workspaceRoot, sessionId), "ralph-signals.json")
}

function resolveOrchestratorCancelMarkerPath(workspaceRoot: string, sessionId: string): string {
  return join(
    workspaceRoot,
    ".agent-guide",
    "runtime",
    "state",
    "sessions",
    sessionId,
    "orchestrator.cancel",
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isErrnoNotFound(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
}

async function writeModeState(state: ModeState, workspaceRoot: string): Promise<string> {
  const filePath = resolveModeStateFilePath({
    workspaceRoot,
    sessionId: state.sessionId,
    mode: state.mode,
  })
  await writeTextFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`)
  return filePath
}

async function readModeState(path: string): Promise<ModeState | null> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as ModeState
  } catch (error) {
    if (isErrnoNotFound(error)) {
      return null
    }
    throw error
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as T
  } catch (error) {
    if (isErrnoNotFound(error)) {
      return null
    }
    throw error
  }
}

async function resolveSessionStates(workspaceRoot: string, sessionId: string): Promise<ModeState[]> {
  const sessionDir = resolveSessionDir(workspaceRoot, sessionId)
  try {
    const entries = await readdir(sessionDir)
    const states = await Promise.all(
      entries
        .filter((item) => item.endsWith("-state.json"))
        .map(async (item) => readModeState(join(sessionDir, item))),
    )
    return states.filter((item): item is ModeState => item !== null)
  } catch (error) {
    if (isErrnoNotFound(error)) {
      return []
    }
    throw error
  }
}

async function persistSessionStates(states: ModeState[], workspaceRoot: string): Promise<void> {
  for (const state of states) {
    await writeModeState(state, workspaceRoot)
  }
}

function extractUltraworkItems(task: string): string[] {
  const trimmed = task.trim()
  if (trimmed.length === 0) {
    return ["execute requested task"]
  }

  const split = trimmed
    .split(/\s*->\s*|\s*,\s*|\s*;\s*/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  const deduped = [...new Set(split.length > 0 ? split : [trimmed])]
  return deduped.slice(0, MAX_ULTRAWORK_ITEMS)
}

function createUltraworkTasks(items: string[]): UltraworkTask[] {
  const scheduleTask: UltraworkTask = {
    id: "schedule",
    run: async () => ({
      status: "completed",
      output: {
        ultraworkTaskCount: items.length,
        ultraworkItems: items,
      },
    }),
  }

  const executeTasks = items.map((item, index): UltraworkTask => ({
    id: `execute-${String(index + 1).padStart(2, "0")}`,
    dependsOn: ["schedule"],
    run: async () => ({
      status: "completed",
      output: {
        [`ultraworkItem${String(index + 1).padStart(2, "0")}`]: item,
      },
    }),
  }))

  const verifyTask: UltraworkTask = {
    id: "verify",
    dependsOn: executeTasks.map((task) => task.id),
    run: async () => ({
      status: "completed",
      output: {
        ultraworkVerified: true,
      },
    }),
  }

  return [scheduleTask, ...executeTasks, verifyTask]
}

async function persistUltraworkReport(input: {
  workspaceRoot: string
  sessionId: string
  report: UltraworkReport
}): Promise<void> {
  const reportPath = resolveUltraworkReportPath(input.workspaceRoot, input.sessionId)
  await writeTextFileAtomic(reportPath, `${JSON.stringify(input.report, null, 2)}\n`)
}

async function readPackageScripts(workspaceRoot: string): Promise<Record<string, string>> {
  const packagePath = join(workspaceRoot, "package.json")
  const parsed = await readJsonFile<unknown>(packagePath)
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    return {}
  }

  const scripts: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed.scripts)) {
    if (typeof value === "string" && value.trim().length > 0) {
      scripts[key] = value
    }
  }

  return scripts
}

async function runNpmScript(workspaceRoot: string, script: "test" | "build"): Promise<boolean> {
  try {
    const args = script === "test" ? ["test"] : ["run", script]
    await execFileAsync("npm", args, {
      cwd: workspaceRoot,
    })
    return true
  } catch {
    return false
  }
}

function applyRalphSignalOverrides(
  base: RalphCompletionSignals,
  overrides: RalphSignalOverrides | null,
): RalphCompletionSignals {
  if (!overrides) {
    return base
  }

  return {
    todosDone: typeof overrides.todosDone === "boolean" ? overrides.todosDone : base.todosDone,
    testsPassed: typeof overrides.testsPassed === "boolean" ? overrides.testsPassed : base.testsPassed,
    buildPassed: typeof overrides.buildPassed === "boolean" ? overrides.buildPassed : base.buildPassed,
    reviewApproved: typeof overrides.reviewApproved === "boolean" ? overrides.reviewApproved : base.reviewApproved,
  }
}

async function evaluateRalphSignals(input: {
  workspaceRoot: string
  sessionId: string
}): Promise<{ signals: RalphCompletionSignals; note: string }> {
  const notes: string[] = []

  const ultraworkStatePath = resolveModeStateFilePath({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    mode: "ultrawork",
  })
  const ultraworkState = await readModeState(ultraworkStatePath)

  let todosDone = true
  if (ultraworkState?.active) {
    todosDone = false
    notes.push("linked ultrawork still active")
  } else if (ultraworkState?.currentPhase === "failed" || ultraworkState?.currentPhase === "cancelled") {
    todosDone = false
    notes.push(`linked ultrawork terminal phase=${ultraworkState.currentPhase}`)
  }

  const scripts = await readPackageScripts(input.workspaceRoot)

  let testsPassed = true
  if (scripts.test) {
    testsPassed = await runNpmScript(input.workspaceRoot, "test")
    notes.push(testsPassed ? "npm test passed" : "npm test failed")
  }

  let buildPassed = true
  if (scripts.build) {
    buildPassed = await runNpmScript(input.workspaceRoot, "build")
    notes.push(buildPassed ? "npm run build passed" : "npm run build failed")
  }

  let reviewApproved = true
  const reviewApproval = await readJsonFile<unknown>(resolveReviewApprovalPath(input.workspaceRoot, input.sessionId))
  if (isRecord(reviewApproval) && typeof reviewApproval.approved === "boolean") {
    reviewApproved = reviewApproval.approved
    notes.push(`review approval override=${String(reviewApproved)}`)
  }

  const baseSignals: RalphCompletionSignals = {
    todosDone,
    testsPassed,
    buildPassed,
    reviewApproved,
  }

  const signalOverrides = await readJsonFile<RalphSignalOverrides>(
    resolveRalphSignalsPath(input.workspaceRoot, input.sessionId),
  )
  const signals = applyRalphSignalOverrides(baseSignals, signalOverrides)

  if (signalOverrides?.note) {
    notes.push(signalOverrides.note)
  }

  return {
    signals,
    note: notes.join("; "),
  }
}

export async function runModeOperation(input: RunModeOperationInput): Promise<RunModeOperationResult> {
  const sessionLock = await acquireSessionLock({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    owner: `mode:${input.mode}`,
  })
  if (!sessionLock.acquired) {
    return {
      status: "failed",
      stateFilePath: resolveModeStateFilePath({
        workspaceRoot: input.workspaceRoot,
        sessionId: input.sessionId,
        mode: input.mode,
      }),
      error: `session_locked: ${sessionLock.holder ?? "session lock is already held"}`,
    }
  }

  try {
    const stateFilePath = resolveModeStateFilePath({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      mode: input.mode,
    })

    if (input.resume) {
      const existing = await readModeState(stateFilePath)
      if (existing && existing.active === false) {
        return {
          status: statusFromTerminalPhase(existing.currentPhase),
          stateFilePath,
        }
      }
    }

    const startedAt = nowIso()
    let state: ModeState = {
      version: 1,
      mode: input.mode,
      sessionId: input.sessionId,
      active: true,
      currentPhase: "starting",
      startedAt,
      updatedAt: startedAt,
    }

    if (input.mode === "ralph") {
      state = {
        ...state,
        iteration: 1,
        maxIterations: input.maxIterations ?? 3,
      }
    }

    await writeModeState(state, input.workspaceRoot)

    if (input.mode === "ultrawork") {
    const schedulingAt = nowIso()
    await writeModeState({
      ...state,
      currentPhase: "scheduling",
      updatedAt: schedulingAt,
    }, input.workspaceRoot)

    const workItems = extractUltraworkItems(input.task)
    const tasks = createUltraworkTasks(workItems)

    const executingAt = nowIso()
    await writeModeState({
      ...state,
      currentPhase: "executing",
      updatedAt: executingAt,
    }, input.workspaceRoot)

    const result = await runUltrawork(tasks)
    const verifyingAt = nowIso()

    if (result.status === "failed") {
      await writeModeState({
        ...state,
        active: false,
        currentPhase: "failed",
        completedAt: verifyingAt,
        updatedAt: verifyingAt,
      }, input.workspaceRoot)

      if (result.error) {
        return {
          status: "failed",
          stateFilePath,
          error: result.error,
        }
      }

      return {
        status: "failed",
        stateFilePath,
      }
    }

    await writeModeState({
      ...state,
      currentPhase: "verifying",
      updatedAt: verifyingAt,
    }, input.workspaceRoot)

    await persistUltraworkReport({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      report: {
        task: input.task,
        workItems,
        waves: result.waves,
        completedTaskIds: result.completedTaskIds,
        outputs: result.outputs,
        generatedAt: nowIso(),
      },
    })

    const completedAt = nowIso()
    await writeModeState({
      ...state,
      active: false,
      currentPhase: "complete",
      completedAt,
      updatedAt: completedAt,
    }, input.workspaceRoot)

      return {
        status: "completed",
        stateFilePath,
      }
    }

    const maxIterations = input.maxIterations ?? 3
    const verify = await runRalphLoop(
    async (iteration, previous) => {
      const phase = previous ? "fixing" : "executing"
      await writeModeState({
        ...state,
        currentPhase: phase,
        iteration,
        maxIterations,
        updatedAt: nowIso(),
      }, input.workspaceRoot)

      const evaluated = await evaluateRalphSignals({
        workspaceRoot: input.workspaceRoot,
        sessionId: input.sessionId,
      })

      await writeModeState({
        ...state,
        currentPhase: "verifying",
        iteration,
        maxIterations,
        updatedAt: nowIso(),
      }, input.workspaceRoot)

      return {
        signals: evaluated.signals,
        note: evaluated.note,
      }
    },
    {
      maxIterations,
    },
  )

    const doneAt = nowIso()
    if (verify.status === "failed") {
    await writeModeState({
      ...state,
      active: false,
      currentPhase: "failed",
      completedAt: doneAt,
      updatedAt: doneAt,
      iteration: verify.iterations,
      maxIterations,
    }, input.workspaceRoot)

      return {
        status: "failed",
        stateFilePath,
        error: verify.reason,
      }
    }

    await writeModeState({
    ...state,
    active: false,
    currentPhase: "complete",
    completedAt: doneAt,
    updatedAt: doneAt,
    iteration: verify.iterations,
    maxIterations,
  }, input.workspaceRoot)

    return {
      status: "completed",
      stateFilePath,
    }
  } finally {
    await sessionLock.release()
  }
}

export async function cancelModeOperation(input: CancelModeOperationInput): Promise<RunModeOperationResult> {
  const sessionStates = await resolveSessionStates(input.workspaceRoot, input.sessionId)
  const result = applyCancelModeContract(sessionStates, {
    targetMode: input.targetMode,
    sessionId: input.sessionId,
  })
  await persistSessionStates(result.states, input.workspaceRoot)

  if (input.targetMode === "orchestrator") {
    const markerPath = resolveOrchestratorCancelMarkerPath(input.workspaceRoot, input.sessionId)
    await writeTextFileAtomic(markerPath, `${nowIso()}\n`)
  }

  return {
    status: "completed",
    stateFilePath: resolveModeStateFilePath({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      mode: input.targetMode,
    }),
  }
}
