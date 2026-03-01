# 사용자 가이드

이 문서는 실무 전환 버전 기준으로 `install/run/doctor`, slash command, context/memory lifecycle, cancel/resume 운영을 설명합니다.

범위 정책:
- 이 프로젝트는 `oh-my-opencode`의 아이디어를 참고해 개인 워크플로우에 맞게 단순화한 구성입니다.
- 개인 실사용 안정성에 직접 필요한 기능만 유지하며, 과도한 확장은 보류합니다.
- 기준 문서: `ARCHITECTURE.md`

## 1) 설치
1. `npm install`
2. `npm run cli -- install`

npm 패키지 방식:
- 전역 설치: `npm install -g opencode-team`
- 단발 실행: `npx opencode-team install`

설치 결과:
- 사용자 설정: `~/.config/opencode/opencode-team.json`
- OpenCode 플러그인 등록: `~/.config/opencode/opencode.json` (`plugin` 배열에 `opencode-team@latest` 추가)
- 프로젝트 MCP manifest: `.agent-guide/runtime/mcp/manifest.json`
- 프로젝트 오버라이드 설정 위치: `.opencode/opencode-team.json` (사용자 설정보다 우선)

## 2) 원샷 orchestrator
- 실행: `npm run cli -- run "/orchestrate implement #29 production plugin"`
- 기본 단계: `requirements -> planning -> issue -> development -> testing -> merge`
- testing 단계는 `testingPlan` 명령을 실제 작업 디렉터리에서 실행하며, 명령 실패 시 즉시 실패로 종료됩니다.
- 기본 허용 검증 명령은 `npm test`, `npm run typecheck`, `npm run build`, `npm run release:gate`입니다.
- git 저장소 + `package.json` 환경에서는 development 스크립트(`opencode:develop`/`develop:opencode`/`develop`)가 필수입니다.
- 기본 스크립트 엔트리: `scripts/develop/index.mjs`
- 수동 실행 예시: `OPENCODE_TASK="implement #29" npm run opencode:develop`
- development 스크립트가 committable 파일 변경을 만들지 못하면 실패합니다.
- development 단계는 documenter 동기화 리포트를 생성하며 경로는 `.agent-guide/docs/documentation-sync.md`입니다.

planning 단계는 planner/architect/critic 루프를 거치며, 고위험 입력은 deliberate 출력(pre-mortem + expanded tests)을 강제합니다.

## 3) Slash / Keyword 라우팅
### Slash
- `/orchestrate`
- `/ultrawork`
- `/ralph`
- `/cancel`

### Keyword
- orchestrate
- ultrawork | ulw | parallel
- ralph | 끝까지 | must complete
- cancel | stop | abort

우선순위: `명시 slash > keyword`.

## 4) ultrawork / ralph / cancel / resume
### ultrawork
- 예시: `npm run cli -- run "/ultrawork --session sprint-12 parallel implementation"`

### ralph
- 예시: `npm run cli -- run "/ralph --session sprint-12 --max-iterations 5 completion gate"`

### cancel
- 예시: `npm run cli -- run "/cancel --session sprint-12 --target ralph"`
- linked mode 정책에 따라 동일 session 내 하위 모드 정리 순서를 적용합니다.

### resume
- 예시: `npm run cli -- run "/orchestrate implement #30" --resume`
- workflow state와 mode state를 기준으로 이어서 실행합니다.
- 이미 terminal 상태(`complete|failed|cancelled`)인 동일 session orchestrator는 재실행 대신 terminal 결과를 반환합니다.
- orchestrator state의 `currentPhase`로 현재 stage 전이를 확인할 수 있습니다.
- session lock으로 동일 session 동시 실행을 차단하며, stale lock은 기본 30분 TTL 기준으로 정리됩니다.

## 5) Context / Memory Lifecycle
자동화 규칙:
- pre-run: 현재 이슈 context 및 memory 로드
- in-run: memory 참조 경로 + 적용 이유 기록
- post-run: context handoff 갱신, 승격 기준 충족 시 memory 업데이트, 임시 context cleanup

관련 파일:
- `.agent-guide/context/issue-*.md`
- `.agent-guide/memory/memory-*.md`
- `.agent-guide/runtime/context-memory-log.jsonl`

## 6) Merge Policy
설정 파일(`opencode-team.json`)의 `merge_policy.require_user_approval`(boolean)로 동작합니다.
- `true` (기본): 사용자 승인 필요
- `false`: green 상태에서 자동 머지 허용

`merge_policy.mode` 문자열 설정은 지원하지 않습니다.

설정 병합 우선순위:
- 사용자 설정: `~/.config/opencode/opencode-team.json`
- 프로젝트 설정: `.opencode/opencode-team.json` (우선 적용)

자동 PR/merge 경로 전제:
- 작업 디렉터리가 git 저장소여야 함
- merge 단계에서 브랜치 생성/커밋/원격 push가 가능해야 함
- 로컬 변경이 없으면 PR 생성 대신 merge stage 실패로 종료

development 산출물 계약:
- `developmentExecution.mode`: `script|dry_run`
- `developmentExecution.scriptName`: 실행한 스크립트 이름 또는 `null`
- `developmentExecution.changedFiles`: 파일 경로 배열(디렉터리 경로 금지)
- `developmentExecution.changeCount`: 변경 파일 수

merge 판단 로그:
- `.agent-guide/runtime/merge-policy-log.jsonl`

## 7) MCP / Tool Policy
- install 시 MCP bootstrap/manifest를 생성합니다.
- run 시 tool policy 위반은 실행 전에 차단합니다.
- doctor로 MCP manifest 및 policy 유효성을 확인합니다.
- 기본 `researcher` role은 웹 리서치용으로 `web_search`, `context7` 도구를 허용합니다.
- 기본 `documenter` role은 `README.md`, `ARCHITECTURE.md`, `docs/**/*.md` 동기화 책임을 가지며 `bash`, `github`는 차단됩니다.

## 8) 진단
- 텍스트: `npm run cli -- doctor`
- JSON: `npm run cli -- doctor --json`

## 9) 운영 체크리스트
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run release:gate`
- `npm run e2e:reliability -- --iterations 10`

E2E 반복 검증 결과는 `.agent-guide/runtime/reports/e2e-reliability-<timestamp>.json`에 저장됩니다.

## 10) 트러블슈팅
- 라우팅이 기대와 다를 때
  - slash command가 있으면 항상 slash가 우선한다.
  - keyword만 있을 때 텍스트에 mode 키워드가 포함됐는지 확인한다.

- cancel이 동작하지 않을 때
  - `--session` 값이 mode 실행과 동일한지 확인한다.
  - 대상 mode state 파일이 active 상태인지 확인한다.

- doctor fail일 때
  - MCP manifest 경로/내용 확인
  - agent tool policy의 allow/deny 형식 확인

추가 운영 문서:
- `docs/operations-runbook.md`
- `docs/go-no-go-template.md`
