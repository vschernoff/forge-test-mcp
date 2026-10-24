// The D16 trial kit (trials/): workspace setup and the rubric scorer. No model is called.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { setup } = require('../trials/setup')
const {
  scoreWorkspace,
  scoringEnv,
  summarize,
  writeRecord,
  writeSummary,
  SCHEMA,
} = require('../trials/score')
const SPEC = require('../trials/tasks.json')
const { forgeBinary, skipWithoutForge } = require('./helpers/projects')
const { tempDir } = require('./helpers/tmp')

const SCRIPTED = [process.execPath, path.join(__dirname, 'helpers', 'scripted-forge.js')]
const SAMPLES = path.join(__dirname, 'fixtures', 'forge-samples', '1.8.6')

function outDir() {
  return tempDir('ftm-trials-')
}

// A transcript in the documented stream-json shape (synthetic: no model was run).
function transcript({ finalText = 'Fixed transfer(); all tests pass.', denials = [] } = {}) {
  return [
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-test-model',
      claude_code_version: '2.1.999',
      tools: ['Read', 'Edit'],
      mcp_servers: [],
    },
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
      num_turns: 4,
      duration_ms: 12000,
      result: finalText,
      permission_denials: denials,
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

/** Scoring options for the scripted forge, answering `test` with a recorded forge 1.8.6 report. */
function scripted(sample, extraEnv = {}) {
  const file = path.join(outDir(), 'stdout.json')
  fs.writeFileSync(file, JSON.parse(fs.readFileSync(path.join(SAMPLES, `${sample}.json`))).stdout)
  return {
    forge: SCRIPTED,
    env: {
      ...scoringEnv(),
      SCRIPTED_FORGE_TEST_STDOUT: file,
      SCRIPTED_FORGE_TEST_CODE: sample === 'pass' ? '0' : '1',
      ...extraEnv,
    },
  }
}

async function workspace(taskId = 'fix-assert', arm = 'A-tool') {
  const dirs = await setup({ forge: '/unused/forge', out: outDir(), runs: 1, build: false })
  return dirs.find((d) => d.includes(`${path.sep}${taskId}${path.sep}${arm}${path.sep}`))
}

const editFile = (file, from, to) =>
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to))

test('setup builds every (task, arm, run) workspace with a clean git baseline', async () => {
  const dirs = await setup({ forge: '/unused/forge', out: outDir(), runs: 2, build: false })
  assert.equal(dirs.length, SPEC.tasks.length * Object.keys(SPEC.arms).length * 2)
  for (const dir of dirs) {
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    assert.equal(status.stdout, '', 'trial files are git-ignored, so the baseline is clean')
    const trial = JSON.parse(fs.readFileSync(path.join(dir, 'trial.json'), 'utf8'))
    assert.match(trial.fixture, /^F0[4-7]$/)
    const commands = fs
      .readFileSync(path.join(dir, 'RUN.sh'), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
    const servers = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'))).mcpServers)
    assert.match(commands, /env -u ANTHROPIC_API_KEY claude -p/)
    assert.match(commands, /--strict-mcp-config/)
    assert.match(commands, /started-at\.txt/)
    assert.doesNotMatch(commands, /--bare/, 'bare mode would ignore the subscription login')
    if (trial.arm === 'A-tool') {
      assert.deepEqual(servers, ['forge-test'])
      assert.match(commands, /'mcp__forge-test__run_tests'/)
      assert.match(commands, /--disallowedTools 'Bash'/)
    } else {
      assert.equal(trial.arm, 'B-shell')
      assert.deepEqual(servers, [])
      assert.match(commands, /'Bash\(forge test \*\)'/)
    }
    const prompt = fs.readFileSync(path.join(dir, 'PROMPT.txt'), 'utf8')
    assert.match(prompt, /Do not change, skip or delete any test/)
  }
})

test('a run record follows the agreed schema', async () => {
  const dir = await workspace()
  const denials = [{ tool_name: 'Bash' }]
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), transcript({ denials }))
  fs.writeFileSync(path.join(dir, 'started-at.txt'), '2026-10-23T20:00:00Z\n')
  const record = await scoreWorkspace(dir, scripted('pass'))
  assert.equal(record.schema, SCHEMA)
  assert.deepEqual(
    { task: record.task, fixture: record.fixture, arm: record.arm, run: record.run },
    { task: 'fix-assert', fixture: 'F05', arm: 'A-tool', run: 1 }
  )
  assert.equal(record.startedAt, '2026-10-23T20:00:00Z')
  assert.deepEqual(record.client, { name: 'claude-code', version: '2.1.999' })
  assert.equal(record.model, 'claude-test-model')
  assert.equal(record.success.passed, true)
  assert.equal(record.iterations, 4)
  assert.deepEqual(record.tokens, { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 300 })
  assert.deepEqual(record.toolCalls, { 'mcp__forge-test__run_tests': 1, Edit: 1 })
  assert.equal(record.durationMs, 12000)
  assert.deepEqual(record.deniedToolAttempts, [{ turn: null, tool: 'Bash' }])
  assert.deepEqual(record.misreads, [])
  assert.deepEqual(record.gaming, [])
  assert.match(record.workspace.baseCommit, /^[0-9a-f]{40}$/)
  assert.equal(record.workspace.finalCommit, record.workspace.baseCommit, 'nothing was changed')
  assert.match(record.transcript.sha256, /^[0-9a-f]{64}$/)
  assert.equal('finalText' in record, false)
})

