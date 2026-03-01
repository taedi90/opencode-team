# Orchestrator Subagent 전환 점검/개선 계획

## 1) 점검 목적
- 현재 구성에서 불필요한 요소와 잘못 연결된 지점을 식별한다.
- 요구사항(오케스트레이터가 서브에이전트를 실제 활용해 워크플로우를 이끌어야 함)을 만족하도록 작업 계획을 확정한다.

## 1.5) 실행 잠금 계획 (계획 종료, 구현 전용)
- 본 문서는 더 이상 확장하지 않는다. 신규 요구는 별도 이슈로 분리한다.
- 아래 `Execution Sprint`를 완료하기 전에는 아키텍처 변경 제안을 추가하지 않는다.
- 이번 스프린트 목표는 단 하나다: **가짜 role 호출 제거 + 실제 subagent executor 경유 실행 보장**.

### Execution Sprint (2일)
#### Checkpoint 1 - Fake Path 제거 (D1-AM)
- 범위:
  - `src/pipeline/agent-runtime.ts`
  - `src/pipeline/orchestrator.ts`
  - `tests/agent-runtime.test.ts` (신규)
- 작업:
  - `producer()` 기반 fallback 제거
  - `SubagentExecutor` 미주입 시 즉시 실패
  - 실패 테스트 3개 먼저 작성
    1) executor 미주입 실패
    2) executor 실패 원인 전파
    3) executor 결과 handoff 계약 검증
- 게이트:
  - `npm test -- tests/agent-runtime.test.ts`

#### Checkpoint 2 - Graph 단일 실행 경로 (D1-PM)
- 범위:
  - `src/pipeline/agent-graph.ts`
  - `src/pipeline/orchestrator.ts`
  - `tests/pipeline-orchestrator.test.ts`
- 작업:
  - role 실행 순서를 `WORKFLOW_STAGE_AGENT_GRAPH`에서만 읽도록 강제
  - role별 하드코딩 분기 제거
  - stage reducer 패턴으로 payload -> artifact 변환
- 게이트:
  - `npm test -- tests/pipeline-orchestrator.test.ts tests/agent-graph.test.ts`

#### Checkpoint 3 - Role 정책 강제 + 이력 보존 (D2-AM)
- 범위:
  - `src/runtime/agent-tool-policy.ts`
  - `src/plugin/create-plugin-interface.ts`
  - `src/pipeline/artifact-contract.ts`
  - `tests/agent-tool-policy.test.ts`
- 작업:
  - role 실행마다 allow/deny 정책 평가
  - deny 도구 시 즉시 실패
  - `agentRunsByStage` append-only 보존(덮어쓰기 금지)
- 게이트:
  - `npm test -- tests/agent-tool-policy.test.ts tests/stage-artifact-contract.test.ts`

#### Checkpoint 4 - Resume/State 최소 완성 (D2-PM)
- 범위:
  - `src/runtime/mode-state-contract.ts`
  - `src/pipeline/orchestrator.ts`
  - `tests/mode-state-contract.test.ts`
- 작업:
  - `currentNode` 기준 resume
  - `session_id` 노드별 저장/재사용
  - v1 -> v2 마이그레이션 보장
- 게이트:
  - `npm test -- tests/mode-state-contract.test.ts tests/pipeline-orchestrator.test.ts`

### Sprint 종료 조건 (필수)
- `npm test && npm run typecheck && npm run build && npm run release:gate` 통과
- 아래 4개가 동시에 참이어야 완료로 판정:
  1. executor 미경유 role 실행 0건
  2. role 정책 위반 미탐지 0건
  3. role 실행 이력 유실 0건
  4. resume 재개 실패 0건

## 2) 현재 상태 진단 요약
- 현재는 `stage-driven` 워크플로우 위에 role 래퍼를 얹은 상태다.
- `runWorkflowAgent`는 실제 서브에이전트 실행기가 아니라 로컬 `producer()` 결과를 envelope로 포장한다.
- role/model/tier가 기록되지만 실제 모델 호출 증거는 없다.
- 결론: "서브에이전트를 호출하는 형태"는 있으나 "서브에이전트 실행 런타임"은 미완성이다.

## 3) 불필요/잘못된 구성 체크리스트

### A. 필수 수정(요구사항 불충족)
1. 실제 서브에이전트 실행 경로 부재
   - 근거: `src/pipeline/agent-runtime.ts`의 `runWorkflowAgent`는 `producer()` 호출만 수행.
   - 영향: role/model routing이 동작해도 실제 하위 에이전트 실행이 일어나지 않음.

