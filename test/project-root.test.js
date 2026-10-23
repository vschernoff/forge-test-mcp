const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { findFoundryRoot } = require('../src/project-root')

function tree(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-mcp-root-')))
  for (const file of files) {
    const target = path.join(root, file)
    if (file.endsWith('/')) fs.mkdirSync(target, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
    }
  }
  return root
}

test('finds foundry.toml in the start directory or above it', () => {
  const root = tree(['repo/.git/', 'repo/foundry.toml', 'repo/test/deep/'])
  assert.equal(findFoundryRoot(path.join(root, 'repo')), path.join(root, 'repo'))
  assert.equal(findFoundryRoot(path.join(root, 'repo/test/deep')), path.join(root, 'repo'))
})

test('prefers the nearest foundry.toml (monorepo package)', () => {
  const root = tree(['repo/.git/', 'repo/foundry.toml', 'repo/pkg/foundry.toml', 'repo/pkg/src/'])
  assert.equal(findFoundryRoot(path.join(root, 'repo/pkg/src')), path.join(root, 'repo/pkg'))
})

test('does not climb past the git root, like forge', () => {
  const root = tree(['foundry.toml', 'inner/.git/', 'inner/src/'])
  assert.equal(findFoundryRoot(path.join(root, 'inner/src')), null)
})

test('a directory named foundry.toml is not a project', () => {
  const root = tree(['repo/.git/', 'repo/foundry.toml/'])
  assert.equal(findFoundryRoot(path.join(root, 'repo')), null)
})

test('returns null when there is no project at all', () => {
  const root = tree(['empty/.git/'])
  assert.equal(findFoundryRoot(path.join(root, 'empty')), null)
})
