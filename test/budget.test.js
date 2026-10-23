const assert = require('node:assert/strict')
const test = require('node:test')

const { fitToBudget } = require('../src/budget')

const header = { status: 'failed', summary: { passed: 0, failed: 200 } }

function failures(count, extra = {}) {
  return Array.from({ length: count }, (_, i) => ({
    test: `T.test_fail${String(i).padStart(3, '0')}()`,
    file: 'test/T.t.sol',
    kind: 'unit',
    reason: `case ${i}: expected the counter to keep its initial value after increment: ${i + 1} != ${i}`,
    ...extra,
  }))
}

function bytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload))
}

test('everything that fits is returned untouched, with truncated: null', () => {
  const payload = fitToBudget(header, failures(5))
  assert.equal(payload.failures.length, 5)
  assert.equal(payload.truncated, null)
})

for (const budget of [2048, 4096, 8192, 16384, 65536]) {
  test(`200 failures stay within ${budget} bytes and account for every failure (FR-32)`, () => {
    const all = failures(200)
    const payload = fitToBudget(header, all, budget)
    assert.ok(bytes(payload) <= budget, `${bytes(payload)} > ${budget}`)
    const t = payload.truncated
    if (!t) {
      // Only allowed when every failure is there in full.
      assert.equal(payload.failures.length, 200)
      return
    }
    assert.equal(t.shownInFull + t.shownWithoutTraceOrLogs + t.namesOnly.length + t.notListed, 200)
    assert.equal(payload.failures.length, t.shownInFull + t.shownWithoutTraceOrLogs)
    // Names come in report order straight after the failures shown.
    assert.equal(t.namesOnly[0], all[payload.failures.length]?.test)
  })
}

test('the default 8 KB budget cannot hold 200 failures, so it truncates', () => {
  assert.ok(fitToBudget(header, failures(200)).truncated)
})

test('traces and logs are dropped before whole failures are', () => {
  const heavy = failures(10, { trace: ['x'.repeat(900)], logs: ['y'.repeat(150)] })
  const payload = fitToBudget(header, heavy, 4096)
  assert.ok(bytes(payload) <= 4096)
  assert.ok(payload.truncated.shownWithoutTraceOrLogs > 0)
  const slim = payload.failures.at(-1)
  assert.equal(slim.trace, undefined)
  assert.equal(slim.logs, undefined)
  assert.ok(slim.reason, 'the reason always survives')
})

test('the budget is clamped to the allowed range', () => {
  const payload = fitToBudget(header, failures(200), 10)
  assert.equal(payload.truncated.budgetBytes, 2048)
  assert.ok(bytes(payload) <= 2048)
})
