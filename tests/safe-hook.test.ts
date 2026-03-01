import { describe, expect, it, vi } from "vitest"

import { safeCreateHook } from "../src/plugin/safe-hook.js"

describe("safe hook", () => {
  it("isolates hook creation failure", async () => {
    const warn = vi.fn()
    const hook = safeCreateHook({
      name: "beforeRun",
      create: () => {
        throw new Error("boom")
      },
      logger: { warn },
    })

    await hook({})
    expect(warn).toHaveBeenCalled()
  })

  it("isolates hook execution failure", async () => {
    const warn = vi.fn()
    const hook = safeCreateHook({
      name: "afterRun",
      create: () => async () => {
        throw new Error("explode")
      },
      logger: { warn },
    })

    await hook({})
    expect(warn).toHaveBeenCalled()
  })
})
