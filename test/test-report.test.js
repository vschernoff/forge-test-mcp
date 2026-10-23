const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { summarizeReport, cleanText } = require('../src/test-report')

const SAMPLES = path.join(__dirname, 'fixtures', 'forge-samples')

function report(version, name) {
  const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES, version, `${name}.json`), 'utf8'))
  return JSON.parse(sample.stdout)
}

for (const version of ['1.8.5', '1.8.6']) {
  test(`forge ${version}: invariant failure comes from invariant_failures[] with its sequence`, () => {
    const { failures } = summarizeReport(report(version, 'fail-invariant'))
    assert.equal(failures.length, 1)
    const [f] = failures
    assert.equal(f.test, 'SupplyInvariantTest.invariant_supplyMatches()')
    assert.equal(f.kind, 'invariant')
    assert.equal(f.reason, 'supply mismatch: 6683 != 6355')
    assert.deepEqual(
      f.sequence.calls.map((c) => `${c.call}(${c.args})`),
      ['Handler.mint(uint256)(6683)', 'Handler.burnFrom(uint256)(328)']
    )
    assert.equal(f.sequence.shrunkFrom, 4)
  })

  test(`forge ${version}: fuzz failure keeps raw args, calldata and seed`, () => {
    const { failures } = summarizeReport(report(version, 'fail-fuzz'))
    const [f] = failures
    assert.equal(f.kind, 'fuzz')
    assert.match(f.counterexample.args, /^\d+$/, 'raw args, without the " [1.3e39]" annotation')
    assert.match(f.counterexample.calldata, /^0x08e9b940/)
    assert.equal(f.counterexample.seed, '0x5eed')
  })

  test(`forge ${version}: setUp failure is kind setup and listed in notRun`, () => {
    const { failures, notRun } = summarizeReport(report(version, 'edge-setup-skip-logs'))
    const setUp = failures.find((f) => f.test === 'SetUpFailsTest.setUp()')
    assert.equal(setUp.kind, 'setup')
    assert.equal(setUp.reason, 'setUp exploded')
    assert.deepEqual(notRun, ['SetUpFailsTest: setUp() failed, so none of its tests ran'])
    const logs = failures.find((f) => f.test === 'EdgeTest.test_logsThenFails()').logs
    assert.deepEqual(logs, ['about to fail, number = 0', 'custom log: 42'])
  })

  test(`forge ${version}: passing tests produce no failures`, () => {
    assert.deepEqual(summarizeReport(report(version, 'pass')), { failures: [], notRun: [] })
  })
}

test('handles the forge 1.7 shape: top-level reason and Sequence', () => {
  const legacy = {
    'test/A.t.sol:A': {
      test_results: {
        'invariant_x()': {
          status: 'Failure',
          reason: 'broken',
          counterexample: {
            Sequence: [
              3,
              [
                {
                  contract_name: 'test/A.t.sol:H',
                  signature: 'f(uint256)',
                  raw_args: '1',
                  sender: '0x1',
                },
              ],
            ],
          },
          kind: { Invariant: {} },
        },
      },
    },
  }
  const [f] = summarizeReport(legacy).failures
  assert.equal(f.reason, 'broken')
  assert.deepEqual(f.sequence, {
    calls: [{ call: 'H.f(uint256)', args: '1', sender: '0x1' }],
    shrunkFrom: 3,
  })
})

test('long sequences keep the last calls and count the rest', () => {
  const calls = Array.from({ length: 30 }, (_, i) => ({
    contract_name: 'H',
    signature: `f${i}()`,
    raw_args: '',
  }))
  const r = {
    's:C': {
      test_results: {
        'invariant_y()': {
          status: 'Failure',
          reason: null,
          invariant_failures: [
            {
              kind: 'predicate',
              name: 'invariant_y',
              reason: 'r',
              counterexample: { Sequence: [30, calls] },
            },
          ],
          kind: { Invariant: {} },
        },
      },
    },
  }
  const [f] = summarizeReport(r).failures
  assert.equal(f.sequence.calls.length, 12)
  assert.equal(f.sequence.earlierCallsOmitted, 18)
  assert.equal(f.sequence.calls.at(-1).call, 'H.f29()')
})

test('a failure without any reason says so instead of an empty string', () => {
  const r = {
    's:C': { test_results: { 't()': { status: 'Failure', reason: null, kind: { Unit: {} } } } },
  }
  assert.equal(summarizeReport(r).failures[0].reason, '(forge reported no failure reason)')
})

test('cleanText escapes control characters, collapses NUL runs and caps length', () => {
  assert.equal(cleanText('\u0000'.repeat(4000)), '\\x00×4000')
  assert.equal(cleanText('a\u001bb'), 'a\\x1bb')
  assert.equal(cleanText('x'.repeat(310)), `${'x'.repeat(300)}… (+10 chars)`)
  assert.equal(cleanText(null), null)
})
