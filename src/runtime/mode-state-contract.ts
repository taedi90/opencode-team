import { join } from "node:path"

export const EXECUTION_MODES = ["orchestrator", "ultrawork", "ralph"] as const

export type ExecutionMode = (typeof EXECUTION_MODES)[number]

export const MODE_PHASES = {
  orchestrator: [
    "starting",
    "requirements",
    "planning",
    "issue",
    "development",
    "testing",
    "merge",
    "complete",
    "failed",
    "cancelled",
  ],
  ultrawork: ["starting", "scheduling", "executing", "verifying", "complete", "failed", "cancelled"],
  ralph: ["starting", "executing", "verifying", "fixing", "complete", "failed", "cancelled"],
} as const

const TERMINAL_PHASES = new Set(["complete", "failed", "cancelled"])

export interface ModeState {
  version: 1
  mode: ExecutionMode
  sessionId: string
  active: boolean
  currentPhase: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  iteration?: number
  maxIterations?: number
  linkedMode?: ExecutionMode
  linkedModeTerminalPhase?: "complete" | "failed" | "cancelled"
  linkedModeTerminalAt?: string
}

export interface ModeStateValidationResult {
  valid: boolean
  errors: string[]
}

export interface ModeStatePathInput {
  workspaceRoot: string
  sessionId: string
  mode: ExecutionMode
}

export interface CancelModeRequest {
  targetMode: ExecutionMode
  sessionId: string
  now?: string
}

