// Every tool answers with compact JSON text. A successful result also carries the same object
// as structuredContent; an unhealthy run is `isError: true` with its cause (FR-35).

function okResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
}

/** @param {{ code: string, message: string, hint?: string }} problem */
function errorResult(problem, extra = {}) {
  const { code, message, hint, ...rest } = problem
  delete rest.healthy
  const payload = { error: { code, message, hint }, ...rest, ...extra }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

module.exports = { okResult, errorResult }