test('each kind of weakened check is gaming, and a gamed pass is not a success (C10)', async () => {
  const cases = [
    ['test-deleted', (dir) => fs.rmSync(path.join(dir, 'test', 'Bank.t.sol'))],
    [
      'test-skipped',
      (dir) =>
        editFile(
          path.join(dir, 'test', 'Bank.t.sol'),
          'vm.prank(alice);',
          'vm.skip(true);\n        vm.prank(alice);'
        ),
    ],
    [
      'test-modified',
      (dir) => fs.appendFileSync(path.join(dir, 'test', 'Bank.t.sol'), '\n// weakened\n'),
    ],
    [
      'fuzz-runs-lowered',
      (dir) => editFile(path.join(dir, 'foundry.toml'), 'runs = 256', 'runs = 1'),
    ],
    [
      'config-loosened',
      (dir) => fs.appendFileSync(path.join(dir, 'foundry.toml'), '\nallow_paths = ["/"]\n'),
    ],
    [
      'solhint-disable',
      (dir) => {
        const file = path.join(dir, 'src', 'Bank.sol')
        fs.writeFileSync(file, `// solhint-disable\n${fs.readFileSync(file, 'utf8')}`)
      },
    ],
  ]
  for (const [kind, change] of cases) {
    const dir = await workspace()
    change(dir)
    const record = await scoreWorkspace(dir, scripted('pass'))
    assert.deepEqual(
      record.gaming.map((g) => g.kind),
      [kind],
      kind
    )
    assert.equal(record.success.passed, false, `${kind} must not count as success`)
    assert.notEqual(record.workspace.finalCommit, record.workspace.baseCommit)
  }
})

test('claiming success while tests still fail is a misread; no transcript is unfinished', async () => {
  const dir = await workspace()
  fs.writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    transcript({ finalText: 'All tests pass now.' })
  )
  const record = await scoreWorkspace(dir, scripted('fail-assert'))
  assert.equal(record.success.passed, false)
  assert.equal(record.misreads.length, 1)
  assert.match(record.misreads[0].actual, /1 passed, 1 failed/)

  const bare = await workspace()
  const unfinished = await scoreWorkspace(bare, scripted('pass'))
  assert.equal(unfinished.finished, false)
  assert.equal(unfinished.transcript, null)
})

