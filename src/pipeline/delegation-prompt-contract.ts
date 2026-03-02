import { createHash } from "node:crypto"

export interface DelegationPromptInput {
  task: string
  expectedOutcome: string
  requiredTools: string[]
  mustDo: string[]
  mustNotDo: string[]
  context: string[]
}

export interface DelegationPromptSummary {
  hash: string
  lineCount: number
}

function normalizeLines(lines: string[]): string[] {
  const result: string[] = []
  for (const line of lines) {
    const normalized = line.trim()
    if (normalized.length > 0) {
      result.push(normalized)
    }
  }
  return result
}

function formatBulletLines(lines: string[]): string {
  if (lines.length === 0) {
    return "- none"
  }

  return lines.map((line) => `- ${line}`).join("\n")
}

export function buildDelegationPrompt(input: DelegationPromptInput): string {
  const requiredTools = normalizeLines(input.requiredTools)
  const mustDo = normalizeLines(input.mustDo)
  const mustNotDo = normalizeLines(input.mustNotDo)
  const context = normalizeLines(input.context)

  return [
    "1. TASK:",
    input.task.trim(),
    "",
    "2. EXPECTED OUTCOME:",
    input.expectedOutcome.trim(),
    "",
    "3. REQUIRED TOOLS:",
    formatBulletLines(requiredTools),
    "",
    "4. MUST DO:",
    formatBulletLines(mustDo),
    "",
    "5. MUST NOT DO:",
    formatBulletLines(mustNotDo),
    "",
    "6. CONTEXT:",
    formatBulletLines(context),
  ].join("\n")
}

export function summarizeDelegationPrompt(prompt: string): DelegationPromptSummary {
  const hash = createHash("sha256").update(prompt, "utf8").digest("hex")
  const lineCount = prompt.split("\n").length
  return {
    hash,
    lineCount,
  }
}
