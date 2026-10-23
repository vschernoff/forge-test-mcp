// Minimal stdio MCP client for tests: spawns the real server entry point and speaks
// newline-delimited JSON-RPC. Every stdout line must be valid JSON-RPC; anything else is
// recorded in `invalidLines` so tests can assert the protocol channel stayed clean (FR-40).
const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const SERVER_ENTRY = path.resolve(__dirname, '..', '..', 'src', 'index.js')

function startServer({ cwd, args = [], env = {}, nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, SERVER_ENTRY, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const invalidLines = []
  let stderr = ''
  let nextId = 1

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      invalidLines.push(line)
      return
    }
    if (message?.jsonrpc !== '2.0') invalidLines.push(line)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      waiter(message)
    }
  })
  child.stderr.on('data', (chunk) => (stderr += chunk))

  function request(method, params = {}, timeoutMs = 60_000) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms; stderr: ${stderr}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async function initialize() {
    const response = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'forge-test-mcp-tests', version: '0.0.0' },
    })
    notify('notifications/initialized')
    return response
  }

  async function callTool(name, args = {}, timeoutMs) {
    return request('tools/call', { name, arguments: args }, timeoutMs)
  }

  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exited
  }

  return {
    child,
    request,
    notify,
    initialize,
    callTool,
    stop,
    invalidLines,
    get stderr() {
      return stderr
    },
  }
}

module.exports = { startServer, SERVER_ENTRY }
