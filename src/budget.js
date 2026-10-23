// FR-32: keep a response within a byte budget, dropping the least useful content first and
// saying exactly what was dropped. Order of sacrifice for failures that do not fit in full:
// traces and logs, then everything but the name, then the name itself (counted only).

const DEFAULT_BUDGET = 8192
const MIN_BUDGET = 2048
const MAX_BUDGET = 65_536
// Room kept for the `truncated` note itself.
const NOTE_RESERVE = 600

function size(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

function slim(failure) {
  const rest = { ...failure }
  for (const key of ['trace', 'backtrace', 'logs', 'logsOmitted']) delete rest[key]
  return rest
}

/**
 * @param {object} header  everything except `failures` and `truncated`
 * @param {object[]} failures
 * @param {number} budget
 */
function fitToBudget(header, failures, budget = DEFAULT_BUDGET) {
  const limit = Math.min(Math.max(budget, MIN_BUDGET), MAX_BUDGET)
  const payload = { ...header, failures: [], truncated: null }
  const fits = (candidate) => size(candidate) + NOTE_RESERVE <= limit

  let index = 0
  let slimmed = 0
  for (; index < failures.length; index++) {
    const full = { ...payload, failures: [...payload.failures, failures[index]] }
    if (fits(full)) {
      payload.failures = full.failures
      continue
    }
    const reduced = slim(failures[index])
    const lighter = { ...payload, failures: [...payload.failures, reduced] }
    if (!fits(lighter)) break
    payload.failures = lighter.failures
    slimmed += 1
  }
  if (index === failures.length && slimmed === 0) return payload

  const rest = failures.slice(index).map((failure) => failure.test)
  const named = []
  for (const name of rest) {
    const trial = { ...payload, truncated: { namesOnly: [...named, name] } }
    if (size(trial) + 200 > limit) break
    named.push(name)
  }
  payload.truncated = {
    budgetBytes: limit,
    shownInFull: index - slimmed,
    shownWithoutTraceOrLogs: slimmed,
    namesOnly: named,
    notListed: rest.length - named.length,
    hint: 'Narrow the run with match_contract / match_test to see the rest in full.',
  }
  return payload
}

module.exports = { fitToBudget, DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET }
