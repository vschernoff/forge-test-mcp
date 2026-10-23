#!/usr/bin/env node
// Builds one workspace per (task, arm, run) for the D16 agent trials:
//
//   node trials/setup.js --forge /abs/path/to/forge --out /abs/trial-dir [--runs 3] [--no-build]
//
// Each workspace is a fresh copy of the task's fixture with forge-std, a git baseline commit (so
// score.js can see exactly what the agent changed), PROMPT.txt, mcp.json and RUN.sh with the
// exact `claude -p` command. Nothing here calls a model; RUN.sh is run by hand (no API key).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { ensureForgeStd } = require('../test/helpers/projects')

const REPO = path.resolve(__dirname, '..')
const SPEC = require('./tasks.json')

function parseArgs(argv) {
  const args = { runs: SPEC.runsPerArm, build: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--forge') args.forge = path.resolve(argv[++i])
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i])
    else if (argv[i] === '--runs') args.runs = Number(argv[++i])
    else if (argv[i] === '--no-build') args.build = false
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!args.forge || !args.out) throw new Error('usage: setup.js --forge <path> --out <dir>')
  return args
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function runScript({ arm, maxTurns }) {
  return `#!/bin/sh
# D16 trial run. Uses your Claude Code login: ANTHROPIC_API_KEY is unset so the subscription is
# used, and --bare is not used (it ignores the login). Writes transcript.jsonl next to this file.
set -eu
cd "$(dirname "$0")"
env -u ANTHROPIC_API_KEY claude -p "$(cat PROMPT.txt)" \\
  --output-format stream-json --verbose \\
  --permission-mode acceptEdits \\
  --allowedTools ${arm.allowedTools.map(shellQuote).join(' ')} \\
  --disallowedTools ${arm.disallowedTools.map(shellQuote).join(' ')} \\
  --mcp-config ./mcp.json --strict-mcp-config \\
  --max-turns ${maxTurns} \\
  > transcript.jsonl
`
}

async function setup({ forge, out, runs, build }) {
  const forgeStd = await ensureForgeStd()
  const created = []
  for (const task of SPEC.tasks) {
    for (const [armName, arm] of Object.entries(SPEC.arms)) {
      for (let run = 1; run <= runs; run++) {
        const dir = path.join(out, task.id, armName, `run-${run}`)
        if (fs.existsSync(dir)) throw new Error(`${dir} exists; use a fresh --out`)
        fs.cpSync(path.join(REPO, 'test', 'fixtures', 'projects', task.fixture), dir, {
          recursive: true,
        })
        fs.cpSync(forgeStd, path.join(dir, 'lib', 'forge-std'), { recursive: true })
        if (build) {
          // Installs the fixture's solc once (online), as a user would; the server is --offline.
          // The compile-error fixture fails this build, which is expected.
          spawnSync(forge, ['build'], { cwd: dir, stdio: 'ignore' })
        }
        fs.writeFileSync(path.join(dir, '.gitignore'), 'out/\ncache/\nlib/\ntranscript.jsonl\n')
        git(dir, 'init', '-q')
        git(dir, 'add', '-A')
        git(
          dir,
          '-c',
          'user.name=trial',
          '-c',
          'user.email=trial@invalid',
          'commit',
          '-q',
          '-m',
          'baseline'
        )
        // Written after the baseline so score.js sees only the agent's own changes.
        fs.writeFileSync(path.join(dir, 'PROMPT.txt'), `${task.prompt} ${arm.toolSentence}\n`)
        const servers =
          armName === 'mcp'
            ? {
                'forge-test': {
                  command: process.execPath,
                  args: [path.join(REPO, 'src', 'index.js'), '--forge', forge],
                },
              }
            : {}
        fs.writeFileSync(
          path.join(dir, 'mcp.json'),
          `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`
        )
        fs.writeFileSync(path.join(dir, 'RUN.sh'), runScript({ arm, maxTurns: SPEC.maxTurns }))
        fs.chmodSync(path.join(dir, 'RUN.sh'), 0o755)
        fs.writeFileSync(
          path.join(dir, 'trial.json'),
          `${JSON.stringify({ task: task.id, arm: armName, run, forge }, null, 2)}\n`
        )
        created.push(dir)
      }
    }
  }
  return created
}

if (require.main === module) {
  setup(parseArgs(process.argv.slice(2)))
    .then((dirs) => console.log(`${dirs.length} workspaces:\n${dirs.join('\n')}`))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}

module.exports = { setup, runScript }
