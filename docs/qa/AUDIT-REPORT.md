# Production Resilience & QA Audit

Date: 2026-08-18 · Auditor: QA lead (all specialist roles executed in-line; see
"Agents Deployed") · Scope: CodeRelay — Telegram + web remote coding agent,
Windows deployment via Scheduled Task, Tailscale remote access.
This is the single, cumulative audit record for the whole workflow; later
phases extend it in place rather than replacing it.

## Chronology

```
PRODUCTION OUTAGE (web dead at logon, third occurrence)
        ↓
ROOT-CAUSE ANALYSIS → BUG-000 cluster (bind race, dead notification,
                      supervisor lie, SSE heartbeat crash)
        ↓
FIXES + 3 REGRESSION TESTS → prod restarted 11:39, HTTP 200
        ↓
AUDIT CYCLE 1 — static + lab audit of the whole lifecycle surface
        ↓
NEW FINDINGS F-01…F-05 (2×P1, 3×P3) → FIXED + 10 REGRESSION TESTS
        ↓
prod restarted 12:32 — the restart itself exercised the bind-retry fix live
        ↓
AUDIT CYCLE 2 — PRODUCTION RELIABILITY / CHAOS QA (this phase):
adversarial labs against the fixes, failure chains, control-flow sweep
        ↓
NEW FINDINGS P3-01…P3-04 (1 test gap FIXED, 3 accepted low risks)
        ↓
FINAL VERIFICATION — 435/435 tests, prod healthy
```

## Executive Summary

The audit hunted for lifecycle/environment/recovery failures of the class that
caused the 2026-08-18 production outage (web bind raced the Tailscale adapter;
process died; supervisor never restarted it; error reporting was unreachable).

Result: **2 new P1 failure modes found, reproduced, fixed and verified**, plus
3 P3 defects fixed, on top of the 4 defects fixed earlier the same day
(BUG-000 cluster). A subsequent chaos-QA cycle (Phase 3, below) attacked the
fixes themselves — permanent dependency absence, crash-restart with a fresh
lock heartbeat, dual-start races, clock-skew adversarial analysis — and
produced no new code defects, one closed test-coverage gap, and three
accepted low risks. 435/435 tests pass, including 14 new regression tests. No
P0 found. The system's data-integrity, security and crash-recovery layers
(checkpoints, orphan recovery, DB quarantine, redaction, deny-lists) were
audited and found sound — findings concentrate in _startup order, supervision
and partial-failure_ behavior, exactly the target class.

**Reliability assessment: the known single-points-of-permanent-death are now
closed.** Every startup dependency (VPN address, internet, Telegram, log
directory, lock file, port) now either waits, retries, degrades or restarts —
none of them silently kills the process anymore.

## Environment Matrix

