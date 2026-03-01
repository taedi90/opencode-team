import { setTimeout as sleep } from "node:timers/promises"

import { describe, expect, it } from "vitest"

import {
  runUltrawork,
  type UltraworkTask,
} from "../src/execution/ultrawork.js"

describe("ultrawork executor", () => {
  it("runs independent tasks in parallel waves and respects dependencies", async () => {
    const executionOrder: string[] = []

    const tasks: UltraworkTask[] = [
      {
        id: "a",
        run: async () => {
          executionOrder.push("a:start")
          await sleep(20)
          executionOrder.push("a:end")
          return { status: "completed", output: { a: true } }
        },
      },
      {
        id: "b",
        run: async () => {
          executionOrder.push("b:start")
          await sleep(20)
          executionOrder.push("b:end")
          return { status: "completed", output: { b: true } }
        },
      },
      {
        id: "c",
        dependsOn: ["a", "b"],
        run: async () => {
          executionOrder.push("c:start")
          return { status: "completed", output: { c: true } }
        },
      },
    ]

    const result = await runUltrawork(tasks)

    expect(result.status).toBe("completed")
    expect(result.waves.length).toBe(2)
    const firstWave = result.waves[0] ?? []
    const secondWave = result.waves[1] ?? []
    expect([...firstWave].sort()).toEqual(["a", "b"])
    expect(secondWave).toEqual(["c"])
    expect(result.outputs).toMatchObject({ a: true, b: true, c: true })

    const cStartIndex = executionOrder.indexOf("c:start")
    expect(cStartIndex).toBeGreaterThan(executionOrder.indexOf("a:end"))
    expect(cStartIndex).toBeGreaterThan(executionOrder.indexOf("b:end"))
  })

  it("fails when task dependency is missing", async () => {
    const result = await runUltrawork([
      {
        id: "a",
        dependsOn: ["missing"],
        run: async () => ({ status: "completed" }),
      },
    ])

    expect(result.status).toBe("failed")
    expect(result.error).toContain("missing dependency")
  })

  it("stops when a task fails", async () => {
    const tasks: UltraworkTask[] = [
      {
        id: "a",
        run: async () => ({ status: "failed", error: "boom" }),
      },
      {
        id: "b",
        run: async () => ({ status: "completed" }),
      },
    ]

    const result = await runUltrawork(tasks)

    expect(result.status).toBe("failed")
    expect(result.failedTaskId).toBe("a")
    expect(result.error).toBe("boom")
  })

  it("prioritizes background tasks first within a wave", async () => {
    const order: string[] = []

    const tasks: UltraworkTask[] = [
      {
        id: "normal",
        run: async () => {
          order.push("normal")
          return { status: "completed" }
        },
      },
      {
        id: "background",
        background: true,
        run: async () => {
          order.push("background")
          return { status: "completed" }
        },
      },
    ]

    const result = await runUltrawork(tasks)

    expect(result.status).toBe("completed")
    expect(order[0]).toBe("background")
  })
})
