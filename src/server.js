const { fromJsonSchema, McpServer } = require('@modelcontextprotocol/server')

const packageJson = require('../package.json')
const { INSTRUCTIONS } = require('./instructions')

/**
 * @param {{ tools: Array<{ name: string, description: string, inputSchema: object,
 *   handler: (args: object) => Promise<object> }> }} options
 */
function createServer({ tools = [] } = {}) {
  const server = new McpServer(
    { name: packageJson.name, version: packageJson.version },
    { instructions: INSTRUCTIONS }
  )
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema) },
      async (args) => tool.handler(args)
    )
  }
  return server
}

module.exports = { createServer }
