const fs = require('node:fs')
const path = require('node:path')

// D19 Q6: redact the exact values of secret-named variables, from the server's environment and
// the project's .env (forge loads .env itself, so tests can print those values). Matching by
// shape instead would blank every bytes32, hash and calldata word the agent needs.
const SECRET_NAME = /PRIVATE_KEY|MNEMONIC|SECRET|TOKEN|API_KEY/i
// Shorter values ("1", "true") would redact ordinary output and protect nothing.
const MIN_LENGTH = 8

function parseDotenv(text) {
  const entries = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    const quoted = value.match(/^(['"])(.*)\1$/)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '')
    entries[match[1]] = value
  }
  return entries
}

/** @returns {Array<{ name: string, value: string }>} */
function collectSecrets({ env = process.env, root }) {
  const sources = [env]
  try {
    sources.push(parseDotenv(fs.readFileSync(path.join(root, '.env'), 'utf8')))
  } catch {
    // No .env.
  }
  const secrets = new Map()
  for (const source of sources) {
    for (const [name, raw] of Object.entries(source)) {
      const value = String(raw ?? '').trim()
      if (!SECRET_NAME.test(name) || value.length < MIN_LENGTH) continue
      secrets.set(value, name)
      // A hex key may be printed with or without 0x, in either case, without leading zeros,
      // or, read as a number (vm.envUint, console.log of a uint), in decimal.
      const hex = value.match(/^(0x)?([0-9a-fA-F]{16,})$/)
      if (hex) {
        const digits = hex[2].toLowerCase()
        const trimmed = digits.replace(/^0+/, '')
        for (const form of [digits, `0x${digits}`, trimmed, `0x${trimmed}`]) {
          if (form.replace(/^0x/, '').length >= MIN_LENGTH) secrets.set(form, name)
        }
        if (digits.length <= 64) {
          const decimal = BigInt(`0x${digits}`).toString(10)
          if (decimal.length >= MIN_LENGTH) secrets.set(decimal, name)
        }
      }
    }
  }
  // Longest first, so a value that contains another is replaced whole.
  return [...secrets]
    .map(([value, name]) => ({ value, name }))
    .sort((a, b) => b.value.length - a.value.length)
}

function redactString(text, secrets) {
  let out = text
  for (const { value, name } of secrets) {
    if (!out.includes(value) && !out.toLowerCase().includes(value.toLowerCase())) continue
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(
      new RegExp(escaped, /^(0x)?[0-9a-f]+$/.test(value) ? 'gi' : 'g'),
      `[redacted:${name}]`
    )
  }
  // forge annotates large numbers ("… [7.7e75]"); after a redacted number that annotation would
  // still give away the leading digits.
  return out.replace(/(\[redacted:[^\]]+\]) \[\d+(?:\.\d+)?e\d+\]/g, '$1')
}

/** Returns a deep copy of `value` with every secret value replaced. */
function redact(value, secrets) {
  if (!secrets.length) return value
  if (typeof value === 'string') return redactString(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets)]))
  }
  return value
}

module.exports = { collectSecrets, redact, parseDotenv }