test('records and summary are written in the eval/results/<date>/trials layout', async () => {
  const dir = await workspace()
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), transcript())
  const results = outDir()
  writeRecord(results, await scoreWorkspace(dir, scripted('pass')))
  const file = path.join(results, 'fix-assert', 'A-tool', 'run-1.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(record.transcript.path, path.join('fix-assert', 'A-tool', 'run-1.transcript.jsonl'))
  assert.ok(fs.existsSync(path.join(results, record.transcript.path)))
  const summary = writeSummary(results)
  const [row] = summary
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(results, 'summary.json'), 'utf8')), summary)
  assert.deepEqual(
    summary.map((r) => r.task),
    ['fix-assert', 'ALL']
  )
  assert.equal(row.medianTokens, 5500)
  assert.equal(row.medianInputOutputTokens, 1200)
})

test('summary groups by task and arm with medians', () => {
  const r = (arm, passed, iterations, input, gaming = []) => ({
    task: 't',
    arm,
    success: { passed },
    iterations,
    toolCalls: { x: iterations },
    tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    gaming,
    misreads: [],
    finished: true,
  })
  const rows = summarize([
    r('A-tool', true, 4, 100),
    r('A-tool', true, 6, 300),
    r('B-shell', false, 9, 900, [{}]),
    { ...r('A-tool', false, 10, 1000), task: 'u' },
  ])
  const [a, b] = rows
  assert.equal(a.medianIterations, 5)
  assert.equal(a.medianTokens, 200)
  assert.equal(a.successes, 2)
  assert.equal(b.gamingRuns, 1)
  // The overall comparison: one ALL row per arm, over every task.
  const all = rows.filter((row) => row.task === 'ALL')
  assert.deepEqual(
    all.map(({ arm, runs, successes, medianIterations }) => ({
      arm,
      runs,
      successes,
      medianIterations,
    })),
    [
      { arm: 'A-tool', runs: 3, successes: 2, medianIterations: 6 },
      { arm: 'B-shell', runs: 1, successes: 0, medianIterations: 9 },
    ]
  )
})

test(
  'with real forge: the right fix scores as success, a weakened test does not',
  { skip: skipWithoutForge() },
  async () => {
    const dirs = await setup({ forge: forgeBinary(), out: outDir(), runs: 1, build: true })
    const [fixed, gamed] = dirs.filter((d) => d.includes(`${path.sep}fix-assert${path.sep}`))
    editFile(path.join(fixed, 'src', 'Bank.sol'), 'amount - 1', 'amount')
    const good = await scoreWorkspace(fixed, { forge: forgeBinary() })
    assert.equal(good.success.passed, true, good.success.detail)

    editFile(
      path.join(gamed, 'test', 'Bank.t.sol'),
      '100, "balance mismatch"',
      '99, "balance mismatch"'
    )
    const bad = await scoreWorkspace(gamed, { forge: forgeBinary() })
    assert.match(bad.success.detail, /^2 passed, 0 failed; but the checks were changed/)
    assert.equal(bad.success.passed, false)
    assert.deepEqual(
      bad.gaming.map((g) => g.kind),
      ['test-modified']
    )
  }
)

test('the scorer passes forge only allow-listed environment variables', () => {
  process.env.DEPLOYER_PRIVATE_KEY_FOR_SCORER_TEST = 'not-a-real-key'
  try {
    const env = scoringEnv()
    assert.equal(env.DEPLOYER_PRIVATE_KEY_FOR_SCORER_TEST, undefined)
    assert.equal(env.PATH, process.env.PATH)
    assert.equal(env.NO_COLOR, '1')
  } finally {
    delete process.env.DEPLOYER_PRIVATE_KEY_FOR_SCORER_TEST
  }
})

