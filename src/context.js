const { runProcess } = require('./forge-process')
const { RECOMMENDED, SUPPORTED, assessForgeVersion, parseForgeVersion } = require('./forge-version')
const { findFoundryRoot } = require('./project-root')
const { classifyTestRun, unhealthy } = require('./run-health')

const VERSION_TIMEOUT_MS = 30_000

/**
 * Shared state for all tools: which forge to run, where, with which options, plus a per-root
 * lock so two tool calls never run forge on the same project at once.
 *
 * @param {{ forge: string|string[], startDir: string, env?: object,
 *   options: { allowFfi: boolean, strictVersion: boolean, timeoutMs: number } }} settings
 */
function createContext({ forge, startDir, env = process.env, options }) {
  const locks = new Map()
  let versionCache = null

  async function checkVersion(root) {
    if (versionCache) return versionCache
    const run = await runProcess({
      command: forge,
      args: ['--version'],
      cwd: root,
      env,
      timeoutMs: VERSION_TIMEOUT_MS,
    })
    if (run.spawnError || run.timedOut || run.code !== 0) {
      const verdict = classifyTestRun(run)
      return verdict.healthy ? unhealthy('FORGE_FAILED', '`forge --version` failed.', run) : verdict
    }
    const parsed = parseForgeVersion(run.stdout)
    if (!parsed) {
      return unhealthy('UNSUPPORTED_FORGE_VERSION', 'Could not read the forge version.', run)
    }
    const { status, version } = assessForgeVersion(parsed)
    const refuse = status === 'too-old' || (status === 'untested' && options.strictVersion)
    if (refuse) {
      return {
        ...unhealthy(
          'UNSUPPORTED_FORGE_VERSION',
          `forge ${version} is outside the supported range ${SUPPORTED.range}.`,
          null
        ),
        hint: `Install a supported version, e.g. \`foundryup -i ${RECOMMENDED}\`.`,
        forge: version,
      }
    }
    versionCache = {
      ok: true,
      forgeVersion: version,
      untested: status === 'untested' ? `outside the tested range ${SUPPORTED.range}` : null,
    }
    return versionCache
  }

  async function prepare() {
    const root = findFoundryRoot(startDir)
    if (!root) {
      return {
        ...unhealthy(
          'NOT_A_FOUNDRY_PROJECT',
          'No foundry.toml in the server’s directory or above it (within the git repository), so nothing was run.',
          null
        ),
        ok: false,
      }
    }
    const version = await checkVersion(root)
    if (!version.ok) return { ...version, ok: false }
    return { ...version, root }
  }

  function withLock(root, task) {
    const previous = locks.get(root) ?? Promise.resolve()
    const next = previous.then(task, task)
    locks.set(
      root,
      next.catch(() => {})
    )
    return next
  }

  return { forge, env, options, prepare, withLock }
}

module.exports = { createContext }
