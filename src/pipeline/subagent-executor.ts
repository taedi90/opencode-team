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

    try {
      const result = await context.execute()
      const requested = normalizeRequestedTools(context.requestedTools)

      return {
        status: "success",
        decision: result.decision,
        payload: result.payload,
        handoff: result.handoff,
        reasons: result.reasons ?? [],
        evidence: result.evidence ?? [],
        toolEvents: [...requested, ...(result.toolEvents ?? [])],
        latencyMs: Date.now() - startedAt,
        attempts: 1,
      }
    } catch (error) {
      return {
        status: "failure",
        decision: "request_changes",
        reasons: [String(error)],
        evidence: [String(error)],
        toolEvents: normalizeRequestedTools((context as { requestedTools?: unknown }).requestedTools),
        latencyMs: Date.now() - startedAt,
        attempts: 1,
        errorCode: "executor_failed",
        errorMessage: String(error),
      }
    }
  }
}
