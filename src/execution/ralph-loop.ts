export interface RalphCompletionSignals {
  todosDone: boolean
  testsPassed: boolean
  buildPassed: boolean
  reviewApproved: boolean
}

export interface RalphIterationResult {
  signals: RalphCompletionSignals
  note?: string
}

export interface RalphLoopHistoryItem {
  iteration: number
  completed: boolean
  signals?: RalphCompletionSignals
  note?: string
  error?: string
}

export interface RalphLoopOptions {
  maxIterations?: number
}

export interface RalphLoopResult {
  status: "completed" | "failed"
  iterations: number
  history: RalphLoopHistoryItem[]
  reason: string
  finalSignals?: RalphCompletionSignals
}

export function isRalphComplete(signals: RalphCompletionSignals): boolean {
  return (
    signals.todosDone
    && signals.testsPassed
    && signals.buildPassed
    && signals.reviewApproved
  )
}

export async function runRalphLoop(
  runIteration: (iteration: number, previous?: RalphIterationResult) => Promise<RalphIterationResult> | RalphIterationResult,
  options: RalphLoopOptions = {},
): Promise<RalphLoopResult> {
  const maxIterations = options.maxIterations ?? 100
  const history: RalphLoopHistoryItem[] = []
  let previousResult: RalphIterationResult | undefined

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    try {
      const result = await runIteration(iteration, previousResult)
      const completed = isRalphComplete(result.signals)
      const historyItem: RalphLoopHistoryItem = {
        iteration,
        completed,
        signals: result.signals,
      }
      if (result.note) {
        historyItem.note = result.note
      }
      history.push({
        ...historyItem,
      })

      if (completed) {
        return {
          status: "completed",
          iterations: iteration,
          history,
          reason: "completion gates satisfied",
          finalSignals: result.signals,
        }
      }

      previousResult = result
    } catch (error) {
      history.push({
        iteration,
        completed: false,
        error: String(error),
      })
    }
  }

  const lastSignals = [...history]
    .reverse()
    .find((item) => item.signals)?.signals

  const failedResult: RalphLoopResult = {
    status: "failed",
    iterations: maxIterations,
    history,
    reason: `max iterations reached (${maxIterations}) before completion`,
  }
  if (lastSignals) {
    failedResult.finalSignals = lastSignals
  }

  return failedResult
}
