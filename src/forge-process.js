const { spawn, spawnSync } = require('node:child_process')

// Generous: `forge build --json` prints every artifact (1.6–2.7 MB on tiny fixtures), and a
// large project can print far more. Beyond this the run is reported, never silently cut.
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const KILL_GRACE_MS = 2000
const IS_WINDOWS = process.platform === 'win32'

const active = new Set()

function killTree(child, signal, { evenIfExited = false } = {}) {
  const exited = child.exitCode !== null || child.signalCode !== null
  // A POSIX group outlives its leader, so after forge exits the group can still be swept.
  if (exited && !(evenIfExited && !IS_WINDOWS)) return
  try {
    if (IS_WINDOWS) {
      // No process groups on Windows; /T takes the whole tree, /F forces it.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      // forge runs as the leader of its own group (detached), so -pid reaches solc and any
      // process a test started, not just forge itself (FR-37: no orphans).
      process.kill(-child.pid, signal)
    }
  } catch {
    // Already gone.
  }
}

/**
 * Runs a command with an argv array (never a shell) and collects its output.
 *
 * @param {object} options
 * @param {string|string[]} options.command  executable, or [executable, ...leading args]
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} options.timeoutMs
 * @param {number} [options.maxOutputBytes]
 * @returns {Promise<{ code: number|null, signal: string|null, timedOut: boolean,
 *   outputTruncated: boolean, spawnError: NodeJS.ErrnoException|null, stdout: string,
 *   stderr: string, durationMs: number }>}
 */
function runProcess({
  command,
  args,
  cwd,
  env = process.env,
  timeoutMs,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  const [executable, ...leading] = Array.isArray(command) ? command : [command]
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(executable, [...leading, ...args], {
        cwd,
        env,
        shell: false,
        detached: !IS_WINDOWS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve(emptyResult({ spawnError: error, durationMs: Date.now() - started }))
      return
    }
    active.add(child)

    const stdout = []
    const stderr = []
    let bytes = 0
    let timedOut = false
    let outputTruncated = false
    let spawnError = null
    let settled = false
    let graceTimer = null

    const stop = () => {
      killTree(child, 'SIGTERM')
      graceTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    }
    const collect = (sink) => (chunk) => {
      if (outputTruncated) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) {
        outputTruncated = true
        stop()
        return
      }
      sink.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      active.delete(child)
      // forge has exited; make sure nothing it started outlives it.
      if (!spawnError && child.pid) killTree(child, 'SIGKILL', { evenIfExited: true })
      resolve({
        code,
        signal,
        timedOut,
        outputTruncated,
        spawnError,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
      })
    }
    child.on('error', (error) => {
      spawnError = error
      finish(null, null)
    })
    child.on('close', finish)
  })
}

function emptyResult(fields) {
  return {
    code: null,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    spawnError: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    ...fields,
  }
}

/** Kills every running forge process tree; called when the server shuts down. */
function killAllActive() {
  for (const child of active) killTree(child, 'SIGKILL')
  active.clear()
}

module.exports = { runProcess, killAllActive, DEFAULT_MAX_OUTPUT_BYTES }