| Env | Condition                                                            | Result                     | Evidence                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Normal operation                                                     | PASS                       | Prod agent live (HTTP 200 on tailnet address); 435 tests                                                                                                                                                                  |
| B   | Cold boot / logon ordering                                           | PASS (component-simulated) | Task action verified via Start-ScheduledTask; supervisor loop proven with stubs; crash-restart lab C4; real reboot NOT SAFELY EXECUTED mid-session                                                                        |
| C   | Dependency late (Tailscale IP, internet)                             | PASS                       | Bind-retry tests (`web bind resilience`); infinite Telegram retry test; live prod restart 12:32 bound on attempt 3                                                                                                        |
| D   | Dependency failure (Telegram down, port held, address NEVER appears) | PASS                       | Outbox chaos tests; EADDRINUSE wait test; lab C1: 115 s on a never-assignable address — alive, 5 log lines, 0.33 s CPU                                                                                                    |
| E   | Dependency recovery                                                  | PASS                       | Port freed → binds; getMe succeeds after 24 failures (tests)                                                                                                                                                              |
| F   | Intermittent connectivity                                            | PARTIAL                    | grammY internal retry + `evaluateHealth` reasoned; no packet-loss rig                                                                                                                                                     |
| G   | Process crash                                                        | PASS                       | Supervisor restart proven (stub exit 1 → restart → exit 0); lab C4: hard kill → instant restart reclaims fresh-mtime lock, serves HTTP 200; orphan requeue chaos tests                                                    |
| H   | Restart during active use                                            | PASS                       | Stranded approvals cancelled + operator notified; interrupted tasks requeued once, billed spend preserved (chaos tests)                                                                                                   |
| I   | Sleep / wake                                                         | NOT SAFELY EXECUTED        | Static analysis: grammY health probe + outbox + SSE client full resync + guarded heartbeat writes                                                                                                                         |
| J   | Network transition                                                   | PARTIAL                    | Telegram side covered; web listener survives flap per Windows socket semantics (UNCONFIRMED, see R-02)                                                                                                                    |
| K   | IP change / adapter bounce                                           | NOT SAFELY EXECUTED        | Would sever the live tailnet; boot-time case covered by bind retry                                                                                                                                                        |
| L   | Resource pressure                                                    | PARTIAL                    | Disk preflight + "disk almost full" chaos tests; C1 soak shows flat RAM (≈63 MB) under permanent retry; CPU/RAM/FD exhaustion not simulated                                                                               |
| M   | Concurrent operations                                                | PASS                       | Queue cap 20, per-project serialization, single-claim recovery test, approval resolve is delete-before-resolve (race-safe), SQLite busy_timeout 5 s; lab C13: two simultaneous starters → exactly one wins, loser exits 5 |
| N   | Browser chaos                                                        | PARTIAL                    | Double-submit fixed (F-03); SSE Last-Event-ID replay tested; oversize-body survival test added (P3-01); full device matrix verified in a prior session                                                                    |
| O   | Invalid configuration                                                | PASS                       | Lab: malformed AUTHORIZED_TELEGRAM_USER_ID → actionable message, exit 2, zero side effects; lab C5: doctor warns on unassigned WEB_HOST                                                                                   |
| P   | Partial failure (one subsystem down)                                 | PASS                       | Telegram dead ⇒ web keeps working (F-02); WEB_HOST absent ⇒ Telegram keeps working (bind retry); DB corrupt ⇒ quarantined, agent returns (chaos test)                                                                     |

## Agents Deployed

`runSubagent` delegation was attempted twice and failed in this environment
("no response"); all twelve specialist roles were therefore executed
sequentially by the lead with the same domain separation. Domain mapping:
startup/lifecycle (labs 1, G, B), network chaos (F-02 labs/tests), resources
(logger/disk), persistence (pragma + chaos review), business logic (task
lifecycle/credits/approvals — this system's "business"; e-commerce items in
the brief are N/A: no orders/payments/inventory exist in this repository),
authn/authz, frontend, API, concurrency, deployment, observability,
adversarial (existing redteam suite reviewed + extended thinking).

## Critical Findings

None (P0: 0).

## High Findings

### F-01 — Stale single-instance lock causes permanent lockout after reboot/crash

- Severity: P1 · Category: Startup / Recovery · Component: src/core/lock.ts, scripts/start-agent.cmd
- Scenario: agent dies uncleanly (power cut, reboot); `agent.pid` remains; at
  next logon Windows has recycled that PID to another `node.exe` (VS Code and
  Copilot spawn many). `exec` comparison passes, `startedAt` was recorded but
  **never checked**.
- Expected: stale lock reclaimed; agent starts.
- Actual (reproduced): `acquired: false` → exit 5 → supervisor correctly does
  not restart exit 5 → agent dead until manual intervention; refusal printed
  to an invisible console only.
- Reproduction: day-old pid file pointing at a live unrelated node.exe;
  `acquireLock()` refused (lab output preserved in session log).
- Root cause: liveness checked by `process.kill(pid, 0)` + executable path
  only; both collide with any other Node process after PID recycling.
- Fix: lock heartbeat (owner touches mtime every 30 s) + two staleness rules —
  lock last touched before current OS boot (`os.uptime()`, 5-min clock margin)
  or silent >10 min within a boot — plus atomic steal (`rm` + `wx` create) so
  racing starters cannot both win.
