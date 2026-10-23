const { DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET } = require('./budget')
const { prepareConfig } = require('./forge-config')
const { runProcess } = require('./forge-process')
const { collectSecrets, redact } = require('./redact')
const { classifyTextRun, unhealthy } = require('./run-health')
const { cleanText } = require('./test-report')
const { errorResult, okResult } = require('./tool-result')
const { parseTextReport, revertPath } = require('./traces')

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*'
// Accepts what run_tests prints ("BankTest.test_transfer()") as well as a bare function name.
const TEST_ID = new RegExp(`^(?:(${IDENTIFIER})\\.)?(${IDENTIFIER})(?:\\([^)]*\\))?$`)

const EXPLAIN_FAILURE_TOOL = {
  name: 'explain_failure',
  description:
    'Re-run one test at high verbosity and return only that test: its reason, decoded call ' +
    'trace (trimmed to the path to the revert when long), backtrace, logs and, for fuzz or ' +
    'invariant tests, the counterexample. Pass the test name as run_tests reports it, e.g. ' +
    '"BankTest.test_transfer()".',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['test'],
    properties: {
      test: {
        type: 'string',
        maxLength: 300,
        description: 'Test function, optionally with its contract: "Contract.test_name()".',
      },
      contract: {
        type: 'string',
        pattern: `^${IDENTIFIER}$`,
        description: 'Test contract, if not given in `test`.',
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

/** "[FAIL: reason; counterexample: …] test() (gas: 1)" → "reason; counterexample: …" */
function reasonFromHeader(header) {
  const first = header.split('\n')[0]
  return first
    .replace(/^\[(?:FAIL|PASS|SKIP)(?::\s?)?/, '')
    .replace(new RegExp(`\\]\\s*(?:${IDENTIFIER}\\([^)]*\\)\\s+\\((?:gas|runs):.*)?$`), '')
}

function size(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

async function explainFailure(context, args = {}) {
  const match = String(args.test ?? '').match(TEST_ID)
  if (!match) {
    return errorResult(
      unhealthy(
        'INVALID_ARGUMENTS',
        'Give the test as "Contract.test_name()" or "test_name".',
        null
      )
    )
  }
  const contract = args.contract ?? match[1] ?? null
  const fn = match[2]

  const ready = await context.prepare()
  if (!ready.ok) return errorResult(ready)
  const { root, forgeVersion } = ready
  const config = await prepareConfig({
    forge: context.forge,
    root,
    env: context.env,
    allowFfi: context.options.allowFfi,
  })
  if (!config.ok) return errorResult(config, { forge: forgeVersion })

  try {
    // forge matches --match-test against the full signature ("test_x()"), so anchor on "(".
    const argv = ['test', '--offline', '-vvvv', `--match-test=^${fn}\\(`]
    if (contract) argv.push(`--match-contract=^${contract}$`)
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
    const verdict = classifyTextRun(run, { timeoutMs: context.options.timeoutMs })
    if (!verdict.healthy) {
      return errorResult(redact(verdict, secrets), { forge: forgeVersion, ffi: config.ffi })
    }

    const entries = [...parseTextReport(verdict.text)].filter(([id]) =>
      id.slice(id.indexOf('.') + 1).startsWith(`${fn}(`)
    )
    if (!entries.length) {
      return errorResult(
        unhealthy('UNPARSEABLE_OUTPUT', `forge ran, but its output has no entry for ${fn}.`, run),
        { forge: forgeVersion }
      )
    }
    // The failing entry first, if the name exists in several contracts.
    entries.sort(([, a], [, b]) => (a.status === 'FAIL' ? 0 : 1) - (b.status === 'FAIL' ? 0 : 1))
    const [[id, entry], ...others] = entries
    const status = { FAIL: 'failed', PASS: 'passed', SKIP: 'skipped' }[entry.status]

    const payload = {
      test: id,
      status,
      forge: forgeVersion,
      ffi: config.ffi,
      reason: status === 'failed' ? cleanText(reasonFromHeader(entry.header), 600) : null,
    }
    // Keep the counterexample lines; drop forge's per-selector metrics table.
    const details = entry.header
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() && !/^\s*[╭╰|+]/.test(l))
    if (details.length) payload.details = details.map((l) => cleanText(l.trim(), 400))
    if (entry.logs.length) payload.logs = entry.logs.map((l) => cleanText(l, 200))
    if (entry.backtrace.length) payload.backtrace = entry.backtrace.map((l) => cleanText(l, 200))
    if (others.length) payload.alsoMatched = others.map(([otherId]) => otherId)

    const budget = Math.min(Math.max(args.max_bytes ?? DEFAULT_BUDGET, MIN_BUDGET), MAX_BUDGET)
    const full = entry.trace.map((l) => cleanText(l, 400))
    if (size({ ...payload, trace: full }) <= budget) {
      payload.trace = full
    } else {
      const path = revertPath(entry.trace)
      payload.trace = path.lines.map((l) => cleanText(l, 400))
      payload.truncated = {
        traceLinesOmitted: path.omitted,
        note: 'The full trace exceeds the budget; this is the path to the revert. Raise max_bytes to see more.',
      }
    }
    if (status !== 'failed') {
      payload.note = `This test ${status === 'passed' ? 'passes' : 'was skipped'} in this run.`
    }
    return okResult(redact(payload, secrets))
  } finally {
    config.cleanup()
  }
}

module.exports = { EXPLAIN_FAILURE_TOOL, explainFailure, reasonFromHeader }
