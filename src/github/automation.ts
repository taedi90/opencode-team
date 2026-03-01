import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  DEFAULT_CONFIG,
} from "../config/index.js"

export interface GithubAutomationAdapter {
  createIssue: (input: {
    title: string
    body: string
  }) => Promise<{ number: number; url: string }>
  createBranch: (input: {
    name: string
    from?: string
  }) => Promise<{ name: string }>
  createPullRequest: (input: {
    title: string
    body: string
    head: string
    base: string
  }) => Promise<{ number: number; url: string }>
  mergePullRequest: (input: {
    pullNumber: number
  }) => Promise<{ merged: boolean }>
}

export interface GithubAutomationInput {
  workingDirectory: string
  issueTitle: string
  issueBody: string
  issueNumber?: number
  issueUrl?: string
  branchName: string
  prTitle: string
  summary: string[]
  verification: string[]
  baseBranch?: string
  idempotencyKey?: string
}

export interface GithubAutomationOptions {
  requireUserApproval?: boolean
  userApprovedMerge?: boolean
  policyLogPath?: string
  retry?: {
    maxRetries?: number
    baseDelayMs?: number
  }
}

export type MergeDecision =
  | "awaiting_user_approval"
  | "auto_merged"
  | "approved_and_merged"

export interface GithubAutomationResult {
  issueNumber: number
  issueUrl: string
  branchName: string
  pullNumber: number
  pullUrl: string
  merged: boolean
  mergeDecision: MergeDecision
  policyLogPath: string
  retryCount: number
}

interface RetryResult<T> {
  value: T
  retries: number
}

function resolvePolicyLogPath(
  workingDirectory: string,
  options: GithubAutomationOptions,
): string {
  if (options.policyLogPath) return options.policyLogPath
  return join(workingDirectory, ".agent-guide", "runtime", "merge-policy-log.jsonl")
}

async function appendPolicyLog(
  logPath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8")
}

function resolveIdempotencyPath(input: GithubAutomationInput): string {
  const raw = input.idempotencyKey ?? `${input.issueTitle}|${input.branchName}|${input.prTitle}`
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)

  return join(
    input.workingDirectory,
    ".agent-guide",
    "runtime",
    "idempotency",
    `github-automation-${normalized || "default"}.json`,
  )
}

async function readIdempotentResult(path: string): Promise<GithubAutomationResult | null> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as GithubAutomationResult
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

async function persistIdempotentResult(path: string, result: GithubAutomationResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8")
}

function shouldRetry(error: unknown): boolean {
  const text = String(error).toLowerCase()
  return text.includes("timeout")
    || text.includes("econn")
    || text.includes("tempor")
    || text.includes("rate limit")
}

async function withRetry<T>(
  task: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 200,
): Promise<RetryResult<T>> {
  let retries = 0

  while (true) {
    try {
      const value = await task()
      return {
        value,
        retries,
      }
    } catch (error) {
      if (retries >= maxRetries || !shouldRetry(error)) {
        throw error
      }
      retries += 1
      const delay = Math.min(3000, baseDelayMs * (2 ** (retries - 1)))
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

async function appendStructuredLog(
  workingDirectory: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const path = join(workingDirectory, ".agent-guide", "runtime", "structured-log.jsonl")
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(payload)}\n`, "utf8")
}

export function buildPullRequestBody(input: {
  issueNumber: number
  summary: string[]
  verification: string[]
}): string {
  const summaryLines = input.summary.map((item) => `- ${item}`).join("\n")
  const verificationLines = input.verification.map((item) => `- ${item}`).join("\n")

  return [
    "## Summary",
    summaryLines,
    "",
    "## Verification",
    verificationLines,
    "",
    `Closes #${input.issueNumber}`,
  ].join("\n")
}

export async function runGithubAutomation(
  adapter: GithubAutomationAdapter,
  input: GithubAutomationInput,
  options: GithubAutomationOptions = {},
): Promise<GithubAutomationResult> {
  const idempotencyPath = resolveIdempotencyPath(input)
  const idempotent = await readIdempotentResult(idempotencyPath)
  if (idempotent) {
    await appendStructuredLog(input.workingDirectory, {
      timestamp: new Date().toISOString(),
      stage: "merge",
      mode: "orchestrator",
      command: "runGithubAutomation",
      error_code: "none",
      retry_count: 0,
      event: "idempotent_hit",
    })
    return idempotent
  }

  const requireUserApproval = options.requireUserApproval
    ?? DEFAULT_CONFIG.merge_policy.require_user_approval
  const retryMax = options.retry?.maxRetries ?? 3
  const retryDelay = options.retry?.baseDelayMs ?? 200
  const logPath = resolvePolicyLogPath(input.workingDirectory, options)
  let retryCount = 0

  const issue = input.issueNumber && input.issueUrl
    ? {
      number: input.issueNumber,
      url: input.issueUrl,
    }
    : await (async () => {
      const issueCall = await withRetry(async () => adapter.createIssue({
        title: input.issueTitle,
        body: input.issueBody,
      }), retryMax, retryDelay)
      retryCount += issueCall.retries
      return issueCall.value
    })()

  const branchInput: {
    name: string
    from?: string
  } = {
    name: input.branchName,
  }
  if (input.baseBranch) {
    branchInput.from = input.baseBranch
  }

  const branchCall = await withRetry(async () => adapter.createBranch(branchInput), retryMax, retryDelay)
  const branch = branchCall.value
  retryCount += branchCall.retries

  const pullCall = await withRetry(async () => adapter.createPullRequest({
    title: input.prTitle,
    body: buildPullRequestBody({
      issueNumber: issue.number,
      summary: input.summary,
      verification: input.verification,
    }),
    head: branch.name,
    base: input.baseBranch ?? "main",
  }), retryMax, retryDelay)
  const pull = pullCall.value
  retryCount += pullCall.retries

  let merged = false
  let mergeDecision: MergeDecision = "awaiting_user_approval"

  if (!requireUserApproval) {
    const mergeCall = await withRetry(async () => adapter.mergePullRequest({
      pullNumber: pull.number,
    }), retryMax, retryDelay)
    const mergeResult = mergeCall.value
    retryCount += mergeCall.retries
    merged = mergeResult.merged
    mergeDecision = "auto_merged"
  } else if (options.userApprovedMerge) {
    const mergeCall = await withRetry(async () => adapter.mergePullRequest({
      pullNumber: pull.number,
    }), retryMax, retryDelay)
    const mergeResult = mergeCall.value
    retryCount += mergeCall.retries
    merged = mergeResult.merged
    mergeDecision = "approved_and_merged"
  }

  await appendPolicyLog(logPath, {
    timestamp: new Date().toISOString(),
    requireUserApproval,
    mergeDecision,
    issueNumber: issue.number,
    pullNumber: pull.number,
  })

  const result: GithubAutomationResult = {
    issueNumber: issue.number,
    issueUrl: issue.url,
    branchName: branch.name,
    pullNumber: pull.number,
    pullUrl: pull.url,
    merged,
    mergeDecision,
    policyLogPath: logPath,
    retryCount,
  }

  await appendStructuredLog(input.workingDirectory, {
    timestamp: new Date().toISOString(),
    stage: "merge",
    mode: "orchestrator",
    command: "runGithubAutomation",
    error_code: "none",
    retry_count: retryCount,
    issue_number: result.issueNumber,
    pull_number: result.pullNumber,
  })

  await persistIdempotentResult(idempotencyPath, result)

  return result
}
