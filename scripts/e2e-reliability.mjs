import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

function parseArgs(argv) {
  let iterations = 10
  let issueBase = 10000
  let sessionPrefix = "e2e-rel"
  let skipBuild = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--iterations") {
      const raw = argv[i + 1]
      if (!raw) throw new Error("--iterations requires a numeric value")
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--iterations must be a positive integer")
      }
      iterations = parsed
      i += 1
      continue
    }

    if (arg === "--issue-base") {
      const raw = argv[i + 1]
      if (!raw) throw new Error("--issue-base requires a numeric value")
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--issue-base must be a positive integer")
      }
      issueBase = parsed
      i += 1
      continue
    }

    if (arg === "--session-prefix") {
      const raw = argv[i + 1]
      if (!raw) throw new Error("--session-prefix requires a value")
      sessionPrefix = raw.trim() || sessionPrefix
      i += 1
      continue
    }

    if (arg === "--skip-build") {
      skipBuild = true
      continue
    }
  }

  return { iterations, issueBase, sessionPrefix, skipBuild }
}

function classifyFailure(text) {
  const lower = text.toLowerCase()
  if (lower.includes("session_locked")) return "session_locked"
  if (lower.includes("no development script")) return "development_script_missing"
  if (lower.includes("verification command failed")) return "verification_failed"
  if (lower.includes("merge prerequisites failed")) return "merge_prereq_failed"
  if (lower.includes("workflow cancelled")) return "cancelled"
  if (lower.includes("timeout") || lower.includes("econn") || lower.includes("tempor")) return "transient_network"
  return "unknown"
}

function nowIso() {
  return new Date().toISOString()
}

async function runNpm(args, cwd) {
  return execFileAsync("npm", args, { cwd })
}

function parseRunJson(raw) {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  const candidates = [trimmed]
  const lines = trimmed.split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("{")) {
      candidates.push(lines.slice(i).join("\n").trim())
      break
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
        return parsed
      }
    } catch {
      // continue
    }
  }

  return null
}

async function runIteration(input) {
  const task = `/orchestrate --session ${input.sessionId} implement #${input.issueNumber} reliability-loop`
  const startedAt = Date.now()

  try {
    const { stdout } = await runNpm(["run", "cli", "--", "run", "--json", task], input.cwd)
    const parsed = parseRunJson(stdout.trim())
    const durationMs = Date.now() - startedAt
    if (parsed?.status === "completed") {
      return {
        success: true,
        durationMs,
        status: parsed.status,
        stateFilePath: parsed.stateFilePath,
      }
    }

    const text = stdout.trim()
    return {
      success: false,
      durationMs,
      status: parsed?.status ?? "failed",
      error: parsed?.error ?? text,
      failureType: classifyFailure(parsed?.error ?? text),
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const stderr = typeof error?.stderr === "string" ? error.stderr : ""
    const stdout = typeof error?.stdout === "string" ? error.stdout : ""
    const parsed = parseRunJson(stdout.trim())
    const text = [parsed?.error, stderr, stdout, String(error)].filter(Boolean).join("\n")
    return {
      success: false,
      durationMs,
      status: parsed?.status ?? "failed",
      error: parsed?.error ?? text,
      failureType: classifyFailure(text),
    }
  }
}

async function main() {
  const cwd = process.cwd()
  const args = parseArgs(process.argv.slice(2))

  if (!args.skipBuild) {
    process.stdout.write("[e2e] building dist before reliability loop\n")
    await runNpm(["run", "build"], cwd)
  }

  const results = []
  for (let i = 0; i < args.iterations; i += 1) {
    const index = i + 1
    const sessionId = `${args.sessionPrefix}-${String(index).padStart(3, "0")}`
    const issueNumber = args.issueBase + i
    process.stdout.write(`[e2e] iteration ${index}/${args.iterations} session=${sessionId}\n`)
    const result = await runIteration({ cwd, sessionId, issueNumber })
    results.push({
      iteration: index,
      sessionId,
      issueNumber,
      ...result,
    })
  }

  const successCount = results.filter((item) => item.success).length
  const failureCount = results.length - successCount
  const successRate = results.length === 0 ? 0 : Number(((successCount / results.length) * 100).toFixed(2))
  const failureByType = {}
  for (const result of results) {
    if (result.success) continue
    const key = result.failureType ?? "unknown"
    failureByType[key] = (failureByType[key] ?? 0) + 1
  }

  const report = {
    generatedAt: nowIso(),
    iterations: args.iterations,
    successCount,
    failureCount,
    successRate,
    failureByType,
    results,
  }

  const reportsDir = join(cwd, ".agent-guide", "runtime", "reports")
  await mkdir(reportsDir, { recursive: true })
  const stamp = nowIso().replace(/[:.]/g, "-")
  const reportPath = join(reportsDir, `e2e-reliability-${stamp}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

  process.stdout.write(`[e2e] report: ${reportPath}\n`)
  process.stdout.write(`[e2e] success_rate=${String(successRate)}% (${String(successCount)}/${String(args.iterations)})\n`)

  if (failureCount > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`[e2e] failed: ${String(error)}\n`)
  process.exit(1)
})
