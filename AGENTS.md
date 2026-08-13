# Working on this repository

Remote coding agent: Telegram → home PC → GitHub Copilot CLI → local project.
Single user, self-hosted, zero recurring infrastructure cost.

## Ground rules

- **Zero recurring cost.** Do not add any dependency or service that costs money
  or requires an external account. One runtime dependency (`grammy`) is the
  budget; prefer Node built-ins (`node:sqlite`, `node:test`,
  `process.loadEnvFile`) over packages.
- **Never invent CLI flags.** Verify against the *installed* Copilot CLI
  (`copilot --help`, `copilot help permissions`, `copilot help config`) before
  using a flag. If a capability does not exist, implement the closest supported
  approach and document the limitation — do not fake it.
- **Never weaken the security model.** `--yolo`, `--allow-all`,
  `--allow-all-paths` and `--allow-all-urls` must never be passed. Additions to
  the permission deny-list are welcome; removals need a strong reason.
- **Never let secrets escape.** Everything sent to Telegram, written to a log,
  or stored in the database goes through `redact()`.
- **Never destroy user work.** Git checkpointing must stay non-destructive: it
  writes through a temporary `GIT_INDEX_FILE` and must not touch the working
  tree or the user's index.

## Commands

```
npm run build       # tsc
npm test            # build + 113 tests (no AI calls, no credits)
npm run typecheck
npm run doctor
npm run agent -- <command>
```

## Conventions

- TypeScript, ESM, `NodeNext` resolution — **always** use `.js` extensions in
  relative imports.
- Tests use `node:test` + `node:assert/strict`. No test framework dependency.
- Untrusted text (anything from Telegram) is passed as an `argv` element with
  `shell: false`. `shell: true` is only acceptable for commands this app itself
  assembles (package-manager shims on Windows).
- Telegram messages are plain text — no `parse_mode` — to avoid formatting
  injection when echoing code and paths.
- Comments explain *why*, not *what*. One line where one line will do.

## Testing changes

Any change to permissions, redaction, git safety, the state machine or the
approval flow must come with a test. The end-to-end suite (`tests/e2e.test.ts`)
drives the real runner against a mock Copilot CLI in a temporary git repo — extend
it rather than mocking the runner itself.
