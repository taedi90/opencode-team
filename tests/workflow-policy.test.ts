import { describe, expect, it } from "vitest"

import type { OpenCodeTeamConfig } from "../src/config/index.js"
import { DEFAULT_CONFIG } from "../src/config/index.js"
import { decideWorkflowPolicy, type WorkflowFactsSnapshot } from "../src/pipeline/workflow-policy.js"

function createConfig(overrides?: Partial<OpenCodeTeamConfig>): OpenCodeTeamConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    merge_policy: {
      ...DEFAULT_CONFIG.merge_policy,
      ...overrides?.merge_policy,
    },
    workflow: {
      ...DEFAULT_CONFIG.workflow,
      ...overrides?.workflow,
      auto_profile: {
        ...DEFAULT_CONFIG.workflow.auto_profile,
        ...overrides?.workflow?.auto_profile,
      },
      budgets: {
        ...DEFAULT_CONFIG.workflow.budgets,
        ...overrides?.workflow?.budgets,
      },
    },
  }
}

function createFacts(task: string): WorkflowFactsSnapshot {
  return {
    task,
    hasPackageJson: true,
    gitAvailable: true,
  }
}

function createKeywordIsolatedConfig(): OpenCodeTeamConfig {
  return createConfig({
    merge_policy: { require_user_approval: true },
    workflow: {
      ...DEFAULT_CONFIG.workflow,
      auto_profile: {
        ...DEFAULT_CONFIG.workflow.auto_profile,
        require_research_keywords: ["research-hit"],
        require_architect_keywords: ["architect-hit"],
        require_critic_keywords: ["critic-hit"],
        require_docs_keywords: ["docs-hit"],
      },
    },
  })
}

describe("decideWorkflowPolicy", () => {
  it("returns deterministic output for same inputs", () => {
    const config = createConfig()
    const facts = createFacts("investigate docs and review")

    const first = decideWorkflowPolicy(config, facts)
    const second = decideWorkflowPolicy(config, facts)

    expect(first).toEqual(second)
  })

  it("keeps optional roles skipped with no keywords and require_user_approval=true", () => {
    const config = createKeywordIsolatedConfig()
    const decision = decideWorkflowPolicy(config, createFacts("implement feature quickly"))

    expect(decision.plan.untilStage).toBe("merge")
    expect(decision.plan.skip).toEqual({
      researcher: true,
      architect: true,
      critic: true,
      documenter: true,
      reviewer: true,
    })
  })

  it("toggles only researcher when research keywords match", () => {
    const config = createKeywordIsolatedConfig()

    const decision = decideWorkflowPolicy(config, createFacts("task contains RESEARCH-hit only"))

    expect(decision.plan.skip).toEqual({
      architect: true,
      critic: true,
      documenter: true,
      reviewer: true,
    })
  })

  it("toggles only architect when architect keywords match", () => {
    const config = createKeywordIsolatedConfig()

    const decision = decideWorkflowPolicy(config, createFacts("task contains architect-HIT only"))

    expect(decision.plan.skip).toEqual({
      researcher: true,
      critic: true,
      documenter: true,
      reviewer: true,
    })
  })

  it("toggles only critic when critic keywords match", () => {
    const config = createKeywordIsolatedConfig()

    const decision = decideWorkflowPolicy(config, createFacts("task contains critic-hit only"))

    expect(decision.plan.skip).toEqual({
      researcher: true,
      architect: true,
      documenter: true,
      reviewer: true,
    })
  })

  it("toggles only documenter when docs keywords match", () => {
    const config = createKeywordIsolatedConfig()

    const decision = decideWorkflowPolicy(config, createFacts("task contains docs-hit only"))

    expect(decision.plan.skip).toEqual({
      researcher: true,
      architect: true,
      critic: true,
      reviewer: true,
    })
  })

  it("enables reviewer when require_user_approval=false", () => {
    const config = createConfig({
      merge_policy: { require_user_approval: false },
      workflow: createKeywordIsolatedConfig().workflow,
    })

    const decision = decideWorkflowPolicy(config, createFacts("implement task"))

    expect(decision.plan.skip).toEqual({
      researcher: true,
      architect: true,
      critic: true,
      documenter: true,
    })
  })

  it("enables reviewer on explicit review keyword", () => {
    const config = createConfig({
      merge_policy: { require_user_approval: true },
      workflow: createKeywordIsolatedConfig().workflow,
    })

    const decision = decideWorkflowPolicy(config, createFacts("please REVIEW this task"))

    expect(decision.plan.skip).toEqual({
      researcher: true,
      architect: true,
      critic: true,
      documenter: true,
    })
  })
})
