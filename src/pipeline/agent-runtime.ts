import {
  buildAgentSystemInstructions,
  type AgentInstructionResult,
} from "../agents/instructions.js"
import {
  resolveAgentRoute,
  type AgentRoute,
} from "../agents/index.js"
import {
  buildRoleOutputEnvelope,
  validateRuntimeHandoff,
  type RoleOutputEnvelope,
  type RuntimeHandoff,
} from "../runtime/role-output-contract.js"
import {
  evaluateToolAccess,
  type ToolAccessReasonCode,
  type ToolPolicySource,
} from "../runtime/agent-tool-policy.js"
import type { OpenCodeTeamConfig } from "../config/index.js"
import type { CoreAgentRole } from "../contracts/roles.js"
import type {
  SubagentExecutionErrorCode,
  SubagentExecutor,
} from "./subagent-executor.js"
import {
  buildDelegationPrompt,
  summarizeDelegationPrompt,
  type DelegationPromptInput,
} from "./delegation-prompt-contract.js"
import type { WorkflowStage } from "./stages.js"

export class WorkflowAgentExecutionError extends Error {
  readonly code: SubagentExecutionErrorCode
  readonly role: CoreAgentRole
  readonly stage: WorkflowStage
  readonly nodeId: string
  readonly reasons: string[]

  constructor(input: {
    message: string
    code: SubagentExecutionErrorCode
    role: CoreAgentRole
    stage: WorkflowStage
    nodeId: string
    reasons?: string[]
  }) {
    super(input.message)
    this.name = "WorkflowAgentExecutionError"
    this.code = input.code
    this.role = input.role
    this.stage = input.stage
    this.nodeId = input.nodeId
    this.reasons = input.reasons ?? []
  }
}

export interface WorkflowAgentRunInput<TContext> {
  role: CoreAgentRole
  stage: WorkflowStage
  nodeId: string
  workspaceRoot: string
  sessionId: string
  context: TContext
  executor: SubagentExecutor
  timeoutMs?: number
  maxRetries?: number
  delegationPrompt?: DelegationPromptInput
  runtimeOverlay?: string
  config?: OpenCodeTeamConfig | undefined
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
}

export interface WorkflowAgentRun<TPayload> {
  role: CoreAgentRole
  stage: WorkflowStage
  nodeId: string
  sessionId: string
  route: AgentRoute
  instructions: AgentInstructionResult
  envelope: RoleOutputEnvelope<TPayload>
  latencyMs: number
  attempts: number
  toolEvents: string[]
  delegationPromptHash?: string
  delegationPromptLineCount?: number
}

export interface WorkflowAgentRunArtifact {
  role: CoreAgentRole
  stage: WorkflowStage
  nodeId: string
  sessionId: string
  model: string
  tier: AgentRoute["tier"]
  kind: AgentRoute["kind"]
  reasoningEffort: AgentRoute["reasoningEffort"]
  decision: string
  status: "ok" | "error"
  reasons: string[]
  evidence: string[]
  handoff: RuntimeHandoff
  instructionSource: string
  instructionSessionFile?: string
  latencyMs: number
  attempts: number
  toolEvents: string[]
  delegationPromptHash?: string
  delegationPromptLineCount?: number
}

export function toWorkflowAgentRunArtifact<TPayload>(run: WorkflowAgentRun<TPayload>): WorkflowAgentRunArtifact {
  return {
    role: run.role,
    stage: run.stage,
    nodeId: run.nodeId,
    sessionId: run.sessionId,
    model: run.route.model,
    tier: run.route.tier,
    kind: run.route.kind,
    reasoningEffort: run.route.reasoningEffort,
    decision: run.envelope.decision,
    status: run.envelope.status,
    reasons: [...run.envelope.reasons],
    evidence: [...run.envelope.evidence],
    handoff: run.envelope.handoff,
    instructionSource: run.instructions.sourcePath,
    ...(run.instructions.sessionFilePath
      ? { instructionSessionFile: String(run.instructions.sessionFilePath) }
      : {}),
    latencyMs: run.latencyMs,
    attempts: run.attempts,
    toolEvents: [...run.toolEvents],
    ...(run.delegationPromptHash ? { delegationPromptHash: run.delegationPromptHash } : {}),
    ...(typeof run.delegationPromptLineCount === "number"
      ? { delegationPromptLineCount: run.delegationPromptLineCount }
      : {}),
  }
}

