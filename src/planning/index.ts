import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  buildRoleOutputEnvelope,
  parseWithRuntimeContractRetry,
  type RoleOutputEnvelope,
  type RuntimeContractErrorCode,
  validateRuntimeHandoff,
  type RuntimeHandoff,
  type RuntimeValidationResult,
} from "../runtime/role-output-contract.js"

export interface PlanningInput {
  problem: string
  context?: string[]
  constraints?: string[]
}

export type PlanningRiskLevel = "low" | "high"

export interface DeliberatePlan {
  preMortem: string[]
  expandedTestPlan: {
    unit: string[]
    integration: string[]
    e2e: string[]
    observability: string[]
  }
}

export interface PlanningAlternative {
  id: string
  summary: string
  pros: string[]
  cons: string[]
}

export interface PlanningDraft {
  principles: string[]
  decisionDrivers: string[]
  alternatives: PlanningAlternative[]
  selectedOptionId: string
  rejectedAlternativesReason?: string
  acceptanceCriteria: string[]
  verificationPlan: string[]
  handoff: RuntimeHandoff
  deliberate?: DeliberatePlan
}

export interface ArchitectReview {
  antithesis: string
  tradeoffTension: string
  synthesis?: string
  handoff: RuntimeHandoff
}

export type CriticReview =
  | {
      decision: "approve"
      handoff: RuntimeHandoff
    }
  | {
      decision: "reject"
      reasons: string[]
      handoff: RuntimeHandoff
    }

export interface PlanningLoopContext {
  input: PlanningInput
  iteration: number
  riskLevel: PlanningRiskLevel
  previousRejectReasons: string[]
}

export interface CriticReviewContext extends PlanningLoopContext {
  draft: PlanningDraft
  architect: ArchitectReview
  validationErrors: string[]
}

export interface ConsensusPlanningHooks {
  createDraft: (context: PlanningLoopContext) => Promise<PlanningDraft> | PlanningDraft
  reviewArchitecture: (context: PlanningLoopContext & { draft: PlanningDraft }) => Promise<ArchitectReview> | ArchitectReview
  reviewCritic: (context: CriticReviewContext) => Promise<CriticReview> | CriticReview
}

export interface AdrRecord {
  decision: string
  drivers: string[]
  alternatives: string[]
  whyChosen: string
  consequences: string[]
  followUps: string[]
}

interface ConsensusPlanningResultBase {
  iterations: number
  history: Array<{
    iteration: number
    decision: CriticReview["decision"]
    reasons: string[]
  }>
  lastRejectReasons: string[]
}

export interface ApprovedConsensusPlanningResult
  extends ConsensusPlanningResultBase {
  status: "approved"
  adr: AdrRecord
}

export interface RejectedConsensusPlanningResult
  extends ConsensusPlanningResultBase {
  status: "rejected"
}

export type ConsensusPlanningResult =
  | ApprovedConsensusPlanningResult
  | RejectedConsensusPlanningResult

export interface ConsensusPlanningOptions {
  maxIterations?: number
  contractRetries?: number
  hooks?: Partial<ConsensusPlanningHooks>
  workspaceRoot?: string
  artifactName?: string
}

const DEFAULT_MAX_ITERATIONS = 5
const DEFAULT_CONTRACT_RETRIES = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validatePlanningDraftOutput(value: unknown): RuntimeValidationResult<PlanningDraft> {
  if (!isRecord(value)) {
    return {
      valid: false,
      error: {
        code: "schema_validation_failed",
        message: "planning draft must be an object",
        details: ["draft output is not object"],
      },
    }
  }

  const handoff = validateRuntimeHandoff(value.handoff)
  if (!handoff.valid || !handoff.value) {
    return {
      valid: false,
      error: handoff.error ?? {
        code: "handoff_missing",
        message: "handoff contract validation failed",
        details: ["handoff is missing"],
      },
    }
  }

  return {
    valid: true,
    value: {
      ...(value as Omit<PlanningDraft, "handoff">),
      handoff: handoff.value,
    },
  }
}

function validateArchitectReviewOutput(value: unknown): RuntimeValidationResult<ArchitectReview> {
  if (!isRecord(value)) {
    return {
      valid: false,
      error: {
        code: "schema_validation_failed",
        message: "architect review must be an object",
        details: ["architect output is not object"],
      },
    }
  }

  const handoff = validateRuntimeHandoff(value.handoff)
  if (!handoff.valid || !handoff.value) {
    return {
      valid: false,
      error: handoff.error ?? {
        code: "handoff_missing",
        message: "handoff contract validation failed",
        details: ["handoff is missing"],
      },
    }
  }

  return {
    valid: true,
    value: {
      ...(value as Omit<ArchitectReview, "handoff">),
      handoff: handoff.value,
    },
  }
}

