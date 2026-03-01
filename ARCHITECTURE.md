# Architecture

## 1) Purpose
- 이 문서는 프로젝트의 단일 설계 기준 문서다.
- 제품 목표, 시스템 구조, 운영 정책, 확장 제한(scope freeze), 검증 기준을 함께 정의한다.
- 구현/운영 의사결정은 이 문서와 `AGENTS.md`를 기준으로 수행한다.
- 프로젝트 방향은 `oh-my-opencode`의 워크플로우 아이디어를 참고해 개인 사용 흐름에 맞게 단순화/개인화하는 데 둔다.

## 2) Product Goal
- OpenAI-only 멀티 에이전트 워크플로우 하네스를 제공한다.
- 사용자 입력 1회로 `requirements -> planning -> issue -> development -> testing -> merge`를 일관되게 실행한다.
- `ultrawork`(병렬 실행)와 `ralph loop`(완료 보장 반복)를 코어 실행 축으로 유지한다.
- 계획 단계는 `planner -> architect -> critic` 합의 루프와 ADR 산출을 강제한다.

## 3) Non-Goals
- 멀티 벤더 모델 라우팅/폴백 체인
- 대규모 명령 템플릿 레지스트리 확장
- 엔터프라이즈 다중 사용자 운영(RBAC, 조직 정책 엔진)
- 실시간 대시보드/메트릭 파이프라인 추가

## 4) Runtime Surface
- `install`: 사용자/프로젝트 설정 초기화 + MCP bootstrap
- `run`: 명령/키워드 라우팅 후 orchestrator 또는 mode 실행
- `doctor`: 설정/도구/인증/MCP 상태 점검(JSON/텍스트)

## 5) System Layers
- `src/config`
  - user/project 설정 병합
  - OpenAI-only 모델 정책
  - `merge_policy.require_user_approval` boolean 정책
- `src/agents`
  - 역할 카탈로그, 티어/모델/effort 라우팅
  - orchestrator, plan, architect, critic, researcher, developer, tester, reviewer
- `src/planning`
  - 합의형 플래닝 엔진(정/반/합)
  - ADR 생성 및 deliberate 모드 검증
- `src/pipeline`
  - 6단계 오케스트레이터
  - stage artifact 계약 검증, 상태 저장/재개
- `src/execution`
  - `ultrawork`: DAG/wave 병렬 실행
  - `ralph-loop`: 완료 조건 반복 검증/재시도
- `src/github`
  - issue/branch/PR/merge 자동화
  - retry/backoff/idempotency/정책 로그
- `src/runtime`
  - mode state/cancel contract
  - session lock + stale lock TTL 복구
  - context/memory lifecycle
- `src/plugin`, `src/cli`
  - plugin 인터페이스 + slash/keyword 라우팅
  - CLI 엔트리 제공

## 6) Workflow Architecture

### 6.1 Stages
- `requirements`
  - 요구사항/제약/DoD를 구조화
- `planning`
  - planner 초안 -> architect 반론 -> critic 게이트
  - 필요 시 재루프(최대 반복)
  - ADR 산출
- `issue`
  - GitHub issue 생성 및 추적 키 확보
- `development`
  - 기본 development script 실행(`opencode:develop` 우선)
  - `developmentExecution` artifact 생성
  - committable 변경이 없으면 실패(no-op 방지)
- `testing`
  - allowlist 명령만 실행
  - 실패 즉시 중단
- `merge`
  - 브랜치 준비, PR 생성, 정책 기반 merge

### 6.2 Stage Gate
- stage 산출물은 계약 검증을 통과해야 다음 단계로 전이한다.
- 계약 위반은 `schema_validation_failed`로 즉시 실패 처리한다.

## 7) Planning Model (Consensus)
- 순서: planner -> architect -> critic (순차 강제)
- architect 책임: antithesis, tradeoff tension, synthesis
- critic 책임: 승인/반려 판단 + 반려 근거
- 결과물: ADR(Decision/Drivers/Alternatives/Why/Consequences/Follow-ups)
- 고위험 입력은 deliberate 모드(pre-mortem + expanded tests)를 강제한다.

