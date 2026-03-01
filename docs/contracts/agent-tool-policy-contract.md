# Agent Tool Policy Contract

## 목적
- agent별 tool 사용 가능 범위를 allowlist/denylist로 명시하고, 런타임에서 강제한다.

## 정책 소스
- `default`: 내장 기본 정책
- `config`: 사용자/프로젝트 설정에서 override된 정책

## 평가 입력
- `agentRole: string`
- `toolName: string`
- optional: `config`

## 평가 결과(`ToolAccessDecision`)
- `allowed: boolean`
- `reason_code`
  - `allowed`
  - `agent_unknown`
  - `tool_not_allowed`
  - `tool_explicitly_denied`
- `agent: string`
- `tool: string (normalized lowercase)`
- `policy_source: "default" | "config"`
- `evaluated_at: ISO8601 string`

## 강제 규칙
1. unknown agent는 거부한다(`agent_unknown`).
2. denylist에 있으면 allowlist보다 우선해서 거부한다(`tool_explicitly_denied`).
3. allowlist에 없으면 거부한다(`tool_not_allowed`).
4. 허용 조건 충족 시만 실행 가능하다(`allowed`).

## 감사 로그 필드
- 기본 decision 필드 전체
- optional:
  - `session_id`
  - `stage`

## 구현
- 코드: `src/runtime/agent-tool-policy.ts`
- API:
  - `resolveAgentToolPolicy`
  - `evaluateToolAccess`
  - `createToolPolicyAuditLog`
