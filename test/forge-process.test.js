const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { runProcess } = require('../src/forge-process')
const { killRecordedPids } = require('./helpers/cleanup')
const { tempDir: makeTempDir } = require('./helpers/tmp')

const FAKE_FORGE = [process.execPath, path.join(__dirname, 'helpers', 'fake-forge.js')]

function tempDir() {
  return makeTempDir('forge-test-mcp-process-')
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isAlive(pid)
}

function run(scenario, overrides = {}) {
  return runProcess({
    command: FAKE_FORGE,
    args: overrides.args ?? [],
    cwd: overrides.cwd ?? tempDir(),
    env: { ...process.env, FAKE_FORGE_SCENARIO: scenario, ...overrides.env },
    timeoutMs: overrides.timeoutMs ?? 30_000,
    maxOutputBytes: overrides.maxOutputBytes,
  })
}

test('passes arguments verbatim, without a shell (NFR-4)', async () => {
  const cwd = tempDir()
  const hostile = [
    '--match-test=$(touch pwned)',
    '; touch pwned2',
    '`touch pwned3`',
    'a\'b"c',
    '&& echo hi',
  ]
  const result = await run('echo', { cwd, args: hostile })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).args, hostile)
  assert.deepEqual(fs.readdirSync(cwd), [], 'no shell ran, so no file was created')
})

test('reports a missing executable as a spawn error, not as output', async () => {
  const result = await runProcess({
    command: path.join(tempDir(), 'no-such-forge'),
    args: ['test'],
    cwd: tempDir(),
    timeoutMs: 5000,
  })
  assert.equal(result.spawnError?.code, 'ENOENT')
  assert.equal(result.stdout, '')
})

test('reports the exit code and stderr of a failing process', async () => {
  const result = await run('exit', { env: { FAKE_FORGE_EXIT: '3' } })
  assert.equal(result.code, 3)
  assert.match(result.stderr, /fake failure/)
  assert.equal(result.timedOut, false)
})

test('kills the whole process tree on timeout and leaves no orphans (FR-37)', async (t) => {
  const pidFile = path.join(tempDir(), 'grandchild.pid')
  killRecordedPids(t, pidFile)
  const started = Date.now()
  const result = await run('hang-with-child', {
    timeoutMs: 1500,
    env: { FAKE_FORGE_PIDFILE: pidFile },
  })
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 10_000, 'returned promptly after the timeout')
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(await waitUntilDead(grandchild), `grandchild ${grandchild} survived the timeout`)
})

test(
  'sweeps processes that forge left behind when it exits on its own (FR-37)',
  { skip: process.platform === 'win32' && 'Windows has no process groups to sweep after exit' },
  async (t) => {
    const pidFile = path.join(tempDir(), 'grandchild.pid')
    killRecordedPids(t, pidFile)
    const result = await run('exit-leaving-child', { env: { FAKE_FORGE_PIDFILE: pidFile } })
    assert.equal(result.code, 0)
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.ok(await waitUntilDead(grandchild), `grandchild ${grandchild} outlived forge`)
  }
)

test('stops and flags output beyond the cap instead of buffering it all', async () => {
  const result = await run('flood', { maxOutputBytes: 1024 * 1024 })
  assert.equal(result.outputTruncated, true)
  assert.ok(result.stdout.length <= 1024 * 1024)
})

test('returns promptly when forge exits but a descendant holds its stdout open (FR-37)', async (t) => {
  const pidFile = path.join(tempDir(), 'grandchild.pid')
  killRecordedPids(t, pidFile)
  const started = Date.now()
  const result = await run('exit-with-stdout-holder', {
    timeoutMs: 60_000,
    env: { FAKE_FORGE_PIDFILE: pidFile },
  })
  const elapsed = Date.now() - started
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.stdout, '{}')
  assert.ok(elapsed < 15_000, `took ${elapsed} ms`)
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(await waitUntilDead(grandchild), `descendant ${grandchild} survived`)
})

test('escalates to SIGKILL when forge ignores SIGTERM on timeout (FR-37)', async (t) => {
  const pidFile = path.join(tempDir(), 'forge.pid')
  killRecordedPids(t, pidFile)
  const started = Date.now()
  const result = await run('ignore-sigterm', {
    timeoutMs: 1000,
    env: { FAKE_FORGE_PIDFILE: pidFile },
  })
  const elapsed = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.ok(elapsed < 15_000, `took ${elapsed} ms`)
  const forge = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(await waitUntilDead(forge), `forge ${forge} survived SIGKILL escalation`)
})