function assertSuccessfulExecution<TPayload>(input: {
  role: CoreAgentRole
  stage: WorkflowStage
  nodeId: string
  result: {
    status: "success" | "failure" | "cancelled" | "timeout"
    decision: string
    payload?: TPayload
    handoff?: RuntimeHandoff
    reasons?: string[]
    errorCode?: SubagentExecutionErrorCode
    errorMessage?: string
  }
}): asserts input is {
  role: CoreAgentRole
  stage: WorkflowStage
  nodeId: string
  result: {
    status: "success"
    decision: string
    payload: TPayload
    handoff: RuntimeHandoff
    reasons?: string[]
    errorCode?: SubagentExecutionErrorCode
    errorMessage?: string
  }
} {
  const code = input.result.errorCode ?? (input.result.status === "timeout"
    ? "timeout"
    : (input.result.status === "cancelled" ? "cancelled" : "executor_failed"))

  if (input.result.status !== "success") {
    throw new WorkflowAgentExecutionError({
      message: input.result.errorMessage
        ?? `subagent execution failed for ${input.stage}/${input.role} (status=${input.result.status})`,
      code,
      role: input.role,
      stage: input.stage,
      nodeId: input.nodeId,
      ...(input.result.reasons ? { reasons: input.result.reasons } : {}),
    })
  }

  if (input.result.payload === undefined) {
    throw new WorkflowAgentExecutionError({
      message: `subagent execution missing payload for ${input.stage}/${input.role}`,
      code: "contract_invalid",
      role: input.role,
      stage: input.stage,
      nodeId: input.nodeId,
      reasons: ["payload missing"],
    })
  }

  if (input.result.handoff === undefined) {
    throw new WorkflowAgentExecutionError({
      message: `subagent execution missing handoff for ${input.stage}/${input.role}`,
      code: "contract_invalid",
      role: input.role,
      stage: input.stage,
      nodeId: input.nodeId,
      reasons: ["handoff missing"],
    })
  }
}

export async function runWorkflowAgent<TContext, TPayload>(
  input: WorkflowAgentRunInput<TContext>,
): Promise<WorkflowAgentRun<TPayload>> {
  const route = resolveAgentRoute(input.role, input.config)
  const instructions = await buildAgentSystemInstructions({
    workspaceRoot: input.workspaceRoot,
    role: input.role,
    sessionId: input.sessionId,
    ...(input.runtimeOverlay ? { runtimeOverlay: input.runtimeOverlay } : {}),
  })

  const delegationPrompt = input.delegationPrompt
    ? buildDelegationPrompt(input.delegationPrompt)
    : null
  const delegationPromptSummary = delegationPrompt
    ? summarizeDelegationPrompt(delegationPrompt)
    : null

  const execution = await input.executor<TContext, TPayload>({
    role: input.role,
    stage: input.stage,
    nodeId: input.nodeId,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    instructions: delegationPrompt
      ? `${instructions.content}\n\n## Delegation Prompt Contract\n${delegationPrompt}`
      : instructions.content,
    context: input.context,
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    ...(typeof input.maxRetries === "number" ? { maxRetries: input.maxRetries } : {}),
  })

  assertSuccessfulExecution({
    role: input.role,
    stage: input.stage,
    nodeId: input.nodeId,
    result: execution,
  })

  const validatedHandoff = validateRuntimeHandoff(execution.handoff)
  if (!validatedHandoff.valid || !validatedHandoff.value) {
    const details = validatedHandoff.error?.details.join(", ") ?? "handoff validation failed"
    throw new WorkflowAgentExecutionError({
      message: `runtime handoff invalid for role ${input.role}: ${details}`,
      code: "contract_invalid",
      role: input.role,
      stage: input.stage,
      nodeId: input.nodeId,
      ...(validatedHandoff.error?.details ? { reasons: validatedHandoff.error.details } : {}),
    })
  }

  const toolEvents = (execution.toolEvents ?? [])
    .map((event) => event.toolName.trim())
    .filter((name) => name.length > 0)

  for (const toolName of toolEvents) {
    const decision = evaluateToolAccess({
      agentRole: input.role,
      toolName,
      ...(input.config ? { config: input.config } : {}),
    })

    await input.onToolPolicyEvaluated?.({
      stage: input.stage,
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      agentRole: input.role,
      toolName,
      allowed: decision.allowed,
      reasonCode: decision.reason_code,
      policySource: decision.policy_source,
    })

    if (!decision.allowed) {
      throw new WorkflowAgentExecutionError({
        message: `tool policy denied role=${input.role} tool=${toolName} reason=${decision.reason_code}`,
        code: "tool_policy_denied",
        role: input.role,
        stage: input.stage,
        nodeId: input.nodeId,
        reasons: [decision.reason_code],
      })
    }
  }

  return {
    role: input.role,
    stage: input.stage,
    nodeId: input.nodeId,
    sessionId: input.sessionId,
    route,
    instructions,
    envelope: buildRoleOutputEnvelope<TPayload>({
      role: input.role,
      payload: execution.payload as TPayload,
      handoff: validatedHandoff.value,
      attempts: execution.attempts,
      maxAttempts: execution.attempts,
      decision: execution.decision,
      reasons: execution.reasons ?? [],
      evidence: [
        ...(execution.evidence ?? []),
        `model=${route.model}`,
        `tier=${route.tier}`,
        ...(delegationPromptSummary
          ? [
            `delegation_prompt_hash=${delegationPromptSummary.hash}`,
            `delegation_prompt_line_count=${String(delegationPromptSummary.lineCount)}`,
          ]
          : []),
      ],
    }),
    latencyMs: execution.latencyMs,
    attempts: execution.attempts,
    toolEvents,
    ...(delegationPromptSummary ? { delegationPromptHash: delegationPromptSummary.hash } : {}),
    ...(delegationPromptSummary ? { delegationPromptLineCount: delegationPromptSummary.lineCount } : {}),
  }
}
