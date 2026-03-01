# Mode State Contract

## 목적
- `orchestrator`, `ultrawork`, `ralph` 실행 상태를 세션 범위에서 일관되게 저장/검증한다.

## 저장 경로
- 세션 스코프 기준 경로:
  - `.agent-guide/runtime/state/sessions/{sessionId}/{mode}-state.json`
- mode 값:
  - `orchestrator`
  - `ultrawork`
  - `ralph`

## 공통 필수 필드
- `version: 1`
- `mode: "orchestrator" | "ultrawork" | "ralph"`
- `sessionId: string (non-empty)`
- `active: boolean`
- `currentPhase: string`
- `startedAt: ISO8601 string`
- `updatedAt: ISO8601 string`

## 선택 필드
- `completedAt?: ISO8601 string`
- `iteration?: number (positive integer)`
- `maxIterations?: number (positive integer)`
- `linkedMode?: "orchestrator" | "ultrawork" | "ralph"`
- `linkedModeTerminalPhase?: "complete" | "failed" | "cancelled"`
- `linkedModeTerminalAt?: ISO8601 string`

## Phase Vocabulary (고정)
- orchestrator:
  - `starting`, `requirements`, `planning`, `issue`, `development`, `testing`, `merge`, `complete`, `failed`, `cancelled`
- ultrawork:
  - `starting`, `scheduling`, `executing`, `verifying`, `complete`, `failed`, `cancelled`
- ralph:
  - `starting`, `executing`, `verifying`, `fixing`, `complete`, `failed`, `cancelled`

## 무결성 규칙
1. terminal phase(`complete|failed|cancelled`)이면 반드시 `active=false`이고 `completedAt`이 있어야 한다.
2. `active=true` 상태는 `completedAt`을 가지면 안 된다.
3. `iteration`/`maxIterations`가 있으면 둘 다 양의 정수여야 하며 `iteration <= maxIterations`여야 한다.
4. `ralph`가 `active=true`이면 `iteration`, `maxIterations`는 필수다.
5. `linkedMode`는 `mode`와 같을 수 없다.

## 검증 구현
- 코드: `src/runtime/mode-state-contract.ts`
- validator:
  - `validateModeStateContract`
  - `assertModeStateContract`
- 경로 resolver:
  - `resolveModeStateFilePath`
