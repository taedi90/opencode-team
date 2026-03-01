# OpenCode Team

OpenAI-only 기반 멀티 에이전트 실무 워크플로우 플러그인입니다.

요구사항을 한 번 입력하면 기본 경로에서 `requirements -> planning -> issue -> development -> testing -> merge`를 실행하도록 설계되어 있습니다.

이 프로젝트는 `oh-my-opencode`를 개인 워크플로우에 맞게 단순화하고 개인화해서 사용하려는 목적에서 시작했습니다.
핵심 아이디어를 참고하되, 실제 운영에 필요한 기능만 남기는 scope-freeze 정책을 따릅니다.
세부 설계/운영 원칙은 `ARCHITECTURE.md`를 단일 기준으로 사용합니다.

## Acknowledgements
- 이 프로젝트는 `oh-my-opencode`의 워크플로우 아이디어를 참고해 개인 사용 목적에 맞게 재구성했습니다.
- Maintainer: Taesoo Kim (`@taedi90`)

## Quick Start
- 의존성 설치: `npm install`
- 설정/MCP bootstrap: `npm run cli -- install`
- 워크플로우 실행: `npm run cli -- run "implement #29 one-shot orchestrator"`
- 환경 진단: `npm run cli -- doctor --json`

## npm Install
- 전역 설치: `npm install -g opencode-team`
- 설치 후 도움말: `opencode-team --help`
- 1회 실행: `npx opencode-team --help`
- bootstrap: `opencode-team install`

## Slash Commands
- `/orchestrate <task>`: orchestrator one-shot 실행
- `/ultrawork <task>`: standalone ultrawork 실행
- `/ralph <task>`: standalone ralph loop 실행
- `/cancel --target <orchestrator|ultrawork|ralph>`: session mode 취소

추가 args:
- `--session <id>`: 모드 상태 세션 식별자 지정
- `--max-iterations <n>`: ralph max iteration 지정

## Keyword Routing
명시 slash command가 없으면 키워드 라우팅을 적용합니다.
- orchestrator: `orchestrate`
- ultrawork: `ultrawork`, `ulw`, `parallel`
- ralph: `ralph`, `끝까지`, `must complete`
- cancel: `cancel`, `stop`, `abort`

우선순위는 `명시 커맨드 > 키워드 > 기본(orchestrator)`입니다.

## Runtime Lifecycle
- pre-run: `.agent-guide/context` + `.agent-guide/memory` preload
- in-run: memory reference 로그 append
- post-run: context handoff 갱신 + memory 승격/정리

orchestrator 세션 상태:
- `.agent-guide/runtime/state/sessions/<sessionId>/orchestrator-state.json`
- `.agent-guide/runtime/state/sessions/<sessionId>/workflow-state.json`
- `orchestrator-state.json`의 `currentPhase`는 `requirements -> planning -> issue -> development -> testing -> merge` 전이를 기록

관련 로그:
- `.agent-guide/runtime/context-memory-log.jsonl`
- `.agent-guide/runtime/state/sessions/<sessionId>/*-state.json`

## MCP / Tool Policy
- install 단계에서 MCP manifest를 bootstrap 합니다.
- runtime에서 agent tool policy를 검사하며 위반 시 차단합니다.
- doctor에서 MCP manifest 및 tool policy 상태를 점검합니다.
- `researcher` 역할은 기본적으로 `web_search`/`context7` 계열 도구를 허용하고, `bash`/`write`/`edit`/`github`는 차단합니다.

## Verification
- 테스트: `npm test`
- 타입체크: `npm run typecheck`
- 빌드: `npm run build`
- 릴리스 게이트: `npm run release:gate`
- 신뢰성 반복검증: `npm run e2e:reliability -- --iterations 10`

기본 testing stage는 `testingPlan`에 기록된 명령(예: `npm test`, `npm run typecheck`, `npm run build`)을 실제로 실행하고 실패 시 워크플로우를 중단합니다.
보안/재현성 유지를 위해 기본 허용 검증 명령은 `npm test`, `npm run typecheck`, `npm run build`, `npm run release:gate`로 제한됩니다.

자동 PR 경로는 merge 단계에서 로컬 git 브랜치 준비(`checkout -B`, `add/commit`, `push`)가 가능해야 하며,
로컬 변경이 없거나 git 저장소가 아니면 명시적 오류로 실패합니다.

기본 development stage는 git 저장소 + `package.json` 환경에서 개발 스크립트가 필요합니다.
- 우선순위: `opencode:develop` -> `develop:opencode` -> `develop`
- 스크립트가 없으면 development stage는 실패합니다.
- 기본 엔트리: `scripts/develop/index.mjs`
- 수동 실행 예시: `OPENCODE_TASK="implement #101" npm run opencode:develop`
- 스크립트가 파일 변경을 만들지 못하면 no-op으로 실패합니다.

세션 동시 실행 방지를 위해 session lock을 사용하며, stale lock은 TTL(기본 30분) 기준으로 자동 복구합니다.

## Docs
- 아키텍처/운영 설계 기준: `ARCHITECTURE.md`
- 사용자 가이드: `docs/user-guide.md`
- 릴리스 게이트: `docs/release-gate-checklist.md`
- 실경로 E2E 증적: `docs/e2e-evidence.md`
- 운영 runbook: `docs/operations-runbook.md`
- Go/No-Go 템플릿: `docs/go-no-go-template.md`
