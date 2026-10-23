# forge-test-mcp

An MCP server that runs Foundry's `forge test` and `forge build` and returns **compact,
structured results** an AI coding agent can act on: for every failing test, its kind, the
decoded reason, the fuzz counterexample or invariant call sequence, console logs and a short
decoded trace. It speaks standard MCP over stdio and is meant for any MCP client (Claude Code,
Codex, Cursor, Claude Desktop, Windsurf, …). So far it has been tested with an MCP test client,
not yet inside each of those clients.

When forge did **not** run the tests (a compile error, no matching tests, a timeout, a missing
or unsupported `forge`, …) the tool says so as an error. It never reports "0 failed" for tests
that did not run.

> **Status:** in development, not yet published to npm. The commands below show how it will
> be used once it is.

## Requirements

- Node.js 22 or later.
- [Foundry](https://getfoundry.sh) with `forge` **1.8.5 or a later 1.8.x**. You install it; this
  server never installs or updates anything. Newer versions run but are flagged as untested.
- The project's compiler version installed once: run `forge build` in a terminal first. The
  server runs forge with `--offline`, so it cannot download solc itself.

## Configure your MCP client

Start the server **in your Foundry project** (the directory with `foundry.toml`, or below it).
Most clients accept this `mcpServers` entry:

```json
{
  "mcpServers": {
    "forge-test": {
      "command": "npx",
      "args": ["-y", "forge-test-mcp@<version>"]
    }
  }
}
```

Pin an exact version. Client shortcuts, from each vendor's documentation (checked
2026-10-23, not yet verified by running each client):

- **Claude Code:** put the JSON above in `.mcp.json` at the project root. In interactive sessions
  Claude Code asks you to approve project servers the first time.
- **Cursor:** put it in `.cursor/mcp.json`, adding `"type": "stdio"` to the server entry.
- **Codex:** in `.codex/config.toml` (loaded for trusted projects only) or `~/.codex/config.toml`:

  ```toml
  [mcp_servers.forge-test]
  command = "npx"
  args = ["-y", "forge-test-mcp@<version>"]
  ```

### Docker

