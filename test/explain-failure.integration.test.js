// End-to-end trace excerpts in run_tests and explain_failure (FR-31, FR-33), with real forge.
const assert = require('node:assert/strict')
const test = require('node:test')

const { startServer } = require('./helpers/mcp-client')
const { forgeBinary, makeProject, skipWithoutForge } = require('./helpers/projects')

const skip = skipWithoutForge()

async function call(root, tool, args = {}) {
  const server = startServer({ cwd: root, args: ['--forge', forgeBinary()] })
  try {
    await server.initialize()
    const response = await server.callTool(tool, args, 240_000)
    assert.ok(response.result, JSON.stringify(response.error))
    assert.deepEqual(server.invalidLines, [])
    const text = response.result.content[0].text
    return { isError: response.result.isError === true, payload: JSON.parse(text), text }
  } finally {
    await server.stop()
  }
}

test('run_tests attaches the path to the revert and the backtrace (FR-31)', { skip }, async () => {
  const { payload } = await call(await makeProject('edge-cases'), 'run_tests')
  const deep = payload.failures.find((f) => f.test === 'EdgeTest.test_deepTrace()')
  assert.deepEqual(deep.trace, [
    '[381330] EdgeTest::test_deepTrace()',
    '  ├─ [0] VM::assertEq(1, 2, "deep failure") [staticcall]',
    '  │   └─ ← [Revert] deep failure: 1 != 2',
    '  └─ ← [Revert] deep failure: 1 != 2',
  ])
  assert.equal(deep.traceLinesOmitted, 28)
  assert.deepEqual(deep.backtrace, ['VM.assertEq', 'EdgeTest.test_deepTrace'])
  assert.equal(payload.traces, undefined, 'every traceable failure was traced')
})

test('a fuzz failure reproduces in the trace pass (FR-31)', { skip }, async () => {
  const { payload } = await call(await makeProject('fuzz-failure'), 'run_tests')
  const [f] = payload.failures
  assert.ok(
    f.trace.some((line) => /MathHarness::square/.test(line)),
    f.trace.join('\n')
  )
  assert.ok(f.trace.some((line) => /\(0x11\)/.test(line)))
})

test('traces: false skips the second run', { skip }, async () => {
  const { payload } = await call(await makeProject('assert-failure'), 'run_tests', {
    traces: false,
  })
  assert.equal(payload.failures[0].trace, undefined)
})

test(
  'explain_failure returns one invariant failure with its sequence and full trace (FR-33)',
  { skip },
  async () => {
    const { isError, payload } = await call(
      await makeProject('invariant-failure'),
      'explain_failure',
      {
        test: 'SupplyInvariantTest.invariant_supplyMatches()',
      }
    )
    assert.equal(isError, false)
    assert.equal(payload.status, 'failed')
    assert.match(payload.reason, /^supply mismatch: \d+ != \d+$/)
    assert.ok(
      payload.details.some((l) => /calldata=mint\(uint256\)/.test(l)),
      payload.details.join('\n')
    )
    assert.ok(!payload.details.some((l) => /Selector/.test(l)), 'metrics table dropped')
    assert.ok(payload.trace.some((l) => /SupplyInvariantTest::invariant_supplyMatches\(\)/.test(l)))
    assert.ok(payload.trace.some((l) => /← \[Revert\] supply mismatch/.test(l)))
    assert.equal(payload.truncated, undefined)
  }
)

test('explain_failure stays within a small budget (FR-32, FR-33)', { skip }, async () => {
  const root = await makeProject('invariant-failure')
  const { text, payload } = await call(root, 'explain_failure', {
    test: 'invariant_supplyMatches',
    max_bytes: 2048,
  })
  assert.equal(payload.test, 'SupplyInvariantTest.invariant_supplyMatches()')
  assert.ok(Buffer.byteLength(text) <= 2048 + 600, `${Buffer.byteLength(text)} bytes`)
  assert.match(payload.trace.at(-1), /← \[Revert\] supply mismatch/)
})

test(
  'explain_failure on a passing test says it passes; on a missing one it is an error',
  { skip },
  async () => {
    const root = await makeProject('assert-failure')
    const passing = await call(root, 'explain_failure', { test: 'BankTest.test_credit()' })
    assert.equal(passing.isError, false)
    assert.equal(passing.payload.status, 'passed')
    assert.equal(passing.payload.reason, null)

    const missing = await call(root, 'explain_failure', { test: 'test_doesNotExist' })
    assert.equal(missing.isError, true)
    assert.equal(missing.payload.error.code, 'NO_TESTS_RAN')

    const invalid = await call(root, 'explain_failure', { test: 'a; rm -rf /' })
    assert.equal(invalid.payload.error.code, 'INVALID_ARGUMENTS')
  }
)

test('explain_failure keeps FFI off and redacts secrets (FR-38a, D19 Q6)', { skip }, async () => {
  const ffi = await call(await makeProject('ffi-enabled'), 'explain_failure', {
    test: 'FfiTest.test_ffiWritesMarker()',
  })
  assert.equal(ffi.payload.ffi, 'disabled-by-server')
  assert.match(ffi.payload.reason, /FFI is disabled/)

  const secret = await call(await makeProject('secret-env'), 'explain_failure', {
    test: 'test_leaksDotenv',
  })
  assert.ok(
    !secret.text.includes('1111111111111111111111111111111111111111111111111111111111111111')
  )
  assert.ok(!secret.text.includes('dummy-etherscan-token-for-tests'))
  assert.match(secret.payload.reason, /\[redacted:DEPLOYER_PRIVATE_KEY\]/)
})

test('a compile error is an error for explain_failure too (FR-35)', { skip }, async () => {
  const { isError, payload } = await call(await makeProject('compile-error'), 'explain_failure', {
    test: 'test_increment',
  })
  assert.equal(isError, true)
  assert.equal(payload.error.code, 'COMPILE_FAILED')
})
