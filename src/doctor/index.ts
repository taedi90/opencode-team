import { execFile, spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { loadMergedConfig, type OpenCodeTeamConfig } from "../config/index.js"
import type { DoctorCheck, DoctorCommandResult } from "../plugin/types.js"
import { evaluateMcpDoctorChecks } from "../runtime/mcp-doctor-contract.js"

const execFileAsync = promisify(execFile)

export interface DoctorRunOptions {
  workspaceRoot: string
  userHome?: string
  dependencies?: {
    pathExists?: (path: string) => Promise<boolean>
    checkGhAuth?: () => Promise<{ status: "pass" | "warn" | "fail"; detail: string }>
    checkMcpReachability?: (config: OpenCodeTeamConfig) => Promise<string[]>
    mcpManifestPath?: string
  }
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function defaultGhAuthCheck(): Promise<{ status: "pass" | "warn" | "fail"; detail: string }> {
  try {
    await execFileAsync("gh", ["auth", "status"])
    return {
      status: "pass",
      detail: "gh auth is available",
    }
  } catch {
    return {
      status: "warn",
      detail: "gh auth is not configured or gh is unavailable",
    }
  }
}

async function probeMcpServerInitialize(input: {
  command: string
  args: string[]
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "1",
      },
    })

    const complete = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      try {
        child.kill("SIGTERM")
      } catch {
        // no-op
      }
      resolve(value)
    }

    const timeout = setTimeout(() => {
      complete(false)
    }, 2500)

    let output = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString()
      if (output.includes("\"id\":1") && output.includes("\"result\"")) {
        complete(true)
      }
    })

    child.stderr.on("data", (chunk: Buffer | string) => {
      output += chunk.toString()
    })

    child.on("error", () => {
      complete(false)
    })

    child.on("exit", () => {
      if (!settled) {
        const handshook = output.includes("\"id\":1") && output.includes("\"result\"")
        complete(handshook)
      }
    })

    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "opencode-team-doctor",
          version: "0.1.1",
        },
      },
    }

    try {
      child.stdin.write(`${JSON.stringify(initializeRequest)}\n`)
      child.stdin.end()
    } catch {
      complete(false)
    }
  })
}

async function probeRemoteMcp(url: string): Promise<boolean> {
  const timeoutMs = 5000

  const fetchWithTimeout = async (init: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const response = await fetchWithTimeout({ method: "GET" })
    if (response.status >= 200 && response.status < 300) {
      return true
    }
  } catch {
    // no-op
  }

  try {
    const response = await fetchWithTimeout({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      }),
    })

    return response.status >= 200 && response.status < 300
  } catch {
    return false
  }
}

async function defaultMcpReachabilityCheck(config: OpenCodeTeamConfig): Promise<string[]> {
  const reachable: string[] = []

  const requiredServers = Object.entries(config.mcp.servers)
    .filter(([, server]) => server.required && server.enabled)

  for (const [name, server] of requiredServers) {
    if (server.type === "remote") {
      const url = server.command.trim()
      if (!url) {
        continue
      }

      const healthy = await probeRemoteMcp(url)
      if (healthy) {
        reachable.push(name)
      }
      continue
    }

    const command = server.command.trim()
    if (!command) {
      continue
    }

    const healthy = await probeMcpServerInitialize({
      command,
      args: server.args,
    })
    if (healthy) {
      reachable.push(name)
    }
  }

  return reachable
}

function checkStatusPriority(checks: DoctorCheck[]): DoctorCommandResult["status"] {
  if (checks.some((item) => item.status === "fail")) return "fail"
  if (checks.some((item) => item.status === "warn")) return "warn"
  return "pass"
}

function checkModelPolicy(config: OpenCodeTeamConfig): DoctorCheck {
  const invalid = Object.entries(config.models)
    .filter(([, model]) => !model.startsWith("openai/"))
    .map(([role]) => role)

  if (invalid.length > 0) {
    return {
      name: "models_openai_only",
      status: "fail",
      detail: `non-openai agent models detected: ${invalid.join(", ")}`,
    }
  }

  return {
    name: "models_openai_only",
    status: "pass",
    detail: "all configured models are openai/*",
  }
}

function checkConfigPath(name: string, exists: boolean, path: string): DoctorCheck {
  return {
    name,
    status: exists ? "pass" : "warn",
    detail: exists ? `config found: ${path}` : `config not found: ${path}`,
  }
}

function checkRuntimeContractTests(rolePromptContractExists: boolean, runtimeContractExists: boolean): DoctorCheck {
  const missing: string[] = []
  if (!rolePromptContractExists) {
    missing.push("tests/role-prompts-contract.test.ts")
  }
  if (!runtimeContractExists) {
    missing.push("tests/runtime-role-output-contract.test.ts")
  }

  if (missing.length > 0) {
    return {
      name: "runtime_contract_tests",
      status: "warn",
      detail: `runtime contract tests missing: ${missing.join(", ")}`,
    }
  }

  return {
    name: "runtime_contract_tests",
    status: "pass",
    detail: "runtime contract tests are present",
  }
}

function toDoctorCheck(input: {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
}): DoctorCheck {
  return {
    name: input.name,
    status: input.status,
    detail: input.detail,
  }
}

export async function runDoctor(options: DoctorRunOptions): Promise<DoctorCommandResult> {
  const pathExists = options.dependencies?.pathExists ?? defaultPathExists
  const checkGhAuth = options.dependencies?.checkGhAuth ?? defaultGhAuthCheck
  const checkMcpReachability = options.dependencies?.checkMcpReachability ?? defaultMcpReachabilityCheck

  const merged = await loadMergedConfig({
    projectDir: options.workspaceRoot,
    ...(options.userHome ? { userHome: options.userHome } : {}),
  })

  const mcpManifestPath = options.dependencies?.mcpManifestPath
    ?? join(options.workspaceRoot, ".agent-guide", "runtime", "mcp", "manifest.json")

  const [userConfigExists, projectConfigExists, mcpManifestExists, ghAuth, reachableServers] = await Promise.all([
    pathExists(merged.paths.userPath),
    pathExists(merged.paths.projectPath),
    pathExists(mcpManifestPath),
    checkGhAuth(),
    checkMcpReachability(merged.config),
  ])

  const [rolePromptContractExists, runtimeContractExists] = await Promise.all([
    pathExists(join(options.workspaceRoot, "tests", "role-prompts-contract.test.ts")),
    pathExists(join(options.workspaceRoot, "tests", "runtime-role-output-contract.test.ts")),
  ])

  const checks: DoctorCheck[] = [
    checkConfigPath("user_config", userConfigExists, merged.paths.userPath),
    checkConfigPath("project_config", projectConfigExists, merged.paths.projectPath),
    checkModelPolicy(merged.config),
    toDoctorCheck({
      name: "gh_auth",
      status: ghAuth.status,
      detail: ghAuth.detail,
    }),
    checkRuntimeContractTests(rolePromptContractExists, runtimeContractExists),
  ]

  const mcpChecks = evaluateMcpDoctorChecks({
    config: merged.config,
    manifestExists: mcpManifestExists,
    reachableServers,
  }).map((item) => toDoctorCheck(item))

  checks.push(...mcpChecks)

  return {
    status: checkStatusPriority(checks),
    checks,
  }
}

export function formatDoctorReport(result: DoctorCommandResult): string {
  const lines = [`doctor status: ${result.status}`]
  for (const check of result.checks) {
    lines.push(`- [${check.status}] ${check.name}: ${check.detail}`)
  }
  return `${lines.join("\n")}\n`
}
