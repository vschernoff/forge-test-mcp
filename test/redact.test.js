const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { collectSecrets, redact, parseDotenv } = require('../src/redact')

const KEY = '0xAbCd111111111111111111111111111111111111111111111111111111112222'

function project(dotenv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-redact-'))
  if (dotenv !== undefined) fs.writeFileSync(path.join(root, '.env'), dotenv)
  return root
}

test('redacts exact values of secret-named variables from env and .env (D19 Q6)', () => {
  const secrets = collectSecrets({
    env: { PRIVATE_KEY: KEY, HOME: '/home/someone', PATH: '/usr/bin' },
    root: project('ETHERSCAN_API_KEY="token-value-123"\nexport GITHUB_TOKEN=ghp_abcdefgh\n'),
  })
  const out = redact(
    { reason: `key ${KEY} and token-value-123`, logs: ['ghp_abcdefgh', '/home/someone'] },
    secrets
  )
  assert.deepEqual(out, {
    reason: 'key [redacted:PRIVATE_KEY] and [redacted:ETHERSCAN_API_KEY]',
    logs: ['[redacted:GITHUB_TOKEN]', '/home/someone'],
  })
})

test('a hex key is found with or without 0x and in any case', () => {
  const secrets = collectSecrets({ env: { DEPLOYER_PRIVATE_KEY: KEY }, root: project() })
  const bare = KEY.slice(2)
  for (const form of [KEY, KEY.toLowerCase(), bare.toUpperCase(), bare.toLowerCase()]) {
    assert.equal(redact(`x ${form} y`, secrets), 'x [redacted:DEPLOYER_PRIVATE_KEY] y', form)
  }
})

test('does not redact by shape: other bytes32 values survive', () => {
  const secrets = collectSecrets({ env: { PRIVATE_KEY: KEY }, root: project() })
  const other = `0x${'9'.repeat(64)}`
  assert.equal(redact(`hash ${other}`, secrets), `hash ${other}`)
})

test('ignores non-secret names and values too short to matter', () => {
  const secrets = collectSecrets({
    env: { RPC_URL: 'http://localhost:8545', SECRET_FLAG: 'true', API_KEY: '1234567' },
    root: project(),
  })
  assert.deepEqual(secrets, [])
})

test('parses common .env forms', () => {
  assert.deepEqual(
    parseDotenv(
      '# comment\nA=1\nexport B = two \nC="quoted # not a comment"\nD=\'single\'\nE=val # note\n'
    ),
    { A: '1', B: 'two', C: 'quoted # not a comment', D: 'single', E: 'val' }
  )
})
