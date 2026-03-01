import { describe, expect, it } from "vitest"

import {
  createGhCliAdapter,
  isBranchAlreadyExistsError,
} from "../src/github/gh-cli-adapter.js"

describe("gh cli adapter", () => {
  it("detects branch already exists errors", () => {
    expect(isBranchAlreadyExistsError("Reference already exists")).toBe(true)
    expect(isBranchAlreadyExistsError("HTTP 422 Validation Failed")).toBe(true)
    expect(isBranchAlreadyExistsError("already_exists")).toBe(true)
  })

  it("does not treat unrelated errors as branch-exists", () => {
    expect(isBranchAlreadyExistsError("bad credentials")).toBe(false)
    expect(isBranchAlreadyExistsError("network timeout")).toBe(false)
  })

  it("returns existing open pull request when present", async () => {
    const adapter = createGhCliAdapter(
      {
        owner: "acme",
        repo: "tooling",
      },
      {
        runGhJson: async <T>(args: string[]) => {
          const command = args.join(" ")
          if (command.includes("git/ref/heads/main")) {
            return { object: { sha: "base" } } as T
          }
          if (command.includes("git/ref/heads/task-branch")) {
            return { object: { sha: "head" } } as T
          }
          if (command.includes("/pulls?state=open")) {
            return [{ number: 77, html_url: "https://example.com/pulls/77" }] as T
          }
          return { status: "ahead", ahead_by: 1 } as T
        },
      },
    )

    const pull = await adapter.createPullRequest({
      title: "title",
      body: "body",
      head: "task-branch",
      base: "main",
    })

    expect(pull.number).toBe(77)
  })

  it("fails createPullRequest when no commits exist", async () => {
    const adapter = createGhCliAdapter(
      {
        owner: "acme",
        repo: "tooling",
      },
      {
        runGhJson: async <T>(args: string[]) => {
          const command = args.join(" ")
          if (command.includes("git/ref/heads/main") || command.includes("git/ref/heads/task-branch")) {
            return { object: { sha: "sha" } } as T
          }
          if (command.includes("/pulls?state=open")) {
            return [] as T
          }
          if (command.includes("/compare/")) {
            return { status: "identical", ahead_by: 0 } as T
          }
          return { number: 1, html_url: "https://example.com/pulls/1" } as T
        },
      },
    )

    await expect(adapter.createPullRequest({
      title: "title",
      body: "body",
      head: "task-branch",
      base: "main",
    })).rejects.toThrow("no commits")
  })

  it("fails mergePullRequest with explicit api message", async () => {
    const adapter = createGhCliAdapter(
      {
        owner: "acme",
        repo: "tooling",
      },
      {
        runGhJson: async <T>() => ({
          merged: false,
          message: "branch protection prevented merge",
        } as T),
      },
    )

    await expect(adapter.mergePullRequest({ pullNumber: 42 })).rejects.toThrow("branch protection prevented merge")
  })
})
