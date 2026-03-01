import { describe, expect, it } from "vitest"

import {
  isRalphComplete,
  runRalphLoop,
  type RalphIterationResult,
} from "../src/execution/ralph-loop.js"

describe("ralph loop", () => {
  it("evaluates completion gates with strict all-pass rule", () => {
    expect(
      isRalphComplete({
        todosDone: true,
        testsPassed: true,
        buildPassed: true,
        reviewApproved: true,
      }),
    ).toBe(true)

    expect(
      isRalphComplete({
        todosDone: true,
        testsPassed: true,
        buildPassed: false,
        reviewApproved: true,
      }),
    ).toBe(false)
  })

  it("retries until completion and returns completed status", async () => {
    let count = 0

    const result = await runRalphLoop(
      async (): Promise<RalphIterationResult> => {
        count += 1
        return {
          signals: {
            todosDone: true,
            testsPassed: count >= 2,
            buildPassed: count >= 2,
            reviewApproved: count >= 2,
          },
          note: `iteration-${count}`,
        }
      },
      {
        maxIterations: 4,
      },
    )

    expect(result.status).toBe("completed")
    expect(result.iterations).toBe(2)
    expect(result.history.length).toBe(2)
  })

  it("fails when max iterations are exhausted", async () => {
    const result = await runRalphLoop(
      async () => ({
        signals: {
          todosDone: true,
          testsPassed: false,
          buildPassed: true,
          reviewApproved: true,
        },
      }),
      {
        maxIterations: 3,
      },
    )

    expect(result.status).toBe("failed")
    expect(result.iterations).toBe(3)
    expect(result.reason).toContain("max iterations")
  })

  it("records iteration errors and continues retry loop", async () => {
    let count = 0

    const result = await runRalphLoop(
      async () => {
        count += 1
        if (count === 1) {
          throw new Error("transient failure")
        }

        return {
          signals: {
            todosDone: true,
            testsPassed: true,
            buildPassed: true,
            reviewApproved: true,
          },
        }
      },
      {
        maxIterations: 3,
      },
    )

    expect(result.status).toBe("completed")
    expect(result.history[0]?.error).toContain("transient failure")
  })
})
