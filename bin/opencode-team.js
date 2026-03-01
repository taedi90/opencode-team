#!/usr/bin/env node

import { runCli } from "../dist/src/cli/index.js"

runCli(process.argv.slice(2)).then((code) => {
  process.exit(code)
}).catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
