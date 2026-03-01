export const WORKFLOW_STAGES = [
  "requirements",
  "planning",
  "issue",
  "development",
  "testing",
  "merge",
] as const

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number]
