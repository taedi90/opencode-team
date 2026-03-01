# Context and Memory Lifecycle Guide

이 문서는 단기 context와 장기 memory의 작성, 검색, 정리(수명주기) 기준을 정의한다.

본 문서는 `AGENTS.md`의 메모리 강제 규칙을 실행하기 위한 절차 문서다.
정책 충돌 시 `AGENTS.md`를 우선한다.

## 1) 분류 기준
- 이슈별 단기 기록: `.agent-guide/context/`
  - 현재 이슈/브랜치 단위의 작업 상태, 임시 가설, 진행 메모
- 장기 재사용 규칙/결정: `.agent-guide/memory/`
  - 다음 세션/다른 이슈에서도 재사용할 의사결정과 적용 규칙
- 기준 정책 문서: `AGENTS.md`, `README.md`
  - 장기 운영의 기준값과 정책 우선순위

## 2) 수명주기 규칙

### 2-1. 단기 context
- 유효 범위: 현재 이슈를 다루는 세션 동안만 사용한다.
- 조회 범위: 기본적으로 현재 이슈의 context만 조회한다.
- 종료 시점: 이슈 종료(머지/종료 코멘트 완료) 후 폐기한다.
- 예외: 장기 재사용 가치가 있는 내용은 memory로 승격 후 context에서 제거한다.

### 2-2. 장기 memory
- 유효 범위: 여러 세션/이슈에서 재사용한다.
- 유지 방식: 중복/충돌을 주기적으로 정리하며 최신 근거 기준으로 갱신한다.
- 폐기 방식: 유효하지 않은 항목은 삭제 대신 `status:superseded`로 전환한다.

## 3) Frontmatter 필수 필드

### 3-1. context 문서
`context` 문서는 아래 필드를 반드시 포함한다.
신규 문서는 `.agent-guide/context/issue-000-template.md`를 복제해 작성한다.

```yaml
issue: 24
topic: context-search-guide
tags: [context, retrieval, workflow]
status: active
updated_at: 2026-02-20
```

필드 규칙:
- `issue`: 관련 이슈 번호(없으면 `null`)
- `topic`: 문서의 핵심 주제 slug
- `tags`: 검색용 키워드 배열
- `status`: `active | archived | superseded`
- `updated_at`: `YYYY-MM-DD`

### 3-2. memory 문서
`memory` 문서는 아래 필드를 반드시 포함한다.
신규 문서는 `.agent-guide/memory/memory-domain-topic-template.md`를 복제해 작성한다.

```yaml
issue: 24
domain: api
topic: error-handling
tags: [memory, decision, api]
status: active
updated_at: 2026-02-20
```

필드 규칙:
- `issue`: 최초 관련 이슈 번호(없으면 `null`)
- `domain`: 적용 영역 (예: `api`, `auth`, `build`, `ci`)
- `topic`: 장기 재사용할 핵심 주제 slug
- `tags`: 검색용 키워드 배열
- `status`: `active | archived | superseded`
- `updated_at`: `YYYY-MM-DD`

파일명 규칙:
- context: `issue-<번호>-<topic>.md`
- memory: `memory-<domain>-<topic>.md`
- 날짜는 파일명이 아니라 frontmatter(`updated_at`)로 관리한다.

## 4) Prompt/Decision Log 최소 포맷
작업 중에는 해당 이슈의 context 문서에 아래 항목만 기록한다.

- 시간: `YYYY-MM-DD HH:MM`
- 목표: 이번 요청의 성공 조건 1줄
- 제약: 지켜야 할 조건 1~2개
- 기대 산출물: 파일/결과물
- 결과 요약: 성공/실패 + 핵심 차이

예시:
- 2026-02-20 22:30 | 목표: 역할 충돌 제거 | 제약: docs lean 유지, 중복 금지 | 기대 산출물: docs 1개 + 링크 반영 | 결과: 성공, README는 링크만 유지

## 5) 검색 가이드

### 5-1. 조회 순서
구현 전 최소 조회 순서는 아래를 따른다.
1. 현재 이슈 context
2. 관련 memory (`domain`/`topic` 기준)
3. 필요한 세부 문서 (`.agent-guide/docs/`)

단기 context는 현재 이슈 범위에서만 조회한다.
이슈가 종료된 context는 검색 대상에서 제외한다.
memory를 참조해 의사결정을 내렸다면 context 문서에 `참조 문서 경로 + 적용 이유`를 기록한다.

### 5-2. context 메타필터 예시
1) 특정 이슈 관련 문서
- `issue:24`

2) 활성 문서만 조회
- `status:active`

3) 태그 교집합 조회
- `tags:context AND tags:workflow`

4) 주제 + 상태 결합
- `topic:context-search-guide AND status:active`

5) 최근 갱신 문서 추적
- `updated_at:2026-02-*`

### 5-3. memory 메타필터 예시
1) 특정 domain 정책 조회
- `domain:api AND status:active`

2) 특정 주제의 장기 결정 조회
- `topic:error-handling AND tags:decision`

3) 적용 범위가 같은 memory 교집합 조회
- `tags:auth AND tags:security AND status:active`

4) superseded 제외
- `status:active AND NOT status:superseded`

5) 최신 갱신 memory 우선
- `domain:ci AND updated_at:2026-02-*`

### 5-4. 키워드 검색 예시
1) 결정 근거 찾기
- `결정 AND trade-off`

2) 장애 재현 기록 찾기
- `문제 AND 재현`

3) PR 전 정리 항목 회수
- `PR AND 정리`

4) 장기 규칙 충돌 점검
- `superseded OR 충돌 OR 대체`

### 5-5. 충돌 처리 규칙
1. 동일 domain/topic에서 상충하는 memory가 있으면 `updated_at`이 최신인 항목을 우선 검토한다.
2. 최신 항목에 근거가 부족하면 기존 항목을 병합해 1개로 정리하고, 정리 이유를 기록한다.
3. 더 이상 유효하지 않은 항목은 `status:superseded`로 전환한다.

## 6) PR 전 정리 루틴
1. PR 대상 작업의 context 문서 범위를 확정한다.
2. 장기 재사용에 필요 없는 임시 메모/중복/잡음을 제거한다.
3. 주제가 무관한 내용은 memory 파일을 분리한다.
4. 장기 정책/결정으로 승격할 내용이 있으면 `AGENTS.md` 또는 `README.md`에 반영한다.
5. context 문서는 승격/근거 링크만 남기고 폐기 준비 상태로 정리한다.
6. memory 문서는 중복/충돌을 점검하고 필요 시 병합 또는 `superseded` 처리한다.
