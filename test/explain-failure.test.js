const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createContext } = require('../src/context')
const { explainFailure } = require('../src/explain-failure')
const { tempDir } = require('./helpers/tmp')

const SCRIPTED = [process.execPath, path.join(__dirname, 'helpers', 'scripted-forge.js')]

function project() {
  const root = tempDir('ftm-explain-')
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\n')
  return root
}

/** Text output with one failing test whose trace has `calls` passing calls before the revert. */
function deepTraceOutput(calls) {
  const lines = [
    'Ran 1 test for test/Deep.t.sol:DeepTest',
    '[FAIL: deep failure: 1 != 2] test_deep() (gas: 1)',
    'Traces:',
    '  [1] DeepTest::test_deep()',
  ]
  for (let i = 0; i < calls; i++) {
    lines.push(`    ├─ [26382] Counter::increment()`, `    │   └─ ← [Stop]`)
  }
  lines.push(
    '    ├─ [0] VM::assertEq(1, 2, "deep failure") [staticcall]',
    '    │   └─ ← [Revert] deep failure: 1 != 2',
    '    └─ ← [Revert] deep failure: 1 != 2',
    '',
    'Backtrace:',
    '  at VM.assertEq',
    '  at DeepTest.test_deep',
    '',
    'Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 1ms (1ms CPU time)'
  )
  return `${lines.join('\n')}\n`
}

async function explain(stdout, args) {
  const root = project()
  const out = path.join(root, 'forge-test-stdout.txt')
  const log = path.join(root, 'forge-calls.log')
  fs.writeFileSync(out, stdout)
  const context = createContext({
    forge: SCRIPTED,
    startDir: root,
    env: {
      ...process.env,
      SCRIPTED_FORGE_TEST_STDOUT: out,
      SCRIPTED_FORGE_TEST_CODE: '1',
      SCRIPTED_FORGE_LOG: log,
    },
    options: { allowFfi: false, strictVersion: false, timeoutMs: 10_000 },
  })
  const result = await explainFailure(context, args)
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  return { result, payload: JSON.parse(result.content[0].text), calls }
}

test('a trace over the budget falls back to the path to the revert (FR-33)', async () => {
  const { result, payload } = await explain(deepTraceOutput(200), {
    test: 'DeepTest.test_deep()',
    max_bytes: 4096,
  })
  assert.equal(result.isError, undefined)
  assert.ok(Buffer.byteLength(result.content[0].text) <= 4096)
  assert.deepEqual(payload.trace, [
    '[1] DeepTest::test_deep()',
    '  ├─ [0] VM::assertEq(1, 2, "deep failure") [staticcall]',
    '  │   └─ ← [Revert] deep failure: 1 != 2',
    '  └─ ← [Revert] deep failure: 1 != 2',
  ])
  assert.equal(payload.truncated.traceLinesOmitted, 400)
  assert.deepEqual(payload.backtrace, ['VM.assertEq', 'DeepTest.test_deep'])
})

test('a trace within the budget is returned whole', async () => {
  const { payload } = await explain(deepTraceOutput(3), { test: 'test_deep' })
  assert.equal(payload.trace.length, 10)
  assert.equal(payload.truncated, undefined)
})

test('the forge command anchors the test name and passes the contract (no shell)', async () => {
  const { calls } = await explain(deepTraceOutput(1), { test: 'DeepTest.test_deep()' })
  assert.deepEqual(calls, [
    ['test', '--offline', '-vvvv', '--match-test=^test_deep\\(', '--match-contract=^DeepTest$'],
  ])
})
