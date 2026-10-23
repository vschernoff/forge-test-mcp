// A stand-in for forge in process tests, run as [node, this file, ...args].
// FAKE_FORGE_SCENARIO picks the behaviour; FAKE_FORGE_PIDFILE receives grandchild pids.
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const scenario = process.env.FAKE_FORGE_SCENARIO ?? 'echo'
const args = process.argv.slice(2)

function startGrandchild() {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  fs.writeFileSync(process.env.FAKE_FORGE_PIDFILE, String(grandchild.pid))
}

switch (scenario) {
  case 'echo':
    process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }))
    break
  case 'exit':
    process.stderr.write('fake failure\n')
    process.exitCode = Number(process.env.FAKE_FORGE_EXIT ?? 1)
    break
  case 'hang-with-child':
    startGrandchild()
    setInterval(() => {}, 1000)
    break
  case 'exit-leaving-child':
    startGrandchild()
    process.stdout.write('{}')
    // Exit while the grandchild keeps running, with its stdio detached from ours.
    process.exit(0)
    break
  case 'flood': {
    const chunk = Buffer.alloc(64 * 1024, 'x')
    const write = () => {
      while (process.stdout.write(chunk));
      process.stdout.once('drain', write)
    }
    write()
    break
  }
  default:
    process.stderr.write(`unknown FAKE_FORGE_SCENARIO ${scenario}\n`)
    process.exitCode = 99
}
