// Kills the processes a test recorded in a pid file once the test ends, even if it failed or was
// cancelled by --test-timeout (e.g. a hanging mutant). Only PIDs this test wrote are touched, and
// on POSIX only if they still run one of our fakes, so a reused PID is never killed.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const OUR_FAKES = /fake-forge\.js|scripted-forge\.js|setInterval\(\(\) => \{\}, 1000\)/

function isOurFake(pid) {
  if (process.platform === 'win32') return true
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return OUR_FAKES.test(ps.stdout ?? '')
}

function killRecordedPids(t, pidFile) {
  t.after(() => {
    let text
    try {
      text = fs.readFileSync(pidFile, 'utf8')
    } catch {
      return
    }
    for (const pid of text.split(/\s+/).map(Number).filter(Number.isInteger)) {
      try {
        if (pid > 0 && isOurFake(pid)) process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })
}

module.exports = { killRecordedPids }