2. stage-agent 그래프 미사용
   - 근거: `src/pipeline/agent-graph.ts`의 `resolveStageAgentSequence`는 테스트 외 사용 없음.
   - 영향: 단일 진실 원천(SSOT) 부재, stage 코드와 그래프가 쉽게 어긋남.

3. 도구 정책이 서브에이전트 단위로 집행되지 않음
   - 근거: `src/plugin/create-plugin-interface.ts`에서 정책 평가는 실행 시작 시 `orchestrator` 1회만 수행.
   - 영향: `developer/tester/documenter/researcher` 역할별 allow/deny 정책이 실행 경로에서 실질 집행되지 않음.

4. role 실행 로그 누적 손실
   - 근거: stage artifacts 병합 시 `artifacts.agentRuns`가 stage마다 덮어쓰기됨 (`src/pipeline/orchestrator.ts`).
   - 영향: 최종 결과에서 전체 실행 이력이 사라지고 마지막 stage 기록만 남을 수 있음.

### B. 구조적으로 어색한 지점(복잡도만 증가)
1. planning role 래핑과 deterministic 기본 로직의 혼재
   - 근거: planning에서 `plan/architect/critic`를 role 래핑하되 내부 payload는 기본 함수(`createDefaultPlanning*`) 결과 사용.
   - 영향: 호출 구조가 복잡해졌지만 실제 에이전트 품질/다양성 이점이 없음.

2. `documenter`/`researcher`의 역할 명세 대비 실행 현실 불일치
   - 근거: 문서/리서치 역할이 실제 모델 실행보다 파일 스캔/리포트 작성 로직 중심.
   - 영향: 역할 프롬프트/툴 정책과 실제 동작의 계약 불일치.

3. 예외를 성공으로 흡수하는 처리
   - 근거: requirements 단계에서 일부 실패를 warning artifact로 흡수하고 stage를 completed 처리.
   - 영향: 초기 실패가 뒤 단계에서 늦게 드러나 디버깅 비용 증가.

### C. 제거/정리 후보
- 실제 경로에 연결되지 않은 헬퍼/그래프 접근 코드.
- stage와 role에서 중복 정의된 상태 전이 상수.
- 사용되지 않는 role 실행 부가 artifact 필드.

### D. oh-my-opencode 벤치마크 대비 추가 보완 필요
1. delegation prompt 계약 부재
   - 근거: 위임 품질을 강제하는 구조화 프롬프트 템플릿(섹션/검증/금지사항)이 없음.
   - 영향: subagent 실행 품질 편차가 커지고 재시도 비용 증가.

2. background subagent lifecycle 미정
   - 근거: `run_in_background`, `background_output`, `background_cancel` 수준의 운영 프로토콜 부재.
   - 영향: 병렬 작업 도중 결과 수집 누락, zombie task, 종료 누락 위험.

3. session continuity 규약 부족
   - 근거: retry 시 동일 `session_id` 재사용, 대화 컨텍스트 연속성 규칙이 명확하지 않음.
   - 영향: 실패 복구 시 매번 재탐색/재학습이 발생.

4. 지식 누적(노트패드) 루프 부재
   - 근거: task 간 learnings/decisions/issues를 자동 누적/주입하는 메커니즘이 없음.
   - 영향: 동일 실수를 반복하고 role 간 일관성이 낮아짐.

5. category/skill 라우팅 미정
   - 근거: 역할 고정 중심으로 설계되어 작업 유형별 모델/스킬 최적화 경로가 없음.
   - 영향: 비용/품질 최적화와 확장성이 떨어짐.

6. hook 기반 자동 복구 체계 미흡
   - 근거: delegate-task 실패 패턴 감지 및 재시도 가이드 주입 계층이 없음.
   - 영향: 오류 발생 시 운영자가 수동으로 복구 경로를 판단해야 함.

7. worktree/실행 격리 전략 부족
   - 근거: 세션별 독립 작업 디렉터리(worktree) 강제 기준 부재.
   - 영향: 병렬 세션 간 충돌, 변경 오염 위험 증가.

8. 역할별 권한 계약 테스트 부족
   - 근거: role permission matrix를 회귀 테스트로 강제하는 항목이 약함.
   - 영향: 정책 누락/오설정이 릴리즈 단계까지 잠복 가능.

