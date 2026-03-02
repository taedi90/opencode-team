export const RUN_COMMAND_MODES = ["orchestrator", "ultrawork", "ralph", "ulw_loop", "cancel"] as const

export type RunCommandMode = (typeof RUN_COMMAND_MODES)[number]
export type CancelTargetMode = "orchestrator" | "ultrawork" | "ralph"
export type RunRouteSource = "slash" | "keyword" | "default"

export interface ParsedRunCommand {
  mode: RunCommandMode
  source: RunRouteSource
  task: string
  args: string[]
  sessionId: string
  maxIterations?: number
  cancelTargetMode: CancelTargetMode
  command?: string
}

interface SlashCommandSchema {
  mode: RunCommandMode
  aliases: string[]
}

interface KeywordPattern {
  mode: RunCommandMode
  regex: RegExp
}

interface KeywordMatch {
  mode: RunCommandMode
  index: number
}

const SLASH_SCHEMAS: readonly SlashCommandSchema[] = [
  { mode: "orchestrator", aliases: ["orchestrate"] },
  { mode: "ultrawork", aliases: ["ultrawork", "ulw"] },
  { mode: "ralph", aliases: ["ralph"] },
  { mode: "ulw_loop", aliases: ["ulw-loop", "ultrawork-ralph"] },
  { mode: "cancel", aliases: ["cancel"] },
]

const KEYWORD_PATTERNS: readonly KeywordPattern[] = [
  { mode: "cancel", regex: /\bcancel\b|\bstop\b|\babort\b/i },
  { mode: "ultrawork", regex: /\bultrawork\b|\bulw\b|\bparallel\b/i },
  { mode: "ralph", regex: /\bralph\b|끝까지|must complete/i },
  { mode: "orchestrator", regex: /\borchestrate\b/i },
]

function splitTokens(value: string): string[] {
  return value.trim().split(/\s+/).filter((token) => token.length > 0)
}

function resolveModeFromSlash(command: string): RunCommandMode | null {
  const normalized = command.toLowerCase()
  for (const schema of SLASH_SCHEMAS) {
    if (schema.aliases.includes(normalized)) {
      return schema.mode
    }
  }
  return null
}

function detectKeywordMode(task: string): RunCommandMode | null {
  const matches: KeywordMatch[] = []
  for (const pattern of KEYWORD_PATTERNS) {
    const result = pattern.regex.exec(task)
    if (!result || result.index < 0) {
      continue
    }
    matches.push({ mode: pattern.mode, index: result.index })
  }

  if (matches.length === 0) {
    return null
  }

  matches.sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index
    }

    return KEYWORD_PATTERNS.findIndex((item) => item.mode === left.mode)
      - KEYWORD_PATTERNS.findIndex((item) => item.mode === right.mode)
  })

  return matches[0]?.mode ?? null
}

function parseArgSchema(args: string[]): {
  taskTokens: string[]
  sessionId: string
  maxIterations?: number
  cancelTargetMode: CancelTargetMode
} {
  const taskTokens: string[] = []
  let sessionId = "default"
  let maxIterations: number | undefined
  let cancelTargetMode: CancelTargetMode = "orchestrator"

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    const next = args[index + 1]

    if (!token) {
      continue
    }

    if (token === "--session" && typeof next === "string" && next.trim().length > 0) {
      sessionId = next.trim()
      index += 1
      continue
    }

    if (token === "--max-iterations" && typeof next === "string") {
      const parsed = Number.parseInt(next, 10)
      if (Number.isInteger(parsed) && parsed > 0) {
        maxIterations = parsed
      }
      index += 1
      continue
    }

    if (token === "--target" && typeof next === "string") {
      const validTargets: CancelTargetMode[] = ["orchestrator", "ultrawork", "ralph"]
      if (validTargets.includes(next as CancelTargetMode)) {
        cancelTargetMode = next as CancelTargetMode
      }
      index += 1
      continue
    }

    taskTokens.push(token)
  }

  return {
    taskTokens,
    sessionId,
    ...(maxIterations ? { maxIterations } : {}),
    cancelTargetMode,
  }
}

export function parseRunCommand(rawTask: string): ParsedRunCommand {
  const trimmed = rawTask.trim()
  if (!trimmed) {
    return {
      mode: "orchestrator",
      source: "default",
      task: "",
      args: [],
      sessionId: "default",
      cancelTargetMode: "orchestrator",
    }
  }

  const tokens = splitTokens(trimmed)
  const first = tokens[0]

  if (first?.startsWith("/")) {
    const command = first.slice(1)
    const mode = resolveModeFromSlash(command)
    if (!mode) {
      throw new Error(`unknown slash command: /${command}`)
    }

    const args = tokens.slice(1)
    const parsed = parseArgSchema(args)
    return {
      mode,
      source: "slash",
      task: parsed.taskTokens.join(" "),
      args,
      sessionId: parsed.sessionId,
      ...(parsed.maxIterations ? { maxIterations: parsed.maxIterations } : {}),
      cancelTargetMode: parsed.cancelTargetMode,
      command,
    }
  }

  const keywordMode = detectKeywordMode(trimmed)
  const parsed = parseArgSchema(tokens)
  return {
    mode: keywordMode ?? "orchestrator",
    source: keywordMode ? "keyword" : "default",
    task: parsed.taskTokens.join(" "),
    args: tokens,
    sessionId: parsed.sessionId,
    ...(parsed.maxIterations ? { maxIterations: parsed.maxIterations } : {}),
    cancelTargetMode: parsed.cancelTargetMode,
  }
}
