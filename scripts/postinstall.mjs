import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const CONFIG_RELATIVE_PATH = ".config/opencode/opencode-team.json"
const PROJECT_CONFIG_RELATIVE_PATH = ".agent-guide/config/opencode-team.json"
const MCP_MANIFEST_RELATIVE_PATH = ".agent-guide/runtime/mcp/manifest.json"

const DEFAULT_CONFIG = {
  merge_policy: {
    require_user_approval: true,
  },
  models: {
    low: "openai/gpt-5.3-codex-spark",
    standard: "openai/gpt-5.3-codex",
    thorough: "openai/gpt-5.3-codex",
  },
  mcp: {
    servers: {
      filesystem: {
        enabled: true,
        required: true,
        command: "mcp-server-filesystem",
        args: [],
      },
      github: {
        enabled: true,
        required: true,
        command: "mcp-server-github",
        args: [],
      },
      web_search: {
        enabled: true,
        required: false,
        command: "mcp-server-web-search",
        args: [],
      },
    },
  },
  agent_tools: {
    orchestrator: {
      allow: ["bash", "read", "glob", "grep", "github", "question"],
      deny: [],
    },
    plan: {
      allow: ["read", "glob", "grep", "write", "question"],
      deny: ["github"],
    },
    architect: {
      allow: ["read", "glob", "grep", "question"],
      deny: ["bash", "github", "write"],
    },
    critic: {
      allow: ["read", "glob", "grep", "question"],
      deny: ["bash", "github", "write"],
    },
    developer: {
      allow: ["bash", "read", "glob", "grep", "write", "edit", "question"],
      deny: [],
    },
    tester: {
      allow: ["bash", "read", "glob", "grep", "question"],
      deny: ["github"],
    },
    reviewer: {
      allow: ["read", "glob", "grep", "github", "question"],
      deny: ["write", "edit", "bash"],
    },
  },
}

async function pathExists(path) {
  try {
    await readFile(path, "utf8")
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

async function ensureDefaultConfig() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  if (!home) return

  const configPath = join(home, CONFIG_RELATIVE_PATH)
  if (await pathExists(configPath)) return

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8")
}

function buildManifest(home) {
  const userPath = home
    ? join(home, CONFIG_RELATIVE_PATH)
    : CONFIG_RELATIVE_PATH
  const projectPath = join(process.cwd(), PROJECT_CONFIG_RELATIVE_PATH)
  const servers = {}

  for (const [name, server] of Object.entries(DEFAULT_CONFIG.mcp.servers)) {
    servers[name] = {
      name,
      enabled: server.enabled,
      required: server.required,
      command: server.command,
      args: [...server.args],
      source: "merged_config",
    }
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    config_paths: {
      user_path: userPath,
      project_path: projectPath,
    },
    servers,
  }
}

async function ensureMcpManifest() {
  const manifestPath = join(process.cwd(), MCP_MANIFEST_RELATIVE_PATH)
  if (await pathExists(manifestPath)) return

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const manifest = buildManifest(home)

  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

async function ensureInstallBootstrap() {
  await ensureDefaultConfig()
  await ensureMcpManifest()
}

ensureInstallBootstrap().catch((error) => {
  process.stderr.write(`[opencode-team] failed to bootstrap install artifacts: ${String(error)}\n`)
})
