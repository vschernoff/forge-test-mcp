// Decoded traces exist only in forge's text output (the --json traces are raw and huge; design
// note §2.1). This parses `forge test -vvv`/`-vvvv` text, as printed by forge 1.8.5/1.8.6
// (test/fixtures/text-traces), into per-test sections. Unparseable text is never an error: the
// caller falls back to a raw tail.
//
//   Ran 5 tests for test/Edge.t.sol:EdgeTest
//   [FAIL: deep failure: 1 != 2] test_deepTrace() (gas: 381330)
//   Logs:            (optional)
//   Traces:
//     [381330] EdgeTest::test_deepTrace()
//       ├─ [0] VM::assertEq(1, 2, "deep failure") [staticcall]
//       │   └─ ← [Revert] deep failure: 1 != 2
//       └─ ← [Revert] deep failure: 1 != 2
//   Backtrace:       (optional)
//     at VM.assertEq
//
// Invariant failures put the [Sequence] and a metrics table between the [FAIL line and the
// test name, and print one trace block per call, separated by blank lines.

const { stripAnsi } = require('./run-health')

const SUITE = /^Ran \d+ tests? for (.+)$/
const ENTRY = /^\[(FAIL|PASS|SKIP)\b/
const SECTION = /^(Logs|Traces|Backtrace):\s*$/
const SIGNATURE = /([A-Za-z_][A-Za-z0-9_]*\([^)]*\))\s+\((?:gas|runs):/g
const MAX_EXCERPT_LINES = 12

/** @returns {Map<string, { status: string, header: string, logs: string[], trace: string[],
 *   backtrace: string[] }>} keyed by "Contract.signature()" */
function parseTextReport(text) {
  const tests = new Map()
  // CRLF from forge on Windows (or a Windows checkout) must parse the same as LF.
  const body = stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .split(/\nFailing tests:\n/)[0]
  let contract = null
  let entry = null
  let section = null

  const finish = () => {
    if (!entry || !contract) return
    const signatures = [...entry.headerLines.join('\n').matchAll(SIGNATURE)]
    const signature = signatures.at(-1)?.[1]
    if (signature) {
      tests.set(`${contract}.${signature}`, {
        status: entry.status,
        header: entry.headerLines.join('\n'),
        logs: trimBlank(entry.sections.Logs ?? []),
        trace: trimBlank(entry.sections.Traces ?? []),
        backtrace: trimBlank(entry.sections.Backtrace ?? []).map((l) => l.replace(/^at\s+/, '')),
      })
    }
    entry = null
    section = null
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const suite = line.match(SUITE)
    if (suite) {
      finish()
      contract = suite[1].split(':').pop()
      continue
    }
    if (/^Suite result:/.test(line)) {
      finish()
      continue
    }
    const start = line.match(ENTRY)
    if (start) {
      finish()
      entry = { status: start[1], headerLines: [line], sections: {} }
      continue
    }
    if (!entry) continue
    const heading = line.match(SECTION)
    if (heading) {
      section = heading[1]
      entry.sections[section] = []
      continue
    }
    if (section) {
      // Section lines are indented by two spaces; blank lines separate invariant call blocks.
      if (line === '' || line.startsWith('  ')) entry.sections[section].push(line.slice(2))
      else section = null
    } else {
      entry.headerLines.push(line)
    }
  }
  finish()
  return tests
}

function trimBlank(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

/** Column where a trace line's content starts, after the tree drawing. */
function depthOf(line) {
  const match = line.match(/^[\s│├└─]*/)
  return match[0].length
}

/**
 * The frames on the path to the first revert in the last trace block that reverts: the root
 * call, each enclosing call, the reverting frame and its revert line. A 34-line trace of
 * twelve passing calls before a failing assert becomes 4 lines.
 */
function revertPath(trace) {
  const blocks = [[]]
  for (const line of trace) {
    if (line.trim() === '') blocks.push([])
    else blocks.at(-1).push(line)
  }
  const total = trace.filter((l) => l.trim() !== '').length
  const block = [...blocks].reverse().find((b) => b.some((l) => l.includes('← [Revert]')))
  if (!block) {
    const lines = trace.filter((l) => l.trim() !== '').slice(-MAX_EXCERPT_LINES)
    return { lines, omitted: total - lines.length }
  }

  const revertIndex = block.findIndex((l) => l.includes('← [Revert]'))
  const keep = new Set([0, revertIndex, block.length - 1])
  let depth = depthOf(block[revertIndex])
  for (let i = revertIndex - 1; i > 0; i--) {
    const d = depthOf(block[i])
    if (d < depth && /\[\d+\]/.test(block[i])) {
      keep.add(i)
      depth = d
    }
  }
  const indexes = [...keep].sort((a, b) => a - b)
  const lines = indexes.map((i) => block[i]).slice(-MAX_EXCERPT_LINES)
  return { lines, omitted: total - lines.length }
}

module.exports = { parseTextReport, revertPath }
