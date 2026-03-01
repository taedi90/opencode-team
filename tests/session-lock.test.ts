import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { acquireSessionLock, resolveSessionLockPath } from "../src/runtime/session-lock.js"

let tempRoot = ""

async function createWorkspace(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-lock-"))
  return tempRoot
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("session lock", () => {
  it("acquires and releases lock", async () => {
    const workspaceRoot = await createWorkspace()
    const lock = await acquireSessionLock({
      workspaceRoot,
      sessionId: "s1",
      owner: "test-owner",
    })

    expect(lock.acquired).toBe(true)
    await lock.release()

    const lockPath = resolveSessionLockPath(workspaceRoot, "s1")
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("recovers stale lock using token timestamp", async () => {
    const workspaceRoot = await createWorkspace()
    const lockPath = resolveSessionLockPath(workspaceRoot, "s2")
    await mkdir(dirname(lockPath), { recursive: true })
    const staleToken = JSON.stringify({
      owner: "stale-owner",
      pid: 1,
      acquiredAt: "2000-01-01T00:00:00.000Z",
    })
    await writeFile(lockPath, `${staleToken}\n`, "utf8")

    const lock = await acquireSessionLock({
      workspaceRoot,
      sessionId: "s2",
      owner: "fresh-owner",
      ttlMs: 1,
    })

    expect(lock.acquired).toBe(true)
    await lock.release()
  })
})
