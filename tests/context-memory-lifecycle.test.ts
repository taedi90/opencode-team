import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import {
  runPostLifecycle,
  runPreloadLifecycle,
} from "../src/runtime/context-memory-lifecycle.js"

let tempDir = ""

async function createWorkspace(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "opencode-team-lifecycle-"))
  await mkdir(join(tempDir, ".agent-guide", "context"), { recursive: true })
  await mkdir(join(tempDir, ".agent-guide", "memory"), { recursive: true })
  await writeFile(
    join(tempDir, ".agent-guide", "context", "issue-028-lifecycle.md"),
    "# Issue 28\n\n## Goal\n- preload\n",
    "utf8",
  )
  await writeFile(
    join(tempDir, ".agent-guide", "memory", "memory-runtime-rule.md"),
    "# Memory\n",
    "utf8",
  )
  await writeFile(
    join(tempDir, ".agent-guide", "context", "tmp-session.md"),
    "temporary\n",
    "utf8",
  )
  return tempDir
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ""
  }
})

describe("context memory lifecycle", () => {
  it("preloads context and memory references", async () => {
    const workspaceRoot = await createWorkspace()
    await writeFile(
      join(workspaceRoot, ".agent-guide", "memory", "memory-alpha-rule.md"),
      "# Memory Alpha\n",
      "utf8",
    )

    const preload = await runPreloadLifecycle({
      workspaceRoot,
      task: "implement #28",
      mode: "orchestrator",
      source: "default",
    })

    const context = await readFile(
      join(workspaceRoot, ".agent-guide", "context", "issue-028-lifecycle.md"),
      "utf8",
    )
    expect(context).toContain("참고:")
    expect(preload.memoryPaths.map((item) => item.split("/").pop())).toEqual([
      "memory-alpha-rule.md",
      "memory-runtime-rule.md",
    ])
  })

  it("writes post handoff, promotes memory, and cleans temp context", async () => {
    const workspaceRoot = await createWorkspace()
    const preload = await runPreloadLifecycle({
      workspaceRoot,
      task: "implement #28",
      mode: "orchestrator",
      source: "default",
    })

    const postInput: {
      workspaceRoot: string
      task: string
      mode: "orchestrator"
      source: "default"
      status: "completed"
      issueContextPath?: string
    } = {
      workspaceRoot,
      task: "implement #28",
      mode: "orchestrator",
      source: "default",
      status: "completed",
      ...(preload.issueContextPath ? { issueContextPath: preload.issueContextPath } : {}),
    }

    const result = await runPostLifecycle(postInput)

    const context = await readFile(
      join(workspaceRoot, ".agent-guide", "context", "issue-028-lifecycle.md"),
      "utf8",
    )
    expect(context).toContain("## Handoff")
    expect(result.promotedMemoryPath).toContain("memory-runtime-context-lifecycle.md")
    if (result.promotedMemoryPath) {
      const memory = await readFile(result.promotedMemoryPath, "utf8")
      expect(memory).toContain("issue: 28")
      expect(memory).not.toContain("pending")
    }
    expect(result.cleanedContextPaths.length).toBe(1)
  })
})
