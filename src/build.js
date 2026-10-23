const fs = require('node:fs')
const path = require('node:path')

const { DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET } = require('./budget')
const { prepareConfig } = require('./forge-config')
const { runProcess } = require('./forge-process')
const { collectSecrets, redact } = require('./redact')
const { classifyProcess, stripAnsi, unhealthy } = require('./run-health')
const { cleanText } = require('./test-report')
const { errorResult, okResult } = require('./tool-result')

const BUILD_TOOL = {
  name: 'build',
  description:
    'Compile the project with `forge build` and return compiler errors and warnings as ' +
    'structured items (file, line, column, code, message). Unchanged files are not recompiled ' +
    'and forge does not repeat their warnings; pass force: true to recompile everything.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      force: {
        type: 'boolean',
        description: 'Recompile everything, so warnings for unchanged files are reported again.',
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

/** Line and column of a solc diagnostic: solc's own "--> file:line:col", else from the offset. */
function locate(root, entry) {
  const file = entry.sourceLocation?.file ?? null
  const formatted = stripAnsi(entry.formattedMessage ?? '').match(/-->\s*(.+?):(\d+):(\d+):?/)
  if (formatted)
    return { file: file ?? formatted[1], line: Number(formatted[2]), column: Number(formatted[3]) }
  const start = entry.sourceLocation?.start
  if (!file || !Number.isInteger(start) || start < 0) return { file, line: null, column: null }
  try {
    const bytes = fs.readFileSync(path.isAbsolute(file) ? file : path.join(root, file))
    const before = bytes.subarray(0, start)
    const lineStart = before.lastIndexOf(0x0a) + 1
    return {
      file,
      line: before.toString('latin1').split('\n').length,
      column: start - lineStart + 1,
    }
  } catch {
    return { file, line: null, column: null }
  }
}

function diagnostic(root, entry) {
  return {
    ...locate(root, entry),
    severity: entry.severity,
    type: entry.type ?? null,
    code: entry.errorCode ?? null,
    message: cleanText(entry.message ?? entry.formattedMessage ?? '', 500),
  }
}

/** The project's own files first: a dependency's warnings matter less than the user's. */
function byRelevance(a, b) {
  const rank = (d) => (d.file && /(^|\/)(lib|node_modules|dependencies)\//.test(d.file) ? 1 : 0)
  return rank(a) - rank(b)
}

/**
 * Runs `forge build --json` and classifies it. Shared by the build tool and by run_tests, which
 * attaches the first compiler errors to a COMPILE_FAILED error.
 *
 * @returns {Promise<{ ok: true, errors: object[], warnings: object[], compiled: string } |
 *   { ok: false, code: string }>}
 */
async function compile({ context, root, env, force = false }) {
  const argv = ['build', '--json', '--offline', '--no-lint']
  if (force) argv.push('--force')
  const run = await context.withLock(root, () =>
    runProcess({
      command: context.forge,
      args: argv,
      cwd: root,
      env,
      timeoutMs: context.options.timeoutMs,
    })
  )
  const problem = classifyProcess(run, { timeoutMs: context.options.timeoutMs, mode: 'json' })
  if (problem) return { ...problem, ok: false }

  let output
  try {
    output = JSON.parse(stripAnsi(run.stdout))
  } catch {
    return {
      ...unhealthy('UNPARSEABLE_OUTPUT', '`forge build --json` did not print JSON.', run),
      ok: false,
    }
  }
  if (!Array.isArray(output?.errors)) {
    return {
      ...unhealthy('UNPARSEABLE_OUTPUT', 'forge’s build output has no errors list.', run),
      ok: false,
    }
  }
  const items = output.errors.map((entry) => diagnostic(root, entry)).sort(byRelevance)
  const errors = items.filter((d) => d.severity === 'error')
  const warnings = items.filter((d) => d.severity !== 'error')
  // Status comes from the diagnostics, never the exit code alone (forge 1.7.1 exits 0 on a
  // compile error). An exit code that reports failure without any error is not trusted.
  if (!errors.length && run.code !== 0) {
    return {
      ...unhealthy(
        'INCONSISTENT_RESULT',
        `forge build exited ${run.code} but reported no compiler error.`,
        run
      ),
      ok: false,
    }
  }
  const nothingCompiled =
    !items.length &&
    Object.keys(output.sources ?? {}).length === 0 &&
    Object.keys(output.contracts ?? {}).length === 0
  return { ok: true, errors, warnings, compiled: nothingCompiled ? 'cached' : 'fresh' }
}

function fitDiagnostics(header, errors, warnings, budget) {
  const limit = Math.min(Math.max(budget, MIN_BUDGET), MAX_BUDGET)
  const payload = { ...header, errors: [], warnings: [], truncated: null }
  const size = (value) => Buffer.byteLength(JSON.stringify(value)) + 300
  const dropped = { errors: 0, warnings: 0 }
  for (const [key, list] of [
    ['errors', errors],
    ['warnings', warnings],
  ]) {
    for (const item of list) {
      const trial = { ...payload, [key]: [...payload[key], item] }
      if (size(trial) > limit) {
        dropped[key] += 1
        continue
      }
      payload[key] = trial[key]
    }
  }
  if (dropped.errors || dropped.warnings) {
    payload.truncated = {
      budgetBytes: limit,
      errorsOmitted: dropped.errors,
      warningsOmitted: dropped.warnings,
      hint: 'Fix the errors shown and build again, or raise max_bytes.',
    }
  }
  return payload
}

async function build(context, args = {}) {
  const ready = await context.prepare()
  if (!ready.ok) return errorResult(ready)
  const { root, forgeVersion } = ready
  // Compilation runs no test code, but the same config is used so the build matches run_tests.
  const config = await prepareConfig({
    forge: context.forge,
    root,
    env: context.env,
    allowFfi: context.options.allowFfi,
  })
  if (!config.ok) return errorResult(config, { forge: forgeVersion })
  try {
    const secrets = collectSecrets({ env: context.env, root })
    const result = await compile({ context, root, env: config.env, force: args.force === true })
    if (!result.ok) return errorResult(redact(result, secrets), { forge: forgeVersion })

    const header = {
      status: result.errors.length ? 'failed' : 'passed',
      forge: forgeVersion,
      compiled: result.compiled,
      summary: { errors: result.errors.length, warnings: result.warnings.length },
    }
    if (ready.untested) header.forgeUntested = ready.untested
    if (result.compiled === 'cached') {
      // forge does not repeat warnings for files it did not recompile (design note §2.3).
      header.summary.warnings = null
      header.note =
        'Nothing changed since the last build, so forge recompiled nothing and repeated no warnings. Call build with force: true to see them.'
    }
    const payload = fitDiagnostics(
      header,
      result.errors,
      result.warnings,
      args.max_bytes ?? DEFAULT_BUDGET
    )
    // An empty list would read as "no warnings"; after a cached build there is no answer.
    if (result.compiled === 'cached') delete payload.warnings
    return okResult(redact(payload, secrets))
  } finally {
    config.cleanup()
  }
}

const COMPILE_ERRORS_SHOWN = 5

/** For a COMPILE_FAILED verdict: the first compiler errors, so no second round trip is needed. */
async function compilerErrorsFor({ context, root, env }) {
  const result = await compile({ context, root, env })
  if (!result.ok || !result.errors.length) return {}
  return {
    compilerErrors: result.errors.slice(0, COMPILE_ERRORS_SHOWN),
    compilerErrorsTotal: result.errors.length,
  }
}

module.exports = { BUILD_TOOL, build, compile, compilerErrorsFor, locate }
