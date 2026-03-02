import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { createPluginRuntime } from "../src/plugin/index.js"

let tempRoot = ""

async function createTempWorkspace(): Promise<{ workspaceRoot: string; userHome: string }> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-plugin-"))
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

describe("plugin runtime", () => {
  it("bootstraps install artifacts", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    const result = await runtime.install()

    expect(result.configPath).toContain("opencode-team.json")
    expect(result.opencodeConfigPath).toContain("opencode.json")
    expect(result.pluginRegistered).toBe(true)
    expect(result.mcpManifestPath).toContain(".agent-guide/runtime/mcp/manifest.json")
  })

  it("runs workflow via runtime.run", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    await runtime.install()
    const result = await runtime.run("bootstrap workflow")

    expect(result.status).toBe("completed")
    expect(result.stateFilePath).toContain(".agent-guide/runtime/state/sessions/default/workflow-state.json")
  })

  it("runs ultrawork and ralph loop from a single slash command", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    await runtime.install()
    const result = await runtime.run("/ulw-loop --session combo-1 --max-iterations 3 implement #31")

    expect(result.status).toBe("completed")
    expect(result.mode).toBe("ulw_loop")
    expect(result.stateFilePath).toContain(".agent-guide/runtime/state/sessions/combo-1/ralph-state.json")
  })

  it("falls back to non-github workflow when gh cli is unavailable", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    await runtime.install()

    const previousPath = process.env.PATH
    const previousOwner = process.env.OPENCODE_GITHUB_OWNER
    const previousRepo = process.env.OPENCODE_GITHUB_REPO

    process.env.PATH = "/nonexistent"
    process.env.OPENCODE_GITHUB_OWNER = "acme"
    process.env.OPENCODE_GITHUB_REPO = "demo"

    try {
      const result = await runtime.run("/orchestrate --session no-gh implement #35")

      expect(result.status).toBe("completed")
      expect(result.error).toBeUndefined()
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }

      if (previousOwner === undefined) {
        delete process.env.OPENCODE_GITHUB_OWNER
      } else {
        process.env.OPENCODE_GITHUB_OWNER = previousOwner
      }

      if (previousRepo === undefined) {
        delete process.env.OPENCODE_GITHUB_REPO
      } else {
        process.env.OPENCODE_GITHUB_REPO = previousRepo
      }
    }
  })

  it("returns doctor checks", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    await runtime.install()
    const result = await runtime.doctor()

    expect(["pass", "warn", "fail"]).toContain(result.status)
    expect(result.checks.some((item) => item.name === "mcp_manifest_exists")).toBe(true)
    expect(result.checks.some((item) => item.name === "agent_tool_policy_valid")).toBe(true)
  })

  it("writes tool policy audit log during run", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    await runtime.install()
    await runtime.run("/orchestrate implement #28")

    const log = await readFile(
      join(workspaceRoot, ".agent-guide", "runtime", "tool-policy-audit.jsonl"),
      "utf8",
    )

    expect(log).toContain("\"reason_code\":\"allowed\"")
    expect(log).toContain("\"agent\":\"orchestrator\"")
    expect(log).toContain("\"session_id\":\"default\"")
    expect(log).toContain("\"stage\":\"requirements\"")
  })

  it("writes workflow event log during orchestrator run", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    await runtime.install()
    await runtime.run("/orchestrate implement #29")

    const events = await readFile(
      join(workspaceRoot, ".agent-guide", "runtime", "workflow-events.jsonl"),
      "utf8",
    )

    expect(events).toContain("\"session_id\":\"default\"")
    expect(events).toContain("\"stage\":\"requirements\"")
    expect(events).toContain("\"phase\":\"starting\"")
  })

  it("persists orchestrator mode state and supports terminal resume", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()
    const runtime = createPluginRuntime({ workspaceRoot, userHome })

    await runtime.install()
    const first = await runtime.run('/orchestrate --session prod-ready implement #47')
    const second = await runtime.run('/orchestrate --session prod-ready implement #47', { resume: true })

    const modeState = await readFile(
      join(
        workspaceRoot,
        ".agent-guide",
        "runtime",
        "state",
        "sessions",
        "prod-ready",
        "orchestrator-state.json",
      ),
      "utf8",
    )

    expect(first.status).toBe("completed")
    expect(second.status).toBe("completed")
    expect(modeState).toContain('"currentPhase": "complete"')
  })
})
