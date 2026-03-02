import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface ReleaseGateCheck {
  name: string
  pass: boolean
  detail: string
}

export interface ReleaseGateResult {
  pass: boolean
  checks: ReleaseGateCheck[]
}

export interface ReleaseGateOptions {
  dependencies?: {
    readText?: (path: string) => Promise<string | null>
    runCliJson?: (workspaceRoot: string, args: string[]) => Promise<unknown>
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

function checkContains(name: string, content: string | null, required: string[]): ReleaseGateCheck {
  if (content === null) {
    return {
      name,
      pass: false,
      detail: "missing file",
    }
  }

  const missing = required.filter((item) => !content.includes(item))
  if (missing.length > 0) {
    return {
      name,
      pass: false,
      detail: `missing required markers: ${missing.join(", ")}`,
    }
  }

  return {
    name,
    pass: true,
    detail: "ok",
  }
}

function checkCiCommands(name: string, content: string | null, requiredCommands: string[]): ReleaseGateCheck {
  if (content === null) {
    return {
      name,
      pass: false,
      detail: "missing file",
    }
  }

  const missing = requiredCommands.filter((command) => {
    const normalized = command.trim()
    return !content.includes(normalized)
  })

  if (missing.length > 0) {
    return {
      name,
      pass: false,
      detail: `missing required CI commands: ${missing.join(", ")}`,
    }
  }

  return {
    name,
    pass: true,
    detail: "ok",
  }
}

function checkPackageReleaseGateScript(name: string, content: string | null): ReleaseGateCheck {
  if (content === null) {
    return {
      name,
      pass: false,
      detail: "missing file",
    }
  }

  try {
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed === "object"
      && parsed !== null
      && "scripts" in parsed
      && typeof (parsed as { scripts?: unknown }).scripts === "object"
      && (parsed as { scripts?: Record<string, unknown> }).scripts !== null
    ) {
      const scripts = (parsed as { scripts: Record<string, unknown> }).scripts
      const releaseGate = scripts["release:gate"]
      if (typeof releaseGate === "string" && releaseGate.includes("scripts/release-gate.mjs")) {
        return {
          name,
          pass: true,
          detail: "ok",
        }
      }
    }

    return {
      name,
      pass: false,
      detail: "release:gate script missing or invalid",
    }
  } catch {
    return {
      name,
      pass: false,
      detail: "invalid package.json",
    }
  }
}

async function defaultRunCliJson(workspaceRoot: string, args: string[]): Promise<unknown> {
  const runtimeHome = join(workspaceRoot, ".agent-guide", "runtime", "release-gate-home")
  const cliPath = join(workspaceRoot, "dist", "src", "cli", "index.js")

  try {
    const { stdout } = await execFileAsync("node", [cliPath, ...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        HOME: runtimeHome,
      },
    })
    return JSON.parse(stdout)
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = String(error.stdout ?? "")
      if (stdout.trim().length > 0) {
        return JSON.parse(stdout)
      }
    }
    throw error
  }
}

function checkBehaviorContract(name: string, value: unknown, validator: (value: unknown) => boolean): ReleaseGateCheck {
  if (validator(value)) {
    return {
      name,
      pass: true,
      detail: "ok",
    }
  }
  return {
    name,
    pass: false,
    detail: "behavior contract check failed",
  }
}

function hasKey(record: unknown, key: string): boolean {
  return typeof record === "object" && record !== null && key in record
}

function isRunJsonContract(value: unknown, expectedMode: string): boolean {
  if (!(hasKey(value, "mode") && hasKey(value, "source") && hasKey(value, "stateFilePath"))) {
    return false
  }

  const mode = (value as { mode?: unknown }).mode
  const source = (value as { source?: unknown }).source
  return mode === expectedMode && source === "slash"
}

