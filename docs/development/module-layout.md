# 모듈/엔트리 경로 규칙

## 기본 원칙
- 도메인 단위로 디렉터리를 분리한다.
- 각 도메인은 `index.ts`를 엔트리로 가진다.
- 루트 엔트리(`src/index.ts`)는 도메인 엔트리만 재수출한다.

## 현재 도메인
- `src/config`: 설정 타입, 기본 정책
- `src/agents`: 에이전트 역할/티어 계약
- `src/planning`: 정/반/합 합의 플래닝 엔진
- `src/pipeline`: 워크플로우 단계 계약
- `src/execution`: ultrawork/ralph loop 실행 엔진
- `src/github`: GitHub 자동화 계약 및 머지 정책 로그
- `src/runtime`: mode state/cancel 계약 및 세션 상태 유틸
- `src/plugin`: plugin runtime 조립(config -> managers -> tools -> hooks -> interface)
- `src/doctor`: doctor 진단 계약 및 체크 실행
- `src/cli`: install/run/doctor 커맨드 엔트리
- `src/release-gate`: 릴리스 게이트 검사 로직

## import 규칙
- ESM 기준으로 내부 상대 경로 import 시 `.js` 확장자를 사용한다.
- 테스트는 `tests/`에 두고 `src/` 공개 계약만 검증한다.

## 확장 규칙
- 새 기능 추가 시 기존 도메인에 포함되지 않으면 도메인을 새로 만든다.
- 도메인별 내부 세부 파일은 자유롭게 분리하되, 외부 노출은 `index.ts`로 통일한다.
