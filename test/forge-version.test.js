const assert = require('node:assert/strict')
const test = require('node:test')

const packageJson = require('../package.json')
const {
  SUPPORTED,
  RELEASE_COMMITS,
  parseForgeVersion,
  assessForgeVersion,
} = require('../src/forge-version')

test('parses the real `forge --version` output of 1.8.6', () => {
  const output =
    'forge Version: 1.8.6\nCommit SHA: 6bad0a66de7c83f7b33695044138f0f5fa4c5990\n' +
    'Build Timestamp: 2026-10-21T17:44:12.747118000Z (1792604652)\nBuild Profile: dist\n'
  assert.deepEqual(parseForgeVersion(output), {
    numbers: [1, 8, 6],
    prerelease: null,
    commit: '6bad0a66de7c83f7b33695044138f0f5fa4c5990',
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

test('a pre-release label on a release commit is that release; any other commit is not', () => {
  const assess = (text) => assessForgeVersion(parseForgeVersion(text))
  const dev = (commit) => `forge Version: 1.8.6-dev\nCommit SHA: ${commit}\n`
  assert.deepEqual(assess(dev(RELEASE_COMMITS['1.8.6'])), {
    status: 'supported',
    version: '1.8.6',
    build: '1.8.6-dev',
  })
  // The 1.8.5 commit does not make a build that says 1.8.6 into a release.
  assert.equal(assess(dev(RELEASE_COMMITS['1.8.5'])).status, 'untested')
  assert.equal(assess(dev('0'.repeat(40))).reason, 'prerelease')
  assert.equal(assess('forge Version: 1.8.6-dev\n').status, 'untested', 'no commit, no match')
  assert.equal(assess('forge Version: 1.9.0\n').reason, 'newer')
})

test('release commits match the D18-verified provenance (VERIFICATION.md)', () => {
  assert.deepEqual(RELEASE_COMMITS, {
    '1.8.5': '51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f',
    '1.8.6': '6bad0a66de7c83f7b33695044138f0f5fa4c5990',
  })
})
