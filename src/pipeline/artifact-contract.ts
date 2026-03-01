import type { WorkflowStage } from "./stages.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isLikelyFilePath(value: string): boolean {
  const normalized = value.trim()
  return normalized.length > 0 && !normalized.endsWith("/")
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function validateHandoff(value: unknown, scope: string): string[] {
  const errors: string[] = []
  if (!isRecord(value)) {
    return [`${scope}.handoff must be an object`]
  }

  if (!isNonEmptyString(value.currentStatus)) {
    errors.push(`${scope}.handoff.currentStatus must be a non-empty string`)
  }
  if (!isStringArray(value.changedFiles)) {
    errors.push(`${scope}.handoff.changedFiles must be a string array`)
  }
  if (!isStringArray(value.openRisks)) {
    errors.push(`${scope}.handoff.openRisks must be a string array`)
  }
  if (!isNonEmptyString(value.nextAction)) {
    errors.push(`${scope}.handoff.nextAction must be a non-empty string`)
  }

  return errors
}

function validateDevelopmentExecution(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) {
    return ["development.developmentExecution must be an object"]
  }

  if (value.mode !== "script" && value.mode !== "dry_run") {
    errors.push("development.developmentExecution.mode must be script|dry_run")
  }

  if (value.scriptName !== null && !isNonEmptyString(value.scriptName)) {
    errors.push("development.developmentExecution.scriptName must be string|null")
  }

  if (!isStringArray(value.changedFiles)) {
    errors.push("development.developmentExecution.changedFiles must be string array")
  } else if (!value.changedFiles.every((item) => isLikelyFilePath(item))) {
    errors.push("development.developmentExecution.changedFiles must contain file paths only")
  }

  if (!isNonNegativeInteger(value.changeCount)) {
    errors.push("development.developmentExecution.changeCount must be non-negative integer")
  }

  return errors
}

export interface StageArtifactValidationResult {
  valid: boolean
  errors: string[]
}

export function validateStageArtifactContract(
  stage: WorkflowStage,
  artifacts: unknown,
): StageArtifactValidationResult {
  const errors: string[] = []

  if (!isRecord(artifacts)) {
    return {
      valid: false,
      errors: ["artifacts must be an object"],
    }
  }

  if (stage === "requirements") {
    if (!isNonEmptyString(artifacts.requirementsTask)) {
      errors.push("requirements.requirementsTask must be a non-empty string")
    }

    if (artifacts.systemInstructions !== undefined && typeof artifacts.systemInstructions !== "string") {
      errors.push("requirements.systemInstructions must be a string when provided")
    }

    if (artifacts.systemInstructionSource !== undefined && typeof artifacts.systemInstructionSource !== "string") {
      errors.push("requirements.systemInstructionSource must be a string when provided")
    }
  }

  if (stage === "planning") {
    if (!isNonEmptyString(artifacts.adrDecision)) {
      errors.push("planning.adrDecision must be a non-empty string")
    }

    if (!isStringArray(artifacts.adrDrivers) || artifacts.adrDrivers.length === 0) {
      errors.push("planning.adrDrivers must be a non-empty string array")
    }

    errors.push(...validateHandoff(artifacts.handoff, "planning"))
  }

  if (stage === "development") {
    if (!isNonEmptyString(artifacts.implementationPlan)) {
      errors.push("development.implementationPlan must be a non-empty string")
    }
    if (!isStringArray(artifacts.testingPlan)) {
      errors.push("development.testingPlan must be a string array")
    }
    errors.push(...validateDevelopmentExecution(artifacts.developmentExecution))
    errors.push(...validateHandoff(artifacts.handoff, "development"))
  }

  if (stage === "issue") {
    const issueNumber = artifacts.issueNumber
    const issueDraft = artifacts.issueDraft

    const hasIssueNumber = isPositiveInteger(issueNumber)
    let hasIssueDraft = false

    if (isRecord(issueDraft)) {
      hasIssueDraft = isNonEmptyString(issueDraft.title) && isNonEmptyString(issueDraft.body)
    }

    if (!hasIssueNumber && !hasIssueDraft) {
      errors.push("issue stage requires issueNumber or issueDraft(title/body)")
    }
  }

  if (stage === "testing") {
    if (typeof artifacts.verificationPassed !== "boolean") {
      errors.push("testing.verificationPassed must be boolean")
    }

    errors.push(...validateHandoff(artifacts.handoff, "testing"))
  }

  if (stage === "merge") {
    if (typeof artifacts.mergeReady !== "boolean") {
      errors.push("merge.mergeReady must be boolean")
    }

    errors.push(...validateHandoff(artifacts.handoff, "merge"))
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function assertStageArtifactContract(stage: WorkflowStage, artifacts: unknown): void {
  const result = validateStageArtifactContract(stage, artifacts)
  if (!result.valid) {
    throw new Error(`Invalid stage artifact contract for ${stage}: ${result.errors.join("; ")}`)
  }
}
