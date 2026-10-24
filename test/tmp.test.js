const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const HELPER = path.join(__dirname, 'helpers', 'tmp.js')

// A child process creates a temp dir with a file in it, prints the path and exits.
function createInChild(env = {}) {
  const script = `
    const fs = require('node:fs')
    const dir = require(${JSON.stringify(HELPER)}).tempDir('ftm-tmp-test-')
    fs.mkdirSync(dir + '/lib/forge-std', { recursive: true })
    fs.writeFileSync(dir + '/lib/forge-std/Test.sol', 'x')
    process.stdout.write(dir)
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('test temp dirs are removed when the test process exits', () => {
  const dir = createInChild({ FORGE_TEST_MCP_KEEP_TMP: '' })
  assert.ok(dir.includes('ftm-tmp-test-'))
  assert.equal(fs.existsSync(dir), false, `${dir} was left behind`)
})

test('FORGE_TEST_MCP_KEEP_TMP=1 keeps them for debugging', () => {
  const dir = createInChild({ FORGE_TEST_MCP_KEEP_TMP: '1' })
  try {
    assert.equal(fs.existsSync(path.join(dir, 'lib', 'forge-std', 'Test.sol')), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
