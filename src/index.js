#!/usr/bin/env node

const { protectProtocolStdout } = require('./stdout-guard')

protectProtocolStdout()

const { serveStdio } = require('@modelcontextprotocol/server/stdio')

const packageJson = require('../package.json')
const { createServer } = require('./server')

function main() {
  try {
    serveStdio(() => createServer())
  } catch (error) {
    console.error(`Failed to start ${packageJson.name}: ${error.message}`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = { main }
