import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function main() {
  const root = process.cwd()
  const releaseGateEntry = join(root, "dist", "src", "release-gate", "index.js")

  try {
    await access(releaseGateEntry)
  } catch {
    process.stderr.write("release gate failed: build output missing (run `npm run build` first)\n")
    process.exit(1)
  }

  try {
    const { stdout, stderr } = await execFileAsync("node", [releaseGateEntry], {
      cwd: root,
      env: process.env,
    })
    if (stdout.trim().length > 0) {
      process.stdout.write(stdout)
    }
    if (stderr.trim().length > 0) {
      process.stderr.write(stderr)
    }
  } catch (error) {
    if (error && typeof error === "object") {
      const stdout = "stdout" in error ? String(error.stdout ?? "") : ""
      const stderr = "stderr" in error ? String(error.stderr ?? "") : ""
      if (stdout.trim().length > 0) {
        process.stdout.write(stdout)
      }
      if (stderr.trim().length > 0) {
        process.stderr.write(stderr)
      }
    }
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`release gate failed: ${String(error)}\n`)
  process.exit(1)
})
