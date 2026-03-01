import { assertCommittableChanges } from "./lib/git-change-check.mjs"
import { runHandler } from "./handlers/index.mjs"

function parseCliArgs(argv) {
  const positionals = []
  let task
  let adrDecision

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--task") {
      task = argv[i + 1]
      i += 1
      continue
    }
    if (arg === "--adr") {
      adrDecision = argv[i + 1]
      i += 1
      continue
    }
    positionals.push(arg)
  }

  if (!task && positionals.length > 0) {
    task = positionals.join(" ")
  }

  return {
    task,
    adrDecision,
  }
}

function resolveExecutionInput() {
  const cli = parseCliArgs(process.argv.slice(2))

  const task = (process.env.OPENCODE_TASK ?? cli.task ?? "").trim()
  const adrDecision = (process.env.OPENCODE_ADR_DECISION ?? cli.adrDecision ?? "").trim()

  if (!task) {
    throw new Error("missing task. set OPENCODE_TASK or pass --task")
  }

  return {
    cwd: process.cwd(),
    task,
    adrDecision,
  }
}

async function main() {
  const input = resolveExecutionInput()
  const result = await runHandler(input)

  if (!result.changed) {
    throw new Error("development script produced no changes for the requested task")
  }

  const committablePaths = await assertCommittableChanges({
    cwd: input.cwd,
    expectedPaths: result.changedFiles,
  })

  process.stdout.write(`[opencode:develop] changed files: ${result.changedFiles.join(", ")}\n`)
  process.stdout.write(`[opencode:develop] committable: ${committablePaths.join(", ")}\n`)
}

main().catch((error) => {
  process.stderr.write(`[opencode:develop] failed: ${String(error)}\n`)
  process.exit(1)
})
