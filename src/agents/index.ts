import { DEFAULT_CONFIG, type OpenCodeTeamConfig } from "../config/index.js"
import { CORE_AGENT_ROLES, type CoreAgentRole } from "../contracts/roles.js"

export { CORE_AGENT_ROLES, type CoreAgentRole }

export type AgentTier = "LOW" | "STANDARD" | "THOROUGH"
export type AgentKind = "core" | "planning-sub"
export type ReasoningEffort = "low" | "medium" | "high"

export interface AgentDefinition {
  role: CoreAgentRole
  tier: AgentTier
  kind: AgentKind
}

export interface AgentRoute {
  role: CoreAgentRole
  tier: AgentTier
  kind: AgentKind
  model: string
  reasoningEffort: ReasoningEffort
}

export const AGENT_DEFINITIONS: Record<CoreAgentRole, AgentDefinition> = {
  orchestrator: { role: "orchestrator", tier: "THOROUGH", kind: "core" },
  plan: { role: "plan", tier: "THOROUGH", kind: "core" },
  architect: { role: "architect", tier: "THOROUGH", kind: "planning-sub" },
  critic: { role: "critic", tier: "THOROUGH", kind: "planning-sub" },
  researcher: { role: "researcher", tier: "THOROUGH", kind: "core" },
  developer: { role: "developer", tier: "STANDARD", kind: "core" },
  tester: { role: "tester", tier: "STANDARD", kind: "core" },
  reviewer: { role: "reviewer", tier: "THOROUGH", kind: "core" },
  documenter: { role: "documenter", tier: "THOROUGH", kind: "core" },
}

function resolveModelForRole(role: CoreAgentRole, config: OpenCodeTeamConfig): string {
  return config.models[role]
}

function resolveReasoningForTier(tier: AgentTier): ReasoningEffort {
  if (tier === "LOW") return "low"
  if (tier === "STANDARD") return "medium"
  return "high"
}

export function resolveAgentRoute(
  role: CoreAgentRole,
  config: OpenCodeTeamConfig = DEFAULT_CONFIG,
): AgentRoute {
  const definition = AGENT_DEFINITIONS[role]
  return {
    role,
    tier: definition.tier,
    kind: definition.kind,
    model: resolveModelForRole(role, config),
    reasoningEffort: resolveReasoningForTier(definition.tier),
  }
}

export * from "./instructions.js"
