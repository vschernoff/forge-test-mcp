const { fitToBudget, DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET } = require('./budget')
const { prepareConfig } = require('./forge-config')
const { runProcess } = require('./forge-process')
const { collectSecrets, redact } = require('./redact')
const { classifyTestRun } = require('./run-health')
const { summarizeReport } = require('./test-report')
const { errorResult, okResult } = require('./tool-result')

// Agent-supplied filters become one `--flag=value` argv entry each, so a value that looks like
// a flag ("--ffi") is matched literally and never parsed as an option (verified on 1.8.6).
const FILTER_PATTERN = '^[^\\u0000-\\u001f]{1,200}$'

const RUN_TESTS_TOOL = {
  name: 'run_tests',
  description:
    'Run `forge test` and return a compact summary: counts, and for each failing test its kind ' +
    '(unit, fuzz, invariant, setup), decoded reason, fuzz counterexample or invariant call ' +
    'sequence, and console logs. isError means the tests did not run (compile error, no ' +
    'matching tests, timeout, missing forge, …); never report that as passing.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      match_test: {
        type: 'string',
        pattern: FILTER_PATTERN,
        description: 'Only run test functions matching this regex.',
      },
      match_contract: {
        type: 'string',
        pattern: FILTER_PATTERN,
        description: 'Only run test contracts matching this regex.',
      },
      match_path: {
        type: 'string',
        pattern: FILTER_PATTERN,
        description: 'Only run test files matching this glob.',
      },
      fuzz_runs: {
        type: 'integer',
        minimum: 1,
        maximum: 1_000_000,
        description:
          'Override fuzz runs. A value below the project setting is reported as reduced; do not use it to make tests pass.',
      },
      max_bytes: {
        type: 'integer',
        minimum: MIN_BUDGET,
        maximum: MAX_BUDGET,
        description: `Response size budget in bytes (default ${DEFAULT_BUDGET}).`,
      },
    },
  },
}

function filterArgs(args) {
  const argv = []
  if (args.match_test) argv.push(`--match-test=${args.match_test}`)
  if (args.match_contract) argv.push(`--match-contract=${args.match_contract}`)
  if (args.match_path) argv.push(`--match-path=${args.match_path}`)
  return argv
}

/**
 * @param {object} context  from createContext(): forge command, root, env, options, helpers
 */
async function runTests(context, args = {}) {
  const ready = await context.prepare()
  if (!ready.ok) return errorResult(ready)
  const { forgeVersion, root } = ready

  const config = await prepareConfig({
    forge: context.forge,
    root,
    env: context.env,
    allowFfi: context.options.allowFfi,
  })
  if (!config.ok) return errorResult(config, { forge: forgeVersion })

  try {
    const argv = ['test', '--json', '--offline', '-vv', ...filterArgs(args)]
    if (args.fuzz_runs) argv.push(`--fuzz-runs=${args.fuzz_runs}`)

    const run = await context.withLock(root, () =>
      runProcess({
        command: context.forge,
        args: argv,
        cwd: root,
        env: config.env,
        timeoutMs: context.options.timeoutMs,
      })
    )
    const secrets = collectSecrets({ env: context.env, root })
    const verdict = classifyTestRun(run, { timeoutMs: context.options.timeoutMs })
    if (!verdict.healthy) {
      return errorResult(redact(verdict, secrets), { forge: forgeVersion, ffi: config.ffi })
    }

    const { failures, notRun } = summarizeReport(verdict.report)
    const header = {
      status: verdict.counts.failed > 0 ? 'failed' : 'passed',
      forge: forgeVersion,
      summary: verdict.counts,
      ffi: config.ffi,
      fuzzRuns: fuzzRunsNote(config.fuzzRuns, args.fuzz_runs),
      notRun,
    }
    if (ready.untested) header.forgeUntested = ready.untested
    if (config.writableFsPermissions.length) {
      header.writableFsPermissions = config.writableFsPermissions
    }
    const payload = fitToBudget(header, failures, args.max_bytes ?? DEFAULT_BUDGET)
    return okResult(redact(payload, secrets))
  } finally {
    config.cleanup()
  }
}

function fuzzRunsNote(configured, requested) {
  const note = { configured, used: requested ?? configured }
  if (requested && configured && requested < configured) note.reduced = true
  return note
}

module.exports = { RUN_TESTS_TOOL, runTests }
