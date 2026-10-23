// On a stdio MCP server, stdout is the protocol channel: one stray line corrupts the session
// (FR-40, SRS C3). Forge always runs as a child with piped stdio, so the only in-process risk
// is our own code or a dependency calling console.*. Route all of it to stderr.
function protectProtocolStdout(target = console) {
  const toStderr = (...args) => console.error(...args)
  for (const method of ['log', 'info', 'debug', 'warn', 'trace', 'dir', 'table']) {
    target[method] = toStderr
  }
}

module.exports = { protectProtocolStdout }
