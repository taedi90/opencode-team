import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { CORE_AGENT_ROLES, type CoreAgentRole } from "../contracts/roles.js"

export const AGENT_ROLES = CORE_AGENT_ROLES

export type AgentRole = CoreAgentRole

export interface MergePolicyConfig {
  require_user_approval: boolean
}

export interface ModelsConfig {
  orchestrator: string
  plan: string
  architect: string
  critic: string
  researcher: string
  developer: string
  tester: string
  reviewer: string
  documenter: string
}

export interface McpServerConfig {
  enabled: boolean
  required: boolean
  type: "stdio" | "remote"
  command: string
  args: string[]
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>
}

export interface AgentToolPolicy {
  allow: string[]
  deny: string[]
}

export type AgentToolPolicies = Record<AgentRole, AgentToolPolicy>

export interface OpenCodeTeamConfig {
  merge_policy: MergePolicyConfig
  models: ModelsConfig
  mcp: McpConfig
  agent_tools: AgentToolPolicies
}

export interface LoadMergedConfigOptions {
  projectDir: string
  userHome?: string
}

export interface LoadMergedConfigResult {
  config: OpenCodeTeamConfig
  warnings: string[]
  paths: {
    userPath: string
    projectPath: string
  }
}

export interface EnsureUserConfigFileOptions {
  userHome?: string
}

export interface EnsureUserConfigFileResult {
  path: string
  created: boolean
}

export interface EnsureOpenCodePluginRegistrationOptions {
  userHome?: string
  pluginPackage?: string
}

export interface EnsureOpenCodePluginRegistrationResult {
  path: string
  created: boolean
  updated: boolean
  registered: boolean
}

interface OpenCodeTeamConfigPatch {
  merge_policy?: Partial<MergePolicyConfig>
  models?: Partial<ModelsConfig>
  mcp?: {
    servers?: Record<string, Partial<McpServerConfig>>
  }
  agent_tools?: Partial<Record<AgentRole, Partial<AgentToolPolicy>>>
}

const CONFIG_FILE_NAME = "opencode-team.json"
const OPENCODE_CONFIG_FILE_NAME = "opencode.json"
const DEFAULT_PLUGIN_PACKAGE = "opencode-team@latest"
const USER_CONFIG_SUBDIR = ".config/opencode"
const PROJECT_CONFIG_SUBDIR = ".opencode"
const USER_LEGACY_CONFIG_SUBDIRS = [".agent-guide/config", ".opencode"] as const
const PROJECT_LEGACY_CONFIG_SUBDIRS = [".agent-guide/config"] as const

