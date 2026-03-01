import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { ensureUserConfigFile } from "../src/config/index.js"
import { runDoctor } from "../src/doctor/index.js"
import { ensureMcpBootstrap } from "../src/runtime/mcp-bootstrap.js"

let tempRoot = ""

async function createTempWorkspace(): Promise<{ workspaceRoot: string; userHome: string }> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-doctor-"))
  const workspaceRoot = join(tempRoot, "workspace")
  const userHome = join(tempRoot, "home")
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(userHome, { recursive: true })
  return { workspaceRoot, userHome }
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("doctor", () => {
  it("reports pass/warn checks with injected dependencies", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    await ensureUserConfigFile({ userHome })
    await ensureMcpBootstrap({ workspaceRoot, userHome })

    const result = await runDoctor({
      workspaceRoot,
      userHome,
      dependencies: {
        checkGhAuth: async () => ({
          status: "pass",
          detail: "ok",
        }),
      },
    })

    expect(result.checks.some((item) => item.name === "mcp_manifest_exists")).toBe(true)
    expect(result.checks.some((item) => item.name === "gh_auth")).toBe(true)
    expect(result.checks.some((item) => item.name === "runtime_contract_tests")).toBe(true)
    expect(["pass", "warn", "fail"]).toContain(result.status)
  })

  it("fails when mcp manifest path is missing", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    await ensureUserConfigFile({ userHome })

    const missingManifestPath = join(workspaceRoot, ".agent-guide", "runtime", "mcp", "missing.json")

    const result = await runDoctor({
      workspaceRoot,
      userHome,
      dependencies: {
        mcpManifestPath: missingManifestPath,
        checkGhAuth: async () => ({
          status: "pass",
          detail: "ok",
        }),
      },
    })

    const manifestCheck = result.checks.find((item) => item.name === "mcp_manifest_exists")
    expect(manifestCheck?.status).toBe("fail")
    expect(result.status).toBe("fail")
  })

  it("uses custom pathExists dependency", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    await ensureUserConfigFile({ userHome })

    const projectConfigPath = join(workspaceRoot, ".opencode", "opencode-team.json")
    await mkdir(join(workspaceRoot, ".opencode"), { recursive: true })
    await writeFile(projectConfigPath, "{}")

    const result = await runDoctor({
      workspaceRoot,
      userHome,
      dependencies: {
        pathExists: async (path) => path === projectConfigPath,
        checkGhAuth: async () => ({
          status: "warn",
          detail: "not logged in",
        }),
      },
    })

    const projectCheck = result.checks.find((item) => item.name === "project_config")
    expect(projectCheck?.status).toBe("pass")
  })

  it("fails when required MCP servers are unreachable", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    await ensureUserConfigFile({ userHome })
    await ensureMcpBootstrap({ workspaceRoot, userHome })

    const result = await runDoctor({
      workspaceRoot,
      userHome,
      dependencies: {
        checkGhAuth: async () => ({
          status: "pass",
          detail: "ok",
        }),
        checkMcpReachability: async () => [],
      },
    })

    const reachableCheck = result.checks.find((item) => item.name === "mcp_required_servers_reachable")
    expect(reachableCheck?.status).toBe("fail")
  })

  it("passes required MCP reachability when initialize handshake succeeds", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    const userConfig = await ensureUserConfigFile({ userHome })
    await ensureMcpBootstrap({ workspaceRoot, userHome })

    const mcpHandshakeScript = [
      "process.stdin.setEncoding('utf8');",
      "let raw='';",
      "process.stdin.on('data',(chunk)=>{raw+=chunk});",
      "process.stdin.on('end',()=>{",
      "  const first = raw.split('\\n').map((item)=>item.trim()).filter(Boolean)[0];",
      "  const req = first ? JSON.parse(first) : { id: 1 };",
      "  const res = { jsonrpc:'2.0', id:req.id ?? 1, result:{ protocolVersion:'2024-11-05', capabilities:{}, serverInfo:{ name:'mock', version:'1.0.0'} } };",
      "  process.stdout.write(JSON.stringify(res)+'\\n');",
      "});",
    ].join("")

    await writeFile(
      userConfig.path,
      `${JSON.stringify({
        mcp: {
          servers: {
            filesystem: {
              enabled: true,
              required: true,
              command: "node",
              args: ["-e", mcpHandshakeScript],
            },
            github: {
              enabled: false,
              required: false,
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    )

    const result = await runDoctor({
      workspaceRoot,
      userHome,
      dependencies: {
        checkGhAuth: async () => ({
          status: "pass",
          detail: "ok",
        }),
      },
    })

    const reachableCheck = result.checks.find((item) => item.name === "mcp_required_servers_reachable")
    expect(reachableCheck?.status).toBe("pass")
  })
})