- Regression protection: 5 new tests in tests/hardening.test.ts (pre-boot
  reclaim, silent reclaim, fresh-lock refusal preserved, heartbeat freshness,
  garbage content).
- Status: **FIXED / VERIFIED / REGRESSION-TESTED** (original repro re-run:
  `acquired: true`).
- Phase-3 adversarial re-test (existing finding, revalidated): lab C4 — hard
  kill, then instant restart with the pid file's heartbeat mtime only 43 s old
  → reclaimed (dead-pid rule wins over fresh mtime), served HTTP 200. Lab C13
  — two simultaneous starters → atomic steal held: exactly one winner, loser
  exit 5. Clock-skew analysis: backward jumps are safe by construction;
  forward jumps are bounded by the 5-min margin plus the 30-s heartbeat
  re-touch (see P3-02).

### F-02 — Telegram startup/network failure kills the whole process, silently

- Severity: P1 · Category: Networking / Partial failure / Observability · Component: src/telegram/bot.ts, src/main.ts
- Scenario A: cold boot without internet. `bot.start()` retried getMe only 8
  times (~3 min) then threw. Scenario B: token revoked mid-life; grammY's run
  loop rejects `bot.start()`'s promise.
- Expected: transient network trouble is outlasted; the healthy web interface
  keeps serving; fatal errors are logged and notified before exit.
- Actual: the rejection reached `main()`'s entry `.catch` → `console.error` +
  `process.exit(1)` — no log-file entry, no Telegram/web notification, no DB
  close, and the **healthy web interface died with it** (partial-failure
  handling gap).
- Root cause: bounded retry treated a self-healing condition as fatal; the
  fatal path bypassed logging/notification/cleanup.
- Fix: transient failures now retried indefinitely (backoff capped at 60 s,
  fatal 401/403/409 still surface immediately); `main()` wraps `bot.start()`
  — on fatal error it logs, notifies operators best-effort, then runs the
  ordinary `shutdown()` (web stopped, DB closed, lock released, exit 8).
- Regression protection: 4 tests (25-failure persistence, immediate fatal
  throw, finite-budget surfacing, backoff cap) via exported
  `telegramCallWithRetry` / `isFatalTelegramError`.
- Status: **FIXED / VERIFIED**.

## Medium Findings

None open. (The SSE heartbeat uncaught-crash risk found earlier today is part
of the BUG-000 cluster, fixed and shipped.)

## Low Findings

### F-03 — Enter key re-enters task submission while a POST is in flight

- P3 · Concurrency/UX · web/app.js. The send _button_ was disabled during
  flight but `keydown → sendOrStop() → sendTask()` never checked it; a
  double-Enter submits the same prompt twice → two paid tasks.
- Fix: guard at the single entry point (`if ($('send-button').disabled) return`).
- Protection: guard-by-construction; no browser test harness exists in this
  repo (documented honestly — server-side dedupe was rejected as two identical
  prompts can be legitimate). Status: **FIXED**.

### F-04 — Lock refusal was console-only

- P3 · Observability · src/main.ts. Under the scheduled task nobody can see a
  console; a refusal now also lands in the log file. Telegram silence kept
  deliberately (a true duplicate means a healthy instance is already
  answering). Status: **FIXED**.

### F-05 — Unusable log directory crashed startup entirely

- P3 · Startup/Resources · src/core/logger.ts. `configureLogger` →
  `mkdirSync` throw propagated before any interface existed. Now degrades to
  console-only logging with a stderr notice. Regression test included.
  Status: **FIXED / VERIFIED**.

## Informational Findings

- I-01 Supervisor loops every 30 s on persistent config errors (exit 2) —
  accepted: self-heals the moment `.env` is fixed; log rotation bounds growth.
- I-02 Supervisor loops if `node.exe` path becomes invalid (Node uninstalled)
  — accepted; re-run `startup install` after Node upgrades.
- I-03 Residual lock-recycling window: a start **within 10 minutes** of an
  unclean crash whose PID was instantly recycled by another node.exe still
  refuses (exit 5). Self-heals on any later start. Judged acceptable versus
  the risk of stealing a live lock.
