// The trace pass of run_tests against a scripted fake forge (review of #4: each test kills a
// mutant that survived the integration suite).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createContext } = require('../src/context')
const { runTests } = require('../src/run-tests')

const SCRIPTED = path.join(__dirname, 'helpers', 'scripted-forge.js')
const FIXTURES = path.join(__dirname, 'fixtures')

// A matching pair recorded from forge 1.8.6 on the edge-cases fixture: the JSON report and the
// -vvv text output of the same tests.
function project({ text = 'text-traces/1.8.6-edge-cases.txt' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-tracepass-')))
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\n')
  const sample = path.join(FIXTURES, 'forge-samples', '1.8.6', 'edge-setup-skip-logs.json')
  const json = path.join(root, '.json-stdout')
  fs.writeFileSync(json, JSON.parse(fs.readFileSync(sample, 'utf8')).stdout)
  const textOut = path.join(root, '.text-stdout')
  fs.writeFileSync(textOut, text ? fs.readFileSync(path.join(FIXTURES, text), 'utf8') : '')
  return { root, json, textOut, log: path.join(root, '.test-calls.log') }
}

function context({ root, json, textOut, log }, env = {}) {
  return createContext({
    forge: [process.execPath, SCRIPTED],
    startDir: root,
    env: {
      ...process.env,
      SCRIPTED_FORGE_LOG: log,
      SCRIPTED_FORGE_TEST_STDOUT: json,
      SCRIPTED_FORGE_TEST_CODE: '1',
      SCRIPTED_FORGE_TEXT_STDOUT: textOut,
      SCRIPTED_FORGE_TEXT_CODE: '1',
      ...env,
    },
    options: { allowFfi: false, strictVersion: false, timeoutMs: 20_000 },
  })
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text)
}

test('the trace pass runs offline, on exactly the failing tests (FR-31, FR-38b)', async () => {
  const p = project()
  const payload = payloadOf(await runTests(context(p)))
  const calls = fs.readFileSync(p.log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 2, 'one JSON run, one trace pass')
  assert.deepEqual(calls[1], [
    'test',
    '--offline',
    '-vvv',
    '--match-contract=^(EdgeTest)$',
    // Anchored on "(" because forge matches the full signature; a looser pattern would re-run
    // other tests too (test_deepTrace must not match test_deepTraceTwo).
    '--match-test=^(test_deepTrace|test_forkWithoutRpc|test_hugeRevertString|test_logsThenFails)\\(',
  ])
  const deep = payload.failures.find((f) => f.test === 'EdgeTest.test_deepTrace()')
  assert.equal(deep.trace.length, 4)
  assert.equal(payload.traces, undefined)
})

test('a trace pass that fails leaves the verdict and failures intact', async () => {
  const p = project({ text: null })
  const payload = payloadOf(await runTests(context(p, { SCRIPTED_FORGE_TEXT_CODE: '0' })))
  assert.equal(payload.status, 'failed')
  assert.equal(payload.summary.failed, 5)
  assert.match(payload.traces, /^unavailable: /)
  assert.ok(payload.failures.every((f) => f.trace === undefined))
})

test('a trace pass that throws leaves the verdict and failures intact', async () => {
  const p = project()
  const ctx = context(p)
  let calls = 0
  const original = ctx.withLock
  ctx.withLock = (root, task) =>
    calls++ === 0 ? original(root, task) : Promise.reject(new Error('trace pass exploded'))
  const result = await runTests(ctx)
  assert.equal(result.isError, undefined)
  const payload = payloadOf(result)
  assert.equal(payload.status, 'failed')
  assert.equal(payload.summary.failed, 5)
  assert.equal(payload.traces, 'unavailable: trace pass exploded')
})
