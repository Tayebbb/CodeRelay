# Contributing to CodeRelay

Thanks for considering a contribution. CodeRelay is a small, security-focused,
self-hosted tool — contributions are judged by that standard: correctness and
safety first, features second, size last.

## Getting set up

```powershell
git clone https://github.com/Tayebbb/CodeRelay.git
cd CodeRelay
npm install
npm test
```

`npm test` runs the linter, the TypeScript build and the full suite. It drives
the real task runner against a **mock** agent CLI in temporary git
repositories — **it makes no AI calls and costs no credits**, so run it as
often as you like.

Other useful commands:

```powershell
npm run lint         # strict type check (noUnusedLocals, noImplicitReturns…)
npm run typecheck
npm run build
npm run doctor       # environment diagnostic
```

`node scripts/live-acceptance.mjs` drives the **real** Copilot CLI and spends
about one AI credit — it is manual-only, and only needed for changes to the
runner, permissions, git handling or process execution.

## Ground rules

- **Zero recurring cost.** Do not add dependencies. `grammy` is the entire
  runtime dependency budget; prefer Node built-ins (`node:sqlite`, `node:test`,
  `node:http`).
- **Never weaken the security model.** The permission deny-lists, redaction,
  child-environment allow-list and repository hardening are the product.
  Additions to deny-lists are welcome; removals need a strong, argued reason.
- **Security-sensitive changes need tests.** Anything touching permissions,
  redaction, git safety, the task state machine or the approval flow must come
  with a test. Extend `tests/e2e.test.ts` rather than mocking the runner.
- **Never weaken a red-team regression.** `tests/redteam.test.ts` holds
  regressions for attacks that actually worked against earlier builds.
- **Verify CLI flags against the installed CLI.** Provider adapters may only
  declare capabilities backed by a real, verified flag — never a hoped-for one.

## Conventions

- TypeScript, ESM, `NodeNext` resolution — always use `.js` extensions in
  relative imports.
- Tests use `node:test` + `node:assert/strict`. No test framework dependency.
- Comments explain _why_, not _what_.

## Reporting security issues

**Never open a public issue for a vulnerability.** Use GitHub's private
reporting as described in [SECURITY.md](SECURITY.md). Real findings get fixed,
credited, and turned into permanent red-team regressions.