function validateCriticReviewOutput(value: unknown): RuntimeValidationResult<CriticReview> {
  if (!isRecord(value)) {
    return {
      valid: false,
      error: {
        code: "schema_validation_failed",
        message: "critic review must be an object",
        details: ["critic output is not object"],
      },
    }
  }

  if (value.decision !== "approve" && value.decision !== "reject") {
    return {
      valid: false,
      error: {
        code: "decision_invalid",
        message: "critic decision must be approve or reject",
        details: [`received decision: ${String(value.decision)}`],
      },
    }
  }

  const handoff = validateRuntimeHandoff(value.handoff)
  if (!handoff.valid || !handoff.value) {
    return {
      valid: false,
      error: handoff.error ?? {
        code: "handoff_missing",
        message: "handoff contract validation failed",
        details: ["handoff is missing"],
      },
    }
  }

  if (value.decision === "approve") {
    return {
      valid: true,
      value: {
        decision: "approve",
        handoff: handoff.value,
      },
    }
  }

  if (!Array.isArray(value.reasons) || value.reasons.some((item) => typeof item !== "string")) {
    return {
      valid: false,
      error: {
        code: "schema_validation_failed",
        message: "critic reject reasons must be string array",
        details: ["critic.reasons invalid"],
      },
    }
  }

  return {
    valid: true,
    value: {
      decision: "reject",
      reasons: [...value.reasons],
      handoff: handoff.value,
    },
  }
}

function contractRejectResult(input: {
  iteration: number
  code: RuntimeContractErrorCode
  details: string[]
}): RejectedConsensusPlanningResult {
  const reason = `${input.code}: ${input.details.join(", ")}`
  return {
    status: "rejected",
    iterations: input.iteration,
    history: [
      {
        iteration: input.iteration,
        decision: "reject",
        reasons: [reason],
      },
    ],
    lastRejectReasons: [reason],
  }
}

interface PlanningPersistencePayload {
  loopContext: PlanningLoopContext
  draft: PlanningDraft
  architect: ArchitectReview
  critic: CriticReview
  roleOutputs: {
    plan: RoleOutputEnvelope<PlanningDraft>
    architect: RoleOutputEnvelope<ArchitectReview>
    critic: RoleOutputEnvelope<CriticReview>
  }
  validationErrors: string[]
  status: "approved" | "rejected"
  adr?: AdrRecord
}

function resolveArtifactName(input: PlanningInput, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim()

  const normalized = input.problem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (normalized.length > 0) return normalized.slice(0, 48)

  return `plan-${Date.now()}`
}

async function persistPlanningArtifacts(
  workspaceRoot: string,
  artifactName: string,
  payload: PlanningPersistencePayload,
): Promise<void> {
  const baseDir = join(workspaceRoot, ".agent-guide")
  const draftsDir = join(baseDir, "drafts")
  const notesDir = join(baseDir, "notes")
  const plansDir = join(baseDir, "plans")

  await mkdir(draftsDir, { recursive: true })
  await mkdir(notesDir, { recursive: true })
  await mkdir(plansDir, { recursive: true })

  const iteration = payload.loopContext.iteration
  const draftPath = join(draftsDir, `${artifactName}-iter-${String(iteration).padStart(2, "0")}.json`)
  const notePath = join(notesDir, `${artifactName}.md`)
  const planPath = join(plansDir, `${artifactName}.md`)

  await writeFile(
    draftPath,
    `${JSON.stringify({
      iteration,
      draft: payload.draft,
      architect: payload.architect,
      critic: payload.critic,
      roleOutputs: payload.roleOutputs,
      validationErrors: payload.validationErrors,
    }, null, 2)}\n`,
    "utf8",
  )

  const criticReasons =
    payload.critic.decision === "reject"
      ? payload.critic.reasons.join(", ")
      : payload.validationErrors.join(", ")
  const noteBlock = [
    `## Iteration ${iteration}`,
    `- status: ${payload.status}`,
    `- selected: ${payload.draft.selectedOptionId}`,
    `- antithesis: ${payload.architect.antithesis}`,
    `- tradeoff: ${payload.architect.tradeoffTension}`,
    `- critic: ${payload.critic.decision}`,
    criticReasons.length > 0 ? `- reasons: ${criticReasons}` : "- reasons: none",
    "",
  ].join("\n")
  await writeFile(notePath, noteBlock, { encoding: "utf8", flag: "a" })

  if (payload.status === "approved" && payload.adr) {
    const lines = [
      `# Plan: ${artifactName}`,
      "",
      "## ADR",
      `- Decision: ${payload.adr.decision}`,
      `- Drivers: ${payload.adr.drivers.join(", ")}`,
      "",
      "## Alternatives",
      ...payload.adr.alternatives.map((item) => `- ${item}`),
      "",
      "## Why Chosen",
      payload.adr.whyChosen,
      "",
      "## Consequences",
      ...payload.adr.consequences.map((item) => `- ${item}`),
      "",
      "## Follow-ups",
      ...payload.adr.followUps.map((item) => `- ${item}`),
      "",
    ]
    await writeFile(planPath, `${lines.join("\n")}\n`, "utf8")
  }
}

