import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, it, afterEach } from "vitest"

import {
  buildPullRequestBody,
  runGithubAutomation,
  type GithubAutomationAdapter,
} from "../src/github/automation.js"

let tempDir = ""

async function createTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "opencode-team-github-"))
  return tempDir
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ""
  }
})

function createMockAdapter(): GithubAutomationAdapter {
  return {
    createIssue: async () => ({ number: 101, url: "https://example.com/issues/101" }),
    createBranch: async () => ({ name: "task/101-example" }),
    createPullRequest: async () => ({ number: 201, url: "https://example.com/pull/201" }),
    mergePullRequest: async () => ({ merged: true }),
  }
}

describe("github automation", () => {
  it("builds PR body with closes keyword and verification evidence", () => {
    const body = buildPullRequestBody({
      issueNumber: 12,
      summary: ["add pipeline", "add tests"],
      verification: ["npm test", "npm run typecheck"],
    })

    expect(body).toContain("Closes #12")
    expect(body).toContain("npm test")
    expect(body).toContain("npm run typecheck")
  })

  it("uses default merge policy B and waits for user approval", async () => {
    const workingDirectory = await createTempDir()

    const result = await runGithubAutomation(
      createMockAdapter(),
      {
        workingDirectory,
        issueTitle: "Issue title",
        issueBody: "Issue body",
        branchName: "task/101-example",
        prTitle: "PR title",
        summary: ["summary"],
        verification: ["npm test"],
      },
    )

    expect(result.mergeDecision).toBe("awaiting_user_approval")
    expect(result.merged).toBe(false)
  })

  it("auto merges when requireUserApproval is false", async () => {
    const workingDirectory = await createTempDir()

    const result = await runGithubAutomation(
      createMockAdapter(),
      {
        workingDirectory,
        issueTitle: "Issue title",
        issueBody: "Issue body",
        branchName: "task/101-example",
        prTitle: "PR title",
        summary: ["summary"],
        verification: ["npm test"],
      },
      {
        requireUserApproval: false,
      },
    )

    expect(result.mergeDecision).toBe("auto_merged")
    expect(result.merged).toBe(true)
  })

  it("writes merge policy decision logs per PR", async () => {
    const workingDirectory = await createTempDir()

    const result = await runGithubAutomation(
      createMockAdapter(),
      {
        workingDirectory,
        issueTitle: "Issue title",
        issueBody: "Issue body",
        branchName: "task/101-example",
        prTitle: "PR title",
        summary: ["summary"],
        verification: ["npm test"],
      },
    )

    const logContent = await readFile(result.policyLogPath, "utf8")
    expect(logContent).toContain("\"requireUserApproval\":true")
    expect(logContent).toContain("awaiting_user_approval")
  })

  it("reuses idempotent result for duplicate requests", async () => {
    const workingDirectory = await createTempDir()
    let issueCalls = 0

    const adapter: GithubAutomationAdapter = {
      createIssue: async () => {
        issueCalls += 1
        return { number: 101, url: "https://example.com/issues/101" }
      },
      createBranch: async () => ({ name: "task/101-example" }),
      createPullRequest: async () => ({ number: 201, url: "https://example.com/pull/201" }),
      mergePullRequest: async () => ({ merged: false }),
    }

    const input = {
      workingDirectory,
      issueTitle: "Issue title",
      issueBody: "Issue body",
      branchName: "task/101-example",
      prTitle: "PR title",
      summary: ["summary"],
      verification: ["npm test"],
      idempotencyKey: "same-request",
    }

    const first = await runGithubAutomation(adapter, input)
    const second = await runGithubAutomation(adapter, input)

    expect(first.issueNumber).toBe(second.issueNumber)
    expect(issueCalls).toBe(1)
  })

  it("retries transient failures", async () => {
    const workingDirectory = await createTempDir()
    let issueAttempts = 0

    const adapter: GithubAutomationAdapter = {
      createIssue: async () => {
        issueAttempts += 1
        if (issueAttempts === 1) {
          throw new Error("timeout")
        }
        return { number: 101, url: "https://example.com/issues/101" }
      },
      createBranch: async () => ({ name: "task/101-example" }),
      createPullRequest: async () => ({ number: 201, url: "https://example.com/pull/201" }),
      mergePullRequest: async () => ({ merged: false }),
    }

    const result = await runGithubAutomation(adapter, {
      workingDirectory,
      issueTitle: "Issue title",
      issueBody: "Issue body",
      branchName: "task/101-example",
      prTitle: "PR title",
      summary: ["summary"],
      verification: ["npm test"],
    })

    expect(result.issueNumber).toBe(101)
    expect(result.retryCount).toBeGreaterThan(0)
  })

  it("applies configurable retry policy", async () => {
    const workingDirectory = await createTempDir()
    let issueAttempts = 0

    const adapter: GithubAutomationAdapter = {
      createIssue: async () => {
        issueAttempts += 1
        if (issueAttempts <= 2) {
          throw new Error("temporary network error")
        }
        return { number: 101, url: "https://example.com/issues/101" }
      },
      createBranch: async () => ({ name: "task/101-example" }),
      createPullRequest: async () => ({ number: 201, url: "https://example.com/pull/201" }),
      mergePullRequest: async () => ({ merged: false }),
    }

    const result = await runGithubAutomation(
      adapter,
      {
        workingDirectory,
        issueTitle: "Issue title",
        issueBody: "Issue body",
        branchName: "task/101-example",
        prTitle: "PR title",
        summary: ["summary"],
        verification: ["npm test"],
      },
      {
        retry: {
          maxRetries: 3,
          baseDelayMs: 1,
        },
      },
    )

    expect(result.issueNumber).toBe(101)
    expect(result.retryCount).toBe(2)
  })

  it("uses provided issue info without creating a new issue", async () => {
    const workingDirectory = await createTempDir()
    let issueCalls = 0

    const adapter: GithubAutomationAdapter = {
      createIssue: async () => {
        issueCalls += 1
        return { number: 999, url: "https://example.com/issues/999" }
      },
      createBranch: async () => ({ name: "task/101-example" }),
      createPullRequest: async () => ({ number: 201, url: "https://example.com/pull/201" }),
      mergePullRequest: async () => ({ merged: false }),
    }

    const result = await runGithubAutomation(adapter, {
      workingDirectory,
      issueTitle: "Issue title",
      issueBody: "Issue body",
      issueNumber: 123,
      issueUrl: "https://example.com/issues/123",
      branchName: "task/101-example",
      prTitle: "PR title",
      summary: ["summary"],
      verification: ["npm test"],
    })

    expect(result.issueNumber).toBe(123)
    expect(issueCalls).toBe(0)
  })
})
