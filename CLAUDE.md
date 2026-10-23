# forge-test-mcp — notes for agents working on this repo

- **Run health first.** Never report "passed" or "0 failed" unless forge produced a parseable
  report with at least one executed test and an exit code that agrees. Everything else is
  `isError` with a cause (SRS FR-35, C4).
- **No shell.** Spawn forge with argv arrays; pass every option as one `--flag=value` entry.
- **Always `--offline`** (FR-38b). FFI is disabled by a `FOUNDRY_CONFIG` override built from
  `forge config`, never by `FOUNDRY_FFI` (forge ignores it; FR-38a).
- **stdout is the protocol channel.** Nothing may print to it except the MCP transport (FR-40).
- `instructions` stays static and ≤ 512 chars, measured over a live handshake (FR-39).
- No tool may broadcast, deploy, sign or accept keys (FR-38).
- Branch + PR for everything. `npm run lint` and `npm test` green before review. No AI
  attribution lines in commits or PR bodies. Never merge or publish without Vitaliy.
