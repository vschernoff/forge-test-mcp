const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageJson = require('../package.json')
const serverJson = require('../server.json')
const { HINTS } = require('../src/run-health')
const { createTools } = require('../src/tools')

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')

test('server.json agrees with package.json (MCP Registry requirements)', () => {
  assert.equal(serverJson.name, packageJson.mcpName)
  assert.equal(serverJson.version, packageJson.version)
  assert.equal(serverJson.packages[0].identifier, packageJson.name)
  assert.equal(serverJson.packages[0].version, packageJson.version)
  assert.ok(serverJson.description.length <= 100, `${serverJson.description.length} chars`)
})

test('the README documents every tool and every error code the server can return', () => {
  for (const tool of createTools({})) {
    assert.match(README, new RegExp(`\`${tool.name}\``), `tool ${tool.name}`)
  }
  for (const code of Object.keys(HINTS)) {
    assert.match(README, new RegExp(`\`${code}\``), `error code ${code}`)
  }
})

test('the README states the same Foundry range as the code', () => {
  assert.ok(README.includes(`\`${packageJson.foundryCompatibility}\``))
})

test('nothing in the README or package description claims the tool makes contracts secure', () => {
  const text = `${README}\n${packageJson.description}\n${serverJson.description}`
  const claims = text
    .split(/(?<=[.!?])\s+|\n/)
    .filter((sentence) =>
      /\b(secure|guarantee|safe to deploy|audit-ready|bug-free)/i.test(sentence)
    )
  // Each such word may only appear in a sentence that negates it (the disclaimer).
  for (const sentence of claims) {
    assert.match(sentence, /\b(not|cannot|never|no)\b/i, `possible safety claim: "${sentence}"`)
  }
  assert.match(README, /Passing tests do not prove a contract is secure/)
})
