import type { OpenCodeTeamConfig } from "../config/index.js"
import type { ToolAccessDecision } from "../runtime/agent-tool-policy.js"

export interface PluginRuntimeOptions {
  workspaceRoot: string
  userHome?: string
}

export interface PluginManagers {
  workspaceRoot: string
  userHome?: string
  loadConfig: () => Promise<{
    config: OpenCodeTeamConfig
    warnings: string[]
    paths: {
      userPath: string
      projectPath: string
    }
  }>
}

export interface PluginTools {
  evaluateToolAccess: (input: {
    agentRole: string
    toolName: string
    config: OpenCodeTeamConfig
  }) => ToolAccessDecision
}

export interface PluginHooks {
  beforeRun: (input: {
    task: string
    sessionId: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "ulw_loop" | "cancel"
    source: "slash" | "keyword" | "default"
  }) => Promise<void>
  afterRun: (input: {
    task: string
    sessionId: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "ulw_loop" | "cancel"
    source: "slash" | "keyword" | "default"
    status: "completed" | "failed"
  }) => Promise<void>
  onToolPolicyEvaluated: (input: {
    task: string
    sessionId: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "ulw_loop" | "cancel"
    source: "slash" | "keyword" | "default"
    stage?: string
    nodeId?: string
    agentRole: string
    toolName: string
    allowed: boolean
    reasonCode: string
    policySource: string
  }) => Promise<void>
}

export interface InstallCommandResult {
  configPath: string
  configCreated: boolean
  opencodeConfigPath: string
  pluginRegistered: boolean
  mcpManifestPath: string
  mcpManifestCreated: boolean
  mcpManifestUpdated: boolean
}

export interface RunCommandResult {
  status: "completed" | "failed"
  stateFilePath: string
  mode: "orchestrator" | "ultrawork" | "ralph" | "ulw_loop" | "cancel"
  source: "slash" | "keyword" | "default"
  failedStage?: string
  error?: string
}

export interface DoctorCheck {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
}

export interface DoctorCommandResult {
  status: "pass" | "warn" | "fail"
  checks: DoctorCheck[]
}

export interface PluginInterface {
  install: () => Promise<InstallCommandResult>
  run: (task: string, options?: { resume?: boolean }) => Promise<RunCommandResult>
  doctor: () => Promise<DoctorCommandResult>
}