The image contains the server and forge 1.8.6 (the official static Alpine build, checked
against the release's provenance digests during the build). Mount the project at `/project`
and a cache volume at `/cache`, where forge keeps the compiler:

```bash
docker build -t forge-test-mcp .
docker run --rm -v "$PWD":/project -v forge-test-mcp-cache:/cache --entrypoint forge forge-test-mcp build
```

The second command installs the project's solc once, online. Then configure the client to run
`docker` with `["run", "-i", "--rm", "-v", "<project>:/project", "-v",
"forge-test-mcp-cache:/cache", "forge-test-mcp"]`. forge writes `out/` and `cache/` into the
project, so on Linux add `--user "$(id -u):$(id -g)"` to both commands.

### Options

Options go after the package name in `args`. Only the user sets them; no tool argument can.

| Option                | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `--root <dir>`        | Project directory (default: where the client starts the server).                          |
| `--forge <path>`      | The `forge` executable (default: `forge` on `PATH`).                                      |
| `--timeout <seconds>` | Stop a forge run after this long (default 300).                                           |
| `--allow-ffi`         | Let tests use FFI cheatcodes when `foundry.toml` enables them. Off by default; see below. |
| `--strict-version`    | Refuse forge versions newer than the tested range instead of flagging them.               |

## Tools

| Tool              | What it does                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_tests`       | Runs `forge test`. Filters: `match_test`, `match_contract`, `match_path`; `fuzz_runs`; `traces` (default true); `max_bytes` (default 8192).                                                              |
| `explain_failure` | Re-runs one test at high verbosity and returns only that test: reason, counterexample, logs, backtrace and the decoded trace. Pass the name as `run_tests` prints it, e.g. `"BankTest.test_transfer()"`. |
| `build`           | Runs `forge build` and returns compiler errors and warnings with file, line, column and code. `force: true` recompiles everything.                                                                       |

None of them sends transactions, deploys, signs or accepts keys.

A failing `run_tests` result looks like this:

```json
{
  "status": "failed",
  "forge": "1.8.6",
  "summary": { "suites": 1, "passed": 1, "failed": 1, "skipped": 0 },
  "ffi": "disabled",
  "fuzzRuns": { "configured": 256, "used": 256 },
  "notRun": [],
  "failures": [
    {
      "test": "SupplyInvariantTest.invariant_supplyMatches()",
      "file": "test/Supply.t.sol",
      "kind": "invariant",
      "reason": "supply mismatch: 6683 != 6355",
      "sequence": {
        "calls": [
          { "call": "Handler.mint(uint256)", "args": "6683", "sender": "0x…022f" },
          { "call": "Handler.burnFrom(uint256)", "args": "328", "sender": "0x…054e" }
        ],
        "shrunkFrom": 4
      },
      "trace": [
        "[21670] SupplyInvariantTest::invariant_supplyMatches()",
        "  ├─ [0] VM::assertEq(6683, 6355, \"supply mismatch\") [staticcall]",
        "  │   └─ ← [Revert] supply mismatch: 6683 != 6355",
        "  └─ ← [Revert] supply mismatch: 6683 != 6355"
      ],
      "traceLinesOmitted": 16
    }
  ],
  "truncated": null
}
```

Responses stay within the size budget. When there is more than fits, traces and logs go
first, then whole failures, and `truncated` says exactly how many were left out.

### When the tests did not run

The result is an MCP error (`isError: true`) with a code, a message and a hint:

| Code                                                                                                                                                         | Cause                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `COMPILE_FAILED`                                                                                                                                             | The project does not compile (the first compiler errors are included).         |
| `NO_TESTS_RAN`                                                                                                                                               | No test matched the filters, or every matched test was skipped.                |
| `NOT_A_FOUNDRY_PROJECT`                                                                                                                                      | No `foundry.toml` here or above it in the repository.                          |
| `FORGE_NOT_FOUND`, `UNSUPPORTED_FORGE_VERSION`                                                                                                               | `forge` is missing, or older than 1.8.5.                                       |
| `SOLC_MISSING`                                                                                                                                               | Run `forge build` once in a terminal so forge can install the compiler.        |
| `TIMEOUT`                                                                                                                                                    | The run took longer than `--timeout`; forge reports nothing until it finishes. |
| `CONFIG_ERROR`, `INVALID_ARGUMENTS`, `FORGE_CRASHED`, `FORGE_FAILED`, `UNPARSEABLE_OUTPUT`, `INCONSISTENT_RESULT`, `OUTPUT_TOO_LARGE`, `FFI_OVERRIDE_FAILED` | forge could not produce a trustworthy report; the message and stderr say why.  |

## Security and trust

**Running tests runs code.** `forge test` executes the project's Solidity and cheatcodes with
your user's rights, just as it does in a terminal. Only use this server on projects you would
test in a terminal yourself. It cannot make an untrusted repository safe.

What the server does to reduce that risk:

- **FFI is off unless you opt in.** FFI cheatcodes run arbitrary shell commands. forge ignores
  `FOUNDRY_FFI` in the environment, so when `foundry.toml` sets `ffi = true` the server runs
  forge with a copy of the resolved configuration that has `ffi = false`, and checks through
  forge that it took effect before running anything. Start the server with `--allow-ffi` if
  you want FFI.
- **No downloads.** forge always runs with `--offline`, so forge itself makes no network
  lookups. Tests can still reach the network on their own, for example fork tests through
  `vm.createSelectFork` and RPC endpoints.
- **No shell.** forge is started with an argument list. Tool arguments are validated and passed
  as single `--flag=value` arguments.
- **Secrets.** forge loads the project's `.env` itself, so tests can read and print those
  values. The server replaces the exact values of variables named like `*PRIVATE_KEY*`,
  `*MNEMONIC*`, `*SECRET*`, `*TOKEN*`, `*API_KEY*` and `*RPC_URL*` (RPC URLs often embed an API
  key), from its environment and `.env`, with
  `[redacted:NAME]`. A hex value such as a private key is also caught without `0x`, in either
  case, without leading zeros, and in decimal (as `vm.envUint` and `console.log` print it). It
  cannot catch a secret printed in any other form. Keep spendable keys out of projects you
  test with an agent.
- **No transactions.** No tool broadcasts, deploys, signs or takes a key.

**Passing tests do not prove a contract is secure.** They show the tests you wrote pass.
Contracts that will hold value need an independent audit.

## Foundry compatibility

Tested in CI against forge **1.8.5 and 1.8.6** on Linux, macOS and Windows. Supported range:
`>=1.8.5 <1.9.0`. Older versions are refused. Newer ones run with a `forgeUntested` note
(or are refused with `--strict-version`).

## License

MIT © Vitaliy Chernov. See [NOTICE](NOTICE) for the licences of the dependencies.
