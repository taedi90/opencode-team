import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { loadMergedConfig, type OpenCodeTeamConfig } from "../config/index.js"

export interface McpManifestServer {
  name: string
  enabled: boolean
  required: boolean
  type: "stdio" | "remote"
  command: string
  args: string[]
  source: "merged_config"
}

export interface McpManifest {
  version: 1
  generated_at: string
  config_paths: {
    user_path: string
    project_path: string
  }
  servers: Record<string, McpManifestServer>
}

export interface BuildMcpManifestOptions {
  generatedAt?: string
  configPaths: {
    userPath: string
    projectPath: string
  }
}

export interface BootstrapMcpManifestOptions {
  workspaceRoot: string
  manifest: McpManifest
}

export interface BootstrapMcpManifestResult {
  path: string
  created: boolean
  updated: boolean
  manifest: McpManifest
}

export interface EnsureMcpBootstrapOptions {
  workspaceRoot: string
  userHome?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function resolveMcpManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agent-guide", "runtime", "mcp", "manifest.json")
}

async function readManifest(path: string): Promise<McpManifest | null> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) {
      return null
    }
    return parsed as unknown as McpManifest
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

function manifestsEqual(left: McpManifest, right: McpManifest): boolean {
  const leftComparable = {
    ...left,
    generated_at: "",
  }
  const rightComparable = {
    ...right,
    generated_at: "",
  }
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable)
}

function mapManifestServers(config: OpenCodeTeamConfig): Record<string, McpManifestServer> {
  const servers: Record<string, McpManifestServer> = {}
  for (const [name, server] of Object.entries(config.mcp.servers)) {
    servers[name] = {
      name,
      enabled: server.enabled,
      required: server.required,
      type: server.type,
      command: server.command,
      args: [...server.args],
      source: "merged_config",
    }
  }
  return servers
}

export function buildMcpManifest(
  config: OpenCodeTeamConfig,
  options: BuildMcpManifestOptions,
): McpManifest {
  return {
    version: 1,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    config_paths: {
      user_path: options.configPaths.userPath,
      project_path: options.configPaths.projectPath,
    },
    servers: mapManifestServers(config),
  }
}

export async function bootstrapMcpManifest(
  options: BootstrapMcpManifestOptions,
): Promise<BootstrapMcpManifestResult> {
  const path = resolveMcpManifestPath(options.workspaceRoot)
  const previous = await readManifest(path)

  const created = previous === null
  const updated = previous !== null && !manifestsEqual(previous, options.manifest)
  const shouldWrite = created || updated

  if (shouldWrite) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8")
  }

  return {
    path,
    created,
    updated,
    manifest: options.manifest,
  }
}

export async function ensureMcpBootstrap(
  options: EnsureMcpBootstrapOptions,
): Promise<BootstrapMcpManifestResult> {
  const loadOptions: {
    projectDir: string
    userHome?: string
  } = {
    projectDir: options.workspaceRoot,
  }

  if (options.userHome) {
    loadOptions.userHome = options.userHome
  }

  const merged = await loadMergedConfig(loadOptions)

  const manifest = buildMcpManifest(merged.config, {
    configPaths: {
      userPath: merged.paths.userPath,
      projectPath: merged.paths.projectPath,
    },
  })

  return bootstrapMcpManifest({
    workspaceRoot: options.workspaceRoot,
    manifest,
  })
}