- I-04 `MAX_QUEUED_TASKS=20` + 4000-char prompts bound the damage of a stolen
  web session flooding paid tasks; login throttle 5/15 min; sessions die on
  restart. Verified in code and tests.
- I-05 Frontend has no automated test harness; its double-submit fix is
  code-review-verified only.
- I-06 The e-commerce test domains in the audit brief (payments, inventory,
  refunds) do not exist in this system; the equivalent value-at-risk surfaces
  (AI credits, git history, approvals) were audited instead.

## Phase 3 — Production Reliability / Chaos QA (2026-08-18, later the same day)

Goal: attack the fixes themselves and the failure _chains_ around them
(temporary-vs-permanent classification, supervision interplay, notification
storms, races). Specialist roles A–G from the phase brief were executed
in-line (subagent infrastructure still unavailable); labs ran against
isolated instances in temp workspaces — production was never touched.

### Labs and exact experiments

| Lab | Experiment (actual commands)                                                                                              | Result                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Isolated web-only instance, `WEB_HOST=203.0.113.1` (TEST-NET, never assignable), `TELEGRAM_ENABLED=false`; observed 115 s | PASS: alive and retrying, log grew to only 5 lines (attempt-throttled), CPU total 0.33 s, RAM flat ≈63 MB; retry timer alone correctly held the web-only process open |
| C4  | `Stop-Process -Force` on C1 (crash with pid file left, heartbeat mtime 43 s fresh), immediate restart on 127.0.0.1:18788  | PASS: lock reclaimed via dead-pid rule, HTTP 200                                                                                                                      |
| C5  | `npm run agent -- doctor` with `WEB_HOST=100.99.99.99` override                                                           | PASS: `[!] Web interface … is not an address of this PC right now` + wait-forever hint                                                                                |
| C13 | Two `node dist/src/main.js` launched simultaneously against one workspace                                                 | PASS: exactly one alive, loser exited 5 (supervisor deliberately does not restart 5)                                                                                  |
| —   | Control-flow sweep: every `shutdown()` call site + `process.exit` audit                                                   | PASS: all four call sites log/notify BEFORE exit; cli.ts:350 is a benign interactive Ctrl+C                                                                           |
| —   | Oversize API body (80 KB > 64 KB cap)                                                                                     | Gap found: behavior correct (socket destroyed, server survives) but untested → P3-01                                                                                  |

### "Break the fix" checklist (phase brief §12)

1. Address unavailable at startup → waits: PASS (C1, bind tests)
2. Address appears later → binds: PASS (bind tests; live prod restart bound on attempt 3)
3. Agent waits instead of dying: PASS (C1: 115 s alive)
4. Backoff correct: PASS (delays 1→2→5→10→30→60 s cap; telegram cap test)
5. Waiting notification sent: PASS (live Telegram ⚠️ message on 12:32 restart path design; onWaiting once-per-process unit test)
6. Recovery notification sent: PASS (live: "web interface is up … attempt 3" logged + ✅ notice path; onRecovered unit test)
7. Becomes healthy automatically: PASS (C1 counterpart test: port freed → binds)
8. Supervisor correct on genuine crash: PASS (stub labs + C4)
9. Invalid WEB_HOST does not masquerade as temporary: PARTIAL BY DESIGN — an unassigned-but-valid IP is indistinguishable from a late adapter at bind level; compensations: one-time notification, throttled logs, doctor warning (C5)
10. Doctor detects unassigned WEB_HOST: PASS (C5)
11. No unreachable notification code: PASS (control-flow sweep)
12. No notification/retry storms: PASS (onWaiting fires once per process; process does not exit while retrying, so the supervisor cannot amplify it; C1 log volume 5 lines/115 s)

### Phase-3 findings

- **P3-01 · LOW · Test coverage · Newly discovered · FIXED**: no regression
  test covered the 64 KB body cap / mid-upload destroy surviving path. Added
  "an oversized request body cannot wedge the server" (tests/web.test.ts);
  suite now 435.
