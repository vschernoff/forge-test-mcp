const { runProcess } = require('./forge-process')
const { classifyTextRun } = require('./run-health')
const { cleanText } = require('./test-report')
const { parseTextReport, revertPath } = require('./traces')

// D19 Q4: trace excerpts come from a second, text-mode run of the first few failing tests only.
const MAX_TRACED = 5

function functionName(signature) {
  return signature.slice(0, signature.indexOf('('))
}

/** `Contract.fn(types)` → { contract, fn } (test names come from forge, so they are identifiers). */
function splitTestId(id) {
  const dot = id.indexOf('.')
  return { contract: id.slice(0, dot), fn: functionName(id.slice(dot + 1)) }
}

/**
 * Re-runs up to MAX_TRACED failing tests at -vvv and attaches each one's path-to-revert trace
 * and backtrace. Never changes the run's verdict: if this pass fails, the caller reports why
 * traces are missing.
 *
 * @returns {Promise<string|null>} null on success, otherwise why traces are unavailable
 */
async function attachTraces({ context, root, env, failures }) {
  // A setUp() failure has no trace of its own.
  const traceable = failures.filter((f) => f.kind !== 'setup')
  const targets = traceable.slice(0, MAX_TRACED)
  if (!targets.length) return null
  const ids = targets.map((f) => splitTestId(f.test))
  const contracts = [...new Set(ids.map((id) => id.contract))]
  const functions = [...new Set(ids.map((id) => id.fn))]

  const run = await context.withLock(root, () =>
    runProcess({
      command: context.forge,
      args: [
        'test',
        '--offline',
        '-vvv',
        `--match-contract=^(${contracts.join('|')})$`,
        // forge matches --match-test against the full signature ("test_x()"), so anchor on "(".
        `--match-test=^(${functions.join('|')})\\(`,
      ],
      cwd: root,
      env,
      timeoutMs: context.options.timeoutMs,
    })
  )
  const verdict = classifyTextRun(run, { timeoutMs: context.options.timeoutMs })
  if (!verdict.healthy) return `unavailable: ${verdict.code}`

  const parsed = parseTextReport(verdict.text)
  let missing = 0
  for (const failure of targets) {
    const entry = parsed.get(failure.test)
    if (!entry || entry.status !== 'FAIL') {
      missing += 1
      continue
    }
    if (entry.trace.length) {
      const path = revertPath(entry.trace)
      failure.trace = path.lines.map((line) => cleanText(line, 400))
      if (path.omitted) failure.traceLinesOmitted = path.omitted
    }
    if (entry.backtrace.length) failure.backtrace = entry.backtrace.map((l) => cleanText(l, 200))
  }
  const traced = targets.length - missing
  if (traced === traceable.length) return null
  return `${traced} of ${traceable.length} failures traced (the first ${MAX_TRACED} are re-run for traces)`
}

module.exports = { attachTraces, MAX_TRACED }
