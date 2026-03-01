import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_CONFIG,
  ensureOpenCodePluginRegistration,
  ensureUserConfigFile,
  loadMergedConfig,
  type OpenCodeTeamConfig,
} from "../src/config/index.js"

let tempRoot = ""

async function createTempProject(): Promise<{ projectDir: string; userHome: string }> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-config-"))
  const projectDir = join(tempRoot, "project")
  const userHome = join(tempRoot, "home")
  await mkdir(projectDir, { recursive: true })
  await mkdir(userHome, { recursive: true })
  return { projectDir, userHome }
}

async function writeConfigFile(baseDir: string, value: unknown, relativeDir: string): Promise<void> {
  const configDir = join(baseDir, relativeDir)
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, "opencode-team.json"), JSON.stringify(value, null, 2))
}

async function writeUserConfigFile(baseDir: string, value: unknown): Promise<void> {
  await writeConfigFile(baseDir, value, ".config/opencode")
}

async function writeProjectConfigFile(baseDir: string, value: unknown): Promise<void> {
  await writeConfigFile(baseDir, value, ".opencode")
}

async function writeLegacyConfigFile(baseDir: string, value: unknown): Promise<void> {
  const configDir = join(baseDir, ".agent-guide", "config")
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, "opencode-team.json"), JSON.stringify(value, null, 2))
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("config loader", () => {
  it("uses defaults when config files do not exist", async () => {
    const { projectDir, userHome } = await createTempProject()

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.warnings).toEqual([])
  })

  it("merges user and project config with project precedence", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeUserConfigFile(userHome, {
      merge_policy: { require_user_approval: false },
      models: { low: "openai/gpt-5.3-codex-spark" },
    })

    await writeProjectConfigFile(projectDir, {
      merge_policy: { require_user_approval: true },
      models: { thorough: "openai/gpt-5.3-codex" },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.merge_policy.require_user_approval).toBe(true)
    expect(result.config.models.low).toBe("openai/gpt-5.3-codex-spark")
    expect(result.config.models.thorough).toBe("openai/gpt-5.3-codex")
  })

  it("supports boolean merge policy field require_user_approval", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeProjectConfigFile(projectDir, {
      merge_policy: { require_user_approval: false },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.merge_policy.require_user_approval).toBe(false)
  })

  it("warns when require_user_approval is not boolean", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeProjectConfigFile(projectDir, {
      merge_policy: { require_user_approval: "yes" },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.merge_policy.require_user_approval).toBe(true)
    expect(result.warnings).toContain("merge_policy.require_user_approval must be boolean")
  })

  it("ignores deprecated merge_policy.mode and keeps safe default", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeProjectConfigFile(projectDir, {
      merge_policy: { mode: "unknown-policy" },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.merge_policy.require_user_approval).toBe(true)
    expect(result.warnings).toContain(
      "merge_policy.mode is no longer supported; use merge_policy.require_user_approval (boolean)",
    )
  })

  it("rejects non-openai model identifiers", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeUserConfigFile(userHome, {
      models: {
        standard: "anthropic/claude-sonnet-4",
      },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.models.standard).toBe(DEFAULT_CONFIG.models.standard)
    expect(result.warnings).toContain(
      "models.standard must start with openai/",
    )
  })

  it("keeps valid project config even when user config is malformed", async () => {
    const { projectDir, userHome } = await createTempProject()

    const userConfigDir = join(userHome, ".config", "opencode")
    await mkdir(userConfigDir, { recursive: true })
    await writeFile(join(userConfigDir, "opencode-team.json"), "{ invalid json")

    const projectConfig: Partial<OpenCodeTeamConfig> = {
      merge_policy: { require_user_approval: false },
    }
    await writeProjectConfigFile(projectDir, projectConfig)

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.merge_policy.require_user_approval).toBe(false)
    expect(result.warnings.some((item) => item.includes("invalid JSON"))).toBe(true)
  })

  it("loads legacy .agent-guide/config config when new path is absent", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeLegacyConfigFile(projectDir, {
      merge_policy: { require_user_approval: false },
      models: { standard: "openai/gpt-5.3-codex" },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.merge_policy.require_user_approval).toBe(false)
    expect(result.warnings.some((item) => item.includes("loaded from legacy path"))).toBe(true)
    expect(result.warnings.some((item) => item.includes("migrated to"))).toBe(true)

    const migratedRaw = await readFile(
      join(projectDir, ".opencode", "opencode-team.json"),
      "utf8",
    )
    expect(migratedRaw).toContain("\"require_user_approval\": false")
  })

  it("registers plugin package into opencode.json", async () => {
    const { userHome } = await createTempProject()

    const result = await ensureOpenCodePluginRegistration({ userHome })

    expect(result.registered).toBe(true)
    expect(result.updated).toBe(true)
    expect(result.path).toBe(join(userHome, ".config", "opencode", "opencode.json"))

    const raw = await readFile(result.path, "utf8")
    expect(raw).toContain("opencode-team@latest")
  })

  it("does not duplicate plugin entry when already registered", async () => {
    const { userHome } = await createTempProject()
    const configPath = join(userHome, ".config", "opencode", "opencode.json")
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["opencode-team@latest"],
      }, null, 2),
    )

    const result = await ensureOpenCodePluginRegistration({ userHome })

    expect(result.registered).toBe(true)
    expect(result.updated).toBe(false)
  })

  it("migrates legacy user .agent-guide config to ~/.config/opencode path", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeConfigFile(userHome, {
      merge_policy: { require_user_approval: false },
    }, ".agent-guide/config")

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.merge_policy.require_user_approval).toBe(false)
    expect(result.warnings.some((item) => item.includes("loaded from legacy path"))).toBe(true)

    const migratedRaw = await readFile(
      join(userHome, ".config", "opencode", "opencode-team.json"),
      "utf8",
    )
    expect(migratedRaw).toContain("\"require_user_approval\": false")
  })

  it("creates default user config at ~/.config/opencode when missing", async () => {
    const { userHome } = await createTempProject()

    const created = await ensureUserConfigFile({ userHome })

    expect(created.created).toBe(true)
    expect(created.path).toBe(join(userHome, ".config", "opencode", "opencode-team.json"))

    const savedRaw = await readFile(created.path, "utf8")
    expect(savedRaw).toContain("require_user_approval")
    expect(savedRaw).toContain("openai/gpt-5.3-codex")
  })

  it("does not overwrite existing user config during bootstrap", async () => {
    const { userHome } = await createTempProject()

    await writeUserConfigFile(userHome, {
      merge_policy: { require_user_approval: false },
    })

    const result = await ensureUserConfigFile({ userHome })

    expect(result.created).toBe(false)

    const savedRaw = await readFile(result.path, "utf8")
    expect(savedRaw).toContain("\"require_user_approval\": false")
  })

  it("merges mcp server config with project precedence", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeUserConfigFile(userHome, {
      mcp: {
        servers: {
          github: {
            enabled: false,
            command: "github-user-command",
          },
        },
      },
    })

    await writeProjectConfigFile(projectDir, {
      mcp: {
        servers: {
          github: {
            enabled: true,
            command: "github-project-command",
          },
        },
      },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    const githubServer = result.config.mcp.servers.github
    expect(githubServer).toBeDefined()
    expect(githubServer?.enabled).toBe(true)
    expect(githubServer?.command).toBe("github-project-command")
  })

  it("merges agent tool policy override by role", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeProjectConfigFile(projectDir, {
      agent_tools: {
        reviewer: {
          allow: ["read", "github", "bash"],
          deny: [],
        },
      },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.agent_tools.reviewer.allow).toContain("bash")
    expect(result.config.agent_tools.reviewer.deny).toEqual([])
  })

  it("warns and ignores unsupported agent tool role", async () => {
    const { projectDir, userHome } = await createTempProject()

    await writeProjectConfigFile(projectDir, {
      agent_tools: {
        unknown_role: {
          allow: ["read"],
        },
      },
    })

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.warnings.some((item) => item.includes("unknown_role"))).toBe(true)
    expect(result.config.agent_tools.developer.allow).toContain("bash")
  })

  it("includes default researcher role policy with web research tools", async () => {
    const { projectDir, userHome } = await createTempProject()

    const result = await loadMergedConfig({ projectDir, userHome })

    expect(result.config.agent_tools.researcher.allow).toContain("web_search")
    expect(result.config.agent_tools.researcher.allow).toContain("context7_query-docs")
    expect(result.config.agent_tools.researcher.deny).toContain("bash")
  })

  it("includes optional context7 mcp server by default", async () => {
    const { projectDir, userHome } = await createTempProject()

    const result = await loadMergedConfig({ projectDir, userHome })

    const context7Server = result.config.mcp.servers.context7
    expect(context7Server).toBeDefined()
    expect(context7Server?.enabled).toBe(true)
    expect(context7Server?.required).toBe(false)
  })
})
