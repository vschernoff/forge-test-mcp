// A fake forge that answers the calls the server makes, from environment variables and files:
// `--version`, `config` (`--json` or TOML), `build` and `test`. Run as [node, this file, ...args],
// or through a small executable wrapper. Used where a real forge cannot produce the needed
// behaviour on demand (an oversized trace, an override forge ignores, a hang).
//
//   SCRIPTED_FORGE_LOG          build/test argv, one JSON array per line
//   SCRIPTED_FORGE_CALLS        every call: {"args":[…],"foundryConfig":<FOUNDRY_CONFIG contents>|null}
//   SCRIPTED_FORGE_VERSION      `--version` output (default 1.8.6)
//   SCRIPTED_FORGE_CONFIG_JSON  `config --json` output; …_OVERRIDDEN is used when FOUNDRY_CONFIG is set
//   SCRIPTED_FORGE_CONFIG_TOML  `config` (TOML) output
//   SCRIPTED_FORGE_{BUILD,TEST}_{STDOUT,CODE}, SCRIPTED_FORGE_TEST_STDERR
//   SCRIPTED_FORGE_TEXT_{STDOUT,CODE}  for `test` without --json, when set (else TEST_*)
//   SCRIPTED_FORGE_TEST_HANG    pid file: record this pid and a descendant's, then hang in `test`
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const args = process.argv.slice(2)
const env = process.env

if (env.SCRIPTED_FORGE_CALLS) {
  const foundryConfig = env.FOUNDRY_CONFIG ? fs.readFileSync(env.FOUNDRY_CONFIG, 'utf8') : null
  fs.appendFileSync(env.SCRIPTED_FORGE_CALLS, `${JSON.stringify({ args, foundryConfig })}\n`)
}
const logRun = () => {
  if (env.SCRIPTED_FORGE_LOG) fs.appendFileSync(env.SCRIPTED_FORGE_LOG, `${JSON.stringify(args)}\n`)
}

if (args[0] === '--version') {
  process.stdout.write(env.SCRIPTED_FORGE_VERSION ?? 'forge Version: 1.8.6\n')
} else if (args[0] === 'config' && args.includes('--json')) {
  const overridden = env.FOUNDRY_CONFIG && env.SCRIPTED_FORGE_CONFIG_JSON_OVERRIDDEN
  process.stdout.write(
    overridden ??
      env.SCRIPTED_FORGE_CONFIG_JSON ??
      '{"ffi":false,"fuzz":{"runs":256},"fs_permissions":[]}'
  )
} else if (args[0] === 'config') {
  process.stdout.write(env.SCRIPTED_FORGE_CONFIG_TOML ?? '[profile.default]\nffi = false\n')
} else if (args[0] === 'build') {
  logRun()
  process.stdout.write(fs.readFileSync(env.SCRIPTED_FORGE_BUILD_STDOUT, 'utf8'))
  process.exitCode = Number(env.SCRIPTED_FORGE_BUILD_CODE ?? 0)
} else if (args[0] === 'test') {
  logRun()
  if (env.SCRIPTED_FORGE_TEST_HANG) {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    fs.writeFileSync(env.SCRIPTED_FORGE_TEST_HANG, `${process.pid} ${descendant.pid}`)
    setInterval(() => {}, 1000)
  } else {
    // A text-mode run (the trace pass, explain_failure) may be scripted separately.
    const text = !args.includes('--json') && env.SCRIPTED_FORGE_TEXT_STDOUT !== undefined
    const stdout = text ? env.SCRIPTED_FORGE_TEXT_STDOUT : env.SCRIPTED_FORGE_TEST_STDOUT
    process.stdout.write(stdout ? fs.readFileSync(stdout, 'utf8') : '')
    process.stderr.write(env.SCRIPTED_FORGE_TEST_STDERR ?? '')
    process.exitCode = Number(
      (text ? env.SCRIPTED_FORGE_TEXT_CODE : undefined) ?? env.SCRIPTED_FORGE_TEST_CODE ?? 0
    )
  }
} else {
  process.stderr.write(`scripted forge: unexpected ${args.join(' ')}\n`)
  process.exitCode = 2
}
