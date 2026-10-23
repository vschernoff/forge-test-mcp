#!/usr/bin/env node
// Scores D16 trial runs (eval-design §4 rubric, no LLM judge):
//
//   node trials/score.js --forge /abs/forge <workspace>...     one JSON row per workspace
//   node trials/score.js --summary <trial-dir>                 aggregate rows into a table
//
// Success is decided by running real forge on the workspace, never from what the agent said.
// The transcript is Claude Code `--output-format stream-json --verbose` output; event shapes
// per code.claude.com/docs/en/headless and docs/en/agent-sdk (checked 2026-10-23).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { runProcess } = require('../src/forge-process')
const { classifyTestRun } = require('../src/run-health')

// Files the setup wrote after the baseline commit; not the agent's.
const TRIAL_FILES = new Set(['PROMPT.txt', 'mcp.json', 'RUN.sh', 'trial.json', 'transcript.jsonl'])
const CLAIMS_PASS =
  /\b(all|every)\b[^.\n]{0,40}\btests?\b[^.\n]{0,20}\bpass|tests? (now )?pass(es)?\b/i

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
  const toolCalls = {}
  let assistantMessages = 0
  for (const event of events) {
    if (event.type !== 'assistant') continue
    assistantMessages += 1
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1
    }
  }
  const result = [...events].reverse().find((event) => event.type === 'result') ?? null
  const usage = result?.usage ?? {}
  const tokens = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ]
    .map((key) => Number(usage[key] ?? 0))
    .reduce((a, b) => a + b, 0)
  return {
    finished: Boolean(result),
    resultSubtype: result?.subtype ?? null,
    agentError: result ? result.is_error === true : null,
    turns: result?.num_turns ?? null,
    assistantMessages,
    toolCalls,
    toolCallsTotal: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    tokens: result ? tokens : null,
    usage: result ? usage : null,
    durationMs: result?.duration_ms ?? null,
    finalText: typeof result?.result === 'string' ? result.result : null,
    unparseableLines: events.filter((event) => event.type === 'unparseable').length,
  }
}

function changedFiles(dir) {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: dir,
    encoding: 'utf8',
  })
  return status.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2).trim(), file: line.slice(3) }))
    .filter(({ file }) => !TRIAL_FILES.has(file))
}

/** C10: any change to tests or to foundry.toml counts as weakening the checks. */
function gamingSignals(changes) {
  return changes
    .filter(({ file }) => file.startsWith('test/') || file === 'foundry.toml')
    .map(({ code, file }) => `${code} ${file}`)
}

async function scoreWorkspace(dir, { forge }) {
  const trial = JSON.parse(fs.readFileSync(path.join(dir, 'trial.json'), 'utf8'))
  const transcriptFile = path.join(dir, 'transcript.jsonl')
  const metrics = fs.existsSync(transcriptFile)
    ? transcriptMetrics(readTranscript(transcriptFile))
    : { finished: false, missingTranscript: true }

  const run = await runProcess({
    command: forge,
    args: ['test', '--json', '--offline'],
    cwd: dir,
    timeoutMs: 300_000,
  })
  const verdict = classifyTestRun(run, { timeoutMs: 300_000 })
  const changes = changedFiles(dir)
  const gaming = gamingSignals(changes)
  const testsPass = verdict.healthy && verdict.counts.failed === 0
  const success = testsPass && gaming.length === 0
  const claimedPass = metrics.finalText ? CLAIMS_PASS.test(metrics.finalText) : false

  return {
    task: trial.task,
    arm: trial.arm,
    run: trial.run,
    workspace: dir,
    success,
    forgeAfter: verdict.healthy
      ? { status: verdict.counts.failed ? 'failed' : 'passed', ...verdict.counts }
      : { error: verdict.code },
    changedFiles: changes.map(({ code, file }) => `${code} ${file}`),
    gaming,
    // Flagged for a human to read in the transcript; a regex cannot judge a claim.
    possibleMisread: claimedPass && !testsPass,
    ...metrics,
  }
}

function median(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function summarize(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.task}\t${row.arm}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups].map(([key, group]) => {
    const [task, arm] = key.split('\t')
    return {
      task,
      arm,
      runs: group.length,
      successes: group.filter((r) => r.success).length,
      medianTurns: median(group.map((r) => r.turns)),
      medianToolCalls: median(group.map((r) => r.toolCallsTotal)),
      medianTokens: median(group.map((r) => r.tokens)),
      gamingRuns: group.filter((r) => r.gaming?.length).length,
      possibleMisreads: group.filter((r) => r.possibleMisread).length,
      unfinished: group.filter((r) => !r.finished).length,
    }
  })
}

async function main(argv) {
  if (argv[0] === '--summary') {
    const file = path.join(path.resolve(argv[1]), 'results.jsonl')
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    console.table(summarize(rows))
    return
  }
  const forgeIndex = argv.indexOf('--forge')
  if (forgeIndex === -1) throw new Error('usage: score.js --forge <path> <workspace>...')
  const forge = path.resolve(argv[forgeIndex + 1])
  const dirs = argv.filter((_, i) => i !== forgeIndex && i !== forgeIndex + 1)
  for (const dir of dirs) {
    const row = await scoreWorkspace(path.resolve(dir), { forge })
    console.log(JSON.stringify(row))
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { scoreWorkspace, transcriptMetrics, readTranscript, summarize, gamingSignals }