export function classifyPlanningRisk(input: PlanningInput): PlanningRiskLevel {
  const text = `${input.problem} ${(input.context ?? []).join(" ")} ${(input.constraints ?? []).join(" ")}`
    .toLowerCase()
  const highRiskKeywords = [
    "migration",
    "delete",
    "drop",
    "production",
    "security",
    "auth",
    "payment",
    "billing",
    "destructive",
  ]

  return highRiskKeywords.some((keyword) => text.includes(keyword))
    ? "high"
    : "low"
}

function validateDraft(draft: PlanningDraft): string[] {
  const errors: string[] = []

  if (draft.principles.length < 3) {
    errors.push("principles must include at least 3 items")
  }

  if (draft.decisionDrivers.length < 3) {
    errors.push("decisionDrivers must include at least 3 items")
  }

  if (draft.alternatives.length < 2 && !draft.rejectedAlternativesReason) {
    errors.push("alternatives must include at least 2 options or provide rejectedAlternativesReason")
  }

  if (!draft.alternatives.some((item) => item.id === draft.selectedOptionId)) {
    errors.push("selectedOptionId must exist in alternatives")
  }

  if (draft.acceptanceCriteria.length === 0) {
    errors.push("acceptanceCriteria must not be empty")
  }

  if (draft.verificationPlan.length === 0) {
    errors.push("verificationPlan must not be empty")
  }

  if (draft.deliberate) {
    if (draft.deliberate.preMortem.length < 3) {
      errors.push("deliberate preMortem must include at least 3 scenarios")
    }

    if (draft.deliberate.expandedTestPlan.unit.length === 0) {
      errors.push("deliberate expandedTestPlan.unit must not be empty")
    }

    if (draft.deliberate.expandedTestPlan.integration.length === 0) {
      errors.push("deliberate expandedTestPlan.integration must not be empty")
    }

    if (draft.deliberate.expandedTestPlan.e2e.length === 0) {
      errors.push("deliberate expandedTestPlan.e2e must not be empty")
    }

    if (draft.deliberate.expandedTestPlan.observability.length === 0) {
      errors.push("deliberate expandedTestPlan.observability must not be empty")
    }
  }

  return errors
}

export function createDefaultPlanningDraft(context: PlanningLoopContext): PlanningDraft {
  const previousReasons = context.previousRejectReasons
  const followUpCriterion =
    previousReasons.length > 0
      ? `critic reject 원인 해결: ${previousReasons.join(", ")}`
      : "핵심 시나리오 테스트 통과"

  const deliberate = context.riskLevel === "high"
    ? {
      preMortem: [
        "데이터 정합성 손상 가능성",
        "권한/보안 경계 누락 가능성",
        "배포 후 롤백 지연 가능성",
      ],
      expandedTestPlan: {
        unit: ["핵심 함수 경계 조건 테스트 추가"],
        integration: ["워크플로우 단계 연계 테스트 추가"],
        e2e: ["샘플 요구사항 E2E 실행"],
        observability: ["실패 코드/재시도 로그 필드 검증"],
      },
    }
    : undefined

  return {
    principles: ["단순함 우선", "검증 가능성", "운영 안정성"],
    decisionDrivers: [
      "구현 속도",
      "리스크 제어",
      "재현 가능한 검증",
    ],
    alternatives: [
      {
        id: "minimal-copy",
        summary: "참조 구현을 최소 이식하고 불필요 기능을 제거한다.",
        pros: ["빠른 납기", "검증된 패턴 재사용"],
        cons: ["초기 구조 적응 필요"],
      },
      {
        id: "greenfield",
        summary: "모든 컴포넌트를 신규 설계로 구현한다.",
        pros: ["설계 자유도"],
        cons: ["초기 제작 속도 저하", "검증 비용 증가"],
      },
    ],
    selectedOptionId: "minimal-copy",
    acceptanceCriteria: [
      "필수 기능 범위가 PRD와 일치한다",
      followUpCriterion,
    ],
    verificationPlan: [
      "단위 테스트 실행",
      "타입체크 실행",
      "빌드 실행",
    ],
    handoff: {
      currentStatus: "draft_ready",
      changedFiles: [],
      openRisks: [],
      nextAction: "request architecture review",
    },
    ...(deliberate ? { deliberate } : {}),
  }
}

