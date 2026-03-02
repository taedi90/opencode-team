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
  const contextPathByRun = new Map<string, string>()

  function toRunKey(payload: { sessionId: string; task: string }): string {
    return `${payload.sessionId}::${payload.task}`
  }

  const beforeRun = safeCreateHook<{
    task: string
    sessionId: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "ulw_loop" | "cancel"
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
        contextPathByRun.set(toRunKey(payload), preload.issueContextPath)
      }
    },
  })

  const afterRun = safeCreateHook<{
    task: string
    sessionId: string
    mode: "orchestrator" | "ultrawork" | "ralph" | "ulw_loop" | "cancel"
    source: "slash" | "keyword" | "default"
    status: "completed" | "failed"
  }>({
    name: "afterRun",
    create: () => async (payload) => {
      const issueContextPath = contextPathByRun.get(toRunKey(payload))
      await runPostLifecycle({
        workspaceRoot: input.workspaceRoot,
        task: payload.task,
        mode: payload.mode,
        source: payload.source,
        status: payload.status,
        ...(issueContextPath ? { issueContextPath } : {}),
      })

      contextPathByRun.delete(toRunKey(payload))
    },
  })

  const onToolPolicyEvaluated = safeCreateHook<{
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
  }>({
    name: "onToolPolicyEvaluated",
    create: () => async (payload) => {
      const issueContextPath = contextPathByRun.get(toRunKey(payload))
      if (issueContextPath) {
        await appendInRunMemoryReference({
          workspaceRoot: input.workspaceRoot,
          issueContextPath,
          referencePath: payload.stage
            ? `tool-policy:${payload.stage}:${payload.agentRole}:${payload.toolName}`
            : `tool-policy:${payload.agentRole}:${payload.toolName}`,
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
      }, {
        sessionId: payload.sessionId,
        ...(payload.stage ? { stage: payload.stage } : {}),
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
