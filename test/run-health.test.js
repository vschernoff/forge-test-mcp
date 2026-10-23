const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { classifyTestRun, HINTS } = require('../src/run-health')
const { errorResult } = require('../src/tool-result')

// Real `forge test` outputs recorded from forge 1.8.5 and 1.8.6 in the Phase 1 spike
// (forge-test-mcp-spike/scripts/record-samples.mjs). Local paths are replaced by placeholders.
const SAMPLES_DIR = path.join(__dirname, 'fixtures', 'forge-samples')

const EXPECTED = {
  pass: { healthy: true, counts: { passed: 4, failed: 0 } },
  'fail-assert': { healthy: true, counts: { passed: 1, failed: 1 } },
  'fail-fuzz': { healthy: true, counts: { passed: 1, failed: 1 } },
  'fail-invariant': { healthy: true, counts: { passed: 1, failed: 1 } },
  'custom-errors': { healthy: true, counts: { passed: 1, failed: 7 } },
  // setUp() failure is reported as a failing pseudo-test: the run did execute.
  'edge-setup-skip-logs': { healthy: true, counts: { passed: 1, failed: 5, skipped: 1 } },
  'compile-error': { code: 'COMPILE_FAILED' },
  'no-match': { code: 'NO_TESTS_RAN' },
  'usage-error': { code: 'INVALID_ARGUMENTS' },
  'not-a-project': { code: 'NOT_A_FOUNDRY_PROJECT' },
  'solc-missing': { code: 'SOLC_MISSING' },
  panic: { code: 'FORGE_CRASHED' },
  'config-error': { code: 'CONFIG_ERROR' },
}

function loadSamples() {
  const samples = []
  for (const version of fs.readdirSync(SAMPLES_DIR)) {
    for (const file of fs.readdirSync(path.join(SAMPLES_DIR, version))) {
      const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, version, file), 'utf8'))
      samples.push({ version, name: path.basename(file, '.json'), sample })
    }
  }
  return samples
}

function asRun(sample, overrides = {}) {
  return {
    code: sample.code,
    signal: sample.signal,
    timedOut: false,
    outputTruncated: false,
    spawnError: null,
    stdout: sample.stdout,
    stderr: sample.stderr,
    ...overrides,
  }
}

function syntheticRun(overrides) {
  return asRun({ code: 0, signal: null, stdout: '', stderr: '' }, overrides)
}

const samples = loadSamples()

test('every recorded sample has an expectation, for both forge versions', () => {
  assert.deepEqual(
    [...new Set(samples.map((s) => s.version))].sort(),
    ['1.8.5', '1.8.6'],
    'samples for both pinned versions'
  )
  for (const { version, name } of samples) {
    assert.ok(EXPECTED[name], `no expectation for ${version}/${name}`)
  }
  for (const name of Object.keys(EXPECTED)) {
    assert.equal(samples.filter((s) => s.name === name).length, 2, `${name} on both versions`)
  }
})

for (const { version, name, sample } of samples) {
  test(`real forge ${version}: ${name} → ${EXPECTED[name]?.code ?? 'healthy'}`, () => {
    const expected = EXPECTED[name]
    const verdict = classifyTestRun(asRun(sample))
    if (expected.healthy) {
      assert.equal(verdict.healthy, true, JSON.stringify(verdict))
      for (const [key, value] of Object.entries(expected.counts)) {
        assert.equal(verdict.counts[key], value, `${key}`)
      }
    } else {
      assert.equal(verdict.healthy, false)
      assert.equal(verdict.code, expected.code, JSON.stringify(verdict))
      assert.ok(verdict.message && verdict.hint, 'every error carries a message and a hint')
    }
  })
}

test('no-match keeps forge’s own explanation for the agent', () => {
  const sample = samples.find((s) => s.name === 'no-match').sample
  const verdict = classifyTestRun(asRun(sample))
  assert.match(verdict.forgeSays, /no tests match the provided pattern/)
  assert.match(verdict.forgeSays, /doesNotExist_xyz/)
})