export function createDefaultPlanningArchitectReview(context: PlanningLoopContext & { draft: PlanningDraft }): ArchitectReview {
  return {
    antithesis: `선택안(${context.draft.selectedOptionId})은 단기 속도는 빠르지만 장기 확장성 위험이 있다.`,
    tradeoffTension: "초기 납기 속도와 중장기 유지보수 안정성은 동시에 극대화할 수 없다.",
    synthesis: "핵심 경로는 최소 이식으로 진행하고 확장 포인트만 계약 기반으로 분리한다.",
    handoff: {
      currentStatus: "architecture_reviewed",
      changedFiles: [],
      openRisks: [],
      nextAction: "run critic gate",
    },
  }
}

export function createDefaultPlanningCriticReview(context: CriticReviewContext): CriticReview {
  if (context.riskLevel === "high") {
    if (!context.draft.deliberate) {
      return {
        decision: "reject",
        reasons: ["high-risk input requires deliberate output"],
        handoff: {
          currentStatus: "reject",
          changedFiles: [],
          openRisks: ["high risk draft missing deliberate plan"],
          nextAction: "revise draft with deliberate section",
        },
      }
    }

    if (context.draft.deliberate.preMortem.length < 3) {
      return {
        decision: "reject",
        reasons: ["high-risk deliberate output requires at least 3 preMortem scenarios"],
        handoff: {
          currentStatus: "reject",
          changedFiles: [],
          openRisks: ["insufficient preMortem coverage"],
          nextAction: "expand deliberate preMortem scenarios",
        },
      }
    }
  }

  if (context.validationErrors.length > 0) {
    return {
      decision: "reject",
      reasons: context.validationErrors,
      handoff: {
        currentStatus: "reject",
        changedFiles: [],
        openRisks: [...context.validationErrors],
        nextAction: "fix validation errors and retry planning",
      },
    }
  }

  return {
    decision: "approve",
    handoff: {
      currentStatus: "approve",
      changedFiles: [],
      openRisks: [],
      nextAction: "emit ADR and proceed to issue stage",
    },
  }
}

function buildAdr(input: PlanningInput, draft: PlanningDraft, architect: ArchitectReview): AdrRecord {
  const selected = draft.alternatives.find((item) => item.id === draft.selectedOptionId)
  const alternativeSummaries = draft.alternatives.map((item) => `${item.id}: ${item.summary}`)
  const riskLevel = classifyPlanningRisk(input)

  return {
    decision: selected?.summary ?? `선택 옵션: ${draft.selectedOptionId}`,
    drivers: [...draft.decisionDrivers],
    alternatives: alternativeSummaries,
    whyChosen: architect.synthesis ?? architect.tradeoffTension,
    consequences: [
      `문제 범위(${input.problem})에 대해 단계적 구현을 적용한다.`,
      "Critic 게이트 기준을 충족하지 못하면 재계획한다.",
      `위험도: ${riskLevel}`,
      ...(draft.deliberate ? ["deliberate 계획(preMortem + expanded tests)을 함께 실행한다."] : []),
    ],
    followUps: [
      ...draft.verificationPlan,
      "PR 본문에 ADR 결정 근거를 요약한다.",
    ],
  }
}

