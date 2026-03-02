import { execFile } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { loadMergedConfig, type OpenCodeTeamConfig } from "../config/index.js"

const execFileAsync = promisify(execFile)

interface InstallSpec {
  serverName: string
  packageName: string
}

export function normalizeNpxServerArgs(
  packageName: string,
  args: readonly string[],
  fallbackTail: readonly string[] = [],
): string[] {
  let startIndex = 0
  while (args[startIndex] === "-y" && args[startIndex + 1] === packageName) {
    startIndex += 2
  }

  const tail = args.slice(startIndex)
  const normalizedTail = tail.length > 0 ? [...tail] : [...fallbackTail]
  return ["-y", packageName, ...normalizedTail]
}

export interface EnsureMcpAutoInstallOptions {
  workspaceRoot: string
  userHome?: string
}

const INSTALL_SPECS: readonly InstallSpec[] = [
  {
    serverName: "filesystem",
    packageName: "@modelcontextprotocol/server-filesystem",
  },
  {
    serverName: "github",
    packageName: "@modelcontextprotocol/server-github",
  },
]

function resolveWebsearchUrl(): string {
  if (process.env.TAVILY_API_KEY) {
    return "https://mcp.tavily.com/mcp/"
  }

  if (process.env.EXA_API_KEY) {
    return `https://mcp.exa.ai/mcp?tools=web_search_exa&exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  }

  return "https://mcp.exa.ai/mcp?tools=web_search_exa"
}

function resolveInstalledPackagePath(installRoot: string, packageName: string): string {
  return join(installRoot, "node_modules", ...packageName.split("/"))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function installPackage(installRoot: string, packageName: string): Promise<void> {
  await execFileAsync(
    "npm",
    ["install", "--no-save", "--prefix", installRoot, packageName],
    { cwd: installRoot },
  )
}

function buildProjectConfigPatch(config: OpenCodeTeamConfig): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {
    web_search: {
      enabled: true,
      required: false,
      type: "remote",
      command: resolveWebsearchUrl(),
      args: [],
    },
    context7: {
      enabled: true,
      required: false,
      type: "remote",
      command: "https://mcp.context7.com/mcp",
      args: [],
    },
  }

  const filesystem = config.mcp.servers.filesystem
  if (filesystem && filesystem.enabled && filesystem.type !== "remote") {
    const normalizedFilesystemArgs = normalizeNpxServerArgs(
      "@modelcontextprotocol/server-filesystem",
      filesystem.args,
      ["."],
    )
    mcpServers.filesystem = {
      enabled: filesystem.enabled,
      required: filesystem.required,
      type: "stdio",
      command: "npx",
      args: normalizedFilesystemArgs,
    }
  }

  const github = config.mcp.servers.github
  if (github && github.enabled && github.type !== "remote") {
    const normalizedGithubArgs = normalizeNpxServerArgs(
      "@modelcontextprotocol/server-github",
      github.args,
    )
    mcpServers.github = {
      enabled: github.enabled,
      required: github.required,
      type: "stdio",
      command: "npx",
      args: normalizedGithubArgs,
    }
  }

  return {
    mcp: {
      servers: mcpServers,
    },
  }
}

async function writeProjectPatch(projectPath: string, patch: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(projectPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch (error) {
    if (error) {
      existing = {}
    }
  }

  const existingMcp = (typeof existing.mcp === "object" && existing.mcp !== null && !Array.isArray(existing.mcp))
    ? existing.mcp as Record<string, unknown>
    : {}
  const existingServers = (typeof existingMcp.servers === "object" && existingMcp.servers !== null && !Array.isArray(existingMcp.servers))
    ? existingMcp.servers as Record<string, unknown>
    : {}

  const patchMcp = patch.mcp as Record<string, unknown>
  const patchServers = patchMcp.servers as Record<string, unknown>

  const next = {
    ...existing,
    mcp: {
      ...existingMcp,
      servers: {
        ...existingServers,
        ...patchServers,
      },
    },
  }

  await mkdir(dirname(projectPath), { recursive: true })
  await writeFile(projectPath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

export async function ensureMcpAutoInstall(options: EnsureMcpAutoInstallOptions): Promise<void> {
  if (process.env.VITEST) {
    return
  }

  const merged = await loadMergedConfig({
    projectDir: options.workspaceRoot,
    ...(options.userHome ? { userHome: options.userHome } : {}),
  })

  const installRoot = join(options.workspaceRoot, ".agent-guide", "runtime", "mcp-tools")
  await mkdir(installRoot, { recursive: true })

  for (const spec of INSTALL_SPECS) {
    const server = merged.config.mcp.servers[spec.serverName]
    if (!server || !server.enabled || server.type === "remote") {
      continue
    }

    const packagePath = resolveInstalledPackagePath(installRoot, spec.packageName)
    const installed = await pathExists(packagePath)
    if (!installed) {
      await installPackage(installRoot, spec.packageName)
    }
  }

  const patch = buildProjectConfigPatch(merged.config)
  await writeProjectPatch(merged.paths.projectPath, patch)
}
