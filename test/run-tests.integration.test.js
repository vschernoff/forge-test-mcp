// End-to-end: the real server over stdio, driving a real forge (FORGE_BIN) on fixture projects.
// CI runs this for every forge version in the compatibility matrix (FR-36).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { startServer } = require('./helpers/mcp-client')
const { forgeBinary, makeProject, skipWithoutForge } = require('./helpers/projects')

const skip = skipWithoutForge()
const CALL_TIMEOUT_MS = 240_000

async function callTool(root, tool, args = {}, serverArgs = []) {
  const server = startServer({ cwd: root, args: ['--forge', forgeBinary(), ...serverArgs] })
  try {
    await server.initialize()
    const response = await server.callTool(tool, args, CALL_TIMEOUT_MS)
    assert.ok(response.result, JSON.stringify(response.error))
    // FR-40: forge's own output never reached the protocol channel.
    assert.deepEqual(server.invalidLines, [])
    const text = response.result.content[0].text
    return { isError: response.result.isError === true, payload: JSON.parse(text), text }
  } finally {
    await server.stop()
  }
}

function callRunTests(root, args = {}, serverArgs = []) {
  return callTool(root, 'run_tests', args, serverArgs)
}

function failure(payload, test) {
  const found = payload.failures.find((f) => f.test === test)
  assert.ok(found, `no failure ${test} in ${JSON.stringify(payload.failures.map((f) => f.test))}`)
  return found
}

test('a passing project reports passed with counts', { skip }, async () => {
  const { isError, payload } = await callRunTests(await makeProject('passing'))
  assert.equal(isError, false)
  assert.equal(payload.status, 'passed')
  assert.deepEqual(payload.summary, { suites: 1, passed: 4, failed: 0, skipped: 0 })
  assert.deepEqual(payload.failures, [])
  assert.match(payload.forge, /^1\.\d+\.\d+/)
  assert.equal(payload.ffi, 'disabled')
})

test('an assertion failure carries its message (FR-31)', { skip }, async () => {
  const { payload } = await callRunTests(await makeProject('assert-failure'))
  assert.equal(payload.status, 'failed')
  const f = failure(payload, 'BankTest.test_transfer()')
  assert.equal(f.kind, 'unit')
  assert.equal(f.reason, 'balance mismatch: 99 != 100')
  assert.equal(f.file, 'test/Bank.t.sol')
})

test('a fuzz failure carries the counterexample (FR-31)', { skip }, async () => {
  const { payload } = await callRunTests(await makeProject('fuzz-failure'))
  const f = failure(payload, 'MathTest.testFuzz_squareIsMonotonic(uint256)')
  assert.equal(f.kind, 'fuzz')
  assert.match(f.reason, /0x11/)
  assert.ok(BigInt(f.counterexample.args) >= 2n ** 128n, f.counterexample.args)
  assert.match(f.counterexample.calldata, /^0x[0-9a-f]+$/)
})

test('an invariant failure carries the call sequence (FR-31)', { skip }, async () => {
  const { payload } = await callRunTests(await makeProject('invariant-failure'))
  const f = failure(payload, 'SupplyInvariantTest.invariant_supplyMatches()')
  assert.equal(f.kind, 'invariant')
  assert.match(f.reason, /^supply mismatch: \d+ != \d+$/)
  const calls = f.sequence.calls.map((c) => c.call)
  assert.ok(calls.includes('Handler.mint(uint256)'), calls.join(','))
  assert.ok(calls.indexOf('Handler.mint(uint256)') < calls.lastIndexOf('Handler.burnFrom(uint256)'))
})

