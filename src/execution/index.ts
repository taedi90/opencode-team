export const EXECUTION_FEATURES = ["ultrawork", "ralph_loop"] as const

export type ExecutionFeature = (typeof EXECUTION_FEATURES)[number]

export * from "./ralph-loop.js"
export * from "./ultrawork.js"
