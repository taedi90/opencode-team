import { loadMergedConfig } from "../config/index.js"

import type { PluginManagers, PluginRuntimeOptions } from "./types.js"

export function createManagers(options: PluginRuntimeOptions): PluginManagers {
  const loadConfig: PluginManagers["loadConfig"] = async () => loadMergedConfig({
    projectDir: options.workspaceRoot,
    ...(options.userHome ? { userHome: options.userHome } : {}),
  })

  return {
    workspaceRoot: options.workspaceRoot,
    ...(options.userHome ? { userHome: options.userHome } : {}),
    loadConfig,
  }
}
