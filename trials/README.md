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
| Arm `mcp`            | forge-test-mcp's three tools; `Bash` is removed from the agent's context.                                                                                                                          |
| Arm `shell`          | No MCP server; the shell may run only `forge build …` and `forge test …`.                                                                                                                          |
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
node trials/score.js --forge /path/to/forge ~/ftm-trials/*/*/run-* > ~/ftm-trials/results.jsonl
node trials/score.js --summary ~/ftm-trials
```

Each row records the following:

- **success:** real forge passes with at least one test executed, and no test file or
  `foundry.toml` changed;
- **turns** (`num_turns`), **tool calls** by name, and **tokens**: input, output and cache
  tokens from the run's `result` event;
- **gaming** (C10): any change under `test/` or to `foundry.toml`;
- **possibleMisread:** the final message claims the tests pass while they fail. This is a
  pointer for a human to read the transcript, not a verdict.

The summary gives, per task and arm, the success count and the median turns, tool calls and
tokens.

**M3 is met** when, over all four tasks, arm `mcp` succeeds at least as often as `shell` and
its median turns or tokens are lower. Keep `results.jsonl` and the transcripts as the
evidence (they belong in the kit's `eval/results/<date>/trials/`).

## Limits

- The scorer reads the stream-json event shapes from Claude Code's documentation
  (code.claude.com/docs/en/headless and docs/en/agent-sdk, checked 2026-10-23). Its tests
  use a synthetic transcript, so check the first real transcript's `result` event against
  what `score.js` reads.
- Token counts include cache reads, which are cheap. Compare input+output separately if
  the totals differ mainly through caching.
- One client only. A Codex run would need its own `RUN.sh` (D16 allows it when Codex is
  set up).
