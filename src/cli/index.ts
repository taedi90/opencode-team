import { createPluginRuntime, type PluginInterface } from "../plugin/index.js"

export interface CliIO {
  stdout: (message: string) => void
  stderr: (message: string) => void
}

export interface RunCliOptions {
  workspaceRoot?: string
  userHome?: string
  io?: CliIO
  createRuntime?: (input: { workspaceRoot: string; userHome?: string }) => PluginInterface
}

function printHelp(io: CliIO): void {
  io.stdout(
    [
      "opencode-team CLI",
      "",
      "Commands:",
      "  install [--json]           Bootstrap user config and MCP manifest",
      "  run <task> [--resume]      Run orchestrator workflow",
      "  doctor [--json]            Run environment and policy checks",
      "",
    ].join("\n"),
  )
}

function parseFlags(args: string[]): {
  json: boolean
  resume: boolean
  positionals: string[]
} {
  const positionals: string[] = []
  let json = false
  let resume = false

  for (const arg of args) {
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--resume") {
      resume = true
      continue
    }
    positionals.push(arg)
  }

  return {
    json,
    resume,
    positionals,
  }
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? {
    stdout: (message: string) => {
      process.stdout.write(`${message}\n`)
    },
    stderr: (message: string) => {
      process.stderr.write(`${message}\n`)
    },
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const createRuntime = options.createRuntime ?? ((input) => createPluginRuntime(input))

  const [command, ...rest] = argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(io)
    return 0
  }

  const runtime = createRuntime({
    workspaceRoot,
    ...(options.userHome ? { userHome: options.userHome } : {}),
  })

  const parsed = parseFlags(rest)

  if (command === "install") {
    const result = await runtime.install()
    if (parsed.json) {
      io.stdout(toJson(result).trimEnd())
    } else {
      io.stdout(`config: ${result.configPath} (created=${String(result.configCreated)})`)
      io.stdout(`opencode config: ${result.opencodeConfigPath} (plugin_registered=${String(result.pluginRegistered)})`)
      io.stdout(`mcp manifest: ${result.mcpManifestPath} (created=${String(result.mcpManifestCreated)}, updated=${String(result.mcpManifestUpdated)})`)
    }
    return 0
  }

  if (command === "run") {
    const task = parsed.positionals.join(" ").trim()
    if (!task) {
      io.stderr("run command requires a task string")
      return 1
    }

    const result = await runtime.run(task, { resume: parsed.resume })
    if (parsed.json) {
      io.stdout(toJson(result).trimEnd())
    } else {
      io.stdout(`status: ${result.status}`)
      io.stdout(`state: ${result.stateFilePath}`)
      if (result.failedStage) {
        io.stdout(`failed stage: ${result.failedStage}`)
      }
      if (result.error) {
        io.stdout(`error: ${result.error}`)
      }
    }
    return result.status === "completed" ? 0 : 1
  }

  if (command === "doctor") {
    const result = await runtime.doctor()
    if (parsed.json) {
      io.stdout(toJson(result).trimEnd())
    } else {
      io.stdout(`doctor status: ${result.status}`)
      for (const check of result.checks) {
        io.stdout(`- [${check.status}] ${check.name}: ${check.detail}`)
      }
    }

    return result.status === "fail" ? 1 : 0
  }

  io.stderr(`unknown command: ${command}`)
  printHelp(io)
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => {
    process.exit(code)
  }).catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  })
}
