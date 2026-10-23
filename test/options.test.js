const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { parseOptions } = require('../src/options')

test('defaults: cwd, forge on PATH, 300 s, FFI off, lenient version', () => {
  assert.deepEqual(parseOptions([], '/work'), {
    root: '/work',
    forge: 'forge',
    timeoutMs: 300_000,
    allowFfi: false,
    strictVersion: false,
  })
})

test('parses every flag, in both --flag value and --flag=value forms', () => {
  const options = parseOptions(
    ['--root', 'pkg', '--forge=/opt/forge', '--timeout=12.5', '--allow-ffi', '--strict-version'],
    '/work'
  )
  assert.equal(options.root, path.resolve('/work', 'pkg'))
  assert.equal(options.forge, '/opt/forge')
  assert.equal(options.timeoutMs, 12_500)
  assert.equal(options.allowFfi, true)
  assert.equal(options.strictVersion, true)
})

test('rejects unknown flags and bad values instead of guessing', () => {
  assert.throws(() => parseOptions(['--ffi']), /Unknown option --ffi/)
  assert.throws(() => parseOptions(['--timeout', '0']), /--timeout must be > 0/)
  assert.throws(() => parseOptions(['--timeout']), /needs a value/)
})
