import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const OUTPUT_RELATIVE_PATH = "src/generated/opencode-develop-artifact.ts"

function parseIssueNumber(task) {
  const matched = task.match(/#(\d+)/)
  if (!matched) {
    return null
  }

  const parsed = Number.parseInt(matched[1] ?? "", 10)
  return Number.isInteger(parsed) ? parsed : null
}

function buildSignature(task, adrDecision) {
  return createHash("sha256")
    .update(task)
    .update("\n")
    .update(adrDecision)
    .digest("hex")
    .slice(0, 16)
}

function buildSnapshotContent(input) {
  const issueNumber = parseIssueNumber(input.task)
  const signature = buildSignature(input.task, input.adrDecision)

  return [
    "export interface OpenCodeDevelopArtifact {",
    "  issueNumber: number | null",
    "  task: string",
    "  adrDecision: string",
    "  signature: string",
    "}",
    "",
    "export const opencodeDevelopArtifact: OpenCodeDevelopArtifact = {",
    `  issueNumber: ${issueNumber === null ? "null" : String(issueNumber)},`,
    `  task: ${JSON.stringify(input.task)},`,
    `  adrDecision: ${JSON.stringify(input.adrDecision)},`,
    `  signature: ${JSON.stringify(signature)},`,
    "}",
    "",
  ].join("\n")
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

export async function runTaskSnapshotHandler(input) {
  const outputPath = join(input.cwd, OUTPUT_RELATIVE_PATH)
  const nextContent = buildSnapshotContent(input)
  const previousContent = await readTextOrNull(outputPath)

  if (previousContent === nextContent) {
    return {
      changed: false,
      changedFiles: [OUTPUT_RELATIVE_PATH],
    }
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, nextContent, "utf8")

  return {
    changed: true,
    changedFiles: [OUTPUT_RELATIVE_PATH],
  }
}
