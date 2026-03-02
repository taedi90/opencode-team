import { describe, expect, it } from "vitest"

import { parseRunCommand } from "../src/plugin/command-routing.js"

describe("command routing", () => {
  it("prioritizes explicit slash command over keyword", () => {
    const parsed = parseRunCommand("/ultrawork orchestrate this task")
    expect(parsed.mode).toBe("ultrawork")
    expect(parsed.source).toBe("slash")
  })

  it("detects keyword mode when slash command is absent", () => {
    const parsed = parseRunCommand("please run ralph loop until done")
    expect(parsed.mode).toBe("ralph")
    expect(parsed.source).toBe("keyword")
  })

  it("parses args schema for session and max iterations", () => {
    const parsed = parseRunCommand("/ralph --session sprint-a --max-iterations 7 verify")
    expect(parsed.sessionId).toBe("sprint-a")
    expect(parsed.maxIterations).toBe(7)
    expect(parsed.task).toBe("verify")
  })

  it("parses combined ulw-loop slash command", () => {
    const parsed = parseRunCommand("/ulw-loop --session sprint-a --max-iterations 7 implement")
    expect(parsed.mode).toBe("ulw_loop")
    expect(parsed.source).toBe("slash")
    expect(parsed.sessionId).toBe("sprint-a")
    expect(parsed.maxIterations).toBe(7)
    expect(parsed.task).toBe("implement")
  })

  it("parses cancel target mode", () => {
    const parsed = parseRunCommand("/cancel --session release-1 --target ralph")
    expect(parsed.mode).toBe("cancel")
    expect(parsed.cancelTargetMode).toBe("ralph")
    expect(parsed.sessionId).toBe("release-1")
  })
})
