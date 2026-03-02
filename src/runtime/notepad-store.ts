import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const MAX_NOTEPAD_BYTES = 32 * 1024
const DEFAULT_OVERLAY_LINES_PER_FILE = 20

const NOTEPAD_FILE_BY_KIND = {
  learnings: "learnings.md",
  decisions: "decisions.md",
  issues: "issues.md",
} as const

export type NotepadKind = keyof typeof NOTEPAD_FILE_BY_KIND

const NOTEPAD_KINDS: readonly NotepadKind[] = ["learnings", "decisions", "issues"]

function toAscii(value: string): string {
  return value.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?")
}

function cleanLines(lines: readonly string[]): string[] {
  return lines
    .map((line) => toAscii(line).trim())
    .filter((line) => line.length > 0)
}

function capToMaxBytes(content: string, maxBytes: number): string {
  let next = content
  while (Buffer.byteLength(next, "utf8") > maxBytes) {
    const breakIndex = next.indexOf("\n")
    if (breakIndex < 0) {
      return ""
    }
    next = next.slice(breakIndex + 1)
  }
  return next
}

function resolveNotepadPath(workspaceRoot: string, sessionId: string, kind: NotepadKind): string {
  return join(workspaceRoot, ".agent-guide", "notepads", sessionId, NOTEPAD_FILE_BY_KIND[kind])
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return ""
    }
    throw error
  }
}

export async function appendNotepadLines(input: {
  workspaceRoot: string
  sessionId: string
  kind: NotepadKind
  lines: readonly string[]
  maxBytes?: number
}): Promise<void> {
  const maxBytes = input.maxBytes ?? MAX_NOTEPAD_BYTES
  const sanitizedLines = cleanLines(input.lines)
  if (sanitizedLines.length === 0) {
    return
  }

  const path = resolveNotepadPath(input.workspaceRoot, input.sessionId, input.kind)
  await mkdir(dirname(path), { recursive: true })

  const current = await readTextFile(path)
  const nextRaw = `${current}${sanitizedLines.join("\n")}\n`
  const next = capToMaxBytes(nextRaw, maxBytes)

  await writeFile(path, next, "utf8")
}

export async function loadNotepadRuntimeOverlay(input: {
  workspaceRoot: string
  sessionId: string
  lastLinesPerFile?: number
}): Promise<string> {
  const lineLimit = input.lastLinesPerFile ?? DEFAULT_OVERLAY_LINES_PER_FILE
  const sections: string[] = []

  for (const kind of NOTEPAD_KINDS) {
    const path = resolveNotepadPath(input.workspaceRoot, input.sessionId, kind)
    const raw = toAscii(await readTextFile(path))
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const tail = lines.slice(-lineLimit)
    if (tail.length > 0) {
      sections.push(`${kind}:\n${tail.join("\n")}`)
    }
  }

  return sections.join("\n\n")
}
