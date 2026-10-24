// Fixture projects for real-forge integration tests. Each test gets a fresh copy (forge
// persists fuzz and invariant failures in cache/, which would otherwise leak between tests),
// with forge-std at a pinned commit, verified by sha256.
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir } = require('./tmp')

const PROJECTS_DIR = path.join(__dirname, '..', 'fixtures', 'projects')

// Same pin as the solidity-ai-kit evaluation harness (eval/deps.json).
const FORGE_STD = {
  tag: 'v1.17.0',
  commit: 'f3dae6e6ee381f25eb6a246f7da9b85c91a68219',
  sha256: 'e1eab5f0891018e368a0417bfe266d93f8b9af9484e5a15b15f87f1f4b7c50aa',
}

/** The forge binary under test, or null. CI sets FORGE_BIN; locally it is optional. */
function forgeBinary() {
  return process.env.FORGE_BIN || null
}

/** node:test `skip` value for tests that need real forge. */
function skipWithoutForge() {
  if (forgeBinary()) return false
  if (process.env.FORGE_TEST_MCP_REQUIRE_FORGE === '1') {
    throw new Error('FORGE_TEST_MCP_REQUIRE_FORGE=1 but FORGE_BIN is not set')
  }
  return 'set FORGE_BIN to a forge binary to run the real-forge tests'
}

async function ensureForgeStd() {
  if (process.env.FORGE_STD_DIR) return process.env.FORGE_STD_DIR
  const dir = path.join(os.tmpdir(), `forge-test-mcp-forge-std-${FORGE_STD.commit}`)
  if (fs.existsSync(path.join(dir, 'src', 'Test.sol'))) return dir

  const url = `https://codeload.github.com/foundry-rs/forge-std/tar.gz/${FORGE_STD.commit}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`forge-std download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (digest !== FORGE_STD.sha256) {
    throw new Error(`forge-std sha256 mismatch: got ${digest}, want ${FORGE_STD.sha256}`)
  }
  const staging = tempDir('forge-std-')
  const archive = path.join(staging, 'forge-std.tar.gz')
  fs.writeFileSync(archive, bytes)
  const extracted = path.join(staging, 'out')
  fs.mkdirSync(extracted)
  const tar = spawnSync('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1'])
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  fs.renameSync(extracted, dir)
  return dir
}

/** Copies fixture `name` to a fresh temp directory, ready for forge. */
async function makeProject(name) {
  const root = tempDir(`ftm-${name}-`)
  fs.cpSync(path.join(PROJECTS_DIR, name), root, { recursive: true })
  // .env is git-ignored, so the fixture keeps it as `dotenv`.
  const dotenv = path.join(root, 'dotenv')
  if (fs.existsSync(dotenv)) fs.renameSync(dotenv, path.join(root, '.env'))
  fs.cpSync(await ensureForgeStd(), path.join(root, 'lib', 'forge-std'), { recursive: true })
  return root
}

module.exports = { makeProject, ensureForgeStd, forgeBinary, skipWithoutForge, FORGE_STD }
