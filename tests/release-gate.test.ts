import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { runReleaseGate } from "../src/release-gate/index.js"

let tempRoot = ""

async function createWorkspace(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-gate-"))
  await mkdir(join(tempRoot, "docs"), { recursive: true })
  await mkdir(join(tempRoot, ".github", "workflows"), { recursive: true })
  await mkdir(join(tempRoot, "tests"), { recursive: true })
  return tempRoot
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  }
})

describe("release gate", () => {
  it("fails when required markers are missing", async () => {
    const workspaceRoot = await createWorkspace()
    await writeFile(join(workspaceRoot, "README.md"), "README\n", "utf8")
    await writeFile(join(workspaceRoot, "docs", "user-guide.md"), "guide\n", "utf8")

    const result = await runReleaseGate(workspaceRoot, {
      dependencies: {
        runCliJson: async () => ({}),
      },
    })
    expect(result.pass).toBe(false)
  })

  it("passes when all required markers exist", async () => {
    const workspaceRoot = await createWorkspace()
    await writeFile(
      join(workspaceRoot, "README.md"),
      "install run doctor /orchestrate /ultrawork /ralph /cancel\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "docs", "user-guide.md"),
      "원샷 orchestrator cancel/resume MCP\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "docs", "release-gate-checklist.md"),
      "필수 시나리오 차단 규칙 릴리스 노트\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "docs", "e2e-evidence.md"),
      "명령 결과 근거\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, ".github", "workflows", "ci.yml"),
      "npm test\nnpm run typecheck\nnpm run build\nnpm run release:gate\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "package.json"),
      "{\"scripts\":{\"release:gate\":\"node scripts/release-gate.mjs\"}}\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "tests", "role-prompts-contract.test.ts"),
      "describe('role prompt contract', () => {})\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "tests", "runtime-role-output-contract.test.ts"),
      "describe('runtime role output contract', () => {})\n",
      "utf8",
    )

    const result = await runReleaseGate(workspaceRoot, {
      dependencies: {
        runCliJson: async (_workspaceRoot, args) => {
          const joined = args.join(" ")
          if (joined.includes("install")) {
            return {
              configPath: "/tmp/config.json",
              mcpManifestPath: "/tmp/manifest.json",
            }
          }
          if (joined.includes("doctor")) {
            return {
              status: "warn",
              checks: [],
            }
          }
          return {
            mode: "ralph",
            source: "slash",
            stateFilePath: "/tmp/state.json",
          }
        },
      },
    })
    expect(result.pass).toBe(true)
  })

  it("fails when behavior contracts are invalid", async () => {
    const workspaceRoot = await createWorkspace()
    await writeFile(
      join(workspaceRoot, "README.md"),
      "install run doctor /orchestrate /ultrawork /ralph /cancel\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "docs", "user-guide.md"),
      "원샷 orchestrator cancel/resume MCP\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "docs", "release-gate-checklist.md"),
      "필수 시나리오 차단 규칙 릴리스 노트\n",
      "utf8",
    )
    await writeFile(join(workspaceRoot, "docs", "e2e-evidence.md"), "명령 결과 근거\n", "utf8")
    await writeFile(
      join(workspaceRoot, ".github", "workflows", "ci.yml"),
      "npm test\nnpm run typecheck\nnpm run build\nnpm run release:gate\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "package.json"),
      "{\"scripts\":{\"release:gate\":\"node scripts/release-gate.mjs\"}}\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "tests", "role-prompts-contract.test.ts"),
      "describe('role prompt contract', () => {})\n",
      "utf8",
    )
    await writeFile(
      join(workspaceRoot, "tests", "runtime-role-output-contract.test.ts"),
      "describe('runtime role output contract', () => {})\n",
      "utf8",
    )

    const result = await runReleaseGate(workspaceRoot, {
      dependencies: {
        runCliJson: async () => ({ invalid: true }),
      },
    })

    expect(result.pass).toBe(false)
    expect(result.checks.some((check) => check.name === "behavior_run_json_contract" && !check.pass)).toBe(true)
  })
})
