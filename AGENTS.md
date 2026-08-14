# Working on this repository

Remote coding agent: Telegram → home PC → GitHub Copilot CLI → local project.
Single user, self-hosted, zero recurring infrastructure cost.

## Ground rules

- **Zero recurring cost.** Do not add any dependency or service that costs money
  or requires an external account. One runtime dependency (`grammy`) is the
  budget; prefer Node built-ins (`node:sqlite`, `node:test`,
  `process.loadEnvFile`) over packages.
- **Never invent CLI flags, and never trust yesterday's answer.** The Copilot CLI
  auto-updates and its flags and model catalogue change. Verify against the
  _installed_ CLI (`copilot --help`, `help permissions`, `help config`,
  `help sandbox`, `help limits`). Appending `--agent __nope__` to a full argv is
  a zero-cost way to check that every other flag parses.
- **Never weaken the security model.** `--yolo`, `--allow-all`,
  `--allow-all-paths` and `--allow-all-urls` must never be passed. The child
  environment is an allow-list, not a deny-list. Additions to the permission
  deny-list are welcome; removals need a strong reason.
- **Never let secrets escape.** Everything sent to Telegram, written to a log,
  or stored in the database goes through `redact()`.
- **Every agent role costs credits, so decisions about agents must not.**
  Classification, budgeting, confidence scoring and escalation live in
  `src/orchestrator/` and are plain TypeScript. Never add an AI call whose only
  job is to decide whether to make another AI call. Free gates (tests, build,
  manifest integrity, repo scan) always run before a paid review.
- **Advisory roles must be read-only at the tool level.** The explorer and
  reviewer get `--deny-tool=write`; their safety must not depend on the prompt
  being obeyed.
- **A provider must never silently lower the bar.** The deny-list is written in
  each CLI's own flag language, so a provider that cannot express "deny
  shell(curl)" would void a protection the README still promises. Every provider
  DECLARES its capabilities, `REQUIRED_CAPABILITIES` are mandatory, and
  `selectProvider()` refuses rather than degrades. Declare a capability only when
  a real, verified flag on the _installed_ CLI implements it.
- **"Zero recurring cost" is per-provider.** It is true of Copilot because the
  subscription already exists. Any other provider bills separately and must say
  so in `billing`, which `doctor` prints.
- **Anything that runs project-supplied code gets `buildChildEnv()`,** never
  `process.env`. `execCommand`'s `env` REPLACES the environment; a hostile
  `"test"` script must not be able to read the bot token.
- **Treat the target repository as hostile configuration, not just hostile text.**
  The Copilot CLI loads agents, skills, hooks, plugins, MCP and LSP config
  relative to the working directory. New capability paths go in
  `src/security/repoScan.ts`; anything that names a command is `blocking`.
- **Git executes what `.git/config` and `.git/hooks` name.** New git invocations
  must go through `Git.run()` so they inherit `GIT_HARDENING`, and anything that
  can execute belongs in `fingerprintGitControlSurface`.
- **Never destroy user work.** Git checkpointing must stay non-destructive: it
  writes through a temporary `GIT_INDEX_FILE` and must not touch the working
  tree or the user's index. Never overwrite an existing checkpoint ref.
- **Never block a Telegram handler on something another update must resolve.**
  grammY processes updates strictly sequentially, so awaiting an approval inside
  a handler deadlocks the entire bot.
- **Interfaces are thin clients.** Telegram and the web UI submit, cancel,
  retry and approve ONLY through `TaskService`/`ApprovalService`, and observe
  ONLY through the repository and the `EventBus`. A queue cap, risk gate or
  approval check implemented inside one interface is a bug even when it works:
  it is where the interfaces start to disagree. Each interface must be fully
  optional; the core runs with either or both.
- **The web surface trusts nothing.** All DOM insertion via `textContent`, CSP
  with no inline script, mutations require the `X-CodeRelay` header plus
  same-origin `Origin`, static serving only from `web/` with an extension
  allow-list. The browser gets project metadata, never filesystem paths.

## Commands

```
npm run build       # tsc
npm run lint        # tsc with noUnusedLocals/Parameters/ImplicitReturns
npm test            # lint + build + 306 tests (no AI calls, no credits)
npm run typecheck
npm run doctor
npm run agent -- <command>

node scripts/live-acceptance.mjs   # SPENDS ~1-2 AI CREDITS. Manual only.
```

`scripts/live-acceptance.mjs` drives the real Copilot CLI against a throwaway
repo containing a real bug and asserts the whole chain: checkpoint -> repo scan
-> Copilot -> verification -> approval -> commit, plus "the bot token never
reached Telegram". Run it after touching the runner, permissions, git handling
or `execCommand`. The mocked suite cannot catch environment or quoting faults;
this is the only thing that can.

## Conventions

- TypeScript, ESM, `NodeNext` resolution — **always** use `.js` extensions in
  relative imports.
- Tests use `node:test` + `node:assert/strict`. No test framework dependency.
- Untrusted text (anything from Telegram) is passed as an `argv` element with
  `shell: false`. On Windows, `shell: true` routes through `cmdExeInvocation`,
  which quotes every token that _needs_ quoting — never hand a raw string to
  `spawn(shell: true)`. **Do not quote a bare program name.** `cmd /c ""npm"
"test""` sets `%0` to a quoted bare name, so `%~dp0` inside `npm.cmd` expands
  to the _current directory_; npm then dies looking for
  `<cwd>\node_modules\npm\bin\npm-prefix.js`. That made every verification using
  npm/yarn/pnpm/gradlew fail and silently threw away correct work.
- **The model catalogue is not an entitlement.** `--help` can list a model that
  the API refuses at run time (`Model "X" from --model flag is not available`),
  and that refusal is often just transient rate limiting — the same model works
  again minutes later. Treat it as recoverable: switch models once, then fail
  with an actionable message. Never treat it as a fatal startup error.
- Telegram messages are plain text — no `parse_mode` — to avoid formatting
  injection when echoing code and paths.
- Long-running child processes must be killed with `killProcessTree` and backed
  by a watchdog: `close` does not fire while a grandchild holds a stdio pipe.
- Comments explain _why_, not _what_. One line where one line will do.

## Testing changes

Any change to permissions, redaction, git safety, the state machine or the
approval flow must come with a test. The end-to-end suite (`tests/e2e.test.ts`)
drives the real runner against a mock Copilot CLI in a temporary git repo — extend
it rather than mocking the runner itself. `tests/redteam.test.ts` holds
regressions for attacks that were verified to work against an earlier build;
never weaken one to make a change pass.
