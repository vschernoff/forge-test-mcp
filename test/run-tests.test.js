// run_tests against a scripted fake forge: the guarantees a real forge cannot be made to test
// on demand (review of #3: each test below kills a mutant that survived the integration suite).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createContext } = require('../src/context')
const { runTests } = require('../src/run-tests')
const { killRecordedPids } = require('./helpers/cleanup')
const { startServer } = require('./helpers/mcp-client')
const { tempDir } = require('./helpers/tmp')

const SCRIPTED = path.join(__dirname, 'helpers', 'scripted-forge.js')
const SAMPLE = path.join(__dirname, 'fixtures', 'forge-samples', '1.8.6', 'fail-assert.json')
const KEY = '0x2222222222222222222222222222222222222222222222222222222222222222'

function project() {
  const root = tempDir('ftm-runtests-')
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\n')
  const stdout = path.join(root, '.forge-stdout.json')
  fs.writeFileSync(stdout, JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).stdout)
  return { root, stdout, calls: path.join(root, '.forge-calls.log') }
}

function readCalls(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
}

async function run({ env = {}, options = {}, args = {} } = {}) {
  const { root, stdout, calls } = project()
  const context = createContext({
    forge: [process.execPath, SCRIPTED],
    startDir: root,
    env: {
      ...process.env,
      SCRIPTED_FORGE_CALLS: calls,
      SCRIPTED_FORGE_TEST_STDOUT: stdout,
      SCRIPTED_FORGE_TEST_CODE: '1',
      ...env,
    },
    options: { allowFfi: false, strictVersion: false, timeoutMs: 20_000, ...options },
  })
  const result = await runTests(context, args)
  return { result, payload: JSON.parse(result.content[0].text), calls: readCalls(calls) }
}

test('every forge call except --version runs with --offline (FR-38b)', async () => {
  const { payload, calls } = await run()
  assert.equal(payload.status, 'failed')
  const offlineable = calls.filter((call) => call.args[0] !== '--version')
  assert.ok(
    offlineable.some((call) => call.args[0] === 'test'),
    'the test run itself is checked'
  )
  for (const call of offlineable) {
    assert.ok(call.args.includes('--offline'), `missing --offline: ${call.args.join(' ')}`)
  }
})

test('error results are redacted too, not only reports (D19 Q6)', async () => {
  const { result, payload } = await run({
    env: {
      DEPLOYER_PRIVATE_KEY: KEY,
      SCRIPTED_FORGE_TEST_STDOUT: '',
      SCRIPTED_FORGE_TEST_STDERR: `Error: could not load signer ${KEY} (${BigInt(KEY)})\n`,
    },
  })
  assert.equal(result.isError, true)
  assert.equal(payload.error.code, 'FORGE_FAILED')
  const text = result.content[0].text
  assert.ok(!text.includes(KEY.slice(2)), 'hex key leaked')
  assert.ok(!text.includes(BigInt(KEY).toString()), 'decimal key leaked')
  assert.match(
    payload.stderr,
    /\[redacted:DEPLOYER_PRIVATE_KEY\] \(\[redacted:DEPLOYER_PRIVATE_KEY\]\)/
  )
})

const FFI_ON = {
  SCRIPTED_FORGE_CONFIG_JSON: '{"ffi":true,"fuzz":{"runs":256},"fs_permissions":[]}',
  SCRIPTED_FORGE_CONFIG_TOML: '[profile.default]\nsrc = "src"\nffi = true\n',
}

test('FFI override that forge does not honour stops the run before any test (FR-38a)', async () => {
  const { result, payload, calls } = await run({
    env: {
      ...FFI_ON,
      // forge still reports ffi = true through the override
      SCRIPTED_FORGE_CONFIG_JSON_OVERRIDDEN: '{"ffi":true,"fuzz":{"runs":256}}',
    },
  })
  assert.equal(result.isError, true)
  assert.equal(payload.error.code, 'FFI_OVERRIDE_FAILED')
  assert.deepEqual(
    calls.filter((call) => call.args[0] === 'test'),
    [],
    'no test ran with FFI possibly on'
  )
})

test('an honoured FFI override is what the test run actually gets (FR-38a)', async () => {
  const { payload, calls } = await run({
    env: { ...FFI_ON, SCRIPTED_FORGE_CONFIG_JSON_OVERRIDDEN: '{"ffi":false,"fuzz":{"runs":256}}' },
  })
  assert.equal(payload.ffi, 'disabled-by-server')
  const testCall = calls.find((call) => call.args[0] === 'test')
  assert.match(testCall.foundryConfig, /^ffi = false$/m)
  assert.doesNotMatch(testCall.foundryConfig, /^ffi = true$/m)
  assert.match(testCall.foundryConfig, /^src = "src"$/m, 'the rest of the config is kept')
})

test('a forge newer than the tested range is flagged in the result (D19 Q2)', async () => {
  const { payload } = await run({ env: { SCRIPTED_FORGE_VERSION: 'forge Version: 1.9.0\n' } })
  assert.equal(payload.forge, '1.9.0')
  assert.match(payload.forgeUntested, /outside the tested range >=1\.8\.5 <1\.9\.0/)
  const { payload: supported } = await run()
  assert.equal(supported.forgeUntested, undefined)
})

test(
  'stopping the server kills a running forge and what it started (FR-37)',
  { skip: process.platform === 'win32' && 'needs an executable script as the forge binary' },
  async (t) => {
    const { root, calls } = project()
    const wrapper = path.join(root, 'forge')
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPTED}" "$@"\n`)
    fs.chmodSync(wrapper, 0o755)
    const pids = path.join(root, '.forge-pids')
    killRecordedPids(t, pids)
    const server = startServer({
      cwd: root,
      args: ['--forge', wrapper],
      env: { SCRIPTED_FORGE_TEST_HANG: pids, SCRIPTED_FORGE_CALLS: calls },
    })
    await server.initialize()
    server.callTool('run_tests', {}).catch(() => {})
    const until = Date.now() + 20_000
    while (!fs.existsSync(pids) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const [forge, descendant] = fs.readFileSync(pids, 'utf8').split(' ').map(Number)
    await server.stop()
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const deadline = Date.now() + 5000
    while ((alive(forge) || alive(descendant)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(alive(forge), false, `forge ${forge} outlived the server`)
    assert.equal(alive(descendant), false, `descendant ${descendant} outlived the server`)
  }
)
