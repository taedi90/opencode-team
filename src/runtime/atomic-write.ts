import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

function randomSuffix(): string {
  return `${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`
}

export async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true })

  const tempPath = join(parent, `.tmp-${randomSuffix()}`)
  try {
    await writeFile(tempPath, content, "utf8")
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}
