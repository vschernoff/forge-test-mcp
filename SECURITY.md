# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the repository's **Security**
tab and choose **Report a vulnerability**. That opens a private advisory visible only to you and
the maintainer. Please don't open a public issue or pull request for a security problem.

Include what you ran (forge version, operating system, MCP client), what happened, and the
smallest project or tool call that shows it. You'll get an answer in the advisory thread.

## Supported versions

forge-test-mcp has not had a release yet. Until the first release, only the latest commit on
`main` is supported. After that, the latest published version is.

## What counts as a vulnerability here

The trust model is in the README ([Security and trust](README.md#security-and-trust)). In short:

**In scope:**

- A tool argument (anything an agent can send, including through prompt injection) that leads
  to code execution, file writes outside forge's normal output, or forge running with options
  the user did not choose.
- FFI cheatcodes running when the server was not started with `--allow-ffi`.
- The value of a secret-named environment or `.env` variable reaching a tool response in a form
  the README says is redacted.
- Anything that corrupts the MCP protocol stream (stdout).
- A result that reports tests as passed, or as "0 failed", when forge did not actually run them.
  This server's main promise is that this never happens.
- A forge or other process the server started that keeps running after its timeout, or after the
  server exits.

**Not in scope** (documented behaviour):

- The tested project's own code running when tests run. That is what `forge test` does; use the
  server only on projects you would test in a terminal yourself.
- Tests reaching the network themselves (for example through fork cheatcodes), or a test printing
  a secret in a form other than those the README lists.
- Vulnerabilities in forge or other Foundry components. Please report those as described in
  Foundry's [security policy](https://github.com/foundry-rs/.github/blob/main/SECURITY.md).
  Report solc issues to the [Solidity project](https://github.com/ethereum/solidity/security).
