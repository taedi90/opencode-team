import { tool } from "@opencode-ai/plugin/tool"

import { createPluginRuntime } from "./plugin/index.js"

interface OpenCodeCommandConfig {
  description: string
  agent: string
  subtask: true
  template: string
}

interface OpenCodeConfig {
  command?: Record<string, OpenCodeCommandConfig>
  agent?: Record<string, OpenCodeAgentConfig>
}

interface OpenCodeAgentConfig {
  mode: "subagent"
  description: string
  tools?: Record<string, boolean>
  prompt: string
}

type OpenCodeTeamAction = "install" | "doctor" | "run"

interface OpenCodeTeamToolArgs {
  action: OpenCodeTeamAction
  task?: string
  resume?: boolean
  json?: boolean
}

interface OpenCodeTeamToolContext {
  directory: string
  worktree?: string
}

const COMMAND_SPECS: Array<{
  primary: string
  fallback: string
  mode: string
  template: string
}> = [
  {
    primary: "orchestrate",
    fallback: "opencode-team-orchestrate",
    mode: "orchestrate",
    template:
      "Use the opencode_team tool. action=run, task=\"/orchestrate $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
  },
  {
    primary: "ultrawork",
    fallback: "opencode-team-ultrawork",
    mode: "ultrawork",
    template:
      "Use the opencode_team tool. action=run, task=\"/ultrawork $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
  },
  {
    primary: "ralph",
    fallback: "opencode-team-ralph",
    mode: "ralph",
    template:
      "Use the opencode_team tool. action=run, task=\"/ralph $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
  },
  {
    primary: "ulw-loop",
    fallback: "opencode-team-ulw-loop",
    mode: "ulw-loop",
    template:
      "Use the opencode_team tool. action=run, task=\"/ulw-loop $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
  },
  {
    primary: "cancel",
    fallback: "opencode-team-cancel",
    mode: "cancel",
    template:
      "Use the opencode_team tool. action=run, task=\"/cancel $ARGUMENTS\". Then summarize status/stateFilePath.",
  },
]

const AGENT_SPECS: Array<{
  key: string
  description: string
  tools?: Record<string, boolean>
  prompt: string
}> = [
  {
    key: "opencode-team:orchestrator",
    description: "workflow runner",
    tools: { opencode_team: true, bash: false, write: false, edit: false },
    prompt: `You are the opencode-team orchestrator subagent.

Core rule:
- Always use the \`opencode_team\` tool to run workflows.
- Never use bash.
- Never write/edit files directly.

When asked to run a workflow, call:
- action: "run"
- task: one of \`/orchestrate ...\`, \`/ultrawork ...\`, \`/ralph ...\`, \`/ulw-loop ...\`, \`/cancel ...\`

After the tool returns JSON, output a concise report:
- status
- failedStage (if any)
- error (if any)
- stateFilePath`,
  },
  {
    key: "opencode-team:prometheus",
    description: "planner",
    tools: { bash: false, write: false, edit: false },
    prompt: `You are Prometheus (Strategic Planning Consultant).
You produce decision-complete work plans. You do not implement.

Rules:
- Do not write or edit project files.
- Ask questions only if truly blocked.
- Ground decisions using repo evidence (paths) and OpenCode debug commands.

Output:
- Provide an actionable plan with explicit decisions, file paths, and verification commands.`,
  },
  {
    key: "opencode-team:oracle",
    description: "architecture/debug",
    tools: { write: false, edit: false },
    prompt: `You are Oracle (Architecture & Debugging).
Focus on: risks, edge cases, failure modes, and verification.

Constraints:
- Do not write/edit files.
- Provide concrete commands to validate assumptions.`,
  },
  {
    key: "opencode-team:librarian",
    description: "docs lookup",
    tools: { bash: false, write: false, edit: false },
    prompt: `You are Librarian (Docs & API references).
Provide citations/links and exact usage guidance.

Constraints:
- Do not write/edit files.
- Prefer official docs and source references.`,
  },
  {
    key: "opencode-team:explore",
    description: "codebase scan",
    tools: { bash: false, write: false, edit: false },
    prompt: `You are Explore (fast codebase scan).
Return file paths and concise findings.

Constraints:
- Read-only. Do not write/edit files.`,
  },
  {
    key: "opencode-team:momus",
    description: "high-accuracy review",
    tools: { write: false, edit: false },
    prompt: `You are Momus (High-accuracy reviewer).
Verify correctness: file references exist, acceptance criteria are executable, and no business logic assumptions.

Constraints:
- Do not write/edit files.`,
  },
]

