import {
  AGENT_ROLES,
  DEFAULT_CONFIG,
  type AgentRole,
  type AgentToolPolicy,
  type OpenCodeTeamConfig,
} from "../config/index.js"

export type ToolPolicySource = "default" | "config"

export type ToolAccessReasonCode =
  | "allowed"
  | "agent_unknown"
  | "tool_not_allowed"
  | "tool_explicitly_denied"

export interface ToolAccessDecision {
  allowed: boolean
  reason_code: ToolAccessReasonCode
  agent: string
  tool: string
  policy_source: ToolPolicySource
  evaluated_at: string
}

export interface EvaluateToolAccessInput {
  agentRole: string
  toolName: string
  config?: OpenCodeTeamConfig
  now?: string
}

export interface ToolPolicyAuditLog extends ToolAccessDecision {
  session_id?: string
  stage?: string
}

export interface ResolvedAgentToolPolicy {
  allow: Set<string>
  deny: Set<string>
  source: ToolPolicySource
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase()
}

function isKnownRole(value: string): value is AgentRole {
  return AGENT_ROLES.includes(value as AgentRole)
}

function toNormalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeToolName))
}

function arraysMatchIgnoreOrder(a: readonly string[], b: readonly string[]): boolean {
  const left = toNormalizedSet(a)
  const right = toNormalizedSet(b)
  if (left.size !== right.size) {
    return false
  }
  for (const item of left) {
    if (!right.has(item)) {
      return false
    }
  }
  return true
}

function resolvePolicySource(role: AgentRole, config: OpenCodeTeamConfig): ToolPolicySource {
  const defaultPolicy = DEFAULT_CONFIG.agent_tools[role]
  const configuredPolicy = config.agent_tools[role]

  const sameAllow = arraysMatchIgnoreOrder(defaultPolicy.allow, configuredPolicy.allow)
  const sameDeny = arraysMatchIgnoreOrder(defaultPolicy.deny, configuredPolicy.deny)

  return sameAllow && sameDeny ? "default" : "config"
}

function resolvePolicy(role: AgentRole, config: OpenCodeTeamConfig): AgentToolPolicy {
  return config.agent_tools[role]
}

export function resolveAgentToolPolicy(
  role: AgentRole,
  config: OpenCodeTeamConfig = DEFAULT_CONFIG,
): ResolvedAgentToolPolicy {
  const policy = resolvePolicy(role, config)

  return {
    allow: toNormalizedSet(policy.allow),
    deny: toNormalizedSet(policy.deny),
    source: resolvePolicySource(role, config),
  }
}

export function evaluateToolAccess(input: EvaluateToolAccessInput): ToolAccessDecision {
  const config = input.config ?? DEFAULT_CONFIG
  const evaluatedAt = input.now ?? new Date().toISOString()
  const normalizedTool = normalizeToolName(input.toolName)

  if (!isKnownRole(input.agentRole)) {
    return {
      allowed: false,
      reason_code: "agent_unknown",
      agent: input.agentRole,
      tool: normalizedTool,
      policy_source: "default",
      evaluated_at: evaluatedAt,
    }
  }

  const policy = resolveAgentToolPolicy(input.agentRole, config)

  if (policy.deny.has(normalizedTool)) {
    return {
      allowed: false,
      reason_code: "tool_explicitly_denied",
      agent: input.agentRole,
      tool: normalizedTool,
      policy_source: policy.source,
      evaluated_at: evaluatedAt,
    }
  }

  if (!policy.allow.has(normalizedTool)) {
    return {
      allowed: false,
      reason_code: "tool_not_allowed",
      agent: input.agentRole,
      tool: normalizedTool,
      policy_source: policy.source,
      evaluated_at: evaluatedAt,
    }
  }

  return {
    allowed: true,
    reason_code: "allowed",
    agent: input.agentRole,
    tool: normalizedTool,
    policy_source: policy.source,
    evaluated_at: evaluatedAt,
  }
}

export function createToolPolicyAuditLog(
  decision: ToolAccessDecision,
  options: {
    sessionId?: string
    stage?: string
  } = {},
): ToolPolicyAuditLog {
  const entry: ToolPolicyAuditLog = {
    ...decision,
  }

  if (options.sessionId) {
    entry.session_id = options.sessionId
  }

  if (options.stage) {
    entry.stage = options.stage
  }

  return entry
}
