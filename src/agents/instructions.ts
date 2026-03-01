import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  assertCoreSystemPromptContract,
  assertMemoryPolicyPromptContract,
  CORE_SYSTEM_PROMPT,
  MEMORY_POLICY_PROMPT,
} from "./core-system-prompt.js"
import type { CoreAgentRole } from "./index.js"
import { loadRoleSystemPrompt } from "./prompt-loader.js"

const REQUIRED_SECTIONS = ["코딩 원칙", "메모리 규칙"] as const

const MEMORY_POLICY_ROLES: readonly CoreAgentRole[] = ["orchestrator"]

export interface AgentInstructionBuildOptions {
  workspaceRoot: string
  role?: CoreAgentRole
  includeProjectAgents?: boolean
  runtimeOverlay?: string
  sessionId?: string
  persistSessionFile?: boolean
}

export interface AgentInstructionResult {
  sourcePath: string
  content: string
  sources: string[]
  sessionFilePath?: string
}

function extractSection(markdown: string, sectionTitle: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n")
  const heading = `## ${sectionTitle}`
  const start = normalized.indexOf(heading)
  if (start < 0) return ""

  const rest = normalized.slice(start)
  const nextHeadingIndex = rest.slice(1).search(/\n##\s+/)
  if (nextHeadingIndex < 0) {
    return rest.trim()
  }

  return rest.slice(0, nextHeadingIndex + 1).trim()
}

async function loadProjectAgentsSections(workspaceRoot: string): Promise<{
  path: string
  content: string
} | null> {
  const agentsPath = join(workspaceRoot, "AGENTS.md")
  if (!existsSync(agentsPath)) {
    return null
  }

  const raw = await readFile(agentsPath, "utf8")
  const sections = REQUIRED_SECTIONS
    .map((title) => extractSection(raw, title))
    .filter((value) => value.length > 0)

  if (sections.length === 0) {
    return null
  }

  return {
    path: agentsPath,
    content: sections.join("\n\n"),
  }
}

function resolveSessionFilePath(workspaceRoot: string, sessionId: string): string {
  return join(
    workspaceRoot,
    ".agent-guide",
    "runtime",
    "sessions",
    sessionId,
    "model-instructions.md",
  )
}

async function persistSessionInstruction(path: string, content: string): Promise<void> {
  const directoryPath = dirname(path)
  await mkdir(directoryPath, { recursive: true })
  await writeFile(path, `${content}\n`, "utf8")
}

export async function buildAgentSystemInstructions(
  options: AgentInstructionBuildOptions,
): Promise<AgentInstructionResult> {
  const role = options.role ?? "orchestrator"
  const includeProjectAgents = options.includeProjectAgents ?? true
  const persistSessionFile = options.persistSessionFile ?? true
  const sessionId = options.sessionId ?? role

  assertCoreSystemPromptContract(CORE_SYSTEM_PROMPT)
  assertMemoryPolicyPromptContract(MEMORY_POLICY_PROMPT)

  const rolePrompt = await loadRoleSystemPrompt(role, {
    workspaceRoot: options.workspaceRoot,
  })

  const sources = ["builtin:core-system-prompt", rolePrompt.path]
  const parts = [
    CORE_SYSTEM_PROMPT,
    `## Role Prompt (${role})\n${rolePrompt.content}`,
  ]

  if (MEMORY_POLICY_ROLES.includes(role)) {
    parts.splice(1, 0, MEMORY_POLICY_PROMPT)
  }

  const projectAgents = includeProjectAgents
    ? await loadProjectAgentsSections(options.workspaceRoot)
    : null

  if (projectAgents) {
    parts.push(`## Project AGENTS Override\n${projectAgents.content}`)
    sources.push(projectAgents.path)
  }

  if (options.runtimeOverlay && options.runtimeOverlay.trim().length > 0) {
    parts.push(`## Runtime Overlay\n${options.runtimeOverlay.trim()}`)
    sources.push("runtime:overlay")
  }

  const content = parts.join("\n\n").trim()
  const sessionFilePath = persistSessionFile
    ? resolveSessionFilePath(options.workspaceRoot, sessionId)
    : undefined

  if (sessionFilePath) {
    await persistSessionInstruction(sessionFilePath, content)
    sources.push(sessionFilePath)
  }

  const result: AgentInstructionResult = {
    sourcePath: projectAgents?.path ?? "builtin:core-system-prompt",
    content,
    sources,
  }

  if (sessionFilePath) {
    result.sessionFilePath = sessionFilePath
  }

  return result
}
