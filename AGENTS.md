# AGENTS.md - Project Agent Guide

## 프로젝트 개요
### 목적
OpenAI-only 기반 멀티 에이전트 워크플로우 하네스를 구현한다. 요구사항 파악부터 플랜/이슈/개발/테스트/PR 머지까지를 자동화하고, `ultrawork`와 `ralph loop`를 핵심 실행 축으로 유지한다.

### 주요 경로
- `src/`: 애플리케이션 코드 기본 경로
- `docs/`: 사용자를 위한 매뉴얼 문서
- `.agent-guide/context/`: 이슈별 단기 작업 기록
- `.agent-guide/memory/`: 장기 보존 의사결정 기록
- `.agent-guide/docs/`: 에이전트가 필요시 조회하는 세부 운영 문서

### 스타일 가이드
- 문서/로그/코멘트에 이모티콘을 사용하지 않는다.
- 주석은 한글로 간결하게 작성한다.

### 기술 스택
- Runtime: Node.js (ESM)
- Language: TypeScript
- Package Manager: npm
- Test Runner: Vitest
- Lint/Format: TypeScript compiler checks (`tsc --noEmit`)

## 코딩 원칙
1) 생각 먼저 (Think before coding)
- 추측 금지. 가정/불확실성을 명시하고, 막히면 근거와 함께 질문한다.
- 해석이 여러 개면 선택지와 트레이드오프를 먼저 제시한다.

2) 단순함 우선 (Simplicity first)
- 요청받은 범위만 구현한다.
- 나중을 위한 과도한 추상화/설정/확장은 추가하지 않는다.

3) 수술처럼 수정 (Surgical changes)
- 변경 대상 범위만 수정한다.
- 내 변경으로 발생한 미사용 코드만 정리한다.

4) 목표-검증 루프 (Goal-driven execution)
- 요청을 성공 조건으로 변환하고, 검증 통과까지 반복한다.
- 멀티스텝 작업은 `Step -> Verify` 계획으로 시작한다.

5) 컨텍스트 절약 (Lean context)
- AGENTS.md에는 기준 규칙만 둔다.
- 상세 절차는 `.agent-guide/docs/`에서 필요시에만 조회한다.

## 작업 워크플로우 (Issue-driven + TDD)
### 게이트
- 이슈가 없으면 구현을 시작하지 않는다.
- PR에는 관련 이슈 링크(`Closes #번호`)가 반드시 포함되어야 한다.

### 표준 흐름
1. Issue 작성: 배경/범위/완료조건(DoD) 확정
2. 브랜치 생성: `task/<issue-number>-<slug>` 권장
3. RED: 실패하는 테스트를 먼저 작성/확인
4. GREEN: 최소 구현으로 테스트 통과
5. VERIFY: 관련 테스트/검증 루프 실행 및 기록
6. MEMORY: 단기 기록 정리 후 장기 보존 대상 승격
7. PR 생성: 이슈 연결, 검증 근거 첨부
8. 리뷰/머지
9. 이슈 종료 코멘트: 결과/검증/후속 이슈 기록

## 메모리 규칙
- 이 섹션은 메모리 운영의 강제 규칙을 정의한다.
- 작성/검색/정리 절차와 예시는 `.agent-guide/docs/memory-lifecycle-guide.md`를 따른다.

### 단기 메모리 (`.agent-guide/context/`)
- 이슈당 1개 이상의 context 문서를 유지한다.
- 작업 중 의사결정, 검증 로그, 실패 가설/재시도를 기록한다.
- 단기 context는 현재 이슈를 다루는 세션에서만 유효하다.
- 이슈 종료 후에는 승격 근거를 제외하고 폐기한다.

### 단기 메모리 작성 강제 규칙
- 신규 context는 `.agent-guide/context/issue-000-template.md`를 복제해 시작한다.
- 작업 시작 시 `Goal`/`Scope`를 먼저 기록한다.
- 검증을 실행할 때마다 `Verification Log`를 갱신한다.
- 세션 종료 전 `Handoff` 4항목(Current Status/Changed Files/Open Risks/Next Action)을 반드시 채운다.
- 기록이 없으면 해당 작업은 미완료로 간주한다.

### 장기 메모리 (`.agent-guide/memory/`)
- 다음 세션/다른 이슈에서도 재사용될 규칙만 승격한다.
- PR 직전에 승격 여부를 판단하고, 불필요한 단기 메모는 제거한다.
- 승격 시 주제가 서로 무관하면 파일을 분리한다.

### 장기 메모리 작성 강제 규칙
- 신규 memory는 `.agent-guide/memory/memory-domain-topic-template.md`를 복제해 시작한다.
- 한 파일에는 하나의 핵심 규칙/결정만 유지한다.
- `Decision`, `Evidence`, `Reuse Rule`, `Scope`, `Promotion Cleanup`, `Caution` 섹션을 모두 채운다.
- 동일 주제 memory가 이미 있으면 새 파일 추가보다 기존 파일 갱신을 우선한다.
- 근거 없는 주장이나 재현 불가능한 문장은 장기 메모리에 남기지 않는다.

### 승격 기준
- 다음 작업에서도 반복 적용되는 규칙인가?
- 선택 근거가 있으며 되돌릴 때 영향이 큰가?
- 운영 방식의 기본값을 바꾸는가?

### 승격 정리 규칙
- 장기 재사용에 필요 없는 로그/대화/임시 가설은 남기지 않는다.
- 결정 근거는 2~3개 핵심 증거만 남긴다.
- 적용 범위가 다른 규칙은 별도 memory 파일로 분리한다.

### 장기 메모리 파일명 규칙
- 기본 형식: `memory-<domain>-<topic>.md`
- 날짜는 파일명이 아니라 frontmatter의 `updated_at`으로 관리한다.

### 메모리 조회/사용 규칙
- 구현 전 최소 조회 순서: 현재 이슈 context -> 관련 memory(동일 domain/topic) -> 필요한 세부 문서.
- memory를 참조해 의사결정을 내렸다면 context에 `참조 문서 경로 + 적용 이유`를 1줄로 남긴다.
- memory 내용이 현재 코드/요구사항과 충돌하면 최신 근거 기준으로 수정하고 충돌 이유를 기록한다.
- 장기 메모리는 검색 효율을 위해 태그를 유지하고, 주제와 무관한 정보는 즉시 분리한다.

## 검증 규칙
- 코드 변경 시 관련 테스트를 실행한다.
- 실패 시 원인 가설 1개 단위로 수정하고 동일 시나리오를 재검증한다.
- 검증 결과(명령/결과/근거)를 context 문서에 남긴다.

## 참고 문서 (필요시 조회)
- 메모리 수명주기/검색: `.agent-guide/docs/memory-lifecycle-guide.md`
- 검증 루프: `.agent-guide/docs/verification-loop.md`
- 이슈 기반 실행 규칙: `.agent-guide/docs/issue-workflow.md`
- TDD 루프: `.agent-guide/docs/tdd-loop.md`

조회 규칙:
- 해당 작업에 필요한 문서만 읽는다.
- 읽은 문서는 context에 1줄로 기록한다.
- 메모리 정책 충돌 시 `AGENTS.md`를 우선한다.
