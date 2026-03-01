export interface SafeHookLogger {
  warn: (message: string) => void
}

export interface SafeHookCreateInput<TInput> {
  name: string
  create: () => ((input: TInput) => Promise<void> | void)
  logger?: SafeHookLogger
}

function defaultLogger(): SafeHookLogger {
  return {
    warn: (message: string) => {
      process.stderr.write(`${message}\n`)
    },
  }
}

export function safeCreateHook<TInput>(input: SafeHookCreateInput<TInput>): (payload: TInput) => Promise<void> {
  const logger = input.logger ?? defaultLogger()
  let hook: ((payload: TInput) => Promise<void> | void) | null = null
  let creationFailed = false

  return async (payload: TInput) => {
    if (!hook && !creationFailed) {
      try {
        hook = input.create()
      } catch (error) {
        creationFailed = true
        logger.warn(`[hook:${input.name}] failed to create hook: ${String(error)}`)
        return
      }
    }

    if (!hook) {
      return
    }

    try {
      await hook(payload)
    } catch (error) {
      logger.warn(`[hook:${input.name}] failed while executing hook: ${String(error)}`)
    }
  }
}
