export const GITHUB_AUTOMATION_STAGES = [
  "create_issue",
  "create_branch",
  "create_pr",
  "merge",
] as const

export type GithubAutomationStage = (typeof GITHUB_AUTOMATION_STAGES)[number]

export * from "./automation.js"
export * from "./gh-cli-adapter.js"
