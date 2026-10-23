// Static on purpose (FR-39): Codex keeps roughly the first 512 characters of this field, and
// an interpolated path would make the length vary by machine. Behaviour comes first.
const INSTRUCTIONS =
  'Runs Foundry builds and tests and returns compact, structured failures. ' +
  'After changing Solidity, call run_tests before calling the work done. ' +
  'isError means tests did not run: fix the cause and rerun; never report that as passing. ' +
  "Use explain_failure for one failing test's trace. " +
  'Never make tests pass by weakening them: no skipping, deleting or lowering fuzz runs. ' +
  'Passing tests do not prove a contract is secure. ' +
  'FFI is off unless the user enabled it.'

module.exports = { INSTRUCTIONS }
