// FR-36. The range is what the CI compatibility matrix runs; package.json carries the same
// string as `foundryCompatibility` and a test keeps the two in step.
const SUPPORTED = { min: [1, 8, 5], maxExclusive: [1, 9, 0], range: '>=1.8.5 <1.9.0' }
const RECOMMENDED = '1.8.6'

// Release tags and the commit each was built from, as stated by the release's SLSA provenance
// attestation (verified with `gh attestation verify`). Some official builds of a release report
// a pre-release version: forge 1.8.6's Alpine build says "1.8.6-dev". A build whose commit is the
// release's own commit is that release.
const RELEASE_COMMITS = {
  '1.8.5': '51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f',
  '1.8.6': '6bad0a66de7c83f7b33695044138f0f5fa4c5990',
}

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
    commit: text.match(/Commit SHA:\s*([0-9a-f]{40})/i)?.[1].toLowerCase() ?? null,
    text: `${numbers.join('.')}${prerelease ? `-${prerelease}` : ''}`,
  }
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/**
 * @returns {{ status: 'supported'|'untested'|'too-old', version: string,
 *   reason?: 'newer'|'prerelease', build?: string }}
 *   untested = newer than the tested range, or a pre-release (nightly) build that is not a
 *   known release's commit.
 */
function assessForgeVersion(parsed) {
  if (compare(parsed.numbers, SUPPORTED.min) < 0) {
    return { status: 'too-old', version: parsed.text }
  }
  if (compare(parsed.numbers, SUPPORTED.maxExclusive) >= 0) {
    return { status: 'untested', reason: 'newer', version: parsed.text }
  }
  if (parsed.prerelease) {
    const release = parsed.numbers.join('.')
    if (parsed.commit && RELEASE_COMMITS[release] === parsed.commit) {
      return { status: 'supported', version: release, build: parsed.text }
    }
    return { status: 'untested', reason: 'prerelease', version: parsed.text }
  }
  return { status: 'supported', version: parsed.text }
}

module.exports = {
  SUPPORTED,
  RECOMMENDED,
  RELEASE_COMMITS,
  parseForgeVersion,
  assessForgeVersion,
}
