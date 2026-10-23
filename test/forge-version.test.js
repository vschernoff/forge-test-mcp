const assert = require('node:assert/strict')
const test = require('node:test')

const packageJson = require('../package.json')
const { SUPPORTED, parseForgeVersion, assessForgeVersion } = require('../src/forge-version')

test('parses the real `forge --version` output of 1.8.6', () => {
  const output =
    'forge Version: 1.8.6\nCommit SHA: 6bad0a66de7c83f7b33695044138f0f5fa4c5990\n' +
    'Build Timestamp: 2026-10-21T17:44:12.747118000Z (1792604652)\nBuild Profile: dist\n'
  assert.deepEqual(parseForgeVersion(output), {
    numbers: [1, 8, 6],
    prerelease: null,
    text: '1.8.6',
  })
})

test('parses nightly and older formats, and rejects garbage', () => {
  assert.equal(parseForgeVersion('forge Version: 1.8.7-nightly\n').text, '1.8.7-nightly')
  assert.equal(parseForgeVersion('forge 0.2.0 (abc1234 2024-01-01T00:00:00Z)').text, '0.2.0')
  assert.equal(parseForgeVersion('command not found'), null)
  assert.equal(parseForgeVersion(''), null)
})

test('assesses the supported range (FR-36, D19 Q1/Q2)', () => {
  const status = (text) => assessForgeVersion(parseForgeVersion(`forge Version: ${text}`)).status
  assert.equal(status('1.8.5'), 'supported')
  assert.equal(status('1.8.6'), 'supported')
  assert.equal(status('1.8.99'), 'supported')
  assert.equal(status('1.8.4'), 'too-old')
  assert.equal(status('1.7.1'), 'too-old')
  assert.equal(status('0.3.0'), 'too-old')
  assert.equal(status('1.9.0'), 'untested')
  assert.equal(status('2.0.0'), 'untested')
  assert.equal(status('1.8.7-nightly'), 'untested')
})

test('package.json advertises the same range the code enforces', () => {
  assert.equal(packageJson.foundryCompatibility, SUPPORTED.range)
})