export async function runConsensusPlanning(
  input: PlanningInput,
  options: ConsensusPlanningOptions = {},
): Promise<ConsensusPlanningResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const contractRetries = options.contractRetries ?? DEFAULT_CONTRACT_RETRIES
  const hooks = {
    createDraft: options.hooks?.createDraft ?? createDefaultPlanningDraft,
    reviewArchitecture:
      options.hooks?.reviewArchitecture ?? createDefaultPlanningArchitectReview,
    reviewCritic: options.hooks?.reviewCritic ?? createDefaultPlanningCriticReview,
  }

  let previousRejectReasons: string[] = []
  const history: ConsensusPlanningResult["history"] = []
  const artifactName = resolveArtifactName(input, options.artifactName)
  const riskLevel = classifyPlanningRisk(input)

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const loopContext: PlanningLoopContext = {
      input,
      iteration,
      riskLevel,
      previousRejectReasons,
    }

    const draftParse = await parseWithRuntimeContractRetry({
      role: "plan",
      retries: contractRetries,
      producer: () => hooks.createDraft(loopContext),
      validate: validatePlanningDraftOutput,
    })
    if (!draftParse.ok || !draftParse.value) {
      return contractRejectResult({
        iteration,
        code: draftParse.error?.code ?? "schema_validation_failed",
        details: draftParse.error?.details ?? ["plan output contract validation failed"],
      })
    }
    const draft = draftParse.value
    const validationErrors = validateDraft(draft)
    const planEnvelope = buildRoleOutputEnvelope({
      role: "plan",
      payload: draft,
      handoff: draft.handoff,
      attempts: draftParse.attempts,
      maxAttempts: contractRetries + 1,
      decision: "draft_ready",
      evidence: [
        `alternatives=${String(draft.alternatives.length)}`,
        `drivers=${String(draft.decisionDrivers.length)}`,
      ],
    })

    const architectParse = await parseWithRuntimeContractRetry({
      role: "architect",
      retries: contractRetries,
      producer: () => hooks.reviewArchitecture({
        ...loopContext,
        draft,
      }),
      validate: validateArchitectReviewOutput,
    })
    if (!architectParse.ok || !architectParse.value) {
      return contractRejectResult({
        iteration,
        code: architectParse.error?.code ?? "schema_validation_failed",
        details: architectParse.error?.details ?? ["architect output contract validation failed"],
      })
    }
    const architect = architectParse.value
    const architectEnvelope = buildRoleOutputEnvelope({
      role: "architect",
      payload: architect,
      handoff: architect.handoff,
      attempts: architectParse.attempts,
      maxAttempts: contractRetries + 1,
      decision: "review_ready",
      evidence: [architect.tradeoffTension],
    })

    const criticParse = await parseWithRuntimeContractRetry({
      role: "critic",
      retries: contractRetries,
      producer: () => hooks.reviewCritic({
        ...loopContext,
        draft,
        architect,
        validationErrors,
      }),
      validate: validateCriticReviewOutput,
    })
    if (!criticParse.ok || !criticParse.value) {
      return contractRejectResult({
        iteration,
        code: criticParse.error?.code ?? "schema_validation_failed",
        details: criticParse.error?.details ?? ["critic output contract validation failed"],
      })
    }
    const critic = criticParse.value
    const criticEnvelope = buildRoleOutputEnvelope({
      role: "critic",
      payload: critic,
      handoff: critic.handoff,
      attempts: criticParse.attempts,
      maxAttempts: contractRetries + 1,
      decision: critic.decision,
      reasons: critic.decision === "reject" ? critic.reasons : [],
      evidence: critic.decision === "reject" ? critic.reasons : ["critic approved"],
    })

    if (critic.decision === "approve" && validationErrors.length === 0) {
      const adr = buildAdr(input, draft, architect)
      if (options.workspaceRoot) {
        await persistPlanningArtifacts(options.workspaceRoot, artifactName, {
          loopContext,
          draft,
          architect,
          critic,
          roleOutputs: {
            plan: planEnvelope,
            architect: architectEnvelope,
            critic: criticEnvelope,
          },
          validationErrors,
          status: "approved",
          adr,
        })
      }

      return {
        status: "approved",
        iterations: iteration,
        history: [
          ...history,
          {
            iteration,
            decision: "approve",
            reasons: [],
          },
        ],
        adr,
        lastRejectReasons: [],
      }
    }

    if (options.workspaceRoot) {
      await persistPlanningArtifacts(options.workspaceRoot, artifactName, {
        loopContext,
        draft,
        architect,
        critic,
        roleOutputs: {
          plan: planEnvelope,
          architect: architectEnvelope,
          critic: criticEnvelope,
        },
        validationErrors,
        status: "rejected",
      })
    }

    const rejectReasons =
      critic.decision === "reject" ? critic.reasons : validationErrors

    history.push({
      iteration,
      decision: "reject",
      reasons: rejectReasons,
    })
    previousRejectReasons = rejectReasons
  }

  return {
    status: "rejected",
    iterations: maxIterations,
    history,
    lastRejectReasons: previousRejectReasons,
  }
}
