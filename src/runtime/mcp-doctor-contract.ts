import {
  AGENT_ROLES,
  type OpenCodeTeamConfig,
} from "../config/index.js"

export type DoctorCheckStatus = "pass" | "warn" | "fail"

export type McpDoctorCheckName =
  | "mcp_manifest_exists"
  | "mcp_required_servers_configured"
  | "mcp_required_servers_enabled"
  | "mcp_required_servers_reachable"
  | "agent_tool_policy_valid"

export interface McpDoctorCheckResult {
  name: McpDoctorCheckName
  status: DoctorCheckStatus
  detail: string
}

export interface EvaluateMcpDoctorChecksInput {
  config: OpenCodeTeamConfig
  manifestExists: boolean
  reachableServers?: string[]
}

function statusForManifestExists(manifestExists: boolean): McpDoctorCheckResult {
  return {
    name: "mcp_manifest_exists",
    status: manifestExists ? "pass" : "fail",
    detail: manifestExists
      ? "mcp manifest is present"
      : "mcp manifest is missing",
  }
}

function statusForRequiredConfigured(config: OpenCodeTeamConfig): McpDoctorCheckResult {
  const required = Object.entries(config.mcp.servers)
    .filter(([, server]) => server.required)

  const invalid = required
    .filter(([, server]) => server.command.trim().length === 0)
    .map(([name]) => name)

  if (invalid.length > 0) {
    return {
      name: "mcp_required_servers_configured",
      status: "fail",
      detail: `required mcp servers missing command: ${invalid.join(", ")}`,
    }
  }

  return {
    name: "mcp_required_servers_configured",
    status: "pass",
    detail: "required mcp servers have commands",
  }
}

function statusForRequiredEnabled(config: OpenCodeTeamConfig): McpDoctorCheckResult {
  const disabledRequired = Object.entries(config.mcp.servers)
    .filter(([, server]) => server.required && !server.enabled)
    .map(([name]) => name)

  if (disabledRequired.length > 0) {
    return {
      name: "mcp_required_servers_enabled",
      status: "fail",
      detail: `required mcp servers disabled: ${disabledRequired.join(", ")}`,
    }
  }

  return {
    name: "mcp_required_servers_enabled",
    status: "pass",
    detail: "required mcp servers enabled",
  }
}

function statusForRequiredReachable(
  config: OpenCodeTeamConfig,
  reachableServers: readonly string[] | undefined,
): McpDoctorCheckResult {
  if (!reachableServers) {
    return {
      name: "mcp_required_servers_reachable",
      status: "warn",
      detail: "reachability not checked",
    }
  }

  const reachable = new Set(reachableServers)
  const missing = Object.entries(config.mcp.servers)
    .filter(([, server]) => server.required && server.enabled)
    .map(([name]) => name)
    .filter((name) => !reachable.has(name))

  if (missing.length > 0) {
    return {
      name: "mcp_required_servers_reachable",
      status: "fail",
      detail: `required mcp servers unreachable: ${missing.join(", ")}`,
    }
  }

  return {
    name: "mcp_required_servers_reachable",
    status: "pass",
    detail: "required mcp servers reachable",
  }
}

function statusForAgentToolPolicy(config: OpenCodeTeamConfig): McpDoctorCheckResult {
  const invalidRoles = AGENT_ROLES.filter((role) => {
    const policy = config.agent_tools[role]
    return policy.allow.length === 0
  })

  if (invalidRoles.length > 0) {
    return {
      name: "agent_tool_policy_valid",
      status: "fail",
      detail: `agent tool allowlist empty: ${invalidRoles.join(", ")}`,
    }
  }

  return {
    name: "agent_tool_policy_valid",
    status: "pass",
    detail: "agent tool policies are valid",
  }
}

export function evaluateMcpDoctorChecks(
  input: EvaluateMcpDoctorChecksInput,
): McpDoctorCheckResult[] {
  return [
    statusForManifestExists(input.manifestExists),
    statusForRequiredConfigured(input.config),
    statusForRequiredEnabled(input.config),
    statusForRequiredReachable(input.config, input.reachableServers),
    statusForAgentToolPolicy(input.config),
  ]
}