export const DEFAULT_CONFIG: OpenCodeTeamConfig = {
  merge_policy: {
    require_user_approval: true,
  },
  models: {
    orchestrator: "openai/gpt-5.3-codex",
    plan: "openai/gpt-5.3-codex",
    architect: "openai/gpt-5.3-codex",
    critic: "openai/gpt-5.3-codex",
    researcher: "openai/gpt-5.3-codex",
    developer: "openai/gpt-5.3-codex",
    tester: "openai/gpt-5.3-codex",
    reviewer: "openai/gpt-5.3-codex",
    documenter: "openai/gpt-5.3-codex",
  },
  mcp: {
    servers: {
      filesystem: {
        enabled: true,
        required: true,
        type: "stdio",
        command: "mcp-server-filesystem",
        args: [],
      },
      github: {
        enabled: true,
        required: true,
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      },
      web_search: {
        enabled: true,
        required: false,
        type: "remote",
        command: process.env.TAVILY_API_KEY
          ? "https://mcp.tavily.com/mcp/"
          : (process.env.EXA_API_KEY
              ? `https://mcp.exa.ai/mcp?tools=web_search_exa&exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
              : "https://mcp.exa.ai/mcp?tools=web_search_exa"),
        args: [],
      },
      context7: {
        enabled: true,
        required: false,
        type: "remote",
        command: "https://mcp.context7.com/mcp",
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
    researcher: {
      allow: [
        "read",
        "glob",
        "grep",
        "question",
        "web_search",
        "web-search_search",
        "web-search_fetch_content",
        "context7",
        "context7_resolve-library-id",
        "context7_query-docs",
      ],
      deny: ["bash", "write", "edit", "github"],
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
    documenter: {
      allow: ["read", "glob", "grep", "write", "edit", "question"],
      deny: ["bash", "github"],
    },
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cloneDefaults(): OpenCodeTeamConfig {
  const mcpServers: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(DEFAULT_CONFIG.mcp.servers)) {
    mcpServers[name] = {
      enabled: server.enabled,
      required: server.required,
      type: server.type,
      command: server.command,
      args: [...server.args],
    }
  }

  const agentTools = {} as AgentToolPolicies
  for (const role of AGENT_ROLES) {
    const policy = DEFAULT_CONFIG.agent_tools[role]
    agentTools[role] = {
      allow: [...policy.allow],
      deny: [...policy.deny],
    }
  }

  return {
    merge_policy: {
      require_user_approval: DEFAULT_CONFIG.merge_policy.require_user_approval,
    },
    models: AGENT_ROLES.reduce((accumulator, role) => {
      accumulator[role] = DEFAULT_CONFIG.models[role]
      return accumulator
    }, {} as ModelsConfig),
    mcp: {
      servers: mcpServers,
    },
    agent_tools: agentTools,
  }
}

function mergeConfig(base: OpenCodeTeamConfig, patch: OpenCodeTeamConfigPatch): OpenCodeTeamConfig {
  const mergedMcpServers: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(base.mcp.servers)) {
    mergedMcpServers[name] = {
      enabled: server.enabled,
      required: server.required,
      type: server.type,
      command: server.command,
      args: [...server.args],
    }
  }

  if (patch.mcp?.servers) {
    for (const [name, serverPatch] of Object.entries(patch.mcp.servers)) {
      const current = mergedMcpServers[name] ?? {
        enabled: true,
        required: false,
        type: "stdio",
        command: name,
        args: [],
      }

      mergedMcpServers[name] = {
        ...current,
        ...serverPatch,
        args: serverPatch.args ? [...serverPatch.args] : [...current.args],
      }
    }
  }

  const mergedAgentTools = {} as AgentToolPolicies
  for (const role of AGENT_ROLES) {
    const current = base.agent_tools[role]
    const rolePatch = patch.agent_tools?.[role]
    mergedAgentTools[role] = {
      allow: rolePatch?.allow ? [...rolePatch.allow] : [...current.allow],
      deny: rolePatch?.deny ? [...rolePatch.deny] : [...current.deny],
    }
  }

  return {
    merge_policy: {
      ...base.merge_policy,
      ...patch.merge_policy,
    },
    models: {
      ...base.models,
      ...patch.models,
    },
    mcp: {
      servers: mergedMcpServers,
    },
    agent_tools: mergedAgentTools,
  }
}

function parseMergePolicy(
  value: unknown,
  warnings: string[],
): Partial<MergePolicyConfig> {
  if (!isRecord(value)) return {}

  const next: Partial<MergePolicyConfig> = {}
  if (value.mode !== undefined) {
    warnings.push("merge_policy.mode is no longer supported; use merge_policy.require_user_approval (boolean)")
  }

  const requireUserApproval = value.require_user_approval
  if (requireUserApproval !== undefined) {
    if (typeof requireUserApproval === "boolean") {
      next.require_user_approval = requireUserApproval
    } else {
      warnings.push("merge_policy.require_user_approval must be boolean")
    }
  }

  if (Object.keys(next).length === 0) {
    return {}
  }

  return next
}

function parseModels(value: unknown, warnings: string[]): Partial<ModelsConfig> {
  if (!isRecord(value)) return {}

  const next: Partial<ModelsConfig> = {}

  for (const role of AGENT_ROLES) {
    const rawModel = value[role]
    if (rawModel === undefined) continue

    if (typeof rawModel !== "string" || rawModel.trim() === "") {
      warnings.push(`models.${role} must be a non-empty string`)
      continue
    }

    if (!rawModel.startsWith("openai/")) {
      warnings.push(`models.${role} must start with openai/`)
      continue
    }

    next[role] = rawModel.trim()
  }

  return next
}

function parseToolList(value: unknown, warnings: string[], fieldPath: string): string[] | undefined {
  if (!Array.isArray(value)) {
    warnings.push(`${fieldPath} must be a string array`)
    return undefined
  }

  const next: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      warnings.push(`${fieldPath} must contain non-empty strings only`)
      continue
    }
    next.push(item.trim())
  }

  return [...new Set(next)]
}

function parseMcpServers(
  value: unknown,
  warnings: string[],
): { servers?: Record<string, Partial<McpServerConfig>> } {
  if (!isRecord(value)) return {}

  const serversRaw = value.servers
  if (!isRecord(serversRaw)) return {}

  const servers: Record<string, Partial<McpServerConfig>> = {}

  for (const [name, rawServer] of Object.entries(serversRaw)) {
    if (!isRecord(rawServer)) {
      warnings.push(`mcp.servers.${name} must be an object`)
      continue
    }

    const serverPatch: Partial<McpServerConfig> = {}

    if (rawServer.enabled !== undefined) {
      if (typeof rawServer.enabled === "boolean") {
        serverPatch.enabled = rawServer.enabled
      } else {
        warnings.push(`mcp.servers.${name}.enabled must be boolean`)
      }
    }

    if (rawServer.required !== undefined) {
      if (typeof rawServer.required === "boolean") {
        serverPatch.required = rawServer.required
      } else {
        warnings.push(`mcp.servers.${name}.required must be boolean`)
      }
    }

    if (rawServer.command !== undefined) {
      if (typeof rawServer.command === "string" && rawServer.command.trim().length > 0) {
        serverPatch.command = rawServer.command.trim()
      } else {
        warnings.push(`mcp.servers.${name}.command must be a non-empty string`)
      }
    }

    if (rawServer.type !== undefined) {
      if (rawServer.type === "stdio" || rawServer.type === "remote") {
        serverPatch.type = rawServer.type
      } else {
        warnings.push(`mcp.servers.${name}.type must be either stdio or remote`)
      }
    }

    if (rawServer.args !== undefined) {
      if (Array.isArray(rawServer.args) && rawServer.args.every((item) => typeof item === "string")) {
        serverPatch.args = rawServer.args.map((item) => item.trim())
      } else {
        warnings.push(`mcp.servers.${name}.args must be a string array`)
      }
    }

    if (Object.keys(serverPatch).length > 0) {
      servers[name] = serverPatch
    }
  }

  return {
    servers,
  }
}

function parseAgentToolPolicies(
  value: unknown,
  warnings: string[],
): Partial<Record<AgentRole, Partial<AgentToolPolicy>>> {
  if (!isRecord(value)) return {}

  const policies: Partial<Record<AgentRole, Partial<AgentToolPolicy>>> = {}

  for (const [rawRole, rawPolicy] of Object.entries(value)) {
    const role = AGENT_ROLES.find((item) => item === rawRole)
    if (!role) {
      warnings.push(`agent_tools.${rawRole} is not a supported role`)
      continue
    }

    if (!isRecord(rawPolicy)) {
      warnings.push(`agent_tools.${role} must be an object`)
      continue
    }

    const policyPatch: Partial<AgentToolPolicy> = {}

    if (rawPolicy.allow !== undefined) {
      const allow = parseToolList(rawPolicy.allow, warnings, `agent_tools.${role}.allow`)
      if (allow) {
        policyPatch.allow = allow
      }
    }

    if (rawPolicy.deny !== undefined) {
      const deny = parseToolList(rawPolicy.deny, warnings, `agent_tools.${role}.deny`)
      if (deny) {
        policyPatch.deny = deny
      }
    }

    if (Object.keys(policyPatch).length > 0) {
      policies[role] = policyPatch
    }
  }

  return policies
}

function normalizeConfig(raw: unknown, warnings: string[]): OpenCodeTeamConfigPatch {
  if (!isRecord(raw)) return {}

  if (raw.provider !== undefined && raw.provider !== "openai") {
    warnings.push("provider must be openai")
  }

  return {
    merge_policy: parseMergePolicy(raw.merge_policy, warnings),
    models: parseModels(raw.models, warnings),
    mcp: parseMcpServers(raw.mcp, warnings),
    agent_tools: parseAgentToolPolicies(raw.agent_tools, warnings),
  }
}

async function readJsonFile(path: string, warnings: string[]): Promise<unknown | null> {
  try {
    const content = await readFile(path, "utf8")
    try {
      return JSON.parse(content)
    } catch {
      const parsed = parseJsonLike(content)
      if (parsed !== null) {
        return parsed
      }
      throw new SyntaxError("invalid JSON")
    }
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null
    }

    if (error instanceof SyntaxError) {
      warnings.push(`${path}: invalid JSON`)
      return null
    }

    warnings.push(`${path}: failed to read config (${String(error)})`)
    return null
  }
}

function stripJsonComments(content: string): string {
  let output = ""
  let inString = false
  let quote: '"' | "'" | null = null
  let escaped = false
  let i = 0

  while (i < content.length) {
    const ch = content[i]
    const next = i + 1 < content.length ? content[i + 1] : ""

    if (inString) {
      output += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (quote && ch === quote) {
        inString = false
        quote = null
      }
      i += 1
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      output += ch
      i += 1
      continue
    }

    if (ch === "/" && next === "/") {
      i += 2
      while (i < content.length && content[i] !== "\n") {
        i += 1
      }
      continue
    }

    if (ch === "/" && next === "*") {
      i += 2
      while (i + 1 < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        i += 1
      }
      i += 2
      continue
    }

    output += ch
    i += 1
  }

  return output
}

function removeTrailingCommas(content: string): string {
  let output = ""
  let inString = false
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]

    if (inString) {
      output += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (quote && ch === quote) {
        inString = false
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      output += ch
      continue
    }

    if (ch === ",") {
      let j = i + 1
      while (j < content.length && /\s/.test(content[j] ?? "")) {
        j += 1
      }
      const trailing = content[j] ?? ""
      if (j < content.length && (trailing === "}" || trailing === "]")) {
        continue
      }
    }

    output += ch
  }

  return output
}

function parseJsonLike(content: string): unknown | null {
  try {
    const withoutComments = stripJsonComments(content)
    const normalized = removeTrailingCommas(withoutComments)
    return JSON.parse(normalized)
  } catch {
    return null
  }
}

async function readConfigWithFallback(
  primaryPath: string,
  fallbackPaths: readonly string[],
  warnings: string[],
): Promise<{ raw: unknown | null; usedPath: string | null }> {
  const primaryRaw = await readJsonFile(primaryPath, warnings)
  if (primaryRaw !== null) {
    return { raw: primaryRaw, usedPath: primaryPath }
  }

  for (const fallbackPath of fallbackPaths) {
    const fallbackRaw = await readJsonFile(fallbackPath, warnings)
    if (fallbackRaw !== null) {
      warnings.push(`${fallbackPath}: loaded from legacy path; migrate to ${primaryPath}`)
      return { raw: fallbackRaw, usedPath: fallbackPath }
    }
  }

  return { raw: null, usedPath: null }
}

async function persistMigratedConfig(
  sourcePath: string,
  targetPath: string,
  raw: unknown,
  warnings: string[],
): Promise<void> {
  try {
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8")
    warnings.push(`${sourcePath}: migrated to ${targetPath}`)
  } catch (error) {
    warnings.push(`${sourcePath}: failed to migrate to ${targetPath} (${String(error)})`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8")
    return true
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false
    }
    throw error
  }
}

export async function ensureUserConfigFile(
  options: EnsureUserConfigFileOptions = {},
): Promise<EnsureUserConfigFileResult> {
  const userHome = options.userHome ?? process.env.HOME ?? process.env.USERPROFILE ?? ""
  const userPath = join(userHome, USER_CONFIG_SUBDIR, CONFIG_FILE_NAME)

  if (await pathExists(userPath)) {
    return {
      path: userPath,
      created: false,
    }
  }

  await mkdir(dirname(userPath), { recursive: true })
  await writeFile(userPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8")

  return {
    path: userPath,
    created: true,
  }
}

export async function ensureOpenCodePluginRegistration(
  options: EnsureOpenCodePluginRegistrationOptions = {},
): Promise<EnsureOpenCodePluginRegistrationResult> {
  const userHome = options.userHome ?? process.env.HOME ?? process.env.USERPROFILE ?? ""
  const path = join(userHome, USER_CONFIG_SUBDIR, OPENCODE_CONFIG_FILE_NAME)
  const pluginPackage = options.pluginPackage?.trim() || DEFAULT_PLUGIN_PACKAGE

  let created = false
  let rawConfig: unknown

  try {
    const content = await readFile(path, "utf8")
    rawConfig = parseJsonLike(content)
    if (rawConfig === null) {
      return {
        path,
        created: false,
        updated: false,
        registered: false,
      }
    }
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      created = true
      rawConfig = {
        $schema: "https://opencode.ai/config.json",
      }
    } else {
      throw error
    }
  }

  const base = isRecord(rawConfig)
    ? rawConfig
    : {
      $schema: "https://opencode.ai/config.json",
    }

  const plugins = Array.isArray(base.plugin)
    ? base.plugin.filter((item): item is string => typeof item === "string")
    : []

  const alreadyRegistered = plugins.some((item) => item === pluginPackage || item === "opencode-team")
  if (alreadyRegistered) {
    if (created) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify({ ...base, plugin: plugins }, null, 2)}\n`, "utf8")
    }
    return {
      path,
      created,
      updated: created,
      registered: true,
    }
  }

  const next = {
    ...base,
    plugin: [...plugins, pluginPackage],
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")

  return {
    path,
    created,
    updated: true,
    registered: true,
  }
}

export async function loadMergedConfig(
  options: LoadMergedConfigOptions,
): Promise<LoadMergedConfigResult> {
  const warnings: string[] = []
  const userHome = options.userHome ?? process.env.HOME ?? process.env.USERPROFILE ?? ""

  const paths = {
    userPath: join(userHome, USER_CONFIG_SUBDIR, CONFIG_FILE_NAME),
    projectPath: join(options.projectDir, PROJECT_CONFIG_SUBDIR, CONFIG_FILE_NAME),
  }

  const userLegacyPaths = USER_LEGACY_CONFIG_SUBDIRS
    .map((dir) => join(userHome, dir, CONFIG_FILE_NAME))
  const projectLegacyPaths = PROJECT_LEGACY_CONFIG_SUBDIRS
    .map((dir) => join(options.projectDir, dir, CONFIG_FILE_NAME))

  let config = cloneDefaults()

  const userLoaded = await readConfigWithFallback(paths.userPath, userLegacyPaths, warnings)
  if (userLoaded.raw !== null) {
    const userRaw = userLoaded.raw
    if (userLoaded.usedPath && userLoaded.usedPath !== paths.userPath) {
      await persistMigratedConfig(userLoaded.usedPath, paths.userPath, userRaw, warnings)
    }
    const normalized = normalizeConfig(userRaw, warnings)
    config = mergeConfig(config, normalized)
  }

  const projectLoaded = await readConfigWithFallback(paths.projectPath, projectLegacyPaths, warnings)
  if (projectLoaded.raw !== null) {
    const projectRaw = projectLoaded.raw
    if (projectLoaded.usedPath && projectLoaded.usedPath !== paths.projectPath) {
      await persistMigratedConfig(projectLoaded.usedPath, paths.projectPath, projectRaw, warnings)
    }
    const normalized = normalizeConfig(projectRaw, warnings)
    config = mergeConfig(config, normalized)
  }

  return {
    config,
    warnings,
    paths,
  }
}
