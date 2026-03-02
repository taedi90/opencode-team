import { describe, expect, it } from "vitest"

import * as entry from "../src/index.js"

describe("public entry exports", () => {
  it("exposes OpenCode plugin entrypoint only", () => {
    expect(typeof entry.OpenCodeTeamPlugin).toBe("function")
    expect(typeof entry.default).toBe("function")
    expect("runCli" in entry).toBe(false)
    expect("createPluginRuntime" in entry).toBe(false)
  })

  it("only exposes function values at runtime", () => {
    const nonFunctionExports = Object.entries(entry).filter(([, value]) => typeof value !== "function")
    expect(nonFunctionExports).toEqual([])
  })
})