- **P3-02 · LOW · DESIGN RISK · Newly discovered · ACCEPTED (still open)**:
  a large _forward_ wall-clock jump could make a live lock look pre-boot.
  Bounded by the 5-minute margin and healed within one 30-second heartbeat
  touch; worst case is dueling pollers, which Telegram surfaces as 409s.
  No code change — the alternative (trusting startedAt over mtime) reopens
  F-01.
- **P3-03 · LOW · DESIGN RISK · Newly discovered · ACCEPTED (still open)**:
  if `utimesSync` silently fails for >10 min (AV interference, read-only
  file), a second starter could steal a live lock → dueling instances,
  visible as grammY 409 conflicts. Judged acceptable: the pre-fix failure
  (permanent lockout) was strictly worse than the new worst case (visible
  conflict).
- **P3-04 · LOW · ENVIRONMENTAL RISK · Newly discovered · ACCEPTED (still
  open)**: a web-ONLY install (no Telegram) with a permanently wrong WEB_HOST
  waits forever with no reachable interface — a quiet zombie. Detection
  exists (doctor warning C5, throttled log warns); prod is dual-interface so
  the notification path covers it.

### Temporary-vs-permanent classification (verified behavior)

| Condition                                                | Class                     | Behavior                                                                           | Evidence                        |
| -------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| WEB_HOST not assigned (EADDRNOTAVAIL)                    | temporary                 | retry forever, notify once                                                         | C1, bind tests                  |
| Port held (EADDRINUSE)                                   | temporary                 | retry, binds when freed                                                            | bind tests, live 12:32 restart  |
| Bind EACCES (Windows excluded port ranges shift at boot) | temporary                 | retry                                                                              | code path, unit-covered set     |
| Unresolvable WEB_HOST hostname (ENOTFOUND)               | permanent                 | fail fast, notify, exit 7                                                          | fatal bind test                 |
| Telegram network failure                                 | temporary                 | retry forever, capped backoff, outbox                                              | retry tests, chaos outbox tests |
| Telegram 401/403/409                                     | permanent                 | log + notify + clean shutdown(8)                                                   | fatal-throw test, main.ts catch |
| Malformed .env                                           | permanent                 | exit 2 with actionable message; supervisor retries every 30 s (self-heals on edit) | Env-O lab                       |
| Corrupt database                                         | permanent (for that file) | quarantine + fresh start + banner                                                  | chaos DB tests                  |
| Stale/garbage/recycled lock                              | temporary                 | reclaim                                                                            | F-01 tests, C4                  |

### Cycle 3 — Environmental & Adversarial Reliability Audit (2026-08-18, third pass)

Scope: the failure domains not yet exercised by cycles 1–2, probed
adversarially (agents 1–10 of the phase brief mapped onto this system; domains
already covered are cross-referenced, not re-run). All probes are code-path
audits against the current build, verified where cited by the existing test
suite; production was not touched.

| Probe                                                  | Question                                                                 | Result                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram rate limit (Agent 6)                          | Does a 429 destroy the notification or the task?                         | PASS — `isTransient` classes 429 and ≥5xx as retryable → message enters the durable outbox; replay on reconnect; a poisoned message is dropped after bounded attempts (chaos test "one undeliverable message cannot block the queue forever"). A notification failure never touches task state.                                                         |
| Abnormal repository states (Agent 7)                   | Merge/rebase in progress, conflicted, broken git, no commits, dirty tree | PASS — preflight refuses conflicted trees outright, refuses when `git status` errors, requires approval for dirty trees, refuses when a checkpoint cannot be created in a repo that has commits, and detects executable git config BEFORE the first worktree-reading git command. Mid-rebase states surface as conflicted or dirty and hit those gates. |
| Provider binary vanishes or crashes at spawn (Agent 8) | CLI uninstalled/updated mid-life                                         | PASS — both the synchronous spawn throw and the async `child.on('error')` path map to stopReason `spawn-error`, failing the task with a message instead of crashing the agent.                                                                                                                                                                          |
| Two tasks target the same repository (Agent 10)        | Concurrent mutation of one worktree                                      | PASS by construction — `claimNextQueued(pid, busyProjects)` excludes busy projects atomically inside the claim; verified by the queue test that an older task blocks younger tasks for the same project only.                                                                                                                                           |
| Duplicate command while first task runs (Agent 10)     | Second submission queues, does not race                                  | PASS — same claim mechanism; queue cap 20 bounds pileup.                                                                                                                                                                                                                                                                                                |
| UI/API/security domains (Agents 1, 2, 9)               | —                                                                        | Covered in cycles 1–2 (F-03, P3-01, Security Findings section); no new probes warranted.                                                                                                                                                                                                                                                                |

