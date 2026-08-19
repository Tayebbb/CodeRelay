<!-- Thanks! The bar, from CONTRIBUTING.md: correctness and safety first,
     features second, size last. -->

## What & why

<!-- What does this change, and what problem does it solve? Link issues. -->

## Checklist

- [ ] `npm test` passes (lint + build + full suite; makes no AI calls)
- [ ] No new runtime dependencies (`grammy` is the entire budget)
- [ ] Touches permissions, redaction, git safety, the state machine or the
      approval flow → **a test is included**
- [ ] No red-team regression (`tests/redteam.test.ts`) was weakened
- [ ] CLI flags used are verified against the *installed* CLI, not assumed
- [ ] Docs updated where behavior changed (README / .env.example)

## If this touches the runner, permissions, git handling or exec

- [ ] `node scripts/live-acceptance.mjs` passed locally (spends ~1 AI credit)