## 8) Mode System

### 8.1 Modes
- `orchestrator`: 전체 파이프라인 제어
- `ultrawork`: 병렬 작업 분해/실행
- `ralph`: 완료 조건 기반 반복 검증
- `cancel`: target mode 취소

### 8.2 State and Session
- 세션별 상태 파일 경로:
  - `.agent-guide/runtime/state/sessions/<sessionId>/workflow-state.json`
  - `.agent-guide/runtime/state/sessions/<sessionId>/<mode>-state.json`
- resume는 기존 상태를 기준으로 실패 지점부터 재개한다.

### 8.3 Concurrency Safety
- 동일 session 동시 실행은 session lock으로 차단한다.
- stale lock은 TTL(기본 30분) 기준 자동 복구한다.

## 9) Contracts
- stage artifact contract
- mode state contract
- cancel contract
- runtime role output contract
- mcp bootstrap contract
- mcp doctor contract
- agent tool policy contract

모든 계약은 테스트로 고정하고, 위반 시 실패를 기본 동작으로 한다.

## 10) MCP and Tool Governance
- install 단계에서 MCP manifest/bootstrap 생성
- 런타임에서 agent별 allow/deny 정책 강제
- `doctor`에서 필수 서버 reachability 및 policy 유효성 점검
- researcher role은 웹 리서치 계열 도구 허용, 쓰기/시스템 도구 기본 차단

## 11) Merge Policy
- 단일 설정 키: `merge_policy.require_user_approval` (boolean)
  - `true`(기본): 사용자 승인 필요
  - `false`: green 시 자동 merge 허용
- 문자열 모드(`merge_policy.mode`)는 지원하지 않는다.

## 12) Reliability and Safety
- retry/backoff: 네트워크/GitHub transient 오류 대응
- idempotency: issue/PR 중복 실행 방지
- safe staging: generated/non-code untracked 파일 자동 제외
- atomic write: 상태 파일 손상 방지
- structured logging: stage/mode/error/retry 추적

## 13) Context and Memory Lifecycle
- pre-run: context + memory preload
- in-run: 근거 경로/적용 이유 기록
- post-run: handoff 갱신 + memory 승격/정리

## 14) Scope Freeze Rules

### 14.1 Keep
- `install/run/doctor` 실행 표면
- 6단계 workflow + `ultrawork` + `ralph`
- 세션 락, 검증 allowlist, retry/backoff, 계약 테스트

### 14.2 Do Not Add Now
- 멀티 벤더 모델 추상화
- 대규모 명령 템플릿 레지스트리
- 고급 스케줄러/실시간 대시보드
- 복잡한 권한 계층

### 14.3 Out of Scope
- 특정 레퍼런스와 1:1 기능 동등성 추구
- 엔터프라이즈 다중 사용자 운영
- 마켓플레이스 중심 확장 기능

## 15) Delivery Roadmap

### Phase A (Foundation)
- config/agent/contracts/runtime surface 고정

### Phase B (Workflow Core)
- planning/pipeline/execution/github 경로 실동작화

### Phase C (Operations)
- doctor/release gate/reliability loop/runbook/Go-NoGo 정착

### Phase D (Hardening)
- 실패 주입 검증, 운영 지표 고도화, 문서-동작 정합 유지

## 16) Verification and Release Criteria
- 필수 검증:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `npm run release:gate`
- 운영 검증:
  - `npm run e2e:reliability -- --iterations 10`
  - 성공률/실패 유형/복구 절차를 Go/No-Go 템플릿에 기록

## 17) Issue Management Policy
- 모든 구현 작업은 GitHub issue를 기준으로 진행한다.
- issue에는 배경/범위/DoD/검증 계획을 반드시 포함한다.
- PR에는 `Closes #<issue>`를 포함한다.
