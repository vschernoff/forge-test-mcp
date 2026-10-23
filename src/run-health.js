// Run health before findings (FR-35, SRS C4). A `forge test` run is healthy only when forge
// produced a parseable report with at least one executed test and an exit code that agrees
// with it. Every other outcome is an error with a cause, never "0 failed".
//
// Each rule below was reproduced with real forge 1.8.5/1.8.6 output (test/fixtures/
// forge-samples), except the guards marked "guard", which have no known trigger yet.

// eslint-disable-next-line no-control-regex -- matching terminal colour codes is the point
const ANSI = /\x1b\[[0-9;]*m/g

const HINTS = {
  FORGE_NOT_FOUND:
    'Install Foundry (https://getfoundry.sh) so `forge` is on PATH, or start the server with --forge <path>. This server never installs it.',
  UNSUPPORTED_FORGE_VERSION: 'Install a supported forge version with `foundryup`.',
  NOT_A_FOUNDRY_PROJECT:
    'Start the server in a Foundry project (a directory with foundry.toml, or below one inside the same git repository).',
  CONFIG_ERROR: 'Fix foundry.toml; forge could not read it.',
  FFI_OVERRIDE_FAILED:
    'This is a forge-test-mcp bug; please report it. Only the user can choose to run FFI tests, by starting the server with --allow-ffi.',
  SOLC_MISSING:
    'Run `forge build` once in a terminal so forge can install the compiler. This server runs forge with --offline and does not download anything.',
  COMPILE_FAILED:
    'Fix the compiler errors (call build for the full list), then run the tests again.',
  INVALID_ARGUMENTS: 'Check the tool arguments.',
  TIMEOUT:
    'forge reports results only when it finishes, so none are available. Narrow the run with match_contract / match_test, or raise the timeout in the server config.',
  FORGE_CRASHED: 'forge itself crashed. Run the same command in a terminal to see the full error.',
  FORGE_FAILED: 'forge stopped with an error before running tests; see stderr.',
  UNPARSEABLE_OUTPUT: 'forge printed something other than its JSON report; see stdout and stderr.',
  NO_TESTS_RAN:
    'No test was executed. Check the match_* filters, or that the project has test functions.',
  INCONSISTENT_RESULT:
    'forge’s exit code disagrees with its report, so neither can be trusted. Re-run in a terminal.',
  OUTPUT_TOO_LARGE: 'Narrow the run with match_contract / match_test.',
}

const STATUSES = new Set(['Success', 'Failure', 'Skipped'])

function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '')
}

