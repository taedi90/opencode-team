import { describe, expect, it } from "vitest"

import { normalizeNpxServerArgs } from "../src/runtime/mcp-auto-install.js"

describe("normalizeNpxServerArgs", () => {
  it("removes duplicated leading npx package prefixes", () => {
    const normalized = normalizeNpxServerArgs(
      "@modelcontextprotocol/server-github",
      [
        "-y",
        "@modelcontextprotocol/server-github",
        "-y",
        "@modelcontextprotocol/server-github",
      ],
    )

    expect(normalized).toEqual(["-y", "@modelcontextprotocol/server-github"])
  })

  it("applies fallback tail when args are empty", () => {
    const normalized = normalizeNpxServerArgs(
      "@modelcontextprotocol/server-filesystem",
      [],
      ["."],
    )

    expect(normalized).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "."])
  })
})
