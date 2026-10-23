const path = require('node:path')

const DEFAULT_TIMEOUT_SECONDS = 300

const USAGE = `Usage: forge-test-mcp [options]

  --root <dir>         Project directory (default: the current directory).
  --forge <path>       forge executable (default: \`forge\` on PATH).
  --timeout <seconds>  Stop a forge run after this long (default: ${DEFAULT_TIMEOUT_SECONDS}).
  --allow-ffi          Let tests use FFI cheatcodes when foundry.toml enables them.
                       Off by default: FFI runs arbitrary commands.
  --strict-version     Refuse forge versions newer than the tested range.`

/**
 * Server settings come only from the command line the user configured, never from tool
 * arguments (FR-38a: FFI opt-in is the user's, not the agent's).
 */
function parseOptions(argv, cwd = process.cwd()) {
  const options = {
    root: cwd,
    forge: 'forge',
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    allowFfi: false,
    strictVersion: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined]
    const value = () => {
      const next = inline ?? argv[++i]
      if (next === undefined || next === '') throw new Error(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '--root':
        options.root = path.resolve(cwd, value())
        break
      case '--forge':
        options.forge = value()
        break
      case '--timeout': {
        const seconds = Number(value())
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be > 0')
        options.timeoutMs = Math.round(seconds * 1000)
        break
      }
      case '--allow-ffi':
        options.allowFfi = true
        break
      case '--strict-version':
        options.strictVersion = true
        break
      default:
        throw new Error(`Unknown option ${arg}\n\n${USAGE}`)
    }
  }
  return options
}

module.exports = { parseOptions, USAGE, DEFAULT_TIMEOUT_SECONDS }
