import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { createToolPolicyAuditLog } from "../runtime/agent-tool-policy.js"
import {
  appendInRunMemoryReference,
  runPostLifecycle,
  runPreloadLifecycle,
} from "../runtime/context-memory-lifecycle.js"
import { safeCreateHook } from "./safe-hook.js"
import type { PluginHooks } from "./types.js"

export function createHooks(input: { workspaceRoot: string }): PluginHooks {
  const contextPathByTask = new Map<string, string>()

  const beforeRun = safeCreateHook<{
    task: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "cancel"
    source: "slash" | "keyword" | "default"
  }>({
    name: "beforeRun",
    create: () => async (payload) => {
      const preload = await runPreloadLifecycle({
        workspaceRoot: input.workspaceRoot,
        task: payload.task,
        mode: payload.mode,
        source: payload.source,
      })

      if (preload.issueContextPath) {
        contextPathByTask.set(payload.task, preload.issueContextPath)
      }
    },
  })

  const afterRun = safeCreateHook<{
    task: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "cancel"
    source: "slash" | "keyword" | "default"
    status: "completed" | "failed"
  }>({
    name: "afterRun",
    create: () => async (payload) => {
      const issueContextPath = contextPathByTask.get(payload.task)
      await runPostLifecycle({
        workspaceRoot: input.workspaceRoot,
        task: payload.task,
        mode: payload.mode,
        source: payload.source,
        status: payload.status,
        ...(issueContextPath ? { issueContextPath } : {}),
      })

      contextPathByTask.delete(payload.task)
    },
  })

  const onToolPolicyEvaluated = safeCreateHook<{
    task: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "cancel"
    source: "slash" | "keyword" | "default"
    agentRole: string
    toolName: string
    allowed: boolean
    reasonCode: string
    policySource: string
  }>({
    name: "onToolPolicyEvaluated",
    create: () => async (payload) => {
      const issueContextPath = contextPathByTask.get(payload.task)
      if (issueContextPath) {
        await appendInRunMemoryReference({
          workspaceRoot: input.workspaceRoot,
          issueContextPath,
          referencePath: `tool-policy:${payload.agentRole}:${payload.toolName}`,
          reason: `policy ${payload.allowed ? "allow" : "deny"} (${payload.reasonCode})`,
        })
      }

      const auditPath = join(input.workspaceRoot, ".agent-guide", "runtime", "tool-policy-audit.jsonl")
      await mkdir(dirname(auditPath), { recursive: true })
      const entry = createToolPolicyAuditLog({
        allowed: payload.allowed,
        reason_code: payload.reasonCode as "allowed" | "agent_unknown" | "tool_not_allowed" | "tool_explicitly_denied",
        agent: payload.agentRole,
        tool: payload.toolName,
        policy_source: payload.policySource as "default" | "config",
        evaluated_at: new Date().toISOString(),
      })
      await appendFile(auditPath, `${JSON.stringify(entry)}\n`, "utf8")
    },
  })

  return {
    beforeRun,
    afterRun,
    onToolPolicyEvaluated,
  }
}
