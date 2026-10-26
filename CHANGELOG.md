# Changelog

## 0.1.0 — 2026-10-26

An MCP server that runs Foundry's `forge test` and `forge build` and returns compact,
structured results to AI coding agents.

### Tools

- `run_tests`: runs `forge test`, with `match_test` / `match_contract` / `match_path`,
  `fuzz_runs`, `traces` and `max_bytes`. Each failing test comes back with its kind (unit, fuzz,
  invariant, setup), its decoded reason, the fuzz counterexample or invariant call sequence,
  console logs, and a short decoded trace for the first five failures. Responses stay within a
  size budget (8 KB by default) and say what was left out.
- `explain_failure`: re-runs one test at high verbosity and returns its reason, counterexample,
  logs, backtrace and decoded trace.
- `build`: compiler errors and warnings with file, line, column and code. It says when forge
  repeated no warnings because nothing was recompiled.

### Run health

- When forge did not run the tests, the result is an MCP error with a code and a hint, never
  "0 failed". This covers a compile error, no matching tests, no Foundry project, a missing or
  unsupported forge, a missing solc, a timeout, a crash, unparseable output, an exit code that
  disagrees with the report, and oversized output.

### Safety

- forge always runs with `--offline`, without a shell, and with every option as a single
  argument.
- FFI cheatcodes are off unless the server is started with `--allow-ffi`, even when
  `foundry.toml` enables them. The server overrides the resolved configuration and checks
  through forge that the override took effect before anything runs.
- Values of secret-named variables (`*PRIVATE_KEY*`, `*MNEMONIC*`, `*SECRET*`, `*TOKEN*`,
  `*API_KEY*`, `*RPC_URL*`) from the environment and the project's `.env` are redacted from
  responses, including the decimal form of hex keys.
- A timeout kills forge's whole process tree, and no forge process outlives the server.
- No tool sends transactions, deploys, signs or takes a key.

### Compatibility

- forge `>=1.8.5 <1.9.0`, tested in CI with 1.8.5 and 1.8.6 on Linux, macOS and Windows.
  Newer versions run with a `forgeUntested` note, or are refused with `--strict-version`.
  Official builds that label themselves pre-release (the 1.8.6 Alpine build reports
  `1.8.6-dev`) count as the release when their commit is the release's commit.
- Node.js 22 and 24.
- A Dockerfile with forge 1.8.6 (static Alpine build, pinned digests).

### Agent trials

Run on 2026-10-26 with the Claude Code CLI 2.1.310, forge 1.8.6 and this server at commit
052a1f3 (see `trials/`). Four tasks (a failing assertion, a compile error, a fuzz failure and an
invariant failure), three runs each per arm. One arm used this server with Bash disallowed; the
other used `forge build` / `forge test` through Bash, with no MCP server.

- Both arms solved 12 of 12. Every run changed only the contract under test, and the scorer
  flagged no gaming, no misread result and no unfinished run.
- Median tokens: 288,158 with the server, 290,275.5 with the shell. Median turns: 9 and 7.5.
  The two are comparable: on these tasks the server did not make the agent faster or cheaper.
  What it adds is run health and safety: no "0 failed" for tests that did not run, FFI off,
  `--offline`, and redacted secrets.

### Not yet verified

- Use inside each MCP client. The server has now been used from the Claude Code CLI (in the
  agent trials). The configuration snippets for other clients come from the vendors'
  documentation and have not been run.
