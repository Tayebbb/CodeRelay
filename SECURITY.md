# Security Policy

CodeRelay is an AI agent that runs unattended on a personal computer with the
operator's own permissions. Security reports are taken seriously and handled
with priority over feature work.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use
GitHub's private reporting: **Security → Report a vulnerability** on this
repository. Include what you found, how to reproduce it, and what an attacker
gains.

You can expect an acknowledgement within a few days. There is no bounty — this
is a free, self-hosted personal tool — but real findings get fixed, credited,
and added to the red-team regression suite so they stay fixed.

## Scope — what counts

The threat model treats the **target repository as hostile input** and the
operator as trusted. In scope, roughly in order of severity:

1. Escaping the deny-lists or the child-environment allow-list (e.g. reaching
   the Telegram bot token or the operator's credentials from a task, a test
   run, or repository content).
2. Making the agent execute repository-supplied configuration (git hooks,
   filter/diff drivers, planted binaries, agent-instruction files, MCP/LSP
   config) despite the existing detections.
3. Web interface: authentication bypass, CSRF, XSS via agent output or
   repository content, path traversal, session weaknesses, the service worker
   caching anything from `/api/`.
4. Destroying the operator's uncommitted work, or bypassing an approval gate
   (protected branch, push, dirty tree, manifest tamper).
5. Unbounded spend: defeating the credit budgets or the unreported-usage guard.

Out of scope: attacks requiring an already-compromised operator account or
machine, the inherent fact that running a project's tests executes that
project's code (documented as a known limitation), and denial-of-service
against your own instance.

## What already exists

The design assumptions and verified attack history are documented in
[project-analysis.md](project-analysis.md) §7, and every previously working
exploit has a regression test in `tests/redteam.test.ts`. Reading those two
first will tell you what has already been tried.