test('timeout, truncation and spawn failures are errors even if output looks clean', () => {
  const clean = samples.find((s) => s.name === 'pass').sample
  assert.equal(classifyTestRun(asRun(clean, { timedOut: true })).code, 'TIMEOUT')
  assert.equal(classifyTestRun(asRun(clean, { outputTruncated: true })).code, 'OUTPUT_TOO_LARGE')
  assert.equal(
    classifyTestRun(syntheticRun({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }))
      .code,
    'FORGE_NOT_FOUND'
  )
  assert.equal(
    classifyTestRun(asRun(clean, { code: null, signal: 'SIGKILL' })).code,
    'FORGE_CRASHED'
  )
})

test('forge 1.7-style plain-text "no tests" output is not a clean run', () => {
  // Recorded from forge 1.7.1 in the spike: exit 0, plain text on stdout.
  for (const stdout of [
    'No tests found in project! Forge looks for functions that start with `test`\n',
    'Warning: no tests match the provided pattern:\n\tmatch-test: `x`\n',
  ]) {
    assert.equal(classifyTestRun(syntheticRun({ stdout })).code, 'UNPARSEABLE_OUTPUT')
  }
})

test('JSON that is not a test report is not a clean run', () => {
  for (const stdout of ['[]', 'null', '"ok"', '42', '{"a":1}', '{"s":{"test_results":[]}}']) {
    const verdict = classifyTestRun(syntheticRun({ stdout }))
    assert.equal(verdict.code, 'UNPARSEABLE_OUTPUT', stdout)
  }
  const unknownStatus = JSON.stringify({ s: { test_results: { 't()': { status: 'Passed' } } } })
  assert.equal(classifyTestRun(syntheticRun({ stdout: unknownStatus })).code, 'UNPARSEABLE_OUTPUT')
})

test('a report whose tests were all skipped is not a clean run', () => {
  const stdout = JSON.stringify({ s: { test_results: { 't()': { status: 'Skipped' } } } })
  const verdict = classifyTestRun(syntheticRun({ stdout }))
  assert.equal(verdict.code, 'NO_TESTS_RAN')
  assert.match(verdict.message, /skipped/)
})

test('an exit code that disagrees with the report is not trusted', () => {
  const failing = JSON.stringify({ s: { test_results: { 't()': { status: 'Failure' } } } })
  const passing = JSON.stringify({ s: { test_results: { 't()': { status: 'Success' } } } })
  assert.equal(
    classifyTestRun(syntheticRun({ stdout: failing, code: 0 })).code,
    'INCONSISTENT_RESULT'
  )
  assert.equal(
    classifyTestRun(syntheticRun({ stdout: passing, code: 1 })).code,
    'INCONSISTENT_RESULT'
  )
})

test('empty output is never a pass', () => {
  assert.equal(classifyTestRun(syntheticRun({ code: 0 })).code, 'UNPARSEABLE_OUTPUT')
  assert.equal(classifyTestRun(syntheticRun({ code: 1 })).code, 'FORGE_FAILED')
})

test('no unhealthy verdict can be read as a passing run (FR-35)', () => {
  const verdicts = [
    ...samples.map(({ sample }) => classifyTestRun(asRun(sample))),
    classifyTestRun(syntheticRun({ stdout: '{}' })),
    classifyTestRun(syntheticRun({ timedOut: true })),
  ]
  for (const verdict of verdicts.filter((v) => !v.healthy)) {
    const result = errorResult(verdict)
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent, undefined, 'errors carry no structured "report"')
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error.code, verdict.code)
    assert.equal(payload.counts?.failed ?? 0, 0)
    assert.ok(!('status' in payload), 'no passed/failed status on an error')
  }
  for (const verdict of verdicts.filter((v) => v.healthy)) {
    assert.ok(verdict.counts.passed + verdict.counts.failed > 0)
  }
})

test('every error code has a hint', () => {
  for (const [code, hint] of Object.entries(HINTS)) assert.ok(hint.length > 10, code)
})
