const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createContext } = require('../src/context')
const { tempDir } = require('./helpers/tmp')

// A fake forge that only answers `--version` with FAKE_FORGE_VERSION_OUTPUT.
const FAKE = path.join(os.tmpdir(), 'ftm-fake-version-forge.js')
fs.writeFileSync(FAKE, 'process.stdout.write(process.env.FAKE_FORGE_VERSION_OUTPUT ?? "")\n')

function project() {
  const root = tempDir('ftm-context-')
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\n')
  return root
}

function context(versionOutput, options = {}, startDir = project()) {
  return createContext({
    forge: [process.execPath, FAKE],
    startDir,
    env: { ...process.env, FAKE_FORGE_VERSION_OUTPUT: versionOutput },
    options: { allowFfi: false, strictVersion: false, timeoutMs: 10_000, ...options },
  })
}

test('a supported forge passes, with the project root resolved', async () => {
  const root = project()
  const ready = await context('forge Version: 1.8.6\n', {}, path.join(root)).prepare()
  assert.equal(ready.forgeVersion, '1.8.6')
  assert.equal(ready.root, root)
  assert.equal(ready.untested, null)
})

test('forge older than 1.8.5 is refused with an install hint (FR-36)', async () => {
  const ready = await context('forge Version: 1.7.1\n').prepare()
  assert.equal(ready.ok, false)
  assert.equal(ready.code, 'UNSUPPORTED_FORGE_VERSION')
  assert.match(ready.message, /1\.7\.1 is older than the supported range >=1\.8\.5 <1\.9\.0/)
  assert.match(ready.hint, /foundryup -i 1\.8\.6/)
})

test('newer forge runs but is flagged, unless --strict-version (D19 Q2)', async () => {
  const lenient = await context('forge Version: 1.9.0\n').prepare()
  assert.equal(lenient.forgeVersion, '1.9.0')
  assert.match(lenient.untested, /newer than the tested range/)
  const strict = await context('forge Version: 1.9.0\n', { strictVersion: true }).prepare()
  assert.equal(strict.code, 'UNSUPPORTED_FORGE_VERSION')
})

test('unreadable version output is refused, not assumed fine', async () => {
  const ready = await context('something else\n').prepare()
  assert.equal(ready.code, 'UNSUPPORTED_FORGE_VERSION')
})

test('a missing forge binary is FORGE_NOT_FOUND', async () => {
  const ctx = createContext({
    forge: path.join(os.tmpdir(), 'definitely-not-forge-here'),
    startDir: project(),
    options: { allowFfi: false, strictVersion: false, timeoutMs: 10_000 },
  })
  const ready = await ctx.prepare()
  assert.equal(ready.code, 'FORGE_NOT_FOUND')
})

test('no foundry.toml is NOT_A_FOUNDRY_PROJECT before forge is even asked', async () => {
  const empty = tempDir('ftm-context-empty-')
  fs.mkdirSync(path.join(empty, '.git'))
  const ready = await context('forge Version: 1.8.6\n', {}, empty).prepare()
  assert.equal(ready.code, 'NOT_A_FOUNDRY_PROJECT')
})

test('withLock runs tasks for one root one at a time', async () => {
  const ctx = context('forge Version: 1.8.6\n')
  const order = []
  const task = (name, ms) => () =>
    new Promise((resolve) => {
      order.push(`start ${name}`)
      setTimeout(() => {
        order.push(`end ${name}`)
        resolve(name)
      }, ms)
    })
  await Promise.all([ctx.withLock('/r', task('a', 50)), ctx.withLock('/r', task('b', 10))])
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b'])
})

// Recorded from forge-test-mcp's Docker CI: the official v1.8.6 Alpine build calls itself
// 1.8.6-dev, but its commit is the v1.8.6 release commit.
const ALPINE_1_8_6 =
  'forge Version: 1.8.6-dev\nCommit SHA: 6bad0a66de7c83f7b33695044138f0f5fa4c5990\n' +
  'Build Timestamp: 2026-10-21T17:36:15.539564462Z (1792604175)\nBuild Profile: dist\n'

test('a -dev build of a release commit counts as that release, even with --strict-version', async () => {
  const ready = await context(ALPINE_1_8_6, { strictVersion: true }).prepare()
  assert.equal(ready.forgeVersion, '1.8.6')
  assert.equal(ready.untested, null)
})

test('a pre-release build of any other commit is flagged as pre-release', async () => {
  const nightly =
    'forge Version: 1.8.6-nightly\nCommit SHA: 4e8874b2bdc840929585ca73e170993c50a4a531\n'
  const lenient = await context(nightly).prepare()
  assert.match(lenient.untested, /a pre-release build, not a tested release/)
  const strict = await context(nightly, { strictVersion: true }).prepare()
  assert.equal(strict.code, 'UNSUPPORTED_FORGE_VERSION')
  assert.match(strict.message, /is a pre-release build and --strict-version is set/)
})