## 4) 목표 아키텍처(요구사항 기준)
- 오케스트레이터는 stage를 직접 처리하지 않고 "stage -> role graph"를 해석해 role 실행을 오케스트레이션한다.
- 각 role 실행은 반드시 `SubagentExecutor`를 통해 수행한다.
- role별 tool policy를 실행 전/중에 강제한다.
- 상태/로그는 stage 단위 + role 단위 모두 추적한다.
- delegation prompt는 표준 계약(섹션/검증/금지 규칙)으로 생성한다.
- background subagent는 생성/수집/취소/정리 lifecycle을 가진다.
- retry는 동일 `session_id` 기반으로 연속 대화 컨텍스트를 재사용한다.
- notepad 기반 지식 누적(learn/decision/issue/verification)을 다음 delegation에 주입한다.
- category/skill 라우팅으로 작업 유형별 모델/권한/스킬 최적화를 지원한다.
- 세션별 worktree 격리를 기본값으로 하여 병렬 실행 충돌을 차단한다.

핵심 원칙:
1. 실행 단일 경로: role 실행은 무조건 executor 경유
2. 그래프 단일 소스: stage-role 연결은 그래프에서만 선언
3. 계약 일치: 프롬프트/정책/실행 결과/아티팩트 구조를 동일한 계약으로 강제
4. 실패 조기화: executor 미주입/정책 위반/계약 불일치는 즉시 실패
5. 연속성 보장: retry/resume은 기존 세션 컨텍스트를 유지
6. 운영 완결성: background task는 명시적으로 수집/정리
7. 학습 누적: task 간 지식 전파를 자동화

## 5) 작업 계획

### Phase 0. 정리 기준선 확정 (P0)
- [ ] 현재 경로를 `legacy`로 명시하고, 신규 role-runtime 경로를 기본 경로로 설정한다.
- [ ] `SubagentExecutor` 미주입 시 즉시 실패(fail-fast)하도록 가드한다.
- [ ] `producer-only` fallback 코드를 제거하거나 `legacy` 플래그 하위로 격리한다.
- [ ] `agent-graph`를 오케스트레이터 루프의 단일 소스로 연결한다.
- [ ] 롤백용 feature flag(`orchestrator.role_runtime`)를 추가한다.

완료 기준:
- 가짜 `producer-only` 실행으로 workflow가 진행되지 않는다.
- flag off 시 즉시 legacy 경로로 복귀 가능하다.

### Phase 1. Subagent Executor 계약 도입 (P0)
- [ ] `SubagentExecutor` 인터페이스 신설.
- [ ] 입력 계약 확정:
  - `role`, `stage`, `sessionId`, `nodeId`
  - `model`, `reasoningEffort`, `instructions`
  - `allowedTools`, `contextArtifacts`
  - `timeoutMs`, `maxRetries`, `retryBackoffMs`
  - `abortSignal`, `idempotencyKey`
- [ ] 출력 계약 확정:
  - `status(success|failure|cancelled|timeout)`
  - `decision`, `payload`, `handoff`, `reasons`, `evidence`
  - `toolEvents`, `latencyMs`, `attempts`, `errorCode`
- [ ] `runWorkflowAgent`를 executor adapter로 전환한다.
- [ ] `errorCode` 표준화(`tool_policy_denied`, `timeout`, `contract_invalid`, `network`, `cancelled`)를 추가한다.

완료 기준:
- 모든 role 실행이 executor 호출 로그를 남긴다.
- executor 장애/timeout/cancel 상태가 stage 실패 원인으로 보존된다.

### Phase 2. Graph-driven Orchestrator 전환 (P0)
- [ ] `WORKFLOW_STAGE_AGENT_GRAPH`를 role 실행 순서의 유일한 입력으로 사용한다.
- [ ] 노드 모델 정의: `nodeId = <stage>:<role>:<index>`.
- [ ] 실행 규칙 정의:
  - 기본은 순차 실행
  - 명시된 노드만 병렬 허용
  - 의존 노드 실패 시 하위 노드 skip/fail 정책 고정
- [ ] stage reducer를 분리해 role payload를 stage artifact로 축약한다.
- [ ] planning 루프는 role 노드를 반복 실행하는 서브그래프로 표현한다.

완료 기준:
- role 순서 변경이 그래프 수정만으로 반영된다.
- 오케스트레이터 본문에서 role별 하드코딩 분기가 제거된다.

### Phase 3. Tool Policy 강제 집행 (P0)
- [ ] role 실행 전 `resolveAgentToolPolicy`로 allow/deny 계산.
- [ ] executor `toolEvents`를 받아 deny 위반 시 즉시 실패 처리.
- [ ] audit log 필드 확장: `sessionId`, `workflowStage`, `role`, `nodeId`, `tool`, `decision`, `policySource`.
- [ ] run 시작 1회 검증 + role 실행 중 검증의 책임 분리를 명시한다.

