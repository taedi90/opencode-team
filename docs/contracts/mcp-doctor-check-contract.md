# MCP Doctor Check Contract

## 목적
- `doctor` 단계에서 MCP 준비 상태와 agent tool 정책 유효성을 일관된 결과 포맷으로 진단한다.

## 결과 타입
`McpDoctorCheckResult`
- `name`
  - `mcp_manifest_exists`
  - `mcp_required_servers_configured`
  - `mcp_required_servers_enabled`
  - `mcp_required_servers_reachable`
  - `agent_tool_policy_valid`
- `status: "pass" | "warn" | "fail"`
- `detail: string`

## 입력
`EvaluateMcpDoctorChecksInput`
- `config: OpenCodeTeamConfig`
- `manifestExists: boolean`
- optional: `reachableServers: string[]`

## 판정 규칙
1. manifest가 없으면 `mcp_manifest_exists=fail`.
2. required stdio server command 누락 또는 required remote server URL 누락/형식 오류 시 `mcp_required_servers_configured=fail`.
3. required server disabled면 `mcp_required_servers_enabled=fail`.
4. reachability 미검사면 `mcp_required_servers_reachable=warn`.
5. reachability 검사 결과 required+enabled 서버 중 미도달 항목이 있으면 `mcp_required_servers_reachable=fail`.
6. role별 allowlist가 비어 있으면 `agent_tool_policy_valid=fail`.

## 구현
- 코드: `src/runtime/mcp-doctor-contract.ts`
- API:
  - `evaluateMcpDoctorChecks`
