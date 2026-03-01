import type { CoreAgentRole } from "../contracts/roles.js"
import type { WorkflowStage } from "./stages.js"

export const WORKFLOW_STAGE_AGENT_GRAPH: Record<WorkflowStage, CoreAgentRole[]> = {
  requirements: ["orchestrator", "researcher"],
  planning: ["plan", "architect", "critic"],
  issue: ["orchestrator"],
  development: ["developer", "documenter"],
  testing: ["tester"],
  merge: ["reviewer", "orchestrator"],
}

export function resolveStageAgentSequence(stage: WorkflowStage): CoreAgentRole[] {
  return [...WORKFLOW_STAGE_AGENT_GRAPH[stage]]
}
