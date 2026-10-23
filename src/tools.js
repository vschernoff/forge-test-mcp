const { BUILD_TOOL, build } = require('./build')
const { EXPLAIN_FAILURE_TOOL, explainFailure } = require('./explain-failure')
const { RUN_TESTS_TOOL, runTests } = require('./run-tests')
const { errorResult } = require('./tool-result')

// FR-38: these are all the tools. None broadcasts, deploys, signs or accepts keys.
function createTools(context) {
  const tools = [
    { ...RUN_TESTS_TOOL, run: (args) => runTests(context, args) },
    { ...EXPLAIN_FAILURE_TOOL, run: (args) => explainFailure(context, args) },
    { ...BUILD_TOOL, run: (args) => build(context, args) },
  ]
  return tools.map(({ run, ...definition }) => ({
    ...definition,
    handler: async (args) => {
      try {
        return await run(args ?? {})
      } catch (error) {
        // A bug here must still read as "did not run", never as an empty pass.
        return errorResult({
          code: 'INTERNAL_ERROR',
          message: `forge-test-mcp failed: ${error.message}`,
          hint: 'This is a forge-test-mcp bug; please report it.',
        })
      }
    },
  }))
}

module.exports = { createTools }
