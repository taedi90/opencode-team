# MCP Bootstrap Contract

## 목적
- 설치 단계에서 MCP 실행 준비 정보를 일관된 manifest로 생성한다.

## 생성 경로
- `.agent-guide/runtime/mcp/manifest.json`

## Manifest 스키마
- `version: 1`
- `generated_at: ISO8601 string`
- `config_paths`
  - `user_path: string`
  - `project_path: string`
- `servers: Record<string, McpManifestServer>`

`McpManifestServer`
- `name: string`
- `enabled: boolean`
- `required: boolean`
- `command: string`
- `args: string[]`
- `source: "merged_config"`

## 부트스트랩 규칙
1. install 단계에서 user config와 project config를 병합한 결과를 기준으로 manifest를 생성한다.
2. manifest가 없으면 생성(`created=true`)한다.
3. manifest가 있고 내용이 변경되면 갱신(`updated=true`)한다.
4. 내용이 동일하면 파일을 유지(`created=false`, `updated=false`)한다.

## 구현
- 코드: `src/runtime/mcp-bootstrap.ts`
- API:
  - `buildMcpManifest`
  - `bootstrapMcpManifest`
  - `ensureMcpBootstrap`
