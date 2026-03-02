import { describe, expect, it } from "vitest"

import { DEFAULT_CONFIG, type OpenCodeTeamConfig } from "../src/config/index.js"
import { evaluateMcpDoctorChecks } from "../src/runtime/mcp-doctor-contract.js"

describe("mcp doctor contract", () => {
  it("fails when manifest is missing", () => {
    const checks = evaluateMcpDoctorChecks({
      config: DEFAULT_CONFIG,
      manifestExists: false,
    })

    const manifestCheck = checks.find((item) => item.name === "mcp_manifest_exists")
    expect(manifestCheck?.status).toBe("fail")
  })

  it("fails when required server is disabled", () => {
    const defaultGithub = DEFAULT_CONFIG.mcp.servers.github
    if (!defaultGithub) {
      throw new Error("default github mcp server is missing")
    }

    const config: OpenCodeTeamConfig = {
      ...DEFAULT_CONFIG,
      mcp: {
        servers: {
          ...DEFAULT_CONFIG.mcp.servers,
          github: {
            enabled: false,
            required: defaultGithub.required,
            type: defaultGithub.type,
            command: defaultGithub.command,
            args: [...defaultGithub.args],
          },
        },
      },
    }

    const checks = evaluateMcpDoctorChecks({
      config,
      manifestExists: true,
    })

    const enabledCheck = checks.find((item) => item.name === "mcp_required_servers_enabled")
    expect(enabledCheck?.status).toBe("fail")
    expect(enabledCheck?.detail).toContain("github")
  })

  it("includes troubleshooting hint when required server is unreachable", () => {
    const checks = evaluateMcpDoctorChecks({
      config: DEFAULT_CONFIG,
      manifestExists: true,
      reachableServers: [],
    })

    const reachableCheck = checks.find((item) => item.name === "mcp_required_servers_reachable")
    expect(reachableCheck?.status).toBe("fail")
    expect(reachableCheck?.detail).toContain("filesystem")
    expect(reachableCheck?.detail).toContain("GH_TOKEN")
  })

  it("fails when agent allowlist is empty", () => {
    const config: OpenCodeTeamConfig = {
      ...DEFAULT_CONFIG,
      agent_tools: {
        ...DEFAULT_CONFIG.agent_tools,
        developer: {
          allow: [],
          deny: [],
        },
      },
    }

    const checks = evaluateMcpDoctorChecks({
      config,
      manifestExists: true,
      reachableServers: ["filesystem", "github"],
    })

    const policyCheck = checks.find((item) => item.name === "agent_tool_policy_valid")
    expect(policyCheck?.status).toBe("fail")
    expect(policyCheck?.detail).toContain("developer")
  })
})