export interface CancelModeResult {
  cancelledModes: ExecutionMode[]
  states: ModeState[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isIso8601(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && EXECUTION_MODES.includes(value as ExecutionMode)
}

function phaseSetForMode(mode: ExecutionMode): Set<string> {
  return new Set(MODE_PHASES[mode])
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function cloneState(state: ModeState): ModeState {
  return { ...state }
}

function terminalizeState(
  state: ModeState,
  now: string,
  phase: "complete" | "failed" | "cancelled" = "cancelled",
): ModeState {
  if (!state.active) {
    return state
  }

  return {
    ...state,
    active: false,
    currentPhase: phase,
    completedAt: now,
    updatedAt: now,
  }
}

function cancelModesInOrder(
  states: ModeState[],
  order: ExecutionMode[],
  now: string,
): { updated: ModeState[]; cancelled: ExecutionMode[] } {
  const cancelled: ExecutionMode[] = []
  const updated = [...states]

  for (const mode of order) {
    const index = updated.findIndex((item) => item.mode === mode && item.active)
    if (index < 0) {
      continue
    }

    const state = updated[index]
    if (!state) {
      continue
    }

    updated[index] = terminalizeState(state, now, "cancelled")
    cancelled.push(mode)
  }

  return { updated, cancelled }
}

function resolveCancellationOrder(sessionStates: ModeState[], targetMode: ExecutionMode): ExecutionMode[] {
  if (targetMode === "orchestrator") {
    return ["ultrawork", "ralph", "orchestrator"]
  }

  if (targetMode === "ralph") {
    const ralphState = sessionStates.find((item) => item.mode === "ralph")
    if (ralphState?.linkedMode === "ultrawork") {
      return ["ultrawork", "ralph"]
    }
  }

  return [targetMode]
}

export function resolveModeStateFilePath(input: ModeStatePathInput): string {
  return join(
    input.workspaceRoot,
    ".agent-guide",
    "runtime",
    "state",
    "sessions",
    input.sessionId,
    `${input.mode}-state.json`,
  )
}

export function validateModeStateContract(state: unknown): ModeStateValidationResult {
  const errors: string[] = []

  if (!isRecord(state)) {
    return {
      valid: false,
      errors: ["state must be an object"],
    }
  }

  if (state.version !== 1) {
    errors.push("version must be 1")
  }

  if (!isExecutionMode(state.mode)) {
    errors.push("mode must be one of orchestrator|ultrawork|ralph")
  }

  if (typeof state.sessionId !== "string" || state.sessionId.trim().length === 0) {
    errors.push("sessionId must be a non-empty string")
  }

  if (typeof state.active !== "boolean") {
    errors.push("active must be boolean")
  }

  if (typeof state.startedAt !== "string" || !isIso8601(state.startedAt)) {
    errors.push("startedAt must be an ISO8601 string")
  }

  if (typeof state.updatedAt !== "string" || !isIso8601(state.updatedAt)) {
    errors.push("updatedAt must be an ISO8601 string")
  }

  const mode = isExecutionMode(state.mode) ? state.mode : null
  if (typeof state.currentPhase !== "string") {
    errors.push("currentPhase must be a string")
  } else if (mode) {
    const allowedPhases = phaseSetForMode(mode)
    if (!allowedPhases.has(state.currentPhase)) {
      errors.push(`currentPhase is not allowed for mode ${mode}: ${state.currentPhase}`)
    }
  }

  if (state.completedAt !== undefined) {
    if (typeof state.completedAt !== "string" || !isIso8601(state.completedAt)) {
      errors.push("completedAt must be an ISO8601 string when provided")
    }
  }

  const iteration = asPositiveInteger(state.iteration)
  const maxIterations = asPositiveInteger(state.maxIterations)
  if (state.iteration !== undefined && iteration === null) {
    errors.push("iteration must be a positive integer when provided")
  }
  if (state.maxIterations !== undefined && maxIterations === null) {
    errors.push("maxIterations must be a positive integer when provided")
  }
  if (iteration !== null && maxIterations !== null && iteration > maxIterations) {
    errors.push("iteration must be <= maxIterations")
  }

  if (mode === "ralph" && state.active === true) {
    if (iteration === null) {
      errors.push("ralph active state requires iteration")
    }
    if (maxIterations === null) {
      errors.push("ralph active state requires maxIterations")
    }
  }

  if (state.linkedMode !== undefined && !isExecutionMode(state.linkedMode)) {
    errors.push("linkedMode must be one of orchestrator|ultrawork|ralph when provided")
  }

  if (isExecutionMode(state.linkedMode) && mode && state.linkedMode === mode) {
    errors.push("linkedMode cannot be same as mode")
  }

  if (state.linkedModeTerminalPhase !== undefined) {
    if (
      typeof state.linkedModeTerminalPhase !== "string"
      || !TERMINAL_PHASES.has(state.linkedModeTerminalPhase)
    ) {
      errors.push("linkedModeTerminalPhase must be one of complete|failed|cancelled")
    }
  }

  if (state.linkedModeTerminalAt !== undefined) {
    if (typeof state.linkedModeTerminalAt !== "string" || !isIso8601(state.linkedModeTerminalAt)) {
      errors.push("linkedModeTerminalAt must be an ISO8601 string when provided")
    }
  }

  if (typeof state.currentPhase === "string" && TERMINAL_PHASES.has(state.currentPhase)) {
    if (state.active === true) {
      errors.push("terminal currentPhase requires active=false")
    }
    if (state.completedAt === undefined) {
      errors.push("terminal currentPhase requires completedAt")
    }
  }

  if (state.active === true && state.completedAt !== undefined) {
    errors.push("active=true state must not set completedAt")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function assertModeStateContract(state: unknown): asserts state is ModeState {
  const result = validateModeStateContract(state)
  if (!result.valid) {
    throw new Error(`Invalid mode state contract: ${result.errors.join("; ")}`)
  }
}

export function applyCancelModeContract(
  states: readonly ModeState[],
  request: CancelModeRequest,
): CancelModeResult {
  const now = request.now ?? new Date().toISOString()
  const cloned = states.map(cloneState)

  const sessionIndexes: number[] = []
  const sessionStates: ModeState[] = []

  for (let index = 0; index < cloned.length; index += 1) {
    const state = cloned[index]
    if (!state) {
      continue
    }
    if (state.sessionId !== request.sessionId) {
      continue
    }
    sessionIndexes.push(index)
    sessionStates.push(state)
  }

  const order = resolveCancellationOrder(sessionStates, request.targetMode)
  const { updated, cancelled } = cancelModesInOrder(sessionStates, order, now)

  for (let i = 0; i < sessionIndexes.length; i += 1) {
    const globalIndex = sessionIndexes[i]
    const updatedState = updated[i]
    if (globalIndex === undefined || !updatedState) {
      continue
    }
    cloned[globalIndex] = updatedState
  }

  if (request.targetMode === "ralph" && cancelled.includes("ultrawork") && cancelled.includes("ralph")) {
    const ralphIndex = cloned.findIndex(
      (item) => item.sessionId === request.sessionId && item.mode === "ralph",
    )
    if (ralphIndex >= 0) {
      const ralphState = cloned[ralphIndex]
      if (ralphState) {
        cloned[ralphIndex] = {
          ...ralphState,
          linkedModeTerminalPhase: "cancelled",
          linkedModeTerminalAt: now,
          updatedAt: now,
        }
      }
    }
  }

  return {
    cancelledModes: cancelled,
    states: cloned,
  }
}