test('custom errors and panics are decoded (FR-31)', { skip }, async () => {
  const { payload } = await callRunTests(await makeProject('custom-errors'))
  assert.equal(payload.summary.failed, 7)
  assert.match(
    failure(payload, 'VaultTest.test_withdrawMoreThanBalance()').reason,
    /^InsufficientBalance\(0x[0-9a-fA-F]{40}, 0, 1000000000000000000/
  )
  assert.equal(failure(payload, 'VaultTest.test_withdrawWhenPaused()').reason, 'Paused()')
  assert.match(failure(payload, 'VaultTest.test_panicDivZero()').reason, /\(0x12\)$/)
  assert.equal(
    failure(payload, 'VaultTest.test_undeclaredSelector()').reason,
    'custom error 0xdeadbeef'
  )
})

test('setUp failure, logs, skips and a 4 KB NUL revert are reported sanely', { skip }, async () => {
  const { payload, text } = await callRunTests(await makeProject('edge-cases'))
  assert.deepEqual(payload.notRun, ['SetUpFailsTest: setUp() failed, so none of its tests ran'])
  assert.equal(failure(payload, 'SetUpFailsTest.setUp()').kind, 'setup')
  assert.deepEqual(failure(payload, 'EdgeTest.test_logsThenFails()').logs, [
    'about to fail, number = 0',
    'custom log: 42',
  ])
  assert.equal(failure(payload, 'EdgeTest.test_hugeRevertString()').reason, '\\x00×4000')
  assert.equal(payload.summary.skipped, 1)
  assert.ok(!text.includes('\\u0000'), 'no raw NULs in the response')
})

test('a compile error is isError COMPILE_FAILED, never 0 failed (FR-35)', { skip }, async () => {
  const { isError, payload } = await callRunTests(await makeProject('compile-error'))
  assert.equal(isError, true)
  assert.equal(payload.error.code, 'COMPILE_FAILED')
  assert.match(payload.stderr, /src\/Broken\.sol:13/)
  assert.ok(!('status' in payload))
})

test('a filter that matches nothing is isError NO_TESTS_RAN (FR-35)', { skip }, async () => {
  const { isError, payload } = await callRunTests(await makeProject('passing'), {
    match_test: 'doesNotExist_xyz',
  })
  assert.equal(isError, true)
  assert.equal(payload.error.code, 'NO_TESTS_RAN')
  assert.match(payload.forgeSays, /no tests match/)
})

test('a filter value that looks like a flag is matched literally', { skip }, async () => {
  const root = await makeProject('ffi-enabled')
  const { payload } = await callRunTests(root, { match_test: '--ffi' })
  assert.equal(payload.error.code, 'NO_TESTS_RAN')
  assert.equal(fs.existsSync(path.join(root, 'ffi-marker.txt')), false)
})

test(
  'a directory without foundry.toml is isError NOT_A_FOUNDRY_PROJECT (FR-35)',
  { skip },
  async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-empty-'))
    fs.mkdirSync(path.join(empty, '.git'))
    const { isError, payload } = await callRunTests(empty)
    assert.equal(isError, true)
    assert.equal(payload.error.code, 'NOT_A_FOUNDRY_PROJECT')
  }
)

test(
  'FFI stays off when foundry.toml enables it, and no marker is written (FR-38a)',
  { skip },
  async () => {
    const root = await makeProject('ffi-enabled')
    const { payload } = await callRunTests(root)
    assert.equal(payload.ffi, 'disabled-by-server')
    assert.match(failure(payload, 'FfiTest.test_ffiWritesMarker()').reason, /FFI is disabled/)
    assert.equal(fs.existsSync(path.join(root, 'ffi-marker.txt')), false)
    // The override lives in a temp dir; the project's own foundry.toml is untouched.
    assert.match(fs.readFileSync(path.join(root, 'foundry.toml'), 'utf8'), /^ffi = true$/m)
  }
)

test(
  'FFI runs only when the user starts the server with --allow-ffi (FR-38a)',
  { skip: skip || (process.platform === 'win32' && 'the fixture runs `sh`') },
  async () => {
    const root = await makeProject('ffi-enabled')
    const { payload } = await callRunTests(root, {}, ['--allow-ffi'])
    assert.equal(payload.ffi, 'enabled-by-user')
    assert.equal(payload.status, 'passed')
    assert.equal(fs.existsSync(path.join(root, 'ffi-marker.txt')), true)
  }
)

test('a run that exceeds the timeout is isError TIMEOUT (FR-37)', { skip }, async () => {
  const started = Date.now()
  const { isError, payload } = await callRunTests(await makeProject('hang'), {}, ['--timeout', '8'])
  assert.equal(isError, true)
  assert.equal(payload.error.code, 'TIMEOUT')
  assert.ok(Date.now() - started < 60_000)
  if (process.platform !== 'win32') {
    // No forge process from this binary may outlive the run.
    const { spawnSync } = require('node:child_process')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const left = spawnSync('pgrep', ['-f', `${forgeBinary()} test`], { encoding: 'utf8' })
    assert.equal(left.stdout.trim(), '', `forge still running: ${left.stdout}`)
  }
})

