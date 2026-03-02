import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ToolContext } from "@opencode-ai/plugin/tool"

const runtimeMocks = vi.hoisted(() => {
  const install = vi.fn(async () => ({ installed: true }))
  const doctor = vi.fn(async () => ({ status: "pass" }))
  const run = vi.fn(async (task: string, options?: { resume?: boolean }) => ({
    status: "completed",
    stateFilePath: "/tmp/workflow-state.json",
    task,
    resume: options?.resume ?? false,
  }))

  return {
    createPluginRuntime: vi.fn(() => ({
      install,
      doctor,
      run,
    })),
    install,
    doctor,
    run,
  }
})

vi.mock("../src/plugin/index.js", () => ({
  createPluginRuntime: runtimeMocks.createPluginRuntime,
}))

import OpenCodeTeamPlugin from "../src/index.js"

describe("opencode_team custom tool", () => {
  const originalHome = process.env.HOME

  const baseToolContext: ToolContext = {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "test-agent",
    directory: "/tmp/directory",
    worktree: "/tmp/workspace",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }

  beforeEach(() => {
    runtimeMocks.createPluginRuntime.mockClear()
    runtimeMocks.install.mockClear()
    runtimeMocks.doctor.mockClear()
    runtimeMocks.run.mockClear()
  })

  afterEach(() => {
    if (typeof originalHome === "undefined") {
      delete process.env.HOME
      return
    }
    process.env.HOME = originalHome
  })

  it("uses context workspaceRoot, passes HOME, and trims run task", async () => {
    process.env.HOME = "/home/tester"
    const plugin = await OpenCodeTeamPlugin()

    const output = await plugin.tool.opencode_team.execute(
      {
        action: "run",
        task: "   /orchestrate implement task 11   ",
        resume: true,
      },
      baseToolContext,
    )

    expect(runtimeMocks.createPluginRuntime).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: "/tmp/workspace" }))
    expect(runtimeMocks.createPluginRuntime).toHaveBeenCalledWith(expect.objectContaining({ userHome: "/home/tester" }))
    expect(runtimeMocks.run).toHaveBeenCalledWith("/orchestrate implement task 11", { resume: true })
    expect(output).toBe(
      JSON.stringify(
        {
          status: "completed",
          stateFilePath: "/tmp/workflow-state.json",
          task: "/orchestrate implement task 11",
          resume: true,
        },
        null,
        2,
      ),
    )
  })

  it("falls back to directory when worktree is undefined", async () => {
    delete process.env.HOME
    const plugin = await OpenCodeTeamPlugin()

    await plugin.tool.opencode_team.execute(
      {
        action: "doctor",
      },
      {
        ...baseToolContext,
        worktree: "",
      },
    )

    expect(runtimeMocks.createPluginRuntime).toHaveBeenCalledWith({
      workspaceRoot: "/tmp/directory",
    })
    expect(runtimeMocks.doctor).toHaveBeenCalledTimes(1)
  })
})
