import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { buildAgentSystemInstructions } from "../src/agents/instructions.js"

let tempRoot = ""

async function createWorkspaceWithAgents(content: string): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-agents-"))
  await mkdir(tempRoot, { recursive: true })
  await writeFile(join(tempRoot, "AGENTS.md"), content)
  return tempRoot
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("agent system instructions", () => {
  it("composes built-in instructions without AGENTS.md", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "opencode-team-agents-"))
    tempRoot = workspaceRoot

    const result = await buildAgentSystemInstructions({ workspaceRoot })

    expect(result.content).toContain("## Engineering Principles")
    expect(result.content).toContain("## Memory Policy")
    expect(result.content).toContain("## Role Prompt (orchestrator)")
    expect(result.sourcePath).toBe("builtin:core-system-prompt")
    expect(result.sessionFilePath).toBe(join(
      workspaceRoot,
      ".agent-guide",
      "runtime",
      "sessions",
      "orchestrator",
      "model-instructions.md",
    ))
  })

  it("extracts coding and memory sections from AGENTS.md", async () => {
    const workspaceRoot = await createWorkspaceWithAgents(`
# AGENTS

## 코딩 원칙
- rule-a

## 작업 워크플로우 (Issue-driven + TDD)
- workflow-a

## 메모리 규칙
- memory-a

## 검증 규칙
- verify-a
`)

    const result = await buildAgentSystemInstructions({ workspaceRoot })

    expect(result.content).toContain("## Engineering Principles")
    expect(result.content).toContain("## Memory Policy")
    expect(result.content).toContain("## 코딩 원칙")
    expect(result.content).toContain("## 메모리 규칙")
    expect(result.content).not.toContain("## 작업 워크플로우")
    expect(result.content).toContain("## Project AGENTS Override")
    expect(result.sourcePath).toBe(join(workspaceRoot, "AGENTS.md"))
  })

  it("persists session instruction file", async () => {
    const workspaceRoot = await createWorkspaceWithAgents("# AGENTS\n")

    const result = await buildAgentSystemInstructions({
      workspaceRoot,
      role: "developer",
      sessionId: "issue-20",
    })

    const saved = await readFile(String(result.sessionFilePath), "utf8")
    expect(saved).toContain("## Role Prompt (developer)")
    expect(saved).not.toContain("## Memory Policy")
    expect(result.sources).toContain(String(result.sessionFilePath))
  })

  it("loads researcher prompt when role is researcher", async () => {
    const workspaceRoot = await createWorkspaceWithAgents("# AGENTS\n")

    const result = await buildAgentSystemInstructions({
      workspaceRoot,
      role: "researcher",
      sessionId: "research-session",
    })

    expect(result.content).toContain("## Role Prompt (researcher)")
    expect(result.content).toContain("authoritative documentation")
  })

  it("loads documenter prompt when role is documenter", async () => {
    const workspaceRoot = await createWorkspaceWithAgents("# AGENTS\n")

    const result = await buildAgentSystemInstructions({
      workspaceRoot,
      role: "documenter",
      sessionId: "document-session",
    })

    expect(result.content).toContain("## Role Prompt (documenter)")
    expect(result.content).toContain("doc coverage matrix")
  })

  it("includes runtime overlay when provided", async () => {
    const workspaceRoot = await createWorkspaceWithAgents("# AGENTS\n")

    const result = await buildAgentSystemInstructions({
      workspaceRoot,
      role: "developer",
      sessionId: "runtime-overlay",
      runtimeOverlay: "learnings:\n- keep overlays short",
    })

    expect(result.content).toContain("## Runtime Overlay")
    expect(result.content).toContain("learnings:\n- keep overlays short")
  })
})