test(
  '200 failures fit the default 8 KB budget and say what was cut (FR-32)',
  { skip },
  async () => {
    const root = await makeProject('many-failures')
    const small = await callRunTests(root)
    assert.ok(Buffer.byteLength(small.text) <= 8192, `${Buffer.byteLength(small.text)} bytes`)
    assert.equal(small.payload.summary.failed, 200)
    const t = small.payload.truncated
    assert.ok(t.shownInFull + t.shownWithoutTraceOrLogs + t.namesOnly.length + t.notListed === 200)
    assert.equal(small.payload.failures.length, t.shownInFull + t.shownWithoutTraceOrLogs)
    // The first 5 failures carry trace excerpts (~600 B each), so fewer fit than without.
    assert.ok(small.payload.failures.length >= 25, `${small.payload.failures.length} in full`)
    assert.ok(small.payload.failures[0].trace, 'the first failure keeps its trace')

    const large = await callRunTests(root, { max_bytes: 65_536 })
    assert.ok(Buffer.byteLength(large.text) <= 65_536)
    assert.ok(large.payload.failures.length > small.payload.failures.length)
  }
)

test(
  'lowering fuzz runs below the project setting is flagged (C10, D19 Q5)',
  { skip },
  async () => {
    const { payload } = await callRunTests(await makeProject('fuzz-failure'), { fuzz_runs: 10 })
    assert.deepEqual(payload.fuzzRuns, { configured: 256, used: 10, reduced: true })
  }
)

test('values of secret-named .env variables are redacted (D19 Q6)', { skip }, async () => {
  const { payload, text } = await callRunTests(await makeProject('secret-env'))
  assert.ok(!text.includes('1111111111111111111111111111111111111111111111111111111111111111'))
  assert.ok(!text.includes('dummy-etherscan-token-for-tests'))
  const f = failure(payload, 'SecretTest.test_leaksDotenv()')
  assert.equal(f.reason, 'leaked [redacted:DEPLOYER_PRIVATE_KEY]')
  assert.deepEqual(f.logs, [
    'key [redacted:DEPLOYER_PRIVATE_KEY]',
    'token [redacted:ETHERSCAN_API_KEY]',
  ])
  // Read with vm.envUint, the same key reaches logs and the revert reason in decimal.
  const decimal = BigInt(`0x${'11'.repeat(32)}`).toString()
  assert.ok(!text.includes(decimal), 'decimal key leaked')
  const asNumber = failure(payload, 'SecretTest.test_leaksDotenvAsNumber()')
  assert.equal(asNumber.reason, '[redacted:DEPLOYER_PRIVATE_KEY]')
  assert.deepEqual(asNumber.logs, ['pk [redacted:DEPLOYER_PRIVATE_KEY]'])
  // D24: an RPC URL with an API key in it, printed by the test.
  assert.ok(!text.includes('dummyrpcapikey123456'), 'RPC URL leaked')
  const rpc = failure(payload, 'SecretTest.test_leaksRpcUrl()')
  assert.equal(rpc.reason, 'cannot reach [redacted:MAINNET_RPC_URL]')
  assert.deepEqual(rpc.logs, ['rpc [redacted:MAINNET_RPC_URL]'])
})

test('build returns structured compiler errors (FR-34)', { skip }, async () => {
  const { isError, payload } = await callTool(await makeProject('compile-error'), 'build')
  assert.equal(isError, false)
  assert.equal(payload.status, 'failed')
  assert.deepEqual(
    payload.errors.map(({ file, line, column, type, code }) => ({
      file,
      line,
      column,
      type,
      code,
    })),
    [{ file: 'src/Broken.sol', line: 13, column: 9, type: 'TypeError', code: '9574' }]
  )
})

test('build reports warnings, then says when a cached build cannot (FR-34)', { skip }, async () => {
  const root = await makeProject('warnings')
  const first = await callTool(root, 'build')
  assert.equal(first.payload.status, 'passed')
  assert.equal(first.payload.compiled, 'fresh')
  assert.deepEqual(
    first.payload.warnings.map(({ file, line, code }) => ({ file, line, code })),
    [{ file: 'src/Warn.sol', line: 6, code: '2072' }]
  )
  const second = await callTool(root, 'build')
  assert.equal(second.payload.compiled, 'cached')
  assert.equal(second.payload.summary.warnings, null)
  assert.equal('warnings' in second.payload, false)
  const forced = await callTool(root, 'build', { force: true })
  assert.equal(forced.payload.warnings.length, 1)
})

test(
  'run_tests on a broken build includes the compiler errors (FR-34, FR-35)',
  { skip },
  async () => {
    const { payload } = await callRunTests(await makeProject('compile-error'))
    assert.equal(payload.error.code, 'COMPILE_FAILED')
    assert.equal(payload.compilerErrorsTotal, 1)
    assert.equal(payload.compilerErrors[0].file, 'src/Broken.sol')
    assert.equal(payload.compilerErrors[0].line, 13)
  }
)
