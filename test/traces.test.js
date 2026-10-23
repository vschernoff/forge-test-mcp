const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { parseTextReport, revertPath } = require('../src/traces')
const { reasonFromHeader } = require('../src/explain-failure')
const { classifyTextRun } = require('../src/run-health')

// `forge test --offline -vvv` text output recorded from forge 1.8.5 and 1.8.6.
const DIR = path.join(__dirname, 'fixtures', 'text-traces')

function sample(version, name) {
  return fs.readFileSync(path.join(DIR, `${version}-${name}.txt`), 'utf8')
}

for (const version of ['1.8.5', '1.8.6']) {
  test(`forge ${version}: parses every test entry, ignoring the "Failing tests" recap`, () => {
    const tests = parseTextReport(sample(version, 'edge-cases'))
    assert.deepEqual([...tests.keys()].sort(), [
      'EdgeFuzzRejectTest.testFuzz_tooManyRejects(uint256)',
      'EdgeTest.test_deepTrace()',
      'EdgeTest.test_forkWithoutRpc()',
      'EdgeTest.test_hugeRevertString()',
      'EdgeTest.test_logsThenFails()',
      'EdgeTest.test_skipped()',
      'SetUpFailsTest.setUp()',
    ])
    assert.equal(tests.get('EdgeTest.test_skipped()').status, 'SKIP')
    const logs = tests.get('EdgeTest.test_logsThenFails()')
    assert.deepEqual(logs.logs, ['about to fail, number = 0', 'custom log: 42'])
    assert.deepEqual(logs.backtrace, ['VM.assertEq', 'EdgeTest.test_logsThenFails'])
  })

  test(`forge ${version}: a long trace shrinks to the path to the revert`, () => {
    const { trace } = parseTextReport(sample(version, 'edge-cases')).get(
      'EdgeTest.test_deepTrace()'
    )
    assert.equal(trace.length, 32)
    assert.deepEqual(revertPath(trace), {
      lines: [
        '[381330] EdgeTest::test_deepTrace()',
        '  ├─ [0] VM::assertEq(1, 2, "deep failure") [staticcall]',
        '  │   └─ ← [Revert] deep failure: 1 != 2',
        '  └─ ← [Revert] deep failure: 1 != 2',
      ],
      omitted: 28,
    })
  })

  test(`forge ${version}: the invariant excerpt is the failing invariant call`, () => {
    const entry = parseTextReport(sample(version, 'invariant-failure')).get(
      'SupplyInvariantTest.invariant_supplyMatches()'
    )
    assert.equal(entry.status, 'FAIL')
    const { lines } = revertPath(entry.trace)
    assert.equal(lines[0], '[21670] SupplyInvariantTest::invariant_supplyMatches()')
    assert.match(lines.at(-1), /← \[Revert\] supply mismatch: 6683 != 6355/)
    assert.equal(reasonFromHeader(entry.header), 'supply mismatch: 6683 != 6355')
    assert.match(entry.header, /\[Sequence\] \(original: 4, shrunk: 2\)/)
  })

  test(`forge ${version}: a nested revert keeps its enclosing call`, () => {
    const entry = parseTextReport(sample(version, 'fuzz-failure')).get(
      'MathTest.testFuzz_squareIsMonotonic(uint256)'
    )
    const { lines } = revertPath(entry.trace)
    assert.match(lines[1], /MathHarness::square/)
    assert.match(lines[2], /← \[Revert\] panic: arithmetic underflow or overflow \(0x11\)/)
    assert.match(
      reasonFromHeader(entry.header),
      /^panic: arithmetic underflow or overflow \(0x11\); counterexample: calldata=0x08e9b940/
    )
  })
}

test('text output without any suite is not a healthy run', () => {
  const base = { signal: null, timedOut: false, outputTruncated: false, spawnError: null }
  const noMatch = classifyTextRun({
    ...base,
    code: 0,
    stdout: 'No files changed, compilation skipped\n',
    stderr: 'Warning: no tests match the provided pattern:\n\tmatch-test: `^x\\(`\n',
  })
  assert.equal(noMatch.code, 'NO_TESTS_RAN')
  assert.match(noMatch.forgeSays, /no tests match/)

  const compile = classifyTextRun({
    ...base,
    code: 1,
    stdout: 'Compiling 22 files with Solc 0.8.37\n',
    stderr: 'Error: Compiler run failed:\nError (9574): …\n',
  })
  assert.equal(compile.code, 'COMPILE_FAILED')

  const contradicting = classifyTextRun({
    ...base,
    code: 0,
    stdout: 'Ran 1 test for t.sol:T\n[FAIL: x] test_a() (gas: 1)\n',
    stderr: '',
  })
  assert.equal(contradicting.code, 'INCONSISTENT_RESULT')
})

test('unknown text never throws; it simply yields no entries', () => {
  assert.equal(parseTextReport('garbage\n[FAIL without anything]\n').size, 0)
  assert.deepEqual(revertPath([]), { lines: [], omitted: 0 })
})
