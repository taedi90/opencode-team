# Cancel Contract

## 목적
- mode 취소 동작을 세션 범위에서 안전하게 수행하고, linked mode 정리 순서를 고정한다.

## 대상
- mode: `orchestrator`, `ultrawork`, `ralph`
- 세션 스코프: 같은 `sessionId` 상태 파일만 변경한다.

## 필수 post-condition
1. 취소 대상 mode가 active 상태였다면 terminal 상태로 전환되어야 한다.
   - `active=false`
   - `currentPhase="cancelled"`
   - `completedAt` 갱신
2. 취소는 세션 범위로 제한되어야 한다.
   - 다른 `sessionId` 상태는 절대 변경하지 않는다.
3. linked mode가 있는 경우 정해진 순서로 정리한다.

## 취소 순서
- target=`orchestrator`
  - `ultrawork -> ralph -> orchestrator`
- target=`ralph`
  - `linkedMode=ultrawork`이면 `ultrawork -> ralph`
  - 그 외에는 `ralph`
- target=`ultrawork`
  - `ultrawork`

## linked metadata 규칙
- `ralph` 취소 시 linked `ultrawork`도 함께 취소되었다면 아래 필드를 기록한다.
  - `linkedModeTerminalPhase="cancelled"`
  - `linkedModeTerminalAt=<ISO8601>`

## 구현
- 코드: `src/runtime/mode-state-contract.ts`
- API:
  - `applyCancelModeContract`
