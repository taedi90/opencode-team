import { describe, expect, it, vi } from "vitest"

import * as entry from "../src/index.js"
import plugin from "../src/index.js"

describe("public entry exports", () => {
  it("exposes default plugin entrypoint only", () => {
    expect(Object.keys(entry)).toEqual(["default"])
    expect(typeof entry.default).toBe("function")
    expect(entry.default).toBe(plugin)
    expect("runCli" in entry).toBe(false)
    expect("createPluginRuntime" in entry).toBe(false)
  })

  it("logs plugin load and returns config hook", async () => {
    const log = vi.fn()
    const hooks = await plugin({
      client: {
        app: {
          log,
        },
      },
    } as never)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({
      body: {
        service: "opencode-team",
        level: "info",
        message: "plugin loaded",
      },
    })
    expect(typeof hooks.config).toBe("function")
    await expect(hooks.config({})).resolves.toBeUndefined()
  })
})