완료 기준:
- `documenter`의 `bash/github` 요청 차단 테스트 통과.
- `researcher`의 `write/edit` 차단 테스트 통과.

### Phase 4. 상태/아티팩트 재설계 + 마이그레이션 (P0)
- [ ] `WorkflowState`를 v2로 확장:
  - `agentTimeline[]` (stage/role/node/status/startedAt/endedAt/retry)
  - `agentRunsByStage` + `agentRunsSummary`
  - `currentNode` (resume 기준)
- [ ] `workflow-state` v1 -> v2 마이그레이션 로직 구현.
- [ ] resume 기준을 stage 인덱스에서 `last unfinished node`로 변경.
- [ ] `agentRuns` 덮어쓰기 제거(append-only 누적).

완료 기준:
- 기존 v1 state에서도 재개가 동작한다.
- 최종 결과에서 role 실행 이력이 유실되지 않는다.

### Phase 5. 부작용 제어/롤백/운영 안정화 (P1)
- [ ] 외부 부작용(idempotency) 규칙 정의:
  - issue/pr 생성 키(`idempotencyKey`) 고정
  - 재시도 시 중복 생성 방지
- [ ] cancel/resume 세분화:
  - role 실행 중 cancel 시점 정의
  - cancelled node 재개 정책 정의
- [ ] 롤아웃 전략:
  - 로컬/CI canary 세션에서 신규 런타임 우선 적용
  - 실패율 임계치 초과 시 flag off 자동 롤백
- [ ] 롤백 절차 문서화:
  - flag off
  - state recovery
  - 영향 범위 진단

완료 기준:
- 동일 이슈/PR 중복 생성 없이 재시도 가능.
- cancel/resume 경계 케이스가 재현 테스트로 통과.

### Phase 6. 테스트/게이트/문서 동기화 (P0/P1)
- [ ] 단위 테스트: executor adapter, graph resolver, policy enforcement, state migration.
- [ ] 통합 테스트: fake executor 기반 end-to-end role orchestration.
- [ ] 장애 테스트: timeout/network/cancel/tool-deny/retry exhaustion.
- [ ] release gate에 "실제 executor 경유 실행" 증거 검증 추가.
- [ ] 사용자 문서(`README.md`, `ARCHITECTURE.md`, `docs/user-guide.md`)를 role-runtime 모델로 개정.

완료 기준:
- `npm test`, `npm run typecheck`, `npm run build`, `npm run release:gate` 통과.
- release gate에서 executor 증거 누락 시 fail 처리된다.

### Phase 7. 운영 하드닝 (oh-my-opencode 설계 반영) (P1)
- [ ] delegation prompt contract 도입:
  - 필수 섹션: `TASK`, `EXPECTED OUTCOME`, `REQUIRED TOOLS`, `MUST DO`, `MUST NOT DO`, `CONTEXT`.
  - 각 delegation 요청의 prompt hash/line count를 artifact에 기록.
- [ ] background subagent manager 도입:
  - `run_in_background` task 생성
  - 완료 알림 큐
  - `background_output` 수집
  - `background_cancel` 정리
- [ ] session continuity 보강:
  - 노드별 `session_id`를 state에 저장
  - retry는 동일 `session_id` 강제
  - fresh session 시작 시 기존 세션 재사용 여부를 정책화
- [ ] notepad/wisdom 루프 도입:
  - `.agent-guide/notepads/<plan>/`에 `learnings.md`, `decisions.md`, `issues.md`, `verification.md` 관리
  - delegation 전 notepad 주입, 완료 후 append-only 기록
- [ ] category/skill 라우팅 확장:
  - category schema(`visual-engineering`, `deep`, `quick`, `writing` 등) + fallback model chain
  - role + category 혼합 라우팅 전략 정의
- [ ] hook 기반 자동 복구:
  - delegate-task 실패 패턴 탐지
  - 재시도 가이드 자동 주입
  - continuation reminder/idle guard 추가
- [ ] worktree 격리 기본화:
  - session 시작 시 worktree 확인/생성 정책
  - state에 `worktree_path` 기록

완료 기준:
- background task 누락/좀비 프로세스 없이 종료된다.
- retry/resume 시 재탐색 없이 세션 연속성이 유지된다.
- 지식 누적이 다음 delegation 품질 향상으로 확인된다.

## 6) 파일 단위 변경 계획

