const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageJson = require('../package.json')
const { startServer } = require('./helpers/mcp-client')
const { tempDir: makeTempDir } = require('./helpers/tmp')

// Codex's guidance is to keep the first ~512 characters of `instructions` self-contained
// (SRS C2). It is a client recommendation, not an MCP limit, but it is the budget the field is
// written for.
const INSTRUCTIONS_BUDGET = 512

// FR-38: the complete tool list. A tool that could broadcast, deploy, sign or take a key
// must never appear here; adding any tool means changing this list on purpose.
const EXPECTED_TOOLS = ['build', 'explain_failure', 'run_tests']

function tempDir(depth) {
  let dir = makeTempDir('forge-test-mcp-server-')
  for (let i = 0; i < depth; i++) dir = path.join(dir, `level-${i}-with-a-longer-name`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('instructions are static and within the 512-char budget, measured over a live handshake (FR-39)', async (t) => {
  const measured = []
  for (const cwd of [tempDir(0), tempDir(6)]) {
    const server = startServer({ cwd })
    try {
      const response = await server.initialize()
      assert.equal(response.result.serverInfo.name, packageJson.name)
      measured.push(response.result.instructions)
    } finally {
      await server.stop()
    }
  }
  const [shallow, deep] = measured
  assert.equal(typeof shallow, 'string')
  assert.equal(shallow, deep, 'instructions must not depend on the working directory')
  assert.ok(
    shallow.length <= INSTRUCTIONS_BUDGET,
    `instructions are ${shallow.length} chars, budget ${INSTRUCTIONS_BUDGET}`
  )
  t.diagnostic(`instructions measured live: ${shallow.length} chars`)
  assert.match(shallow, /^[\x20-\x7e]+$/, 'instructions should be plain ASCII')
  assert.match(shallow, /isError means tests did not run/)
  assert.match(shallow, /do not prove a contract is secure/)
})

test('lists exactly the expected tools, and none that could broadcast or take keys (FR-38)', async () => {
  const server = startServer({ cwd: tempDir(0) })
  try {
    await server.initialize()
    const listed = await server.request('tools/list')
    // With no tools registered the SDK does not advertise the tools capability at all.
    if (EXPECTED_TOOLS.length === 0 && listed.error) {
      assert.equal(listed.error.code, -32601, JSON.stringify(listed.error))
      return
    }
    const names = listed.result.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort())
    for (const name of names) {
      assert.doesNotMatch(name, /send|broadcast|deploy|script|sign|key|wallet|create/i)
    }
    assert.deepEqual(server.invalidLines, [])
  } finally {
    await server.stop()
  }
})

test('console output from server code goes to stderr, never to the protocol channel (FR-40)', () => {
  const script = `
    require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'stdout-guard.js'))}).protectProtocolStdout()
    console.log('log line'); console.info('info line'); console.debug('debug line');
    console.warn('warn line'); console.dir({ dir: 1 }); console.table([1])
  `
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /log line/)
  assert.match(result.stderr, /info line/)
  assert.match(result.stderr, /warn line/)
})

test('the real entry point installs the stdout guard before serving (FR-40)', async () => {
  // Preloaded before src/index.js; the probe fires once index.js has run, as late
  // console.log calls from server code or a dependency would.
  const probe = path.join(tempDir(0), 'probe.js')
  fs.writeFileSync(
    probe,
    "setImmediate(() => { console.log('stdout probe from server code'); console.info('info probe') })\n"
  )
  const server = startServer({ cwd: tempDir(0), nodeArgs: ['--require', probe] })
  try {
    await server.initialize()
    await server.request('ping')
    assert.deepEqual(server.invalidLines, [], 'nothing but JSON-RPC on stdout')
    assert.match(server.stderr, /stdout probe from server code/)
    assert.match(server.stderr, /info probe/)
  } finally {
    await server.stop()
  }
})
