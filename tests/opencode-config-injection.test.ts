import { describe, expect, it, vi } from "vitest"

import plugin from "../src/index.js"

function expectedCommandConfig(mode: string, template: string) {
  return {
    description: `(opencode-team) ${mode} workflow`,
    agent: "opencode-team:orchestrator",
    subtask: true,
    template,
  }
}

function expectedAgentConfig(
  description: string,
  prompt: string,
  tools?: Record<string, boolean>,
) {
  return {
    mode: "subagent",
    description: `(plugin: opencode-team) ${description}`,
    ...(tools ? { tools } : {}),
    prompt,
  }
}

async function createConfigHook() {
  const hooks = await plugin({
    client: {
      app: {
        log: vi.fn(),
      },
    },
  } as never)

  return hooks.config
}

describe("opencode config injection", () => {
  it("injects primary keys when missing", async () => {
    const config = {
      command: {},
    }
    const configHook = await createConfigHook()

    await configHook(config)

    expect(config.command).toEqual({
      orchestrate: expectedCommandConfig(
        "orchestrate",
        "Use the opencode_team tool. action=run, task=\"/orchestrate $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
      ),
      ultrawork: expectedCommandConfig(
        "ultrawork",
        "Use the opencode_team tool. action=run, task=\"/ultrawork $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
      ),
      ralph: expectedCommandConfig(
        "ralph",
        "Use the opencode_team tool. action=run, task=\"/ralph $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
      ),
      "ulw-loop": expectedCommandConfig(
        "ulw-loop",
        "Use the opencode_team tool. action=run, task=\"/ulw-loop $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
      ),
      cancel: expectedCommandConfig(
        "cancel",
        "Use the opencode_team tool. action=run, task=\"/cancel $ARGUMENTS\". Then summarize status/stateFilePath.",
      ),
    })
  })

  it("does not overwrite existing primary key", async () => {
    const existingOrchestrate = {
      description: "existing command",
      agent: "user:agent",
      subtask: false,
      template: "custom",
    }
    const config = {
      command: {
        orchestrate: existingOrchestrate,
      },
    }
    const configHook = await createConfigHook()

    await configHook(config)

    expect(config.command.orchestrate).toBe(existingOrchestrate)
  })

  it("injects fallback key when primary exists", async () => {
    const config: { command: Record<string, unknown> } = {
      command: {
        ultrawork: {
          description: "existing ultrawork",
          agent: "user:agent",
          subtask: false,
          template: "custom",
        },
      },
    }
    const configHook = await createConfigHook()

    await configHook(config)

    expect(config.command.ultrawork).toEqual({
      description: "existing ultrawork",
      agent: "user:agent",
      subtask: false,
      template: "custom",
    })
    expect(config.command["opencode-team-ultrawork"]).toEqual(
      expectedCommandConfig(
        "ultrawork",
        "Use the opencode_team tool. action=run, task=\"/ultrawork $ARGUMENTS\". Then summarize status/failedStage/stateFilePath.",
      ),
    )
  })

  it("injects agents when config.agent is missing", async () => {
    const config: {
      command: Record<string, unknown>
      agent?: Record<string, unknown>
    } = {
      command: {},
    }
    const configHook = await createConfigHook()

    await configHook(config)

    expect(config.agent).toEqual({
      "opencode-team:orchestrator": expectedAgentConfig(
        "workflow runner",
        `You are the opencode-team orchestrator subagent.

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
        { opencode_team: true, bash: false, write: false, edit: false },
      ),
      "opencode-team:prometheus": expectedAgentConfig(
        "planner",
        `You are Prometheus (Strategic Planning Consultant).
You produce decision-complete work plans. You do not implement.

Rules:
- Do not write or edit project files.
- Ask questions only if truly blocked.
- Ground decisions using repo evidence (paths) and OpenCode debug commands.

Output:
- Provide an actionable plan with explicit decisions, file paths, and verification commands.`,
        { bash: false, write: false, edit: false },
      ),
      "opencode-team:oracle": expectedAgentConfig(
        "architecture/debug",
        `You are Oracle (Architecture & Debugging).
Focus on: risks, edge cases, failure modes, and verification.

Constraints:
- Do not write/edit files.
- Provide concrete commands to validate assumptions.`,
        { write: false, edit: false },
      ),
      "opencode-team:librarian": expectedAgentConfig(
        "docs lookup",
        `You are Librarian (Docs & API references).
Provide citations/links and exact usage guidance.

Constraints:
- Do not write/edit files.
- Prefer official docs and source references.`,
        { bash: false, write: false, edit: false },
      ),
      "opencode-team:explore": expectedAgentConfig(
        "codebase scan",
        `You are Explore (fast codebase scan).
Return file paths and concise findings.

Constraints:
- Read-only. Do not write/edit files.`,
        { bash: false, write: false, edit: false },
      ),
      "opencode-team:momus": expectedAgentConfig(
        "high-accuracy review",
        `You are Momus (High-accuracy reviewer).
Verify correctness: file references exist, acceptance criteria are executable, and no business logic assumptions.

Constraints:
- Do not write/edit files.`,
        { write: false, edit: false },
      ),
    })
  })

  it("does not overwrite existing agents when config.agent exists", async () => {
    const existingAgent: Record<string, any> = {
      "custom:agent": {
        mode: "subagent",
        description: "custom",
        prompt: "custom prompt",
      },
    }
    const config = {
      command: {},
      agent: existingAgent,
    }
    const configHook = await createConfigHook()

    await configHook(config)

    expect(config.agent).toBe(existingAgent)
    expect(config.agent["custom:agent"]).toEqual({
      mode: "subagent",
      description: "custom",
      prompt: "custom prompt",
    })

    expect(config.agent["opencode-team:orchestrator"]).toBeDefined()
    expect(config.agent["opencode-team:prometheus"]).toBeDefined()
    expect(config.agent["opencode-team:oracle"]).toBeDefined()
    expect(config.agent["opencode-team:librarian"]).toBeDefined()
    expect(config.agent["opencode-team:explore"]).toBeDefined()
    expect(config.agent["opencode-team:momus"]).toBeDefined()
  })
})
