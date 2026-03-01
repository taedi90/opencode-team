import { createHooks } from "./create-hooks.js"
import { createManagers } from "./create-managers.js"
import { createPluginInterface } from "./create-plugin-interface.js"
import { createTools } from "./create-tools.js"

import type { PluginInterface, PluginRuntimeOptions } from "./types.js"

export function createPluginRuntime(options: PluginRuntimeOptions): PluginInterface {
  const managers = createManagers(options)
  const tools = createTools()
  const hooks = createHooks({
    workspaceRoot: managers.workspaceRoot,
  })

  return createPluginInterface({
    managers,
    tools,
    hooks,
  })
}

export * from "./types.js"
