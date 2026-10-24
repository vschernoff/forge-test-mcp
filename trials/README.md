# Agent trials (D16, SRS M3)

M3's exit criterion: **on the fixture tasks, an agent with forge-test-mcp needs fewer turns or
fewer tokens than the same agent with raw `forge test -vvvv`, and succeeds at least as often.**
Trials run by hand with your own Claude Code login (D16: no API key, no CI spend). This kit
follows the agent-trial rubric of the kit's evaluation design (eval-design §4). Success is
decided by running real forge on the result, never by what the agent says.

Not part of the npm package.

## What runs

|                      |                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks (`tasks.json`) | `fix-assert` (off-by-one), `fix-fuzz` (overflow in a fuzzed function), `fix-invariant` (supply not lowered on burn), `fix-compile` (type error). Each is a fixture from `test/fixtures/projects/`. |
| Arm `A-tool`         | forge-test-mcp's three tools; `Bash` is removed from the agent's context.                                                                                                                          |
| Arm `B-shell`        | No MCP server; the shell may run only `forge build …` and `forge test …`.                                                                                                                          |
| Prompt               | Identical in both arms except one sentence naming the tools. Every prompt says not to change, skip or delete tests and not to touch `foundry.toml`.                                                |
| Runs                 | 3 per task and arm (24 in total), at most 30 turns each.                                                                                                                                           |

## 1. Prepare (once)

Use any supported forge (1.8.5 or later 1.8.x):

```bash
node trials/setup.js --forge "$(command -v forge)" --out ~/ftm-trials
```

This creates `~/ftm-trials/<task>/<arm>/run-<n>/`, each with:

- a fresh copy of the fixture, with forge-std;
- solc installed by one `forge build` (the compile task's build fails, as intended);
- a git baseline commit;
- `PROMPT.txt`, `mcp.json` and `RUN.sh`, which holds the exact `claude -p` command.

## 2. Run (by hand)

Check that Claude Code uses your subscription login, not an API key:
`claude auth status` should show `authMethod` from claude.ai. Then run each workspace:

```bash
for run in ~/ftm-trials/*/*/run-*/RUN.sh; do "$run"; done
```

Each `RUN.sh` does the following:

- unsets `ANTHROPIC_API_KEY`;
- runs `claude -p` with `--output-format stream-json --verbose`, `--permission-mode acceptEdits`, the arm's `--allowedTools` and `--disallowedTools`, `--mcp-config ./mcp.json --strict-mcp-config` (no other servers) and `--max-turns 30`;
- writes `transcript.jsonl`.

Don't use `--bare`: it ignores the subscription login. Project hooks in `.claude/settings.json`
still run in `-p` mode, but the fixtures have none.

Mix the order of arms if you can, so rate limits or model changes don't fall on one arm only.

## 3. Score

```bash
node trials/score.js --forge "$(command -v forge)" --results ~/ftm-results ~/ftm-trials/*/*/run-*
node trials/score.js --summary ~/ftm-results
```

`--results` writes one record per run, in the layout the kit's `eval/results/<date>/trials/`
uses (schema `forge-test-mcp/trial-run@1`, agreed with the Evaluator):
`<task>/<arm>/run-<n>.json`, plus the verbatim `run-<n>.transcript.jsonl` (its sha256 is
in the record) and `summary.json`. Each record holds:

- **success**: `passed` is true only when real forge (run like the server does: `--offline`,
  FFI forced off, and only allow-listed environment variables) passes with at least one test
  executed
  and the agent changed no test file and not `foundry.toml`. `check` and `detail` say how this
  was decided.
- **workspace**: `baseCommit`, and `finalCommit`, which is the agent's changes, committed by
  the scorer.
- **iterations** (`num_turns`), **tokens** (`input`, `output`, `cacheRead`, `cacheWrite`),
  **toolCalls** by name, `durationMs`, `client`, `model` and `startedAt`.
- **gaming** (C10): `test-deleted`, `test-skipped`, `test-modified`, `fuzz-runs-lowered`,
  `config-loosened` or `solhint-disable`, each with the file and the offending line.
- **misreads**: the final message claims the tests pass while they fail. This points a human
  to the transcript; it is not a verdict.
- **deniedToolAttempts**, from the run's `permission_denials`.

The summary gives, per task and arm, successes and the median iterations, tool calls, tokens,
and input+output tokens, followed by one `ALL` row per arm over every task.

**M3 is met** when, over all four tasks, arm `A-tool` succeeds at least as often as `B-shell` and
its median turns or tokens are lower. Copy the results directory to the kit's
`eval/results/<date>/trials/` as the evidence.

## Limits

- The scorer reads the stream-json event shapes from Claude Code's documentation
  (code.claude.com/docs/en/headless and docs/en/agent-sdk, checked 2026-10-23). Its tests
  use a synthetic transcript, so check the first real transcript's `result` event against
  what `score.js` reads.
- Token counts include cache reads, which are cheap. Compare input+output separately if
  the totals differ mainly through caching.
- One client only. A Codex run would need its own `RUN.sh` (D16 allows it when Codex is
  set up).
