import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import {
  cancelModeOperation,
  runModeOperation,
} from "../src/runtime/mode-operations.js"
import { resolveModeStateFilePath } from "../src/runtime/mode-state-contract.js"

let tempRoot = ""

async function createWorkspace(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-mode-"))
  return tempRoot
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("mode operations", () => {
  it("runs ultrawork mode and persists complete state", async () => {
    const workspaceRoot = await createWorkspace()
    const result = await runModeOperation({
      workspaceRoot,
      sessionId: "s1",
      mode: "ultrawork",
      task: "parallel tasks",
    })

    expect(result.status).toBe("completed")
    const content = await readFile(result.stateFilePath, "utf8")
    expect(content).toContain("\"currentPhase\": \"complete\"")

    const reportPath = join(
      workspaceRoot,
      ".agent-guide",
      "runtime",
      "state",
      "sessions",
      "s1",
      "ultrawork-report.json",
    )
    const reportContent = await readFile(reportPath, "utf8")
    expect(reportContent).toContain("\"ultraworkVerified\": true")
  })

  it("runs ralph mode with max iterations", async () => {
    const workspaceRoot = await createWorkspace()
    const result = await runModeOperation({
      workspaceRoot,
      sessionId: "s2",
      mode: "ralph",
      task: "verify",
      maxIterations: 4,
    })

    expect(result.status).toBe("completed")
    const content = await readFile(result.stateFilePath, "utf8")
    expect(content).toContain("\"maxIterations\": 4")
  })

  it("cancels linked mode states in same session only", async () => {
    const workspaceRoot = await createWorkspace()

    const activeAt = new Date().toISOString()
    const targetUltraworkPath = resolveModeStateFilePath({
      workspaceRoot,
      sessionId: "target-session",
      mode: "ultrawork",
    })
    const targetRalphPath = resolveModeStateFilePath({
      workspaceRoot,
      sessionId: "target-session",
      mode: "ralph",
    })
    const otherUltraworkPath = resolveModeStateFilePath({
      workspaceRoot,
      sessionId: "other-session",
      mode: "ultrawork",
    })

    await mkdir(dirname(targetUltraworkPath), { recursive: true })
    await mkdir(dirname(targetRalphPath), { recursive: true })
    await mkdir(dirname(otherUltraworkPath), { recursive: true })

    await writeFile(targetUltraworkPath, `${JSON.stringify({
      version: 1,
      mode: "ultrawork",
      sessionId: "target-session",
      active: true,
      currentPhase: "executing",
      startedAt: activeAt,
      updatedAt: activeAt,
    }, null, 2)}\n`, "utf8")
    await writeFile(targetRalphPath, `${JSON.stringify({
      version: 1,
      mode: "ralph",
      sessionId: "target-session",
      active: true,
      currentPhase: "executing",
      startedAt: activeAt,
      updatedAt: activeAt,
      iteration: 1,
      maxIterations: 3,
      linkedMode: "ultrawork",
    }, null, 2)}\n`, "utf8")
    await writeFile(otherUltraworkPath, `${JSON.stringify({
      version: 1,
      mode: "ultrawork",
      sessionId: "other-session",
      active: true,
      currentPhase: "executing",
      startedAt: activeAt,
      updatedAt: activeAt,
    }, null, 2)}\n`, "utf8")

    await cancelModeOperation({
      workspaceRoot,
      sessionId: "target-session",
      targetMode: "ralph",
    })

    const targetRalph = await readFile(
      targetRalphPath,
      "utf8",
    )
    const otherUltrawork = await readFile(
      otherUltraworkPath,
      "utf8",
    )

    expect(targetRalph).toContain("\"linkedModeTerminalPhase\": \"cancelled\"")
    expect(otherUltrawork).toContain("\"currentPhase\": \"executing\"")
  })

  it("returns immediately for terminal state on resume", async () => {
    const workspaceRoot = await createWorkspace()
    const first = await runModeOperation({
      workspaceRoot,
      sessionId: "resume-1",
      mode: "ultrawork",
      task: "run",
    })

    const resumed = await runModeOperation({
      workspaceRoot,
      sessionId: "resume-1",
      mode: "ultrawork",
      task: "run again",
      resume: true,
    })

    expect(resumed.status).toBe("completed")
    expect(resumed.stateFilePath).toBe(first.stateFilePath)
  })

  it("fails ralph mode when explicit review approval is false", async () => {
    const workspaceRoot = await createWorkspace()
    const reviewPath = join(
      workspaceRoot,
      ".agent-guide",
      "runtime",
      "state",
      "sessions",
      "s3",
      "review-approval.json",
    )
    await mkdir(dirname(reviewPath), { recursive: true })
    await writeFile(reviewPath, "{\"approved\":false}\n", "utf8")

    const result = await runModeOperation({
      workspaceRoot,
      sessionId: "s3",
      mode: "ralph",
      task: "verify",
      maxIterations: 1,
    })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("max iterations reached")
  })

  it("fails ralph mode when linked ultrawork is still active", async () => {
    const workspaceRoot = await createWorkspace()
    const activeAt = new Date().toISOString()
    const ultraworkPath = resolveModeStateFilePath({
      workspaceRoot,
      sessionId: "s4",
      mode: "ultrawork",
    })
    await mkdir(dirname(ultraworkPath), { recursive: true })
    await writeFile(ultraworkPath, `${JSON.stringify({
      version: 1,
      mode: "ultrawork",
      sessionId: "s4",
      active: true,
      currentPhase: "executing",
      startedAt: activeAt,
      updatedAt: activeAt,
    }, null, 2)}\n`, "utf8")

    const result = await runModeOperation({
      workspaceRoot,
      sessionId: "s4",
      mode: "ralph",
      task: "verify",
      maxIterations: 1,
    })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("max iterations reached")
  })

  it("fails when session lock is already held", async () => {
    const workspaceRoot = await createWorkspace()
    const lockPath = join(
      workspaceRoot,
      ".agent-guide",
      "runtime",
      "state",
      "sessions",
      "lock-1",
      "session.lock",
    )
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, "{\"owner\":\"external\"}\n", "utf8")

    const result = await runModeOperation({
      workspaceRoot,
      sessionId: "lock-1",
      mode: "ultrawork",
      task: "parallel tasks",
    })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("session_locked")
  })
})
