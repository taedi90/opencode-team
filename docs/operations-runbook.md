# Operations Runbook

## 목적
- scope-freeze 기준에서 실사용 장애를 빠르게 분류하고 복구한다.
- 신규 기능 추가 없이 현재 동작 범위에서 재현 가능한 절차만 기록한다.

## 사전 점검
- 기본 검증:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
- 설치/진단:
  - `npm run cli -- install`
  - `npm run cli -- doctor --json`

## E2E 반복 검증
- 권장 실행:
  - `npm run e2e:reliability -- --iterations 10`
- 출력:
  - `.agent-guide/runtime/reports/e2e-reliability-<timestamp>.json`
- 주요 지표:
  - `successRate`
  - `failureByType`
  - iteration별 `durationMs`

## 실패 유형별 대응

### 1) `development_script_missing`
- 증상:
  - development stage 실패
  - 메시지에 `no development script` 포함
- 대응:
  1. `package.json`의 scripts에 아래 중 하나를 추가
     - `opencode:develop`
     - `develop:opencode`
     - `develop`
  2. 스크립트가 실제 파일 변경을 생성하는지 확인
  3. 재실행

### 2) `verification_failed`
- 증상:
  - testing stage 실패
  - 메시지에 `verification command failed` 포함
- 대응:
  1. 실패한 명령을 로컬에서 단독 실행
  2. 테스트/빌드 오류 수정
  3. allowlist 외 명령이 들어갔는지 점검

### 3) `merge_prereq_failed`
- 증상:
  - merge stage 실패
  - 메시지에 `merge prerequisites failed` 포함
- 대응:
  1. git 저장소 여부 확인
  2. committable 파일이 있는지 확인
  3. 원격 push 권한/브랜치 상태 점검

### 4) `session_locked`
- 증상:
  - 동일 session 실행 시 `session_locked`
- 대응:
  1. 중복 실행 종료
  2. lock TTL(기본 30분) 경과 후 재시도
  3. 비정상 종료가 확인되면 lock 파일 상태 점검

### 5) `transient_network`
- 증상:
  - timeout/econn/temporary 오류
- 대응:
  1. 네트워크 상태 확인
  2. merge retry/backoff 동작 확인
  3. 재실행 후 재발 시 수동 승인/머지 경로 전환

### 6) `unknown`
- 증상:
  - 위 분류에 해당하지 않는 오류
- 대응:
  1. state/log 파일 확인
  2. 오류 텍스트를 기준으로 새로운 분류 후보 기록
  3. 필요 시 runbook 분류 확장

## 운영 중지 기준
- 동일 유형 치명 실패가 3회 연속 발생
- `doctor` 결과가 `fail`
- E2E 성공률이 목표 기준 미달

## 운영 재개 기준
- 실패 유형 원인/복구 절차 문서화 완료
- 기본 검증(`typecheck/test/build`) 재통과
- E2E 반복 실행 재검증 통과