필수 수정:
- `src/pipeline/orchestrator.ts`
- `src/pipeline/agent-runtime.ts`
- `src/pipeline/subagent-executor.ts` (신규)
- `src/pipeline/agent-graph.ts`
- `src/pipeline/delegation-prompt-contract.ts` (신규)
- `src/pipeline/artifact-contract.ts`
- `src/plugin/create-plugin-interface.ts`
- `src/runtime/agent-tool-policy.ts`
- `src/runtime/mode-state-contract.ts`
- `src/runtime/background-agent-manager.ts` (신규)
- `src/runtime/session-lineage.ts` (신규)
- `src/runtime/notepad-store.ts` (신규)
- `src/runtime/worktree-policy.ts` (신규)
- `src/config/schema/categories.ts` (신규 또는 확장)
- `src/config/schema/background-task.ts` (신규 또는 확장)
- `src/hooks/delegate-task-retry.ts` (신규)
- `src/hooks/background-notification.ts` (신규)

테스트/문서:
- `tests/pipeline-orchestrator.test.ts`
- `tests/agent-runtime.test.ts` (신규)
- `tests/agent-graph.test.ts`
- `tests/agent-tool-policy.test.ts`
- `tests/mode-state-contract.test.ts` (v2 migration 케이스 추가)
- `tests/background-agent-manager.test.ts` (신규)
- `tests/delegation-prompt-contract.test.ts` (신규)
- `tests/session-continuity.test.ts` (신규)
- `tests/notepad-store.test.ts` (신규)
- `tests/worktree-policy.test.ts` (신규)
- `README.md`
- `ARCHITECTURE.md`
- `docs/user-guide.md`
- `docs/contracts/subagent-executor-contract.md` (신규)
- `docs/contracts/delegation-prompt-contract.md` (신규)

## 7) 우선순위와 중단 기준

우선순위:
1. 실행 진실성 확보(executor 강제)
2. 정책 강제(tool policy)
3. 관측 가능성(state/timeline)
4. 문서/게이트 동기화

중단 기준(No-Go):
- role 실행이 executor 미경유로도 성공하는 경우
- role/tool 정책 위반이 탐지되지 않는 경우
- resume 시 role 재개 지점이 불안정한 경우

운영 중단 트리거:
- canary 세션 실패율이 baseline 대비 2배 이상 증가
- 동일 idempotencyKey로 중복 issue/pr 생성이 발생
- cancel 이후 state가 terminal/active 불일치 상태를 보임
- background task 미정리 비율이 임계치(예: 1% 초과)로 증가
- worktree 경계 위반(다른 세션 디렉터리 수정)이 탐지됨

## 8) 테스트 매트릭스(필수)
- 정상 경로:
  - [ ] requirements -> planning -> issue -> development -> testing -> merge role 체인 성공
- 정책 위반 경로:
  - [ ] `documenter`가 `bash` 사용 시 즉시 fail
  - [ ] `researcher`가 `write` 사용 시 즉시 fail
- delegation 품질 경로:
  - [ ] delegation prompt 6-섹션 계약 위반 시 즉시 fail
- 장애 경로:
  - [ ] executor timeout 재시도 후 실패 상태 보존
  - [ ] transient network 오류 재시도 후 성공/실패 판정 검증
- 운영 경계:
  - [ ] role 실행 중 cancel 후 재개
  - [ ] v1 state에서 v2 migration 후 resume
- background 운영 경계:
  - [ ] background task 완료 알림 후 `background_output` 수집 성공
  - [ ] 종료 시 disposable background task 정리 확인
- 세션 연속성:
  - [ ] retry가 동일 `session_id`를 사용하며 컨텍스트를 재사용
- 지식 누적:
  - [ ] notepad append-only 기록이 다음 task delegation에 반영
- 라우팅:
  - [ ] category fallback model 체인이 실패 시 정상 동작
- 격리:
  - [ ] session별 worktree 경계 밖 변경 시 차단
- 부작용 제어:
  - [ ] issue/pr 생성 재시도에도 중복 생성 없음

## 9) 최종 완료 조건(DoD)
- [ ] 오케스트레이터가 모든 role을 실제 subagent executor로 호출한다.
- [ ] role별 tool policy가 실행 중 강제된다.
- [ ] stage/role 실행 이력이 state와 artifact에 모두 보존된다.
- [ ] delegation prompt 계약, background lifecycle, session continuity가 운영에서 일관되게 동작한다.
- [ ] category/skill 라우팅과 fallback model 체인이 재현 가능한 테스트로 보장된다.
- [ ] notepad 기반 지식 누적이 role 간 전파된다.
- [ ] worktree 격리 정책이 병렬 세션 충돌을 차단한다.
- [ ] 문서/아키텍처/계약 테스트가 동일한 런타임 모델을 설명한다.