Outcome: **no additional actionable bottlenecks discovered within the tested
scenarios.** Every cycle-3 probe found existing, test-backed hardening. The
remaining untested surfaces are unchanged: real reboot chain, sleep/wake,
adapter bounce, resource exhaustion (see Remaining Risks).

## Fixed Issues / Verified Fixes

| ID       | Fix                                                                                                     | Verification                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| BUG-000a | Web bind waits out EADDRNOTAVAIL/EADDRINUSE/EACCES with backoff                                         | 3 bind-resilience tests + live boot attempt #1 bind + live 12:32 restart bound on attempt 3 + C1 115 s soak |
| BUG-000b | Fatal-error notification ordered BEFORE process exit                                                    | Code path + live Telegram delivery                                                                          |
| BUG-000c | start-agent.cmd is a true supervisor (Task Scheduler restart-on-failure does not fire on nonzero exits) | Stub labs: exit 5 immediate, exit 1 → 30 s → restart → 0                                                    |
| BUG-000d | SSE heartbeat write guarded against dead-socket crash                                                   | Code review; same pattern as writeSse                                                                       |
| F-01     | Lock heartbeat + boot staleness + atomic steal                                                          | Original repro re-run: reclaimed; 5 tests; labs C4 + C13                                                    |
| F-02     | Infinite transient Telegram retry; fatal → notify → clean shutdown                                      | 4 tests                                                                                                     |
| F-03     | Composer re-entry guard                                                                                 | Code review                                                                                                 |
| F-04     | Lock refusal logged to file                                                                             | Code review; C13 loser produced exit 5 with log entry                                                       |
| F-05     | Logger degrades instead of crashing                                                                     | 1 test                                                                                                      |
| P3-01    | Oversize-body survival regression test                                                                  | Test passes in 435-test suite                                                                               |

## Remaining Risks

Confirmed: none open at P0–P2.

Unconfirmed / environment-dependent:

- R-01 Sleep/wake (Env I): reasoned safe (health probe, outbox, SSE resync),
  not experimentally verified — NOT SAFELY EXECUTED on the production machine.
- R-02 Web listener behavior across a Tailscale adapter bounce (Env J/K):
  Windows keeps IP-bound listeners across address removal/re-add per socket
  semantics, but this was not experimentally verified. If it ever proves
  false, symptom = web dead while Telegram lives; recommendation R-A below.
- R-03 Resource exhaustion (Env L): CPU/RAM/FD starvation untested; disk is
  preflighted per task and chaos-tested.

Accepted: I-01, I-02, I-03 above; P3-02, P3-03, P3-04 (Phase 3).

## Security Findings

No new issues. Verified clean this pass: no `innerHTML`-class sinks in
web/app.js (textContent discipline holds); scrypt + `timingSafeEqual` password
check; 256-bit in-memory sessions; login throttle keyed by remote address with
bounded map; host-header pinning + CSRF header + same-origin checks ahead of
every mutation; static serving confined by resolve-prefix + extension
allow-list; every Telegram command/callback authorized via `authorize()` with
unauthorized-throttle; approval resolution enforces owner or web-operator;
git panel validates project id/action against fixed menus; redaction applied
to diffs, task JSON, logs and outbox. Existing redteam suite (59 attack tests)
re-read for coverage gaps — none found this pass.

## Concurrency Findings

