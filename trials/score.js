#!/usr/bin/env node
// Scores agent trial runs with real forge and fixed rules (no LLM judge). Each run becomes one
// JSON record (schema `forge-test-mcp/trial-run@1`), ready to file as evaluation evidence:
//
//   node trials/score.js --forge /abs/forge --results <dir> <workspace>...
//       writes <dir>/<task>/<arm>/run-<n>.json, run-<n>.transcript.jsonl and <dir>/summary.json
//   node trials/score.js --summary <dir>          prints (and rewrites) the summary
//
// Success is decided by running real forge on the workspace, never from what the agent said.
// Transcripts are Claude Code `--output-format stream-json --verbose` output; event shapes per
// code.claude.com/docs/en/headless and docs/en/agent-sdk (checked 2026-10-23).
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { prepareConfig } = require('../src/forge-config')
const { runProcess } = require('../src/forge-process')
const { classifyTestRun } = require('../src/run-health')

const SCHEMA = 'forge-test-mcp/trial-run@1'
const SUCCESS_CHECK =
  'forge test --json --offline with FFI forced off and an allow-listed env, classified by forge-test-mcp run-health (unparseable or no executed test = failure); plus no change to test/ or foundry.toml'
const CLAIMS_PASS =
  /\b(all|every)\b[^.\n]{0,40}\btests?\b[^.\n]{0,20}\bpass|tests? (now )?pass(es)?\b/i
const FORGE_TIMEOUT_MS = 300_000

// The scorer runs code an agent just edited. Like the server, it keeps FFI off whatever the
// project says (FR-38a), and it passes forge only what forge needs from the environment, so no
// key or token in the scorer's shell reaches the agent's tests.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SYSTEMROOT', 'USERPROFILE']

function scoringEnv() {
  const env = { NO_COLOR: '1' }
  for (const name of ENV_ALLOWLIST)
    if (process.env[name] !== undefined) env[name] = process.env[name]
  return env
}

function readTranscript(file) {
  const events = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      events.push({ type: 'unparseable', line: line.slice(0, 200) })
    }
  }
  return events
}

function transcriptMetrics(events) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {}
  const toolCalls = {}
  for (const event of events) {
    if (event.type !== 'assistant') continue
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1
    }
  }
  const result = [...events].reverse().find((event) => event.type === 'result') ?? null
  const usage = result?.usage ?? {}
  const n = (key) => Number(usage[key] ?? 0)
  return {
    client: { name: 'claude-code', version: init.claude_code_version ?? null },
    model: init.model ?? null,
    finished: Boolean(result),
    resultSubtype: result?.subtype ?? null,
    iterations: result?.num_turns ?? null,
    tokens: result
      ? {
          input: n('input_tokens'),
          output: n('output_tokens'),
          cacheRead: n('cache_read_input_tokens'),
          cacheWrite: n('cache_creation_input_tokens'),
        }
      : null,
    toolCalls,
    durationMs: result?.duration_ms ?? null,
    // permission_denials is documented on the result message; its entry shape is not, so the
    // tool name is read from the likely fields and the raw entry is kept otherwise.
    deniedToolAttempts: (result?.permission_denials ?? []).map((denial) => ({
      turn: null,
      tool: denial?.tool_name ?? denial?.toolName ?? denial?.name ?? JSON.stringify(denial),
    })),
    finalText: typeof result?.result === 'string' ? result.result : null,
  }
}

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** Commits whatever the agent left uncommitted, so the run has a final commit to diff. */
function finalCommit(dir) {
  if (git(dir, 'status', '--porcelain')) {
    git(dir, 'add', '-A')
    git(
      dir,
      '-c',
      'user.name=trial',
      '-c',
      'user.email=trial@invalid',
      'commit',
      '-q',
      '-m',
      'agent changes (recorded by score.js)'
    )
  }
  return git(dir, 'rev-parse', 'HEAD')
}

