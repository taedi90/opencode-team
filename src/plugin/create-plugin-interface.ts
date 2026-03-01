import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

import {
  ensureOpenCodePluginRegistration,
  ensureUserConfigFile,
} from "../config/index.js"
import { runDoctor } from "../doctor/index.js"
import { createGhCliAdapter } from "../github/gh-cli-adapter.js"
import { runWorkflow, type WorkflowRunResult } from "../pipeline/orchestrator.js"
import { createScriptedSubagentExecutor } from "../pipeline/subagent-executor.js"
import { ensureMcpBootstrap } from "../runtime/mcp-bootstrap.js"
import { writeTextFileAtomic } from "../runtime/atomic-write.js"
import {
  resolveModeStateFilePath,
  type ModeState,
} from "../runtime/mode-state-contract.js"
import {
  cancelModeOperation,
  runModeOperation,
} from "../runtime/mode-operations.js"
import { parseRunCommand } from "./command-routing.js"

import type {
  PluginHooks,
  PluginInterface,
  PluginManagers,
  RunCommandResult,
  PluginTools,
} from "./types.js"

const execFileAsync = promisify(execFile)

function nowIso(): string {
  return new Date().toISOString()
}

async function writeModeState(state: ModeState, workspaceRoot: string): Promise<string> {
  const path = resolveModeStateFilePath({
    workspaceRoot,
    sessionId: state.sessionId,
    mode: state.mode,
  })
  await writeTextFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`)
  return path
}

async function readModeState(path: string): Promise<ModeState | null> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as ModeState
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

function resolveWorkflowStatePath(workspaceRoot: string, sessionId: string): string {
  return resolveModeStateFilePath({
    workspaceRoot,
    sessionId,
    mode: "orchestrator",
  }).replace("orchestrator-state.json", "workflow-state.json")
}

function parseGithubRepoRef(remoteUrl: string): { owner: string; repo: string } | null {
  const cleaned = remoteUrl.trim()
  const httpsMatch = cleaned.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/)
  if (!httpsMatch || !httpsMatch[1] || !httpsMatch[2]) {
    return null
  }

  return {
    owner: httpsMatch[1],
    repo: httpsMatch[2],
  }
}

async function resolveGithubAdapter(workspaceRoot: string): Promise<ReturnType<typeof createGhCliAdapter> | null> {
  try {
    const fromEnvOwner = process.env.OPENCODE_GITHUB_OWNER
    const fromEnvRepo = process.env.OPENCODE_GITHUB_REPO
    if (fromEnvOwner && fromEnvRepo) {
      return createGhCliAdapter({
        owner: fromEnvOwner,
        repo: fromEnvRepo,
      })
    }

    const { stdout } = await execFileAsync(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: workspaceRoot },
    )
    const parsed = parseGithubRepoRef(stdout)
    if (!parsed) {
      return null
    }

    return createGhCliAdapter(parsed)
  } catch {
    return null
  }
}

function resolveToolForMode(mode: "orchestrator" | "ultrawork" | "ralph" | "cancel"): string {
  if (mode === "cancel") {
    return "read"
  }
  return "bash"
}

export function createPluginInterface(input: {
  managers: PluginManagers
  tools: PluginTools
  hooks: PluginHooks
}): PluginInterface {
  const { managers, hooks, tools } = input

  return {
    install: async () => {
      const configBootstrap = await ensureUserConfigFile({
        ...(managers.userHome ? { userHome: managers.userHome } : {}),
      })
      const pluginRegistration = await ensureOpenCodePluginRegistration({
        ...(managers.userHome ? { userHome: managers.userHome } : {}),
      })

      const mcpBootstrap = await ensureMcpBootstrap({
        workspaceRoot: managers.workspaceRoot,
        ...(managers.userHome ? { userHome: managers.userHome } : {}),
      })

      return {
        configPath: configBootstrap.path,
        configCreated: configBootstrap.created,
        opencodeConfigPath: pluginRegistration.path,
        pluginRegistered: pluginRegistration.registered,
        mcpManifestPath: mcpBootstrap.path,
        mcpManifestCreated: mcpBootstrap.created,
        mcpManifestUpdated: mcpBootstrap.updated,
      }
    },
    run: async (task, options = {}) => {
      const route = parseRunCommand(task)
      const runTask = route.task.length > 0 ? route.task : task

      await hooks.beforeRun({
        task: runTask,
        mode: route.mode,
        source: route.source,
      })

      const loaded = await managers.loadConfig()
      const policy = tools.evaluateToolAccess({
        agentRole: "orchestrator",
        toolName: resolveToolForMode(route.mode),
        config: loaded.config,
      })

      await hooks.onToolPolicyEvaluated({
        task: runTask,
        mode: route.mode,
        source: route.source,
        agentRole: "orchestrator",
        toolName: resolveToolForMode(route.mode),
        allowed: policy.allowed,
        reasonCode: policy.reason_code,
        policySource: policy.policy_source,
      })

      if (!policy.allowed) {
        await hooks.afterRun({
          task: runTask,
          mode: route.mode,
          source: route.source,
          status: "failed",
        })
        return {
          status: "failed",
          mode: route.mode,
          source: route.source,
          stateFilePath: "",
          error: `orchestrator tool policy blocked run: ${policy.reason_code}`,
        }
      }

      if (route.mode === "ultrawork" || route.mode === "ralph") {
        const modeResult = await runModeOperation({
          workspaceRoot: managers.workspaceRoot,
          sessionId: route.sessionId,
          mode: route.mode,
          task: runTask,
          ...(route.maxIterations ? { maxIterations: route.maxIterations } : {}),
          resume: options.resume ?? false,
        })

        await hooks.afterRun({
          task: runTask,
          mode: route.mode,
          source: route.source,
          status: modeResult.status,
        })

        const response: RunCommandResult = {
          status: modeResult.status,
          mode: route.mode,
          source: route.source,
          stateFilePath: modeResult.stateFilePath,
        }
        if (modeResult.error) {
          response.error = modeResult.error
        }
        return response
      }

      if (route.mode === "cancel") {
        const cancelResult = await cancelModeOperation({
          workspaceRoot: managers.workspaceRoot,
          sessionId: route.sessionId,
          targetMode: route.cancelTargetMode,
        })
        await hooks.afterRun({
          task: runTask,
          mode: route.mode,
          source: route.source,
          status: cancelResult.status,
        })

        const response: RunCommandResult = {
          status: cancelResult.status,
          mode: route.mode,
          source: route.source,
          stateFilePath: cancelResult.stateFilePath,
        }
        if (cancelResult.error) {
          response.error = cancelResult.error
        }
        return response
      }

      const orchestratorModeStatePath = resolveModeStateFilePath({
        workspaceRoot: managers.workspaceRoot,
        sessionId: route.sessionId,
        mode: "orchestrator",
      })
      const workflowStatePath = resolveWorkflowStatePath(managers.workspaceRoot, route.sessionId)
      const existingModeState = await readModeState(orchestratorModeStatePath)

      if (options.resume && existingModeState && existingModeState.active === false) {
        const terminalStatus = existingModeState.currentPhase === "complete"
          ? "completed"
          : "failed"
        await hooks.afterRun({
          task: runTask,
          mode: route.mode,
          source: route.source,
          status: terminalStatus,
        })

        return {
          status: terminalStatus,
          mode: route.mode,
          source: route.source,
          stateFilePath: workflowStatePath,
          ...(terminalStatus === "failed"
            ? { error: "resume requested for terminal orchestrator state" }
            : {}),
        }
      }

      const startedAt = existingModeState?.startedAt ?? nowIso()
      await writeModeState({
        version: 1,
        mode: "orchestrator",
        sessionId: route.sessionId,
        active: true,
        currentPhase: "starting",
        startedAt,
        updatedAt: nowIso(),
      }, managers.workspaceRoot)

      let result: WorkflowRunResult
      try {
        const workflowSubagentExecutor = createScriptedSubagentExecutor()
        result = await runWorkflow(
          {
            task: runTask,
            workingDirectory: managers.workspaceRoot,
          },
          {
            sessionId: route.sessionId,
            stateFilePath: workflowStatePath,
            resume: options.resume ?? false,
            subagentExecutor: workflowSubagentExecutor,
            ...(await (async () => {
              const adapter = await resolveGithubAdapter(managers.workspaceRoot)
              return adapter ? { githubAutomationAdapter: adapter } : {}
            })()),
            onToolPolicyEvaluated: async ({
              agentRole,
              toolName,
              allowed,
              reasonCode,
              policySource,
            }) => {
              await hooks.onToolPolicyEvaluated({
                task: runTask,
                mode: route.mode,
                source: route.source,
                agentRole,
                toolName,
                allowed,
                reasonCode,
                policySource,
              })
            },
            onStageTransition: async ({ stage, phase }) => {
              const updateAt = nowIso()
              await writeModeState({
                version: 1,
                mode: "orchestrator",
                sessionId: route.sessionId,
                active: phase !== "failed",
                currentPhase: phase === "failed" ? "failed" : stage,
                startedAt,
                updatedAt: updateAt,
                ...(phase === "failed" ? { completedAt: updateAt } : {}),
              }, managers.workspaceRoot)
            },
          },
        )
      } catch (error) {
        await writeModeState({
          version: 1,
          mode: "orchestrator",
          sessionId: route.sessionId,
          active: false,
          currentPhase: "failed",
          startedAt,
          updatedAt: nowIso(),
          completedAt: nowIso(),
        }, managers.workspaceRoot)

        await hooks.afterRun({
          task: runTask,
          mode: route.mode,
          source: route.source,
          status: "failed",
        })

        return {
          status: "failed",
          mode: route.mode,
          source: route.source,
          stateFilePath: workflowStatePath,
          error: String(error),
        }
      }

      await writeModeState({
        version: 1,
        mode: "orchestrator",
        sessionId: route.sessionId,
        active: false,
        currentPhase: result.status === "completed"
          ? "complete"
          : (result.error === "workflow cancelled" ? "cancelled" : "failed"),
        startedAt,
        updatedAt: nowIso(),
        completedAt: nowIso(),
      }, managers.workspaceRoot)

      await hooks.afterRun({
        task: runTask,
        mode: route.mode,
        source: route.source,
        status: result.status,
      })

      const response: RunCommandResult = {
        status: result.status,
        mode: route.mode,
        source: route.source,
        stateFilePath: result.stateFilePath,
      }
      if (result.failedStage) {
        response.failedStage = result.failedStage
      }
      if (result.error) {
        response.error = result.error
      }

      return response
    },
    doctor: async () => runDoctor({
      workspaceRoot: managers.workspaceRoot,
      ...(managers.userHome ? { userHome: managers.userHome } : {}),
    }),
  }
}