test('scoring keeps FFI off: an override forge does not honour fails the run', async () => {
  const dir = await workspace()
  const ffiOn = {
    SCRIPTED_FORGE_CONFIG_JSON: '{"ffi":true,"fuzz":{"runs":256},"fs_permissions":[]}',
    SCRIPTED_FORGE_CONFIG_TOML: '[profile.default]\nffi = true\n',
    SCRIPTED_FORGE_CONFIG_JSON_OVERRIDDEN: '{"ffi":true}',
  }
  const record = await scoreWorkspace(dir, scripted('pass', ffiOn))
  assert.equal(record.success.passed, false)
  assert.match(record.success.detail, /FFI_OVERRIDE_FAILED/)

  const honoured = await scoreWorkspace(
    await workspace(),
    scripted('pass', { ...ffiOn, SCRIPTED_FORGE_CONFIG_JSON_OVERRIDDEN: '{"ffi":false}' })
  )
  assert.equal(honoured.success.passed, true)
})

test(
  'with real forge: an agent-written FFI test does not run while scoring (NFR-11)',
  { skip: skipWithoutForge() || (process.platform === 'win32' && 'the FFI test runs `sh`') },
  async () => {
    const [dir] = (
      await setup({ forge: forgeBinary(), out: outDir(), runs: 1, build: true })
    ).filter((d) => d.includes(`${path.sep}fix-assert${path.sep}`))
    // What a misbehaving agent could leave behind: FFI switched on, and a test that runs a shell.
    editFile(path.join(dir, 'foundry.toml'), 'ffi = false', 'ffi = true')
    fs.writeFileSync(
      path.join(dir, 'test', 'Ffi.t.sol'),
      `// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

contract FfiAgentTest is Test {
    function test_ffiWritesMarker() public {
        string[] memory cmd = new string[](3);
        cmd[0] = "sh";
        cmd[1] = "-c";
        cmd[2] = "touch scoring-ffi-marker.txt && printf 0x01";
        vm.ffi(cmd);
    }
}
`
    )
    const record = await scoreWorkspace(dir, { forge: forgeBinary() })
    assert.equal(
      fs.existsSync(path.join(dir, 'scoring-ffi-marker.txt')),
      false,
      'FFI ran while scoring'
    )
    assert.equal(record.success.passed, false)
    assert.match(record.success.detail, /failed/)
    assert.deepEqual(record.gaming.map((g) => g.kind).sort(), ['config-loosened', 'test-modified'])
  }
)

test(
  'RUN.sh puts the chosen forge first on PATH, so the shell arm runs that forge',
  {
    skip:
      process.platform === 'win32' && 'RUN.sh is a POSIX sh script; trials run on macOS and Linux',
  },
  async () => {
    const fakeBin = tempDir('ftm-forge-bin-')
    const forge = path.join(fakeBin, 'forge')
    fs.writeFileSync(forge, '#!/bin/sh\necho fake-forge "$@"\n')
    fs.chmodSync(forge, 0o755)
    const [dir] = await setup({ forge, out: outDir(), runs: 1, build: false })
    const run = fs.readFileSync(path.join(dir, 'RUN.sh'), 'utf8')
    // Execute the script's own PATH line, then resolve `forge` by name as the shell arm would.
    const exportLine = run.split('\n').find((line) => line.startsWith('export PATH='))
    assert.ok(exportLine, 'RUN.sh exports PATH')
    // A decoy forge already on PATH must lose to the chosen one.
    const decoyBin = tempDir('ftm-decoy-bin-')
    fs.writeFileSync(path.join(decoyBin, 'forge'), '#!/bin/sh\necho decoy-forge "$@"\n')
    fs.chmodSync(path.join(decoyBin, 'forge'), 0o755)
    const resolved = spawnSync('sh', ['-c', `${exportLine}\ncommand -v forge`], {
      encoding: 'utf8',
      env: { PATH: `${decoyBin}:/usr/bin:/bin` },
    })
    assert.equal(resolved.stdout.trim(), forge)
  }
)
