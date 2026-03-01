import { describe, expect, it } from "vitest"

import { runCli } from "../src/cli/index.js"

function createIoCapture(): {
  stdout: string[]
  stderr: string[]
  io: {
    stdout: (message: string) => void
    stderr: (message: string) => void
  }
} {
  const stdout: string[] = []
  const stderr: string[] = []

  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => {
        stdout.push(message)
      },
      stderr: (message: string) => {
        stderr.push(message)
      },
    },
  }
}

describe("cli", () => {
  it("prints help when command is missing", async () => {
    const capture = createIoCapture()

    const code = await runCli([], {
      io: capture.io,
      createRuntime: () => {
        throw new Error("runtime should not be created")
      },
    })

    expect(code).toBe(0)
    expect(capture.stdout.join("\n")).toContain("opencode-team CLI")
  })

  it("runs install command with json output", async () => {
    const capture = createIoCapture()

    const code = await runCli(["install", "--json"], {
      io: capture.io,
      createRuntime: () => ({
        install: async () => ({
          configPath: "/tmp/config.json",
          configCreated: true,
          opencodeConfigPath: "/tmp/opencode.json",
          pluginRegistered: true,
          mcpManifestPath: "/tmp/manifest.json",
          mcpManifestCreated: true,
          mcpManifestUpdated: false,
        }),
        run: async () => ({
          status: "completed",
          stateFilePath: "/tmp/state.json",
          mode: "orchestrator",
          source: "default",
        }),
        doctor: async () => ({
          status: "pass",
          checks: [],
        }),
      }),
    })

    expect(code).toBe(0)
    expect(capture.stdout[0]).toContain("configPath")
  })

  it("fails run command when task is missing", async () => {
    const capture = createIoCapture()

    const code = await runCli(["run"], {
      io: capture.io,
      createRuntime: () => ({
        install: async () => ({
          configPath: "",
          configCreated: false,
          opencodeConfigPath: "",
          pluginRegistered: false,
          mcpManifestPath: "",
          mcpManifestCreated: false,
          mcpManifestUpdated: false,
        }),
        run: async () => ({
          status: "completed",
          stateFilePath: "/tmp/state.json",
          mode: "orchestrator",
          source: "default",
        }),
        doctor: async () => ({
          status: "pass",
          checks: [],
        }),
      }),
    })

    expect(code).toBe(1)
    expect(capture.stderr.join("\n")).toContain("requires a task string")
  })

  it("returns non-zero for doctor fail status", async () => {
    const capture = createIoCapture()

    const code = await runCli(["doctor"], {
      io: capture.io,
      createRuntime: () => ({
        install: async () => ({
          configPath: "",
          configCreated: false,
          opencodeConfigPath: "",
          pluginRegistered: false,
          mcpManifestPath: "",
          mcpManifestCreated: false,
          mcpManifestUpdated: false,
        }),
        run: async () => ({
          status: "completed",
          stateFilePath: "/tmp/state.json",
          mode: "orchestrator",
          source: "default",
        }),
        doctor: async () => ({
          status: "fail",
          checks: [
            {
              name: "mcp_manifest_exists",
              status: "fail",
              detail: "missing",
            },
          ],
        }),
      }),
    })

    expect(code).toBe(1)
    expect(capture.stdout.join("\n")).toContain("doctor status: fail")
  })
})
