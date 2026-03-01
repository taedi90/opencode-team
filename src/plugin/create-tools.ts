import { evaluateToolAccess } from "../runtime/agent-tool-policy.js"

import type { PluginTools } from "./types.js"

export function createTools(): PluginTools {
  return {
    evaluateToolAccess: ({ agentRole, toolName, config }) => evaluateToolAccess({
      agentRole,
      toolName,
      config,
    }),
  }
}
