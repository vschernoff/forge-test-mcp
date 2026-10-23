const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runProcess } = require('./forge-process')
const { stripAnsi, unhealthy } = require('./run-health')

const CONFIG_TIMEOUT_MS = 60_000

function configProblem(message, run) {
  return { ...unhealthy('CONFIG_ERROR', message, run), ok: false }
}

async function readConfigJson({ forge, root, env }) {
  const run = await runProcess({
    command: forge,
    args: ['config', '--json', '--offline'],
    cwd: root,
    env,
    timeoutMs: CONFIG_TIMEOUT_MS,
  })
  if (run.spawnError || run.timedOut || run.code !== 0) {
    return {
      problem: configProblem('`forge config` failed, so the project could not be read.', run),
    }
  }
  try {
    return { config: JSON.parse(stripAnsi(run.stdout)) }
  } catch {
    return { problem: configProblem('`forge config --json` did not print JSON.', run) }
  }
}

/**
 * Resolves the project's configuration and, unless the user opted in, makes sure FFI is off.
 *
 * forge ignores FOUNDRY_FFI in the environment (crates/config/src/lib.rs, `.ignore(["FFI"])`),
 * so `ffi = true` in foundry.toml cannot be overridden that way. What works (FR-38a, verified on
 * forge 1.7.1, 1.8.5 and 1.8.6) is FOUNDRY_CONFIG pointing at the resolved configuration with
 * `ffi = false`. The override is then read back through forge itself: if forge does not report
 * ffi = false, nothing runs.
 *
 * @returns {Promise<{ ok: true, env: object, ffi: string, fuzzRuns: number|null,
 *   writableFsPermissions: string[], cleanup: () => void } | { ok: false, code: string }>}
 */
async function prepareConfig({ forge, root, env, allowFfi }) {
  const { config, problem } = await readConfigJson({ forge, root, env })
  if (problem) return problem

  const base = {
    ok: true,
    env,
    fuzzRuns: Number.isInteger(config?.fuzz?.runs) ? config.fuzz.runs : null,
    writableFsPermissions: (config.fs_permissions ?? [])
      .filter((entry) => /write/.test(String(entry?.access)))
      .map((entry) => String(entry.path)),
    cleanup: () => {},
  }
  if (config.ffi !== true) return { ...base, ffi: 'disabled' }
  if (allowFfi) return { ...base, ffi: 'enabled-by-user' }

  const toml = await runProcess({
    command: forge,
    args: ['config', '--offline'],
    cwd: root,
    env,
    timeoutMs: CONFIG_TIMEOUT_MS,
  })
  const text = stripAnsi(toml.stdout)
  const ffiLines = text.match(/^ffi = true$/gm) ?? []
  if (toml.code !== 0 || ffiLines.length !== 1) {
    return {
      ...unhealthy(
        'FFI_OVERRIDE_FAILED',
        'The project enables FFI and the server could not produce a configuration with FFI off, so no tests were run.',
        toml
      ),
      ok: false,
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-mcp-config-'))
  const file = path.join(dir, 'foundry.toml')
  fs.writeFileSync(file, text.replace(/^ffi = true$/m, 'ffi = false'))
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
  const overriddenEnv = { ...env, FOUNDRY_CONFIG: file }

  const check = await readConfigJson({ forge, root, env: overriddenEnv })
  if (check.problem || check.config?.ffi !== false) {
    cleanup()
    return {
      ...unhealthy(
        'FFI_OVERRIDE_FAILED',
        'The project enables FFI and forge did not accept the override that turns it off, so no tests were run.',
        null
      ),
      ok: false,
    }
  }
  return { ...base, env: overriddenEnv, ffi: 'disabled-by-server', cleanup }
}

module.exports = { prepareConfig }
