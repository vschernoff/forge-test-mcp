const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { build, locate } = require('../src/build')
const { runTests } = require('../src/run-tests')
const { createContext } = require('../src/context')

const SCRIPTED = [process.execPath, path.join(__dirname, 'helpers', 'scripted-forge.js')]

function project(files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-build-')))
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\n')
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}

function entry(severity, file, line, code = '2072', message = 'Unused local variable.') {
  return {
    sourceLocation: { file, start: 0, end: 1 },
    type: severity === 'error' ? 'TypeError' : 'Warning',
    severity,
    errorCode: code,
    message,
    formattedMessage: `${severity}: ${message}\n --> ${file}:${line}:9:\n`,
  }
}

async function runBuild(output, { code = 0, args = {}, root = project(), env = {} } = {}) {
  const stdout = path.join(root, 'build-stdout.json')
  const log = path.join(root, 'calls.log')
  fs.writeFileSync(stdout, typeof output === 'string' ? output : JSON.stringify(output))
  const context = createContext({
    forge: SCRIPTED,
    startDir: root,
    env: {
      ...process.env,
      SCRIPTED_FORGE_BUILD_STDOUT: stdout,
      SCRIPTED_FORGE_BUILD_CODE: String(code),
      SCRIPTED_FORGE_LOG: log,
      ...env,
    },
    options: { allowFfi: false, strictVersion: false, timeoutMs: 10_000 },
  })
  const result = await build(context, args)
  return {
    result,
    payload: JSON.parse(result.content[0].text),
    calls: fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
  }
}

const fresh = (errors) => ({ errors, sources: { 'src/A.sol': [] }, contracts: { 'src/A.sol': {} } })

test('status comes from the diagnostics, not the exit code (forge 1.7.1 exits 0 on errors)', async () => {
  const { result, payload } = await runBuild(fresh([entry('error', 'src/Broken.sol', 13, '9574')]))
  assert.equal(result.isError, undefined)
  assert.equal(payload.status, 'failed')
  assert.deepEqual(payload.errors[0], {
    file: 'src/Broken.sol',
    line: 13,
    column: 9,
    severity: 'error',
    type: 'TypeError',
    code: '9574',
    message: 'Unused local variable.',
  })
})

test('a failing exit code without any compiler error is not trusted', async () => {
  const { result, payload } = await runBuild(fresh([]), { code: 1 })
  assert.equal(result.isError, true)
  assert.equal(payload.error.code, 'INCONSISTENT_RESULT')
})

test('a cached build says warnings are unknown instead of reporting none (FR-34)', async () => {
  const { payload } = await runBuild({ errors: [], sources: {}, contracts: {}, build_infos: [] })
  assert.equal(payload.status, 'passed')
  assert.equal(payload.compiled, 'cached')
  assert.equal(payload.summary.warnings, null)
  assert.equal('warnings' in payload, false)
  assert.match(payload.note, /force: true/)
})

test('force: true recompiles; forge-lint is always off (D19 Q7)', async () => {
  const { calls } = await runBuild(fresh([]), { args: { force: true } })
  assert.deepEqual(calls, [['build', '--json', '--offline', '--no-lint', '--force']])
})

test('the project’s own diagnostics come before dependencies’, and the budget holds', async () => {
  const many = [
    ...Array.from({ length: 150 }, (_, i) => entry('warning', 'lib/dep/src/Dep.sol', i + 1)),
    entry('warning', 'src/Mine.sol', 7),
  ]
  const { result, payload } = await runBuild(fresh(many), { args: { max_bytes: 4096 } })
  assert.ok(Buffer.byteLength(result.content[0].text) <= 4096)
  assert.equal(payload.warnings[0].file, 'src/Mine.sol')
  assert.equal(payload.summary.warnings, 151)
  assert.equal(payload.warnings.length + payload.truncated.warningsOmitted, 151)
})

test('output that is not a build report is an error, not a clean build', async () => {
  for (const output of ['not json', '{"sources":{}}']) {
    const { result, payload } = await runBuild(output)
    assert.equal(result.isError, true, output)
    assert.equal(payload.error.code, 'UNPARSEABLE_OUTPUT')
  }
})

test('locate falls back to the byte offset when solc gives no position', () => {
  const root = project({ 'src/A.sol': 'line one\nline two\n  target here\n' })
  const start = Buffer.byteLength('line one\nline two\n  ')
  assert.deepEqual(locate(root, { sourceLocation: { file: 'src/A.sol', start } }), {
    file: 'src/A.sol',
    line: 3,
    column: 3,
  })
  assert.deepEqual(locate(root, {}), { file: null, line: null, column: null })
})

// Compiler messages quote source literals, so a key pasted into a contract comes back in them.
const KEY = `0x${'33'.repeat(32)}`
const leak = () =>
  entry(
    'error',
    'src/Leak.sol',
    3,
    '9574',
    `Type literal_string "${KEY}" is not implicitly convertible to expected type uint256.`
  )

test('a secret quoted in a compiler message is redacted in build results (D19 Q6)', async () => {
  const { result, payload } = await runBuild(fresh([leak()]), {
    code: 1,
    env: { DEPLOYER_PRIVATE_KEY: KEY },
  })
  assert.ok(!result.content[0].text.includes('33'.repeat(32)))
  assert.match(payload.errors[0].message, /literal_string "\[redacted:DEPLOYER_PRIVATE_KEY\]"/)
})

test('a secret quoted in a compile error is redacted on the run_tests error path too', async () => {
  const root = project()
  const buildOut = path.join(root, 'build-stdout.json')
  fs.writeFileSync(buildOut, JSON.stringify(fresh([leak()])))
  const context = createContext({
    forge: SCRIPTED,
    startDir: root,
    env: {
      ...process.env,
      DEPLOYER_PRIVATE_KEY: KEY,
      SCRIPTED_FORGE_TEST_STDOUT: '',
      SCRIPTED_FORGE_TEST_STDERR: `Error: Compiler run failed:\nError (9574): Type literal_string "${KEY}"\n`,
      SCRIPTED_FORGE_TEST_CODE: '1',
      SCRIPTED_FORGE_BUILD_STDOUT: buildOut,
      SCRIPTED_FORGE_BUILD_CODE: '1',
    },
    options: { allowFfi: false, strictVersion: false, timeoutMs: 10_000 },
  })
  const result = await runTests(context, {})
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.error.code, 'COMPILE_FAILED')
  assert.ok(!result.content[0].text.includes('33'.repeat(32)), 'key leaked')
  assert.match(payload.stderr, /\[redacted:DEPLOYER_PRIVATE_KEY\]/)
  assert.match(payload.compilerErrors[0].message, /\[redacted:DEPLOYER_PRIVATE_KEY\]/)
})
