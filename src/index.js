#!/usr/bin/env node

const { protectProtocolStdout } = require('./stdout-guard')

protectProtocolStdout()

const { serveStdio } = require('@modelcontextprotocol/server/stdio')

const packageJson = require('../package.json')
const { createContext } = require('./context')
const { killAllActive } = require('./forge-process')
const { parseOptions } = require('./options')
const { createServer } = require('./server')
const { createTools } = require('./tools')

function main() {
  try {
    const options = parseOptions(process.argv.slice(2))
    const context = createContext({ forge: options.forge, startDir: options.root, options })
    // No forge process may outlive the server (FR-37).
    process.on('exit', killAllActive)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => process.exit(128))
    }
    serveStdio(() => createServer({ tools: createTools(context) }))
  } catch (error) {
    console.error(`Failed to start ${packageJson.name}: ${error.message}`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = { main }
