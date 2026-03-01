import type { CoreAgentRole } from "../contracts/roles.js"

export type RuntimeContractErrorCode =
  | "schema_validation_failed"
  | "decision_invalid"
  | "handoff_missing"

export type RuntimeRole = CoreAgentRole

export interface RuntimeHandoff {
  currentStatus: string
  changedFiles: string[]
  openRisks: string[]
  nextAction: string
}

export interface RuntimeContractError {
  code: RuntimeContractErrorCode
  message: string
  details: string[]
}

export interface RuntimeValidationResult<T> {
  valid: boolean
  value?: T
  error?: RuntimeContractError
}

export interface RuntimeRetryResult<T> {
  ok: boolean
  attempts: number
  value?: T
  error?: RuntimeContractError
}

export interface ContractRetryPolicy {
  maxRetries: number
  nonRetriableCodes: RuntimeContractErrorCode[]
}

export interface RoleOutputEnvelope<T> {
  role: RuntimeRole
  status: "ok" | "error"
  decision: string
  reasons: string[]
  evidence: string[]
  payload: T
  handoff: RuntimeHandoff
  retry: {
    attempts: number
    maxAttempts: number
  }
  errorCode?: RuntimeContractErrorCode
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

export function validateRuntimeHandoff(value: unknown): RuntimeValidationResult<RuntimeHandoff> {
  if (!isRecord(value)) {
    return {
      valid: false,
      error: {
        code: "handoff_missing",
        message: "handoff must be an object",
        details: ["handoff is missing or invalid"],
      },
    }
  }

  const errors: string[] = []
  if (!isNonEmptyString(value.currentStatus)) {
    errors.push("handoff.currentStatus must be a non-empty string")
  }
  if (!isStringArray(value.changedFiles)) {
    errors.push("handoff.changedFiles must be a string array")
  }
  if (!isStringArray(value.openRisks)) {
    errors.push("handoff.openRisks must be a string array")
  }
  if (!isNonEmptyString(value.nextAction)) {
    errors.push("handoff.nextAction must be a non-empty string")
  }

  if (errors.length > 0) {
    return {
      valid: false,
      error: {
        code: "handoff_missing",
        message: "handoff contract validation failed",
        details: errors,
      },
    }
  }

  return {
    valid: true,
    value: {
      currentStatus: String(value.currentStatus),
      changedFiles: [...(value.changedFiles as string[])],
      openRisks: [...(value.openRisks as string[])],
      nextAction: String(value.nextAction),
    },
  }
}

function resolveRetryPolicy(retries: number, policy?: Partial<ContractRetryPolicy>): ContractRetryPolicy {
  return {
    maxRetries: Math.max(0, policy?.maxRetries ?? retries),
    nonRetriableCodes: policy?.nonRetriableCodes ?? [],
  }
}

function shouldRetryContractError(error: RuntimeContractError, attempt: number, policy: ContractRetryPolicy): boolean {
  if (policy.nonRetriableCodes.includes(error.code)) {
    return false
  }
  return attempt <= policy.maxRetries
}

export function buildRoleOutputEnvelope<T>(input: {
  role: RuntimeRole
  payload: T
  handoff: RuntimeHandoff
  attempts: number
  maxAttempts: number
  decision: string
  reasons?: string[]
  evidence?: string[]
  errorCode?: RuntimeContractErrorCode
}): RoleOutputEnvelope<T> {
  return {
    role: input.role,
    status: input.errorCode ? "error" : "ok",
    decision: input.decision,
    reasons: input.reasons ?? [],
    evidence: input.evidence ?? [],
    payload: input.payload,
    handoff: input.handoff,
    retry: {
      attempts: input.attempts,
      maxAttempts: input.maxAttempts,
    },
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  }
}

export async function parseWithRuntimeContractRetry<T>(input: {
  role: RuntimeRole
  retries: number
  producer: () => Promise<unknown> | unknown
  validate: (value: unknown) => RuntimeValidationResult<T>
  retryPolicy?: Partial<ContractRetryPolicy>
}): Promise<RuntimeRetryResult<T>> {
  const policy = resolveRetryPolicy(input.retries, input.retryPolicy)
  const maxAttempts = policy.maxRetries + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const output = await input.producer()
    const validation = input.validate(output)
    if (validation.valid && validation.value !== undefined) {
      return {
        ok: true,
        attempts: attempt,
        value: validation.value,
      }
    }

    const error = validation.error ?? {
      code: "schema_validation_failed",
      message: `runtime contract validation failed for role: ${input.role}`,
      details: ["unknown validation error"],
    }

    if (!shouldRetryContractError(error, attempt, policy) || attempt === maxAttempts) {
      return {
        ok: false,
        attempts: attempt,
        error,
      }
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    error: {
      code: "schema_validation_failed",
      message: `runtime contract validation failed for role: ${input.role}`,
      details: ["unexpected retry state"],
    },
  }
}