function tail(text, max = 1500) {
  const clean = stripAnsi(text).trim()
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

function unhealthy(code, message, run, extra = {}) {
  return {
    healthy: false,
    code,
    message,
    hint: HINTS[code],
    exitCode: run?.code ?? null,
    signal: run?.signal ?? null,
    stderr: tail(run?.stderr),
    ...extra,
  }
}

/** forge's own explanation of why nothing matched (with its "Did you mean" suggestion). */
function noMatchDetail(stderr) {
  const text = stripAnsi(stderr)
  const index = text.search(/no tests match|No tests found/i)
  return index === -1 ? null : text.slice(index).trim().slice(0, 500)
}

function isReport(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(
    (suite) =>
      suite !== null &&
      typeof suite === 'object' &&
      suite.test_results !== null &&
      typeof suite.test_results === 'object' &&
      !Array.isArray(suite.test_results) &&
      Object.values(suite.test_results).every((result) => STATUSES.has(result?.status))
  )
}

function countResults(report) {
  const counts = { suites: 0, passed: 0, failed: 0, skipped: 0 }
  for (const suite of Object.values(report)) {
    counts.suites += 1
    for (const result of Object.values(suite.test_results)) {
      if (result.status === 'Success') counts.passed += 1
      else if (result.status === 'Failure') counts.failed += 1
      else counts.skipped += 1
    }
  }
  return counts
}

/**
 * Classifies a finished `forge test --json` process.
 *
 * @param {{ code: number|null, signal: string|null, timedOut: boolean, outputTruncated: boolean,
 *   spawnError: NodeJS.ErrnoException|null, stdout: string, stderr: string }} run
 * @param {{ timeoutMs?: number }} [context]
 * @returns {{ healthy: true, report: object, counts: object } |
 *   { healthy: false, code: string, message: string, hint: string }}
 */
function classifyTestRun(run, context = {}) {
  if (run.spawnError) {
    const missing = ['ENOENT', 'EACCES', 'ENOTDIR'].includes(run.spawnError.code)
    return missing
      ? unhealthy('FORGE_NOT_FOUND', `Could not start forge (${run.spawnError.code}).`, run)
      : unhealthy('FORGE_FAILED', `Could not start forge: ${run.spawnError.message}`, run)
  }
  if (run.timedOut) {
    const seconds = context.timeoutMs ? ` after ${Math.round(context.timeoutMs / 1000)} s` : ''
    return unhealthy('TIMEOUT', `forge was stopped${seconds}; no tests are reported.`, run)
  }
  if (run.outputTruncated) {
    return unhealthy('OUTPUT_TOO_LARGE', 'forge printed more output than the server accepts.', run)
  }

  const stderr = stripAnsi(run.stderr)
  if (run.signal || run.code === null || run.code >= 128 || /application panicked/i.test(stderr)) {
    const how = run.signal ? `was killed by ${run.signal}` : `exited with ${run.code}`
    return unhealthy('FORGE_CRASHED', `forge ${how} before reporting results.`, run)
  }
  if (/can't install missing solc/i.test(stderr)) {
    return unhealthy('SOLC_MISSING', 'The project’s solc version is not installed.', run)
  }
  if (/failed to extract foundry config/i.test(stderr)) {
    return unhealthy('CONFIG_ERROR', 'forge could not read the project configuration.', run)
  }

  const stdout = stripAnsi(run.stdout).trim()
  if (run.code === 2 && !stdout && /^error: /m.test(stderr)) {
    return unhealthy('INVALID_ARGUMENTS', 'forge rejected the command-line arguments.', run)
  }
  if (
    /Compiler run failed|Compilation failed/.test(`${stderr}\n${stdout}`) &&
    !stdout.startsWith('{')
  ) {
    return unhealthy('COMPILE_FAILED', 'The project does not compile, so no tests ran.', run)
  }
  if (!stdout) {
    return run.code === 0
      ? unhealthy('UNPARSEABLE_OUTPUT', 'forge exited 0 but printed no report.', run) // guard
      : unhealthy('FORGE_FAILED', `forge exited ${run.code} without a report.`, run)
  }
  if (/^Nothing to compile/.test(stdout)) {
    return unhealthy(
      'NOT_A_FOUNDRY_PROJECT',
      'forge found no Foundry project here ("Nothing to compile"), so no tests ran.',
      run
    )
  }

  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    return unhealthy('UNPARSEABLE_OUTPUT', 'forge’s output is not JSON.', run, {
      stdout: stdout.slice(0, 300),
    })
  }
  if (!isReport(report)) {
    return unhealthy('UNPARSEABLE_OUTPUT', 'forge’s JSON is not a test report.', run, {
      stdout: stdout.slice(0, 300),
    })
  }

  const counts = countResults(report)
  if (counts.passed + counts.failed === 0) {
    const message =
      counts.skipped > 0
        ? `All ${counts.skipped} matched tests were skipped; nothing was executed.`
        : 'No tests ran.'
    return unhealthy('NO_TESTS_RAN', message, run, {
      counts,
      forgeSays: noMatchDetail(run.stderr),
    })
  }
  if (counts.failed > 0 !== (run.code !== 0)) {
    return unhealthy(
      'INCONSISTENT_RESULT',
      `forge exited ${run.code} but reported ${counts.failed} failing test(s).`, // guard
      run,
      { counts }
    )
  }
  return { healthy: true, report, counts }
}

module.exports = { classifyTestRun, stripAnsi, tail, unhealthy, HINTS }