function createCommandConfig(mode: string, template: string): OpenCodeCommandConfig {
  return {
    description: `(opencode-team) ${mode} workflow`,
    agent: "opencode-team:orchestrator",
    subtask: true,
    template,
  }
}

function injectCommands(config: unknown): void {
  if (!config || typeof config !== "object") {
    return
  }

  const typedConfig = config as OpenCodeConfig
  const command = typedConfig.command && typeof typedConfig.command === "object"
    ? typedConfig.command
    : {}
  typedConfig.command = command

  for (const spec of COMMAND_SPECS) {
    if (spec.primary in command) {
      if (!(spec.fallback in command)) {
        command[spec.fallback] = createCommandConfig(spec.mode, spec.template)
      }
      continue
    }

    command[spec.primary] = createCommandConfig(spec.mode, spec.template)
  }
}

function createAgentConfig(spec: (typeof AGENT_SPECS)[number]): OpenCodeAgentConfig {
  return {
    mode: "subagent",
    description: `(plugin: opencode-team) ${spec.description}`,
    ...(spec.tools ? { tools: spec.tools } : {}),
    prompt: spec.prompt,
  }
}

function injectAgents(config: unknown): void {
  if (!config || typeof config !== "object") {
    return
  }

  const typedConfig = config as OpenCodeConfig
  const agent = typedConfig.agent && typeof typedConfig.agent === "object"
    ? typedConfig.agent
    : {}
  typedConfig.agent = agent

  for (const spec of AGENT_SPECS) {
    if (spec.key in agent) {
      continue
    }

    agent[spec.key] = createAgentConfig(spec)
  }
}

function toToolJson(value: unknown, json: boolean): string {
  return json
    ? JSON.stringify(value, null, 2)
    : JSON.stringify(value)
}

async function runOpenCodeTeamTool(
  input: OpenCodeTeamToolArgs,
  ctx: OpenCodeTeamToolContext,
): Promise<string> {
  const { action, task, resume = false, json = true } = input
  const workspaceRoot = ctx.worktree && ctx.worktree.trim().length > 0
    ? ctx.worktree
    : ctx.directory
  const runtime = createPluginRuntime({
    workspaceRoot,
    ...(process.env.HOME ? { userHome: process.env.HOME } : {}),
  })

  if (action === "run") {
    const normalizedTask = task?.trim()
    if (!normalizedTask) {
      throw new Error("task is required when action is run")
    }
    const result = await runtime.run(normalizedTask, { resume })
    return toToolJson(result, json)
  }

  if (action === "install") {
    const result = await runtime.install()
    return toToolJson(result, json)
  }

  const result = await runtime.doctor()
  return toToolJson(result, json)
}

const OpencodeTeamPlugin = async (ctx?: {
  client?: {
    app?: {
      log?: (input: {
        body: {
          service: string
          level: string
          message: string
        }
      }) => void
    }
  }
}) => {
  ctx?.client?.app?.log?.({
    body: {
      service: "opencode-team",
      level: "info",
      message: "plugin loaded",
    },
  })

  return {
    tool: {
      opencode_team: tool({
        description: "Run opencode-team workflows in-process",
        args: {
          action: tool.schema.enum(["install", "doctor", "run"]),
          task: tool.schema.string().optional(),
          resume: tool.schema.boolean().optional(),
          json: tool.schema.boolean().optional(),
        },
        execute: async (input: OpenCodeTeamToolArgs, toolCtx: OpenCodeTeamToolContext) => runOpenCodeTeamTool(input, toolCtx),
      }),
    },
    config: async (config: unknown) => {
      injectCommands(config)
      injectAgents(config)
    },
  }
}

export default OpencodeTeamPlugin
