import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import {
  WorkflowAgentExecutionError,
  runWorkflowAgent,
  toWorkflowAgentRunArtifact,
} from "../src/pipeline/agent-runtime.js"
import { createScriptedSubagentExecutor } from "../src/pipeline/subagent-executor.js"

let tempRoot = ""

async function createWorkspace(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-agent-runtime-"))
  return tempRoot
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("workflow agent runtime", () => {
  it("fails when scripted subagent context is missing execute", async () => {
    const workspaceRoot = await createWorkspace()

    await expect(runWorkflowAgent({
      role: "orchestrator",
      stage: "requirements",
      nodeId: "requirements:orchestrator:01",
      workspaceRoot,
      sessionId: "req-orchestrator",
      executor: createScriptedSubagentExecutor(),
      context: {} as { execute: () => unknown },
    })).rejects.toBeInstanceOf(WorkflowAgentExecutionError)
  })

  it("fails when executor returns invalid handoff", async () => {
    const workspaceRoot = await createWorkspace()

    await expect(runWorkflowAgent({
      role: "plan",
      stage: "planning",
      nodeId: "planning:plan:01",
      workspaceRoot,
      sessionId: "plan-01",
      executor: createScriptedSubagentExecutor(),
      context: {
        execute: async () => ({
          decision: "draft_ready",
          payload: {
            ok: true,
          },
          handoff: {
            currentStatus: "planning",
            changedFiles: [],
            openRisks: [],
          },
        }),
      },
    })).rejects.toThrow("runtime handoff invalid")
  })

  it("blocks denied tool usage for role-level policy", async () => {
    const workspaceRoot = await createWorkspace()

    await expect(runWorkflowAgent({
      role: "reviewer",
      stage: "merge",
      nodeId: "merge:reviewer:01",
      workspaceRoot,
      sessionId: "merge-reviewer",
      executor: createScriptedSubagentExecutor(),
      context: {
        requestedTools: ["bash"],
        execute: async () => ({
          decision: "approve",
          payload: {
            gateDecision: "approve",
          },
          handoff: {
            currentStatus: "review_approved",
            changedFiles: [],
            openRisks: [],
            nextAction: "continue",
          },
        }),
      },
    })).rejects.toThrow("tool policy denied")
  })

  it("records stage/node metadata in run artifact", async () => {
    const workspaceRoot = await createWorkspace()

    const run = await runWorkflowAgent({
      role: "researcher",
      stage: "requirements",
      nodeId: "requirements:researcher:02",
      workspaceRoot,
      sessionId: "req-researcher",
      executor: createScriptedSubagentExecutor(),
      context: {
        requestedTools: ["read", "glob", "grep"],
        execute: async () => ({
          decision: "context_collected",
          payload: {
            researchContext: ["README.md"],
          },
          handoff: {
            currentStatus: "research_ready",
            changedFiles: [],
            openRisks: [],
            nextAction: "handoff",
          },
        }),
      },
    })

    const artifact = toWorkflowAgentRunArtifact(run)
    expect(artifact.stage).toBe("requirements")
    expect(artifact.nodeId).toBe("requirements:researcher:02")
    expect(artifact.toolEvents).toEqual(["read", "glob", "grep"])
  })
})
