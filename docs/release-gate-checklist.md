# Release Gate Checklist

## 필수 시나리오
- `npm test`가 통과해야 한다.
- `npm run typecheck`가 통과해야 한다.
- `npm run build`가 통과해야 한다.
- `npm run release:gate`가 통과해야 한다.
- 원샷 orchestrator 흐름에서 `requirements -> planning -> issue -> development -> testing -> merge`가 완료되어야 한다.

## CI 차단 규칙
- 필수 시나리오 중 하나라도 실패하면 CI를 실패 상태로 종료한다.
- release gate 검증은 `src/release-gate` 구현을 단일 소스로 사용하며, 문서/행동 계약 중 하나라도 실패하면 차단한다.
- behavior contract(`install --json`, `doctor --json`, `run --json`) 검증 실패 시 차단한다.
- runtime contract 테스트(`tests/role-prompts-contract.test.ts`, `tests/runtime-role-output-contract.test.ts`) 누락 시 차단한다.
- PR 본문에 `Closes #<issue>`가 없으면 머지 전 검증 단계에서 차단한다.

## 릴리스 노트
- 변경 요약 1~3개 bullet
- 검증 명령 및 결과
- 관련 이슈/PR 링크
- 운영 영향도(merge policy, MCP, lifecycle 변경 여부)
