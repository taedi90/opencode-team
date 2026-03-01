import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const GENERATED_PATH_PREFIXES = [
  ".agent-guide/runtime/",
  ".agent-guide/context/",
]

const ALLOWED_UNTRACKED_PREFIXES = [
  "src/",
  "tests/",
  "scripts/",
  ".github/",
]

const ALLOWED_UNTRACKED_FILES = new Set([
  ".gitignore",
  "README.md",
  "ARCHITECTURE.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
])

function unquotePath(path) {
  const trimmed = path.trim()
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parsePorcelainPaths(pathField) {
  const parts = pathField
    .split(" -> ")
    .map((item) => unquotePath(item))
    .filter((item) => item.length > 0)

  if (parts.length === 0) {
    return []
  }

  if (parts.length === 1) {
    return [parts[0]]
  }

  return [parts[0], parts[parts.length - 1]]
}

function isGeneratedPath(path) {
  return GENERATED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function isAllowedUntrackedPath(path) {
  if (ALLOWED_UNTRACKED_FILES.has(path)) {
    return true
  }
  return ALLOWED_UNTRACKED_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function resolveCommittablePaths(statusOutput) {
  const collected = new Set()

  for (const line of statusOutput.split("\n")) {
    if (line.length < 4) {
      continue
    }

    const statusCode = line.slice(0, 2)
    const pathField = line.slice(3).trim()
    if (!pathField) {
      continue
    }

    const paths = parsePorcelainPaths(pathField)
    const isUntracked = statusCode === "??"

    for (const path of paths) {
      if (isGeneratedPath(path)) {
        continue
      }
      if (isUntracked && !isAllowedUntrackedPath(path)) {
        continue
      }
      collected.add(path)
    }
  }

  return [...collected]
}

export async function assertCommittableChanges(input) {
  await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: input.cwd,
  })

  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: input.cwd,
  })

  const committablePaths = resolveCommittablePaths(stdout)
  if (committablePaths.length === 0) {
    throw new Error("development script produced no committable changes")
  }

  const expectedPaths = (input.expectedPaths ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
  for (const expected of expectedPaths) {
    if (!committablePaths.includes(expected)) {
      throw new Error(`expected changed file is not committable: ${expected}`)
    }
  }

  return committablePaths
}