export async function runReleaseGate(
  workspaceRoot: string,
  options: ReleaseGateOptions = {},
): Promise<ReleaseGateResult> {
  const readTextFile = options.dependencies?.readText ?? readText
  const runCliJson = options.dependencies?.runCliJson ?? defaultRunCliJson

  const readme = await readTextFile(join(workspaceRoot, "README.md"))
  const architecture = await readTextFile(join(workspaceRoot, "ARCHITECTURE.md"))
  const userGuide = await readTextFile(join(workspaceRoot, "docs", "user-guide.md"))
  const gateChecklist = await readTextFile(join(workspaceRoot, "docs", "release-gate-checklist.md"))
  const e2eEvidence = await readTextFile(join(workspaceRoot, "docs", "e2e-evidence.md"))

  const ciWorkflow = await readTextFile(join(workspaceRoot, ".github", "workflows", "ci.yml"))
  const packageJson = await readTextFile(join(workspaceRoot, "package.json"))
  const rolePromptContractTest = await readTextFile(join(workspaceRoot, "tests", "role-prompts-contract.test.ts"))
  const runtimeContractTest = await readTextFile(join(workspaceRoot, "tests", "runtime-role-output-contract.test.ts"))

  const checks: ReleaseGateCheck[] = [
    checkContains("readme_runtime_commands", readme, ["install", "run", "doctor", "documenter"]),
    checkContains("architecture_documenter_contract", architecture, ["documenter", "README", "docs/"]),
    checkContains("user_guide_runtime_sections", userGuide, ["원샷 orchestrator", "cancel/resume", "MCP", "documenter"]),
    checkContains("release_gate_checklist", gateChecklist, ["필수 시나리오", "차단 규칙", "릴리스 노트"]),
    checkContains("e2e_evidence", e2eEvidence, ["명령", "결과", "근거", "/ulw-loop"]),
    checkCiCommands("ci_enforces_release_gate", ciWorkflow, ["npm run release:gate", "npm test", "npm run typecheck", "npm run build"]),
    checkPackageReleaseGateScript("package_has_release_gate_script", packageJson),
    checkContains("role_prompt_contract_tests_present", rolePromptContractTest, ["role prompt contract"]),
    checkContains("runtime_contract_tests_present", runtimeContractTest, ["runtime role output contract"]),
  ]

  try {
    const installResult = await runCliJson(workspaceRoot, ["install", "--json"])
    checks.push(
      checkBehaviorContract("behavior_install_json_contract", installResult, (value) => (
        hasKey(value, "configPath") && hasKey(value, "mcpManifestPath")
      )),
    )
  } catch (error) {
    checks.push({
      name: "behavior_install_json_contract",
      pass: false,
      detail: `failed to execute install behavior check: ${String(error)}`,
    })
  }

  try {
    const doctorResult = await runCliJson(workspaceRoot, ["doctor", "--json"])
    checks.push(
      checkBehaviorContract("behavior_doctor_json_contract", doctorResult, (value) => (
        hasKey(value, "status")
        && hasKey(value, "checks")
        && Array.isArray((value as { checks?: unknown }).checks)
      )),
    )
  } catch (error) {
    checks.push({
      name: "behavior_doctor_json_contract",
      pass: false,
      detail: `failed to execute doctor behavior check: ${String(error)}`,
    })
  }

  try {
    const ralphRunResult = await runCliJson(workspaceRoot, [
      "run",
      "/ralph --session release-gate --max-iterations 1 gate verification",
      "--json",
    ])
    checks.push(
      checkBehaviorContract(
        "behavior_run_json_contract_ralph",
        ralphRunResult,
        (value) => isRunJsonContract(value, "ralph"),
      ),
    )

    const ulwLoopRunResult = await runCliJson(workspaceRoot, [
      "run",
      "/ulw-loop --session release-gate --max-iterations 1 gate verification",
      "--json",
    ])
    checks.push(
      checkBehaviorContract(
        "behavior_run_json_contract_ulw_loop",
        ulwLoopRunResult,
        (value) => isRunJsonContract(value, "ulw_loop"),
      ),
    )
  } catch (error) {
    checks.push({
      name: "behavior_run_json_contract",
      pass: false,
      detail: `failed to execute run behavior check: ${String(error)}`,
    })
  }

  return {
    pass: checks.every((check) => check.pass),
    checks,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReleaseGate(process.cwd()).then((result) => {
    if (!result.pass) {
      for (const check of result.checks) {
        process.stderr.write(`[${check.pass ? "pass" : "fail"}] ${check.name}: ${check.detail}\n`)
      }
      process.exit(1)
    }

    for (const check of result.checks) {
      process.stdout.write(`[pass] ${check.name}: ${check.detail}\n`)
    }
  }).catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  })
}
