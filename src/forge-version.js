// FR-36. The range is what the CI compatibility matrix runs; package.json carries the same
// string as `foundryCompatibility` and a test keeps the two in step.
const SUPPORTED = { min: [1, 8, 5], maxExclusive: [1, 9, 0], range: '>=1.8.5 <1.9.0' }
const RECOMMENDED = '1.8.6'

/** Parses `forge --version` output ("forge Version: 1.8.6" or "forge 1.8.6-nightly (…)"). */
function parseForgeVersion(output) {
  const text = String(output ?? '')
  const match =
    text.match(/Version:\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/) ??
    text.match(/forge\s+v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  const [, major, minor, patch, prerelease = null] = match
  const numbers = [Number(major), Number(minor), Number(patch)]
  return {
    numbers,
    prerelease,
    text: `${numbers.join('.')}${prerelease ? `-${prerelease}` : ''}`,
  }
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/**
 * @returns {{ status: 'supported'|'untested'|'too-old', version: string }}
 *   untested = newer than the tested range, or a pre-release (nightly) build.
 */
function assessForgeVersion(parsed) {
  if (compare(parsed.numbers, SUPPORTED.min) < 0) {
    return { status: 'too-old', version: parsed.text }
  }
  if (compare(parsed.numbers, SUPPORTED.maxExclusive) >= 0 || parsed.prerelease) {
    return { status: 'untested', version: parsed.text }
  }
  return { status: 'supported', version: parsed.text }
}

module.exports = { SUPPORTED, RECOMMENDED, parseForgeVersion, assessForgeVersion }
