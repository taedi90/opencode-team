import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { ensureUserConfigFile } from "../src/config/index.js"
import { ensureMcpBootstrap } from "../src/runtime/mcp-bootstrap.js"

let tempRoot = ""

async function createTempWorkspace(): Promise<{ workspaceRoot: string; userHome: string }> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-mcp-"))
  const workspaceRoot = join(tempRoot, "workspace")
  const userHome = join(tempRoot, "home")
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(userHome, { recursive: true })
  return { workspaceRoot, userHome }
}

async function writeProjectConfig(workspaceRoot: string, value: unknown): Promise<void> {
  const configDir = join(workspaceRoot, ".agent-guide", "config")
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, "opencode-team.json"), JSON.stringify(value, null, 2))
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("mcp bootstrap", () => {
  it("creates mcp manifest from merged config", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    await ensureUserConfigFile({ userHome })
    const result = await ensureMcpBootstrap({ workspaceRoot, userHome })

    expect(result.created).toBe(true)
    expect(result.updated).toBe(false)

    const raw = await readFile(result.path, "utf8")
    expect(raw).toContain("\"version\": 1")
    expect(raw).toContain("\"filesystem\"")
    expect(raw).toContain("\"github\"")
  })

  it("keeps manifest when there is no config change", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    await ensureUserConfigFile({ userHome })
    await ensureMcpBootstrap({ workspaceRoot, userHome })

    const second = await ensureMcpBootstrap({ workspaceRoot, userHome })

    expect(second.created).toBe(false)
    expect(second.updated).toBe(false)
  })

  it("updates manifest when project mcp config changes", async () => {
    const { workspaceRoot, userHome } = await createTempWorkspace()

    await ensureUserConfigFile({ userHome })
    await ensureMcpBootstrap({ workspaceRoot, userHome })

    await writeProjectConfig(workspaceRoot, {
      mcp: {
        servers: {
          github: {
            enabled: false,
          },
        },
      },
    })

    const updated = await ensureMcpBootstrap({ workspaceRoot, userHome })

    expect(updated.created).toBe(false)
    expect(updated.updated).toBe(true)

    const raw = await readFile(updated.path, "utf8")
    expect(raw).toContain("\"github\"")
    expect(raw).toContain("\"enabled\": false")
  })
})