`ApprovalService.resolve` deletes the waiter before resolving (double-answer
returns `not-pending`); task claim is single-winner (chaos test); per-project
approval ordering blocks younger tasks (queue test); git ops refused while a
project task runs (web test); lock steal is now atomic (F-01). No open issues.

## Recovery Findings

Crash → supervisor restart (proven) → orphan requeue with spend preserved,
repeat-interruption abandon, checkpoint refs survive (chaos tests) →
WAITING_APPROVAL stranded tasks cancelled with operator notice (main.ts). DB
corruption quarantines and restarts fresh with explicit banner warning.

## Observability Findings

F-02/F-04/F-05 closed the "dies with no trace" paths: every refusal/fatal now
reaches the log file, and fatal Telegram/web failures notify the operator
before exit. "If it dies at 3 AM": supervisor restarts it and the online
banner announces recovery; if it cannot start, the wrapper keeps retrying
while each attempt logs.

## Regression Tests Added

14 this audit (5 lock, 4 telegram retry, 1 logger, 3 bind-resilience from the
BUG-000 cluster, 1 oversize-body from Phase 3) → suite now 435 tests / 82
suites, all green.

## Final Verification

Exact commands and real results:

- `npm test` → lint + build + **435/435 PASS** (63.8 s), including all 14 new
  regression tests.
- F-01 original reproduction re-run against the fixed build →
  `acquired: true` with stale-lock warning.
- Supervisor emulation (`cmd /d /s /c ""start-agent.cmd" "<stub>""`) → exit 5
  immediate; exit 1 → restart after 30 s → exit 0.
- Chaos labs C1/C4/C5/C13 → all PASS (tables above).
- Production: `Stop-ScheduledTask` + `Start-ScheduledTask` at 12:32 → log
  shows Telegram online first, then `Web interface listening … attempts: 3`
  (the restart itself exercised the EADDRINUSE wait against the dying
  predecessor's socket) → `Invoke-WebRequest http://100.93.197.102:8787/` →
  **HTTP 200**.
- Cycle 3 close-out: full suite re-run after the adversarial pass →
  **435/435 PASS**; production probe HTTP 200; no code changes were required
  by cycle 3.

## Bottleneck Analysis

- Startup: ~9–14 s to fully online, dominated by provider CLI probes —
  acceptable for a supervised long-running agent; no action.
- Throughput: `maxConcurrentTasks` defaults to 1 and the queue caps at 20 —
  deliberate credit-protection bounds, not defects.
- Steady-state resources: ≈63 MB RSS, ≈0 CPU while idle/retrying (C1);
  logs rotate at 8 MB and prune at 30 days; retry logging is attempt-throttled
  (5 lines per 115 s of permanent failure).
- SQLite is synchronous in-process — fine at this scale; busy_timeout 5 s
  guards cross-process doctor reads.
- SSE client set is unbounded but reachable only by the authenticated single
  operator; heartbeat cost is O(clients) every 25 s — negligible.

## Recommendation

**READY WITH KNOWN RISKS** — all confirmed P0–P2 defects fixed and
regression-tested; remaining risks are the documented accepted lows
(P3-02/03/04, I-01/02/03) and the three environments that cannot be exercised
from a live session (real reboot chain, sleep/wake, adapter bounce), each with
a written detection story.

## Residual Risk Assessment

Remaining known ways for the system to be unavailable with the PC on:
(1) Windows sleep (by design — configure power settings), (2) Tailscale
service itself down on the PC (visible in the phone's Tailscale app; Telegram
interface unaffected), (3) config errors requiring operator action (now
loudly logged, supervisor keeps retrying). Recommendations, in value order:

- R-A: optional self-probe: if the bound WEB_HOST address disappears from
  `os.networkInterfaces()` for >N minutes, send a one-time Telegram notice
  (closes R-02 detection gap without admin rights).
- R-B: a scheduled `doctor --notify` daily run as an independent watchdog.
- R-C: consider a boot trigger (`-AtStartup` with autologon or a service
  wrapper) so the agent does not wait for interactive logon after power cuts.
