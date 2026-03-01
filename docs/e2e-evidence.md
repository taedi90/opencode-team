# E2E Evidence

## 시나리오
- 요구사항 1회 입력으로 orchestrator 실행
- slash/keyword 라우팅 확인
- context/memory lifecycle 로그 확인

## 명령
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run cli -- run "/orchestrate implement #29 one-shot"`
- `npm run cli -- run "/ultrawork --session e2e-1 parallel implementation"`
- `npm run cli -- run "/ralph --session e2e-1 --max-iterations 3 verify completion"`
- `npm run cli -- run "/cancel --session e2e-1 --target ralph"`

## 결과
- 테스트/타입체크/빌드 통과
- run 결과에 `mode`, `source`, `stateFilePath`가 포함됨
- `.agent-guide/runtime/context-memory-log.jsonl`에 pre/post 이벤트 기록됨
- mode state 파일에 cancel/resume 관련 상태가 저장됨

## 근거
- `tests/pipeline-orchestrator.test.ts`
- `tests/command-routing.test.ts`
- `tests/context-memory-lifecycle.test.ts`
- `tests/mode-operations.test.ts`
