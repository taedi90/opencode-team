import type { CoreAgentRole } from "../contracts/roles.js"
import type { RuntimeHandoff } from "../runtime/role-output-contract.js"
import type { WorkflowStage } from "./stages.js"

export type SubagentExecutionStatus = "success" | "failure" | "cancelled" | "timeout"

export type SubagentExecutionErrorCode =
  | "tool_policy_denied"
  | "timeout"
  | "contract_invalid"
  | "network"
  | "cancelled"
  | "executor_missing"
  | "executor_failed"

export interface SubagentToolEvent {
  toolName: string
}

export interface SubagentExecutionRequest<TContext> {
  role: CoreAgentRole
  stage: WorkflowStage
  nodeId: string
  sessionId: string
  workspaceRoot: string
  model: string
  reasoningEffort: string
  instructions: string
  context: TContext
  timeoutMs?: number
  maxRetries?: number
}

export interface SubagentExecutionResult<TPayload> {
  status: SubagentExecutionStatus
  decision: string
  payload?: TPayload
  handoff?: RuntimeHandoff
  reasons?: string[]
  evidence?: string[]
  toolEvents?: SubagentToolEvent[]
  latencyMs: number
  attempts: number
  errorCode?: SubagentExecutionErrorCode
  errorMessage?: string
}

export type SubagentExecutor = <TContext, TPayload>(
  request: SubagentExecutionRequest<TContext>,
) => Promise<SubagentExecutionResult<TPayload>>

interface ScriptedSubagentResult<TPayload> {
  decision: string
  payload: TPayload
  handoff: RuntimeHandoff
  reasons?: string[]
  evidence?: string[]
  toolEvents?: SubagentToolEvent[]
}

export interface ScriptedSubagentContext<TPayload> {
  requestedTools?: string[]
  execute: () => Promise<ScriptedSubagentResult<TPayload>> | ScriptedSubagentResult<TPayload>
}

class SubagentTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SubagentTimeoutError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function hasScriptedExecute(value: unknown): value is ScriptedSubagentContext<unknown> {
  return isRecord(value) && typeof value.execute === "function"
}

function normalizeRequestedTools(value: unknown): SubagentToolEvent[] {
  if (!Array.isArray(value)) {
    return []
  }

  const events: SubagentToolEvent[] = []
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      events.push({ toolName: item })
    }
  }
  return events
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null
  }

  if (value <= 0) {
    return null
  }

  return Math.floor(value)
}

async function executeWithTimeout<TPayload>(
  execute: () => Promise<ScriptedSubagentResult<TPayload>>,
  timeoutMs: number,
): Promise<ScriptedSubagentResult<TPayload>> {
  return await new Promise<ScriptedSubagentResult<TPayload>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SubagentTimeoutError(`subagent execution exceeded timeout (${String(timeoutMs)}ms)`))
    }, timeoutMs)

    execute()
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

export function createScriptedSubagentExecutor(): SubagentExecutor {
  return async <TContext, TPayload>(
    request: SubagentExecutionRequest<TContext>,
  ): Promise<SubagentExecutionResult<TPayload>> => {
    const startedAt = Date.now()

    if (!hasScriptedExecute(request.context)) {
      return {
        status: "failure",
        decision: "request_changes",
        reasons: ["scripted_subagent_context_missing_execute"],
        evidence: [],
        toolEvents: [],
        latencyMs: Date.now() - startedAt,
        attempts: 1,
        errorCode: "contract_invalid",
        errorMessage: "scripted subagent context must provide execute()",
      }
    }

    const context = request.context as ScriptedSubagentContext<TPayload>
    const requested = normalizeRequestedTools(context.requestedTools)
    const timeoutMs = toPositiveInteger(request.timeoutMs)
    const maxRetries = Math.max(0, toPositiveInteger(request.maxRetries) ?? 0)
    const maxAttempts = maxRetries + 1
    const attemptErrors: string[] = []

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = timeoutMs === null
          ? await context.execute()
          : await executeWithTimeout(() => Promise.resolve(context.execute()), timeoutMs)

        return {
          status: "success",
          decision: result.decision,
          payload: result.payload,
          handoff: result.handoff,
          reasons: result.reasons ?? [],
          evidence: result.evidence ?? [],
          toolEvents: [...requested, ...(result.toolEvents ?? [])],
          latencyMs: Date.now() - startedAt,
          attempts: attempt,
        }
      } catch (error) {
        const message = toErrorMessage(error)
        attemptErrors.push(`attempt ${String(attempt)}: ${message}`)
        const isTimeoutError = error instanceof SubagentTimeoutError
        const shouldRetry = attempt < maxAttempts

        if (shouldRetry) {
          continue
        }

        return {
          status: isTimeoutError ? "timeout" : "failure",
          decision: "request_changes",
          reasons: [message],
          evidence: attemptErrors,
          toolEvents: requested,
          latencyMs: Date.now() - startedAt,
          attempts: attempt,
          errorCode: isTimeoutError ? "timeout" : "executor_failed",
          errorMessage: message,
        }
      }
    }

    return {
      status: "failure",
      decision: "request_changes",
      reasons: ["subagent execution reached unexpected terminal state"],
      evidence: ["subagent execution reached unexpected terminal state"],
      toolEvents: requested,
      latencyMs: Date.now() - startedAt,
      attempts: maxAttempts,
      errorCode: "executor_failed",
      errorMessage: "subagent execution reached unexpected terminal state",
    }
  }
}
