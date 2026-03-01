import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface SessionLockHandle {
  path: string
  token: string
  acquired: boolean
  holder?: string
  release: () => Promise<void>
}

interface SessionLockTokenPayload {
  owner: string
  pid: number
  acquiredAt: string
}

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000

function nowIso(): string {
  return new Date().toISOString()
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function createLockToken(owner: string): string {
  return JSON.stringify({
    owner,
    pid: process.pid,
    acquiredAt: nowIso(),
  })
}

function parseToken(value: string): SessionLockTokenPayload | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      typeof parsed === "object"
      && parsed !== null
      && typeof (parsed as { owner?: unknown }).owner === "string"
      && typeof (parsed as { pid?: unknown }).pid === "number"
      && typeof (parsed as { acquiredAt?: unknown }).acquiredAt === "string"
    ) {
      return parsed as SessionLockTokenPayload
    }
    return null
  } catch {
    return null
  }
}

function isStaleByToken(token: string, ttlMs: number): boolean {
  const parsed = parseToken(token)
  if (!parsed) {
    return false
  }
  const acquiredAt = Date.parse(parsed.acquiredAt)
  if (Number.isNaN(acquiredAt)) {
    return false
  }
  return Date.now() - acquiredAt > ttlMs
}

async function isStaleByFileAge(path: string, ttlMs: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return Date.now() - info.mtimeMs > ttlMs
  } catch {
    return false
  }
}

export function resolveSessionLockPath(workspaceRoot: string, sessionId: string): string {
  return join(
    workspaceRoot,
    ".agent-guide",
    "runtime",
    "state",
    "sessions",
    sessionId,
    "session.lock",
  )
}

export async function acquireSessionLock(input: {
  workspaceRoot: string
  sessionId: string
  owner: string
  ttlMs?: number
}): Promise<SessionLockHandle> {
  const path = resolveSessionLockPath(input.workspaceRoot, input.sessionId)
  const token = createLockToken(input.owner)

  await mkdir(dirname(path), { recursive: true })

  const ttlMs = input.ttlMs ?? DEFAULT_LOCK_TTL_MS

  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx" })
    return {
      path,
      token,
      acquired: true,
      release: async () => {
        try {
          const current = await readFile(path, "utf8")
          if (current.trim() === token) {
            await rm(path, { force: true })
          }
        } catch (error) {
          if (isErrnoException(error) && error.code === "ENOENT") {
            return
          }
          throw error
        }
      },
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      throw error
    }

    let holder: string | undefined
    try {
      holder = (await readFile(path, "utf8")).trim()
    } catch {
      holder = undefined
    }

    const staleByToken = holder ? isStaleByToken(holder, ttlMs) : false
    const staleByMtime = !staleByToken && await isStaleByFileAge(path, ttlMs)
    if (staleByToken || staleByMtime) {
      await rm(path, { force: true })
      return acquireSessionLock(input)
    }

    return {
      path,
      token,
      acquired: false,
      ...(holder ? { holder } : {}),
      release: async () => {},
    }
  }
}
