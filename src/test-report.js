// Turns a healthy `forge test --json` report (forge 1.8.x) into the failures an agent needs.
// Shapes verified against real 1.8.5/1.8.6 output (design note §2.1):
// - unit/fuzz: `reason` and `counterexample.Single` on the test entry;
// - invariant: top-level `reason`/`counterexample` are null on a first failure and the data is in
//   `invariant_failures[]`, whose `counterexample.Sequence` is `[originalLength, [calls]]`;
// - a reverting setUp() appears as a failing pseudo-test named `setUp()`, and the contract's
//   real tests are then absent from the report.

const MAX_REASON = 300
const MAX_LOG_LINES = 10
const MAX_LOG_LINE = 200
const MAX_SEQUENCE = 12

const KINDS = { Unit: 'unit', Fuzz: 'fuzz', Invariant: 'invariant' }

// eslint-disable-next-line no-control-regex -- escaping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** Escapes control characters, collapses runs of NULs and caps the length. */
function cleanText(text, max = MAX_REASON) {
  if (text === null || text === undefined) return null
  let out = String(text).replace(
    CONTROL_CHARS,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`
  )
  out = out.replace(/(?:\\x00){8,}/g, (run) => `\\x00×${run.length / 4}`)
  return out.length > max ? `${out.slice(0, max)}… (+${out.length - max} chars)` : out
}

function splitSuite(suiteKey) {
  const index = suiteKey.lastIndexOf(':')
  return index === -1
    ? { file: null, contract: suiteKey }
    : { file: suiteKey.slice(0, index), contract: suiteKey.slice(index + 1) }
}

function shortContract(name) {
  return name ? String(name).split(':').pop() : null
}

function sequenceCalls(counterexample) {
  const sequence = counterexample?.Sequence
  if (!Array.isArray(sequence)) return null
  // 1.7.x and 1.8.x: [originalLength, [calls]]; tolerate a plain list of calls.
  const [original, calls] =
    sequence.length === 2 && Array.isArray(sequence[1]) ? sequence : [sequence.length, sequence]
  const mapped = calls.map((call) => ({
    call: `${shortContract(call.contract_name) ?? call.addr ?? '?'}.${
      call.signature ?? call.func_name ?? String(call.calldata ?? '').slice(0, 10)
    }`,
    args: cleanText(call.raw_args ?? call.args ?? ''),
    sender: call.sender ?? null,
  }))
  const result = { calls: mapped.slice(-MAX_SEQUENCE) }
  if (mapped.length > MAX_SEQUENCE) result.earlierCallsOmitted = mapped.length - MAX_SEQUENCE
  if (Number.isInteger(original) && original !== calls.length) result.shrunkFrom = original
  return result
}

function singleCounterexample(counterexample) {
  const single = counterexample?.Single
  if (!single) return null
  const out = { args: cleanText(single.raw_args ?? single.args ?? '') }
  if (single.calldata) out.calldata = single.calldata
  if (single.fuzz_seed) out.seed = single.fuzz_seed
  return out
}

function failureOf(suiteKey, signature, result) {
  const { file, contract } = splitSuite(suiteKey)
  const kindKey = Object.keys(result.kind ?? {})[0]
  const invariantFailures = Array.isArray(result.invariant_failures)
    ? result.invariant_failures
    : []
  const primary = invariantFailures[0]
  const failure = {
    test: `${contract}.${signature}`,
    file,
    kind: signature === 'setUp()' ? 'setup' : (KINDS[kindKey] ?? 'unknown'),
    reason:
      cleanText(result.reason ?? primary?.reason ?? null) ?? '(forge reported no failure reason)',
  }

  const counterexample = primary?.counterexample ?? result.counterexample
  const single = singleCounterexample(counterexample)
  if (single) failure.counterexample = single
  const sequence = sequenceCalls(counterexample)
  if (sequence) failure.sequence = sequence
  if (primary?.kind === 'handler') failure.failedIn = primary.name
  if (invariantFailures.length > 1) {
    failure.otherInvariantFailures = invariantFailures
      .slice(1)
      .map((other) => `${other.name}: ${cleanText(other.reason, 150)}`)
  }

  const logs = (result.decoded_logs ?? []).map((line) => cleanText(line, MAX_LOG_LINE))
  if (logs.length) {
    failure.logs = logs.slice(0, MAX_LOG_LINES)
    if (logs.length > MAX_LOG_LINES) failure.logsOmitted = logs.length - MAX_LOG_LINES
  }
  return { failure, contract }
}

/**
 * @param {object} report  healthy `forge test --json` output
 * @returns {{ failures: object[], notRun: string[] }}
 */
function summarizeReport(report) {
  const failures = []
  const notRun = []
  for (const [suiteKey, suite] of Object.entries(report)) {
    for (const [signature, result] of Object.entries(suite.test_results)) {
      if (result.status !== 'Failure') continue
      const { failure, contract } = failureOf(suiteKey, signature, result)
      failures.push(failure)
      if (failure.kind === 'setup') {
        notRun.push(`${contract}: setUp() failed, so none of its tests ran`)
      }
    }
  }
  return { failures, notRun }
}

module.exports = { summarizeReport, cleanText }
