import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, it } from "vitest"

import {
  appendNotepadLines,
  loadNotepadRuntimeOverlay,
} from "../src/runtime/notepad-store.js"

describe("notepad store", () => {
  it("keeps each notepad file at or below 32KB by truncating old content", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-notepad-"))
    const sessionId = "session-1"

    try {
      const lines = Array.from({ length: 2400 }, (_, index) => (
        `- line-${String(index).padStart(4, "0")} payload=abcdefghijklmnopqrstuvwxyz0123456789`
      ))
      await appendNotepadLines({
        workspaceRoot: tempRoot,
        sessionId,
        kind: "learnings",
        lines,
        maxBytes: 32 * 1024,
      })

      const path = join(tempRoot, ".agent-guide", "notepads", sessionId, "learnings.md")
      const content = await readFile(path, "utf8")

      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(32 * 1024)
      expect(content).toContain("line-2399")
      expect(content).not.toContain("line-0000")
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }, 20_000)

  it("loads only the last N lines per notepad file for runtime overlay", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "opencode-team-notepad-"))
    const sessionId = "session-2"

    try {
      await appendNotepadLines({
        workspaceRoot: tempRoot,
        sessionId,
        kind: "learnings",
        lines: ["- l1", "- l2", "- l3"],
      })
      await appendNotepadLines({
        workspaceRoot: tempRoot,
        sessionId,
        kind: "decisions",
        lines: ["- d1", "- d2", "- d3"],
      })
      await appendNotepadLines({
        workspaceRoot: tempRoot,
        sessionId,
        kind: "issues",
        lines: ["- i1", "- i2", "- i3"],
      })

      const overlay = await loadNotepadRuntimeOverlay({
        workspaceRoot: tempRoot,
        sessionId,
        lastLinesPerFile: 2,
      })

      expect(overlay).toContain("learnings:\n- l2\n- l3")
      expect(overlay).toContain("decisions:\n- d2\n- d3")
      expect(overlay).toContain("issues:\n- i2\n- i3")
      expect(overlay).not.toContain("- l1")
      expect(overlay).not.toContain("- d1")
      expect(overlay).not.toContain("- i1")
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
