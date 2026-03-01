export const CORE_AGENT_ROLES = [
  "orchestrator",
  "plan",
  "architect",
  "critic",
  "researcher",
  "developer",
  "tester",
  "reviewer",
  "documenter",
] as const

export type CoreAgentRole = (typeof CORE_AGENT_ROLES)[number]
