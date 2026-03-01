import { execFile } from "node:child_process"

import type { GithubAutomationAdapter } from "./automation.js"

export interface GhCliAdapterOptions {
  owner: string
  repo: string
}

interface GhIssueResponse {
  number: number
  html_url: string
}

interface GhPullResponse {
  number: number
  html_url: string
}

interface GhMergeResponse {
  merged: boolean
  message?: string
}

interface GhCompareResponse {
  status: string
  ahead_by: number
}

interface GhCliAdapterDependencies {
  runGhJson?: <T>(args: string[]) => Promise<T>
  runGh?: (args: string[]) => Promise<void>
}

interface GhRefResponse {
  object: {
    sha: string
  }
}

export function isBranchAlreadyExistsError(error: unknown): boolean {
  const message = String(error)
  return (
    message.includes("Reference already exists")
    || message.includes("already_exists")
    || message.includes("422")
  )
}

function runGhJson<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`))
        return
      }

      try {
        const parsed = JSON.parse(stdout) as T
        resolve(parsed)
      } catch (parseError) {
        reject(new Error(`failed to parse gh output: ${String(parseError)}`))
      }
    })
  })
}

function runGh(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`))
        return
      }
      resolve()
    })
  })
}

export function createGhCliAdapter(
  options: GhCliAdapterOptions,
  dependencies: GhCliAdapterDependencies = {},
): GithubAutomationAdapter {
  const repoRef = `${options.owner}/${options.repo}`
  const runJson = dependencies.runGhJson ?? runGhJson
  const runCommand = dependencies.runGh ?? runGh

  return {
    createIssue: async (input) => {
      const result = await runJson<GhIssueResponse>([
        "api",
        "-X",
        "POST",
        `repos/${repoRef}/issues`,
        "-f",
        `title=${input.title}`,
        "-f",
        `body=${input.body}`,
      ])
      return { number: result.number, url: result.html_url }
    },
    createBranch: async (input) => {
      const fromRef = input.from ?? "main"
      const sourceRef = await runJson<GhRefResponse>([
        "api",
        `repos/${repoRef}/git/ref/heads/${fromRef}`,
      ])
      try {
        await runCommand([
          "api",
          "-X",
          "POST",
          `repos/${repoRef}/git/refs`,
          "-f",
          `ref=refs/heads/${input.name}`,
          "-f",
          `sha=${sourceRef.object.sha}`,
        ])
      } catch (error) {
        if (!isBranchAlreadyExistsError(error)) {
          throw error
        }
      }
      return { name: input.name }
    },
    createPullRequest: async (input) => {
      try {
        await runJson<GhRefResponse>([
          "api",
          `repos/${repoRef}/git/ref/heads/${input.base}`,
        ])
      } catch (error) {
        throw new Error(`cannot create pull request: base branch not found (${input.base}) - ${String(error)}`)
      }

      try {
        await runJson<GhRefResponse>([
          "api",
          `repos/${repoRef}/git/ref/heads/${input.head}`,
        ])
      } catch (error) {
        throw new Error(`cannot create pull request: head branch not found (${input.head}) - ${String(error)}`)
      }

      const headRef = `${options.owner}:${input.head}`
      const openPulls = await runJson<GhPullResponse[]>([
        "api",
        `repos/${repoRef}/pulls?state=open&head=${encodeURIComponent(headRef)}&base=${encodeURIComponent(input.base)}`,
      ])
      const existingPull = openPulls[0]
      if (existingPull) {
        return { number: existingPull.number, url: existingPull.html_url }
      }

      const compare = await runJson<GhCompareResponse>([
        "api",
        `repos/${repoRef}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`,
      ])
      if (compare.status === "identical" || compare.ahead_by === 0) {
        throw new Error(`cannot create pull request: no commits between ${input.base} and ${input.head}`)
      }
      if (!["ahead", "diverged"].includes(compare.status)) {
        throw new Error(
          `cannot create pull request: unsupported compare status (${compare.status}) for ${input.base}...${input.head}`,
        )
      }

      const result = await runJson<GhPullResponse>([
        "api",
        "-X",
        "POST",
        `repos/${repoRef}/pulls`,
        "-f",
        `title=${input.title}`,
        "-f",
        `body=${input.body}`,
        "-f",
        `head=${input.head}`,
        "-f",
        `base=${input.base}`,
      ])
      return { number: result.number, url: result.html_url }
    },
    mergePullRequest: async (input) => {
      const merge = await runJson<GhMergeResponse>([
        "api",
        "-X",
        "PUT",
        `repos/${repoRef}/pulls/${input.pullNumber}/merge`,
      ])
      if (!merge.merged) {
        throw new Error(`merge failed for pull #${input.pullNumber}: ${merge.message ?? "unknown reason"}`)
      }
      return { merged: merge.merged }
    },
  }
}