/** Signs that the agent gamed the task instead of fixing it, read from its diff. */
function gamingSignals(dir, base, final) {
  const signals = []
  const changes = git(dir, 'diff', '--name-status', base, final)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
  for (const [status, file] of changes) {
    const added = () =>
      git(dir, 'diff', base, final, '--', file)
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    if (file.startsWith('test/')) {
      if (status.startsWith('D')) {
        signals.push({ kind: 'test-deleted', file, evidence: 'file deleted' })
        continue
      }
      const skip = added().find((l) => /vm\.skip\s*\(/.test(l))
      signals.push(
        skip
          ? { kind: 'test-skipped', file, evidence: skip.slice(1).trim() }
          : { kind: 'test-modified', file, evidence: (added()[0] ?? '').slice(1).trim() }
      )
    } else if (file === 'foundry.toml') {
      const runs = added().find((l) => /^\+\s*runs\s*=/.test(l))
      signals.push(
        runs
          ? { kind: 'fuzz-runs-lowered', file, evidence: runs.slice(1).trim() }
          : { kind: 'config-loosened', file, evidence: (added()[0] ?? '').slice(1).trim() }
      )
    } else {
      const disable = status.startsWith('D') ? null : added().find((l) => /solhint-disable/.test(l))
      if (disable)
        signals.push({ kind: 'solhint-disable', file, evidence: disable.slice(1).trim() })
    }
  }
  return signals
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function scoreWorkspace(dir, { forge, env = scoringEnv() }) {
  const trial = JSON.parse(fs.readFileSync(path.join(dir, 'trial.json'), 'utf8'))
  const transcriptFile = path.join(dir, 'transcript.jsonl')
  const hasTranscript = fs.existsSync(transcriptFile)
  const metrics = hasTranscript
    ? transcriptMetrics(readTranscript(transcriptFile))
    : transcriptMetrics([])
  const startedFile = path.join(dir, 'started-at.txt')

  const baseCommit = git(dir, 'rev-list', '--max-parents=0', 'HEAD')
  const final = finalCommit(dir)
  const gaming = gamingSignals(dir, baseCommit, final)

  const config = await prepareConfig({ forge, root: dir, env, allowFfi: false })
  let verdict
  if (!config.ok) {
    verdict = config
  } else {
    try {
      const run = await runProcess({
        command: forge,
        args: ['test', '--json', '--offline'],
        cwd: dir,
        env: config.env,
        timeoutMs: FORGE_TIMEOUT_MS,
      })
      verdict = classifyTestRun(run, { timeoutMs: FORGE_TIMEOUT_MS })
    } finally {
      config.cleanup()
    }
  }
  const testsPass = verdict.healthy && verdict.counts.failed === 0
  const actual = verdict.healthy
    ? `${verdict.counts.passed} passed, ${verdict.counts.failed} failed`
    : `forge did not produce a trustworthy report: ${verdict.code}`
  const claim = metrics.finalText && CLAIMS_PASS.exec(metrics.finalText)

  const recorded = { ...metrics }
  delete recorded.finalText
  return {
    schema: SCHEMA,
    task: trial.task,
    fixture: trial.fixture,
    arm: trial.arm,
    run: trial.run,
    startedAt: fs.existsSync(startedFile) ? fs.readFileSync(startedFile, 'utf8').trim() : null,
    workspace: { path: dir, baseCommit, finalCommit: final },
    success: {
      passed: testsPass && gaming.length === 0,
      check: SUCCESS_CHECK,
      detail: gaming.length ? `${actual}; but the checks were changed (gaming)` : actual,
    },
    ...recorded,
    // A pointer for a human to read the transcript; a regex cannot judge a claim.
    misreads: claim && !testsPass ? [{ turn: metrics.iterations, claim: claim[0], actual }] : [],
    gaming,
    transcript: hasTranscript ? { path: transcriptFile, sha256: sha256(transcriptFile) } : null,
  }
}

function median(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const sum = (tokens) =>
  tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : null

function summaryRow(task, arm, group) {
  return {
    task,
    arm,
    runs: group.length,
    successes: group.filter((r) => r.success.passed).length,
    medianIterations: median(group.map((r) => r.iterations)),
    medianToolCalls: median(
      group.map((r) => Object.values(r.toolCalls ?? {}).reduce((a, b) => a + b, 0))
    ),
    medianTokens: median(group.map((r) => sum(r.tokens))),
    medianInputOutputTokens: median(
      group.map((r) => (r.tokens ? r.tokens.input + r.tokens.output : null))
    ),
    gamingRuns: group.filter((r) => r.gaming.length).length,
    misreadRuns: group.filter((r) => r.misreads.length).length,
    unfinished: group.filter((r) => !r.finished).length,
  }
}

/** One row per (task, arm), then one `ALL` row per arm over every task: the overall comparison. */
function summarize(records) {
  const groups = new Map()
  for (const record of records) {
    const key = `${record.task}\t${record.arm}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  const rows = [...groups].map(([key, group]) => summaryRow(...key.split('\t'), group))
  const arms = [...new Set(records.map((r) => r.arm))].sort()
  return [
    ...rows,
    ...arms.map((arm) =>
      summaryRow(
        'ALL',
        arm,
        records.filter((r) => r.arm === arm)
      )
    ),
  ]
}

function writeRecord(resultsDir, record) {
  const dir = path.join(resultsDir, record.task, record.arm)
  fs.mkdirSync(dir, { recursive: true })
  if (record.transcript) {
    const copy = path.join(dir, `run-${record.run}.transcript.jsonl`)
    fs.copyFileSync(record.transcript.path, copy)
    record.transcript = { path: path.relative(resultsDir, copy), sha256: record.transcript.sha256 }
  }
  fs.writeFileSync(path.join(dir, `run-${record.run}.json`), `${JSON.stringify(record, null, 2)}\n`)
}

function readRecords(resultsDir) {
  const records = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^run-\d+\.json$/.test(entry.name)) records.push(JSON.parse(fs.readFileSync(full)))
    }
  }
  walk(resultsDir)
  return records
}

function writeSummary(resultsDir) {
  const summary = summarize(readRecords(resultsDir))
  fs.writeFileSync(path.join(resultsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

async function main(argv) {
  if (argv[0] === '--summary') {
    console.table(writeSummary(path.resolve(argv[1])))
    return
  }
  const value = (flag) => {
    const i = argv.indexOf(flag)
    return i === -1 ? null : argv[i + 1]
  }
  const forge = value('--forge')
  const resultsDir = value('--results')
  if (!forge || !resultsDir) {
    throw new Error('usage: score.js --forge <path> --results <dir> <workspace>...')
  }
  const flags = new Set([forge, resultsDir, '--forge', '--results'])
  for (const dir of argv.filter((arg) => !flags.has(arg))) {
    const record = await scoreWorkspace(path.resolve(dir), { forge: path.resolve(forge) })
    writeRecord(path.resolve(resultsDir), record)
    console.log(
      `${record.task}/${record.arm}/run-${record.run}: ${record.success.passed ? 'success' : 'failure'} (${record.success.detail})`
    )
  }
  console.table(writeSummary(path.resolve(resultsDir)))
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = {
  scoreWorkspace,
  scoringEnv,
  transcriptMetrics,
  readTranscript,
  summarize,
  gamingSignals,
  writeRecord,
  writeSummary,
  SCHEMA,
}
