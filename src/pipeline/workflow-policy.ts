import type { OpenCodeTeamConfig } from "../config/index.js"
import type { WorkflowStage } from "./stages.js"

export type WorkflowFactsSnapshot = {
  task: string
  hasPackageJson: boolean
  gitAvailable: boolean
}

export type WorkflowPolicyDecision = {
  plan: {
    profile: "auto"
    untilStage: WorkflowStage
    skip: {
      researcher?: boolean
      architect?: boolean
      critic?: boolean
      reviewer?: boolean
      documenter?: boolean
    }
    budgets?: {
      max_role_runs: number
      max_stage_failures: number
      max_total_latency_ms: number
      max_artifact_bytes: number
    }
  }
  explain: {
    signals: string[]
    reasons: string[]
  }
}

function includesAnyKeyword(task: string, keywords: string[]): boolean {
  return keywords.some((keyword) => task.toLowerCase().includes(keyword.toLowerCase()))
}

export function decideWorkflowPolicy(
  config: OpenCodeTeamConfig,
  facts: WorkflowFactsSnapshot,
): WorkflowPolicyDecision {
  const untilStage: WorkflowStage = "merge"
  const researcherEnabled = includesAnyKeyword(
    facts.task,
    config.workflow.auto_profile.require_research_keywords,
  )
  const architectEnabled = includesAnyKeyword(
    facts.task,
    config.workflow.auto_profile.require_architect_keywords,
  )
  const criticEnabled = includesAnyKeyword(
    facts.task,
    config.workflow.auto_profile.require_critic_keywords,
  )
  const documenterEnabled = includesAnyKeyword(
    facts.task,
    config.workflow.auto_profile.require_docs_keywords,
  )
  const reviewerEnabled =
    config.merge_policy.require_user_approval === false
    || facts.task.toLowerCase().includes("review")

  const skip: WorkflowPolicyDecision["plan"]["skip"] = {}
  if (!researcherEnabled) skip.researcher = true
  if (!architectEnabled) skip.architect = true
  if (!criticEnabled) skip.critic = true
  if (!documenterEnabled) skip.documenter = true
  if (!reviewerEnabled) skip.reviewer = true

  const signals = [
    "untilStage:merge",
    ...(researcherEnabled ? ["researcher:enabled"] : ["researcher:skipped"]),
    ...(architectEnabled ? ["architect:enabled"] : ["architect:skipped"]),
    ...(criticEnabled ? ["critic:enabled"] : ["critic:skipped"]),
    ...(documenterEnabled ? ["documenter:enabled"] : ["documenter:skipped"]),
    ...(reviewerEnabled ? ["reviewer:enabled"] : ["reviewer:skipped"]),
  ]

  const reasons = [
    "untilStage is always merge",
    researcherEnabled
      ? "researcher enabled by require_research_keywords match"
      : "researcher skipped because no require_research_keywords match",
    architectEnabled
      ? "architect enabled by require_architect_keywords match"
      : "architect skipped because no require_architect_keywords match",
    criticEnabled
      ? "critic enabled by require_critic_keywords match"
      : "critic skipped because no require_critic_keywords match",
    documenterEnabled
      ? "documenter enabled by require_docs_keywords match"
      : "documenter skipped because no require_docs_keywords match",
    reviewerEnabled
      ? "reviewer enabled because require_user_approval=false or task includes review"
      : "reviewer skipped because require_user_approval=true and task does not include review",
  ]

  return {
    plan: {
      profile: "auto",
      untilStage,
      skip,
      budgets: {
        max_role_runs: config.workflow.budgets.max_role_runs,
        max_stage_failures: config.workflow.budgets.max_stage_failures,
        max_total_latency_ms: config.workflow.budgets.max_total_latency_ms,
        max_artifact_bytes: config.workflow.budgets.max_artifact_bytes,
      },
    },
    explain: {
      signals,
      reasons,
    },
  }
}
