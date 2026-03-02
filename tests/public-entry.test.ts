import { describe, expect, it } from "vitest"

import * as entry from "../src/index.js"

describe("public entry exports", () => {
  it("only exposes function values at runtime", () => {
    const nonFunctionExports = Object.entries(entry).filter(([, value]) => typeof value !== "function")
    expect(nonFunctionExports).toEqual([])
  })
})
