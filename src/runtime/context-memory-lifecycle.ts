import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface LifecycleRunInput {
  workspaceRoot: string
  task: string
  mode: "orchestrator" | "ultrawork" | "ralph" | "ulw_loop" | "cancel"
  source: "slash" | "keyword" | "default"
}

export interface LifecyclePreloadResult {
  issueContextPath?: string
  memoryPaths: string[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function resolveIssueNumber(task: string): number | null {
  const match = task.match(/#(\d+)/)
  if (!match || !match[1]) {
    return null
  }

  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function toIssuePrefix(issueNumber: number): string {
  return `issue-${String(issueNumber).padStart(3, "0")}-`
}

async function listFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path)
    return entries.sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return []
    }
    throw error
  }
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${line}\n`, { encoding: "utf8", flag: "a" })
}

async function appendContextReference(contextPath: string, referencePath: string, reason: string): Promise<void> {
  await appendLine(contextPath, `- 참고: ${referencePath} | 적용 이유: ${reason}`)
}

async function resolveLatestIssueContextPath(contextDir: string, issueNumber: number): Promise<string | undefined> {
  const prefix = toIssuePrefix(issueNumber)
  const entries = await listFiles(contextDir)
  const matches = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
  if (matches.length === 0) {
    return undefined
  }

  const withMtime = await Promise.all(matches.map(async (name) => {
    const filePath = join(contextDir, name)
    const info = await stat(filePath)
    return {
      filePath,
      mtimeMs: info.mtimeMs,
    }
  }))

  withMtime.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return withMtime[0]?.filePath
}

export async function runPreloadLifecycle(input: LifecycleRunInput): Promise<LifecyclePreloadResult> {
  const contextDir = join(input.workspaceRoot, ".agent-guide", "context")
  const memoryDir = join(input.workspaceRoot, ".agent-guide", "memory")
  const runtimeLog = join(input.workspaceRoot, ".agent-guide", "runtime", "context-memory-log.jsonl")

  const memoryPaths = (await listFiles(memoryDir))
    .filter((name) => name.endsWith(".md") && name !== "memory-domain-topic-template.md")
    .map((name) => join(memoryDir, name))

  const issueNumber = resolveIssueNumber(input.task)
  const issueContextPath = issueNumber
    ? await resolveLatestIssueContextPath(contextDir, issueNumber)
    : undefined

  if (issueContextPath) {
    for (const path of memoryPaths) {
      await appendContextReference(issueContextPath, path, "pre-run memory preload")
    }
  }

  await appendLine(runtimeLog, JSON.stringify({
    timestamp: nowIso(),
    event: "preload",
    mode: input.mode,
    source: input.source,
    issueContextPath,
    memoryPaths,
  }))

  return {
    ...(issueContextPath ? { issueContextPath } : {}),
    memoryPaths,
  }
}

export async function appendInRunMemoryReference(input: {
  workspaceRoot: string
  issueContextPath?: string
  referencePath: string
  reason: string
}): Promise<void> {
  if (!input.issueContextPath) {
    return
  }

  await appendContextReference(input.issueContextPath, input.referencePath, input.reason)
}

export async function runPostLifecycle(input: LifecycleRunInput & {
  status: "completed" | "failed"
  issueContextPath?: string
}): Promise<{ promotedMemoryPath?: string; cleanedContextPaths: string[] }> {
  const runtimeLog = join(input.workspaceRoot, ".agent-guide", "runtime", "context-memory-log.jsonl")
  const cleanedContextPaths: string[] = []
  const contextDir = join(input.workspaceRoot, ".agent-guide", "context")
  const issueNumber = resolveIssueNumber(input.task)

  if (input.issueContextPath) {
    await appendLine(input.issueContextPath, "")
    await appendLine(input.issueContextPath, "## Handoff")
    await appendLine(input.issueContextPath, `- Current Status: ${input.status}`)
    await appendLine(input.issueContextPath, "- Changed Files: automated by lifecycle hook")
    await appendLine(input.issueContextPath, "- Open Risks: none")
    await appendLine(input.issueContextPath, "- Next Action (1 line): follow issue checklist")
  }

  let promotedMemoryPath: string | undefined
  if (input.status === "completed" && input.mode === "orchestrator") {
    promotedMemoryPath = join(input.workspaceRoot, ".agent-guide", "memory", "memory-runtime-context-lifecycle.md")
    const evidenceIssue = issueNumber ? `#${issueNumber}` : "none"
    const memoryBody = [
      "---",
      `issue: ${String(issueNumber ?? 0)}`,
      "domain: runtime",
      "topic: context-lifecycle",
      "tags: [memory, lifecycle]",
      "status: active",
      `updated_at: ${nowIso().slice(0, 10)}`,
      "---",
      "",
      "# Runtime Context Lifecycle",
      "",
      "## Decision",
      "- orchestrator 실행 전 context/memory preload와 실행 후 handoff 갱신을 기본 동작으로 유지한다.",
      "",
      "## Evidence",
      `- 관련 이슈: ${evidenceIssue}`,
      `- 실행 모드: ${input.mode}`,
      `- 완료 상태: ${input.status}`,
      "- 검증 근거: lifecycle 통합 테스트 + runtime log 기록",
      "",
      "## Reuse Rule",
      "- 새 runtime 훅 추가 시 preload/post lifecycle을 먼저 연결한다.",
      "",
      "## Scope",
      "- 적용 범위(모듈/상황): plugin hooks, orchestrator run",
      "",
      "## Promotion Cleanup",
      "- 제거한 단기 내용: 없음",
      "- 분리한 무관 주제 파일: 없음",
      "",
      "## Caution",
      "- context 경로를 찾지 못하면 preload/post 기록을 건너뛴다.",
      "",
    ].join("\n")
    await mkdir(dirname(promotedMemoryPath), { recursive: true })
    await writeFile(promotedMemoryPath, memoryBody, "utf8")
  }

  const contextFiles = await listFiles(contextDir)
  for (const name of contextFiles) {
    if (!name.startsWith("tmp-") || !name.endsWith(".md")) {
      continue
    }
    const filePath = join(contextDir, name)
    await rm(filePath, { force: true })
    cleanedContextPaths.push(filePath)
  }

  await appendLine(runtimeLog, JSON.stringify({
    timestamp: nowIso(),
    event: "post",
    mode: input.mode,
    source: input.source,
    status: input.status,
    issueContextPath: input.issueContextPath,
    promotedMemoryPath,
    cleanedContextPaths,
  }))

  return {
    ...(promotedMemoryPath ? { promotedMemoryPath } : {}),
    cleanedContextPaths,
  }
}

export async function readLifecycleLog(path: string): Promise<string> {
  return readFile(path, "utf8")
}
