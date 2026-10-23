// CI setup: fetch forge-std and let forge install the fixtures' solc once, online. The server
// itself always runs forge with --offline and never downloads anything (FR-38b).
const { spawnSync } = require('node:child_process')

const { forgeBinary, makeProject } = require('./projects')

async function main() {
  const forge = forgeBinary()
  if (!forge) throw new Error('FORGE_BIN is not set')
  const root = await makeProject('passing')
  const result = spawnSync(forge, ['build'], { cwd: root, encoding: 'utf8', stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`forge build exited ${result.status}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
