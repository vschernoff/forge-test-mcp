// Packed smoke test (NFR-2): pack the package, install the tarball into a clean project, and
// drive the installed server over stdio. Checks what users actually get from npm, not the
// working tree. With FORGE_BIN set it also runs real tests through the installed copy.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const packageJson = require('../package.json')
const { startServer } = require('./helpers/mcp-client')
const { forgeBinary, makeProject } = require('./helpers/projects')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const IS_WINDOWS = process.platform === 'win32'
const EXPECTED_FILES = ['LICENSE', 'NOTICE', 'README.md', 'package.json']

function npm(args, cwd) {
  const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    shell: IS_WINDOWS, // npm.cmd cannot be spawned without a shell on Windows
    timeout: 300_000,
  })
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

async function main() {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-packed-')))
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', work], PACKAGE_ROOT))
  const files = packed.files.map((f) => f.path).sort()
  const unexpected = files.filter((f) => !f.startsWith('src/') && !EXPECTED_FILES.includes(f))
  assert.deepEqual(unexpected, [], 'only src/, README, LICENSE, NOTICE and package.json ship')
  for (const file of EXPECTED_FILES) assert.ok(files.includes(file), `${file} is in the tarball`)
  console.error(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes`)

  const consumer = path.join(work, 'consumer')
  fs.mkdirSync(consumer)
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"name":"consumer","private":true}\n')
  npm(['install', '--no-audit', '--no-fund', path.join(work, packed.filename)], consumer)
  const installed = path.join(consumer, 'node_modules', packageJson.name)
  const entry = path.join(installed, packageJson.bin[packageJson.name])
  assert.ok(fs.existsSync(entry), 'the bin entry is installed')

  // Without a Foundry project: handshake, tool list, and a run that must be an error.
  const empty = path.join(work, 'not-a-project')
  fs.mkdirSync(path.join(empty, '.git'), { recursive: true })
  const server = startServer({ cwd: empty, entry })
  try {
    const init = await server.initialize()
    assert.equal(init.result.serverInfo.name, packageJson.name)
    assert.ok(init.result.instructions.length <= 512)
    const tools = (await server.request('tools/list')).result.tools.map((t) => t.name).sort()
    assert.deepEqual(tools, ['build', 'explain_failure', 'run_tests'])
    const run = await server.callTool('run_tests', {})
    assert.equal(run.result.isError, true)
    assert.equal(JSON.parse(run.result.content[0].text).error.code, 'NOT_A_FOUNDRY_PROJECT')
    assert.deepEqual(server.invalidLines, [])
  } finally {
    await server.stop()
  }

  if (forgeBinary()) {
    const root = await makeProject('assert-failure')
    const real = startServer({ cwd: root, entry, args: ['--forge', forgeBinary()] })
    try {
      await real.initialize()
      const result = await real.callTool('run_tests', {}, 240_000)
      const payload = JSON.parse(result.result.content[0].text)
      assert.equal(payload.status, 'failed')
      assert.equal(payload.failures[0].reason, 'balance mismatch: 99 != 100')
      assert.deepEqual(real.invalidLines, [])
    } finally {
      await real.stop()
    }
    console.error('installed package ran real forge tests')
  } else {
    console.error('FORGE_BIN not set: skipped the real-forge run')
  }
  console.error('packed smoke test passed')
}

main().catch((error) => {
  console.error(error.stack ?? error.message)
  process.exitCode = 1
})
