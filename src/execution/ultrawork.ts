export type UltraworkTaskResult =
  | {
      status: "completed"
      output?: Record<string, unknown>
    }
  | {
      status: "failed"
      error: string
      output?: Record<string, unknown>
    }

export interface UltraworkTask {
  id: string
  dependsOn?: string[]
  background?: boolean
  run: () => Promise<UltraworkTaskResult> | UltraworkTaskResult
}

export interface UltraworkRunResult {
  status: "completed" | "failed"
  waves: string[][]
  completedTaskIds: string[]
  outputs: Record<string, unknown>
  failedTaskId?: string
  error?: string
}

function validateTasks(tasks: UltraworkTask[]): string | null {
  const ids = new Set<string>()

  for (const task of tasks) {
    if (ids.has(task.id)) {
      return `duplicate task id: ${task.id}`
    }
    ids.add(task.id)
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        return `${task.id}: missing dependency ${dependency}`
      }
    }
  }

  return null
}

export async function runUltrawork(
  tasks: UltraworkTask[],
): Promise<UltraworkRunResult> {
  const validationError = validateTasks(tasks)
  if (validationError) {
    return {
      status: "failed",
      waves: [],
      completedTaskIds: [],
      outputs: {},
      error: validationError,
    }
  }

  const taskMap = new Map(tasks.map((task) => [task.id, task]))
  const pending = new Set(tasks.map((task) => task.id))
  const completed = new Set<string>()
  const completedTaskIds: string[] = []
  const waves: string[][] = []
  const outputs: Record<string, unknown> = {}

  while (pending.size > 0) {
    const runnable: UltraworkTask[] = []
    for (const taskId of pending) {
      const task = taskMap.get(taskId)
      if (!task) continue

      const dependencies = task.dependsOn ?? []
      const isReady = dependencies.every((dependency) => completed.has(dependency))
      if (isReady) {
        runnable.push(task)
      }
    }

    if (runnable.length === 0) {
      return {
        status: "failed",
        waves,
        completedTaskIds,
        outputs,
        error: "dependency cycle or blocked tasks detected",
      }
    }

    runnable.sort((left, right) => {
      if (left.background === right.background) {
        return left.id.localeCompare(right.id)
      }
      return left.background ? -1 : 1
    })

    const wave = runnable.map((task) => task.id)
    waves.push(wave)

    const waveResults = await Promise.all(
      runnable.map(async (task) => {
        try {
          const result = await task.run()
          return {
            task,
            result,
          }
        } catch (error) {
          return {
            task,
            result: {
              status: "failed",
              error: String(error),
            } as UltraworkTaskResult,
          }
        }
      }),
    )

    for (const item of waveResults) {
      if (item.result.output) {
        Object.assign(outputs, item.result.output)
      }

      if (item.result.status === "failed") {
        return {
          status: "failed",
          waves,
          completedTaskIds,
          outputs,
          failedTaskId: item.task.id,
          error: item.result.error,
        }
      }
    }

    for (const task of runnable) {
      pending.delete(task.id)
      completed.add(task.id)
      completedTaskIds.push(task.id)
    }
  }

  return {
    status: "completed",
    waves,
    completedTaskIds,
    outputs,
  }
}
