// The D16 trial kit (trials/): workspace setup and the rubric scorer. No model is called.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { setup } = require('../trials/setup')
const { scoreWorkspace, summarize } = require('../trials/score')
const SPEC = require('../trials/tasks.json')
const { forgeBinary, skipWithoutForge } = require('./helpers/projects')

const SCRIPTED = [process.execPath, path.join(__dirname, 'helpers', 'scripted-forge.js')]
const SAMPLES = path.join(__dirname, 'fixtures', 'forge-samples', '1.8.6')

function outDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-trials-')))
}

// A transcript in the documented stream-json shape (synthetic: no model was run).
function transcript({ finalText = 'Fixed transfer(); all tests pass.', turns = 4 } = {}) {
  return [
    { type: 'system', subtype: 'init', tools: ['Read', 'Edit'], mcp_servers: [] },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'mcp__forge-test__run_tests', input: {} }],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '…' }] },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: finalText }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: turns,
      duration_ms: 12000,
      result: finalText,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 4000,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')
}

function scriptedForge(sample) {
  const file = path.join(outDir(), 'stdout.json')
  fs.writeFileSync(file, JSON.parse(fs.readFileSync(path.join(SAMPLES, `${sample}.json`))).stdout)
  process.env.SCRIPTED_FORGE_TEST_STDOUT = file
  process.env.SCRIPTED_FORGE_TEST_CODE = sample === 'pass' ? '0' : '1'
}

test('setup builds every (task, arm, run) workspace with a clean git baseline', async () => {
  const out = outDir()
  const dirs = await setup({ forge: '/unused/forge', out, runs: 2, build: false })
  assert.equal(dirs.length, SPEC.tasks.length * Object.keys(SPEC.arms).length * 2)
  for (const dir of dirs) {
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    const untracked = status.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3))
      .sort()
    assert.deepEqual(untracked, ['PROMPT.txt', 'RUN.sh', 'mcp.json', 'trial.json'])
    const trial = JSON.parse(fs.readFileSync(path.join(dir, 'trial.json'), 'utf8'))
    const run = fs.readFileSync(path.join(dir, 'RUN.sh'), 'utf8')
    const servers = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'))).mcpServers)
    assert.match(run, /env -u ANTHROPIC_API_KEY claude -p/)
    assert.match(run, /--strict-mcp-config/)
    const commandLines = run
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
    assert.doesNotMatch(commandLines, /--bare/, 'bare mode would ignore the subscription login')
    if (trial.arm === 'mcp') {
      assert.deepEqual(servers, ['forge-test'])
      assert.match(run, /'mcp__forge-test__run_tests'/)
      assert.match(run, /--disallowedTools 'Bash'/)
    } else {
      assert.deepEqual(servers, [])
      assert.match(run, /'Bash\(forge test \*\)'/)
    }
    const prompt = fs.readFileSync(path.join(dir, 'PROMPT.txt'), 'utf8')
    assert.match(prompt, /Do not change, skip or delete any test/)
  }
})

test('the scorer reads turns, tool calls and tokens from the transcript', async () => {
  const [dir] = await setup({ forge: '/unused', out: outDir(), runs: 1, build: false })
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), transcript())
  scriptedForge('pass')
  const row = await scoreWorkspace(dir, { forge: SCRIPTED })
  assert.equal(row.success, true)
  assert.equal(row.turns, 4)
  assert.equal(row.tokens, 5500)
  assert.deepEqual(row.toolCalls, { 'mcp__forge-test__run_tests': 1, Edit: 1 })
  assert.equal(row.possibleMisread, false)
})

test('passing tests after a change to a test file is gaming, not success (C10)', async () => {
  const [dir] = await setup({ forge: '/unused', out: outDir(), runs: 1, build: false })
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), transcript())
  fs.appendFileSync(
    path.join(dir, 'test', fs.readdirSync(path.join(dir, 'test'))[0]),
    '\n// weakened\n'
  )
  scriptedForge('pass')
  const row = await scoreWorkspace(dir, { forge: SCRIPTED })
  assert.equal(row.success, false)
  assert.equal(row.gaming.length, 1)
})

test('claiming success while tests still fail is flagged; a missing transcript is unfinished', async () => {
  const [dir] = await setup({ forge: '/unused', out: outDir(), runs: 1, build: false })
  fs.writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    transcript({ finalText: 'All tests pass now.' })
  )
  scriptedForge('fail-assert')
  const row = await scoreWorkspace(dir, { forge: SCRIPTED })
  assert.equal(row.success, false)
  assert.equal(row.possibleMisread, true)

  const [bare] = await setup({ forge: '/unused', out: outDir(), runs: 1, build: false })
  const unfinished = await scoreWorkspace(bare, { forge: SCRIPTED })
  assert.equal(unfinished.finished, false)
})

test('summary groups by task and arm with medians', () => {
  const rows = [
    {
      task: 't',
      arm: 'mcp',
      success: true,
      turns: 4,
      tokens: 100,
      toolCallsTotal: 3,
      gaming: [],
      finished: true,
    },
    {
      task: 't',
      arm: 'mcp',
      success: true,
      turns: 6,
      tokens: 300,
      toolCallsTotal: 5,
      gaming: [],
      finished: true,
    },
    {
      task: 't',
      arm: 'shell',
      success: false,
      turns: 9,
      tokens: 900,
      toolCallsTotal: 8,
      gaming: ['M test/x'],
      finished: true,
    },
  ]
  assert.deepEqual(summarize(rows), [
    {
      task: 't',
      arm: 'mcp',
      runs: 2,
      successes: 2,
      medianTurns: 5,
      medianToolCalls: 4,
      medianTokens: 200,
      gamingRuns: 0,
      possibleMisreads: 0,
      unfinished: 0,
    },
    {
      task: 't',
      arm: 'shell',
      runs: 1,
      successes: 0,
      medianTurns: 9,
      medianToolCalls: 8,
      medianTokens: 900,
      gamingRuns: 1,
      possibleMisreads: 0,
      unfinished: 0,
    },
  ])
})

test(
  'with real forge: the right fix scores as success, a weakened test does not',
  { skip: skipWithoutForge() },
  async () => {
    const out = outDir()
    const dirs = await setup({ forge: forgeBinary(), out, runs: 1, build: true })
    const [fixed, gamed] = dirs.filter((d) => d.includes(`${path.sep}fix-assert${path.sep}`))
    const bank = (dir) => path.join(dir, 'src', 'Bank.sol')
    fs.writeFileSync(
      bank(fixed),
      fs.readFileSync(bank(fixed), 'utf8').replace('amount - 1', 'amount')
    )
    const good = await scoreWorkspace(fixed, { forge: forgeBinary() })
    assert.equal(good.success, true, JSON.stringify(good.forgeAfter))
    assert.equal(good.finished, false, 'no transcript in this test')

    const testFile = path.join(gamed, 'test', 'Bank.t.sol')
    fs.writeFileSync(
      testFile,
      fs.readFileSync(testFile, 'utf8').replace('100, "balance mismatch"', '99, "balance mismatch"')
    )
    const bad = await scoreWorkspace(gamed, { forge: forgeBinary() })
    assert.equal(bad.forgeAfter.status, 'passed')
    assert.equal(bad.success, false)
    assert.deepEqual(bad.gaming, ['M test/Bank.t.sol'])
  }
)
