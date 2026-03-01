# Stage Artifact Contract

## 목적
- workflow stage 산출물 최소 스키마를 고정해 단계 간 입력/출력 계약을 검증 가능하게 만든다.

## stage별 최소 산출물

공통 optional:
- `agentRuns: AgentRun[]`
  - role/session/model/tier/decision/status/handoff/evidence를 포함한 역할 실행 로그

### requirements
- `requirementsTask: string (non-empty)`
- optional:
  - `systemInstructions: string`
  - `systemInstructionSource: string`
  - `researchContext: string[]`

### planning
- `adrDecision: string (non-empty)`
- `adrDrivers: string[] (non-empty)`

### issue
아래 중 하나는 반드시 있어야 한다.
- `issueNumber: positive integer`
- `issueDraft: { title: string, body: string }`

### development
- 필수:
  - `implementationPlan: string (non-empty)`
  - `testingPlan: string[]`
  - `developmentExecution: { mode, scriptName, changedFiles, changeCount }`
  - `handoff: runtime handoff`
- optional:
  - `documentationSync: { role, summary, updatedDocs, reportPath, sourceOfTruth }`

### testing
- `verificationPassed: boolean`

### merge
- `mergeReady: boolean`

## 검증 구현
- 코드: `src/pipeline/artifact-contract.ts`
- validator:
  - `validateStageArtifactContract`
  - `assertStageArtifactContract`
