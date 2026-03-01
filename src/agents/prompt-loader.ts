import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { CoreAgentRole } from "./index.js"

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url))

export interface LoadRolePromptOptions {
  workspaceRoot?: string
}

export interface RolePromptLoadResult {
  role: CoreAgentRole
  path: string
  content: string
}

function resolvePromptCandidates(role: CoreAgentRole, workspaceRoot?: string): string[] {
  const fileName = `${role}.md`
  const candidates = [
    join(CURRENT_DIR, "prompts", fileName),
    join(process.cwd(), "src", "agents", "prompts", fileName),
  ]

  if (workspaceRoot) {
    candidates.unshift(join(workspaceRoot, "src", "agents", "prompts", fileName))
  }

  return [...new Set(candidates)]
}

export async function loadRoleSystemPrompt(
  role: CoreAgentRole,
  options: LoadRolePromptOptions = {},
): Promise<RolePromptLoadResult> {
  const candidates = resolvePromptCandidates(role, options.workspaceRoot)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`role prompt file not found for ${role}`)
  }

  const content = await readFile(found, "utf8")
  return {
    role,
    path: found,
    content: content.trim(),
  }
}
