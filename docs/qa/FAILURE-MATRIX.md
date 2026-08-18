# Failure Matrix

Living document: every scenario the audit evaluated, what the system is
expected to do, what it actually does, and where that is proven.
Statuses: PASS (verified) · FIXED (was broken this audit, now verified) ·
REASONED (static analysis only) · NOT-EXECUTED (unsafe to test live) · N/A.

| # | Scenario | Expected | Actual | Severity | Status | Evidence |
|---|----------|----------|--------|----------|--------|----------|
| 1 | Logon races Tailscale; WEB_HOST not assigned yet | Wait and bind when address appears; tell operator | Retries with backoff, Telegram notice, binds on arrival | P1 (was outage) | FIXED | tests/web.test.ts "web bind resilience"; live boot 11:39; live 12:32 restart bound on attempt 3; C1 soak: 115 s permanent failure = 5 log lines, 0.33 s CPU |
| 2 | Web bind fails with non-transient error | Fail fast, log + notify BEFORE exit | Does exactly that (was: dead code after process.exit) | P1 | FIXED | web.test.ts fatal test; main.ts ordering |
| 3 | Agent exits nonzero under Task Scheduler | Automatic restart | cmd wrapper loop restarts after 30 s (Task Scheduler's own RestartCount does NOT fire on nonzero exit — verified experimentally) | P1 | FIXED | stub labs: exit 1 → restart → 0; exit 5 → immediate stop |
| 4 | Reboot leaves agent.pid; PID recycled by another node.exe | Reclaim stale lock, start | Was: permanent exit-5 lockout (reproduced). Now: pre-boot/silent locks reclaimed via mtime heartbeat | P1 | FIXED | lab repro before/after; 5 lock tests; lab C4: crash + instant restart (fresh mtime, dead pid) → reclaimed, HTTP 200 |
| 5 | Cold boot without internet (Telegram unreachable) | Outlast it; web keeps serving | Was: process death after ~3 min, web died too. Now: infinite capped-backoff retry | P1 | FIXED | telegram retry tests (25 failures → connect) |
| 6 | Telegram token revoked (boot or mid-life) | Log, notify, clean shutdown, supervisor retries | Was: console-only exit 1, no DB close. Now: notify → shutdown(8) | P1 | FIXED | fatal-throw test; main.ts catch |
| 7 | Two starters race the lock steal | Exactly one wins | Atomic rm + wx-create; loser reports holder | P2 | FIXED | lock.ts steal path; refusal test; lab C13: two simultaneous live starts → one alive, one exit 5 |
| 8 | SSE client socket dies between write and 'close' | Server survives | Heartbeat + writes guarded by try/catch | P2 | FIXED | server.ts; code review |
| 9 | Unwritable log directory at boot | Start anyway, console-only logs | Was: crash before any interface. Now degrades | P3 | FIXED | logger resilience test |
| 10 | Lock refusal under scheduled task | Visible somewhere durable | Now logged to file (console invisible) | P3 | FIXED | main.ts |
| 11 | Double-Enter in web composer during POST | One task | Was: two paid tasks. Now guarded at entry point | P3 | FIXED | app.js guard (code review) |
| 12 | Invalid .env value | Actionable refusal, no side effects | "Configuration error: …", exit 2, nothing touched | — | PASS | Env-O lab |
| 13 | Corrupt task database at open | Quarantine, start fresh, tell operator | Does so, banner warning included | — | PASS | chaos.test.ts DB suite |
| 14 | Power loss mid-task | No lost spend, no double-run, snapshot survives | Requeue once with credits preserved; abandon after repeats; checkpoint intact | — | PASS | chaos.test.ts power-loss suite |
| 15 | Restart while task awaits approval | Task not stranded forever | Cancelled at boot + operator notified | — | PASS | main.ts stranded sweep; banner |
| 16 | Hung verification child with surviving grandchild | Watchdog resolves | killProcessTree + watchdog | — | PASS | chaos "command that refuses to die" |
| 17 | Telegram down while task finishes | Outcome not lost | Outbox stores redacted message, replays on reconnect | — | PASS | chaos Telegram suite |
| 18 | Duplicate Telegram update delivery | Executed once | Update dedupe | — | PASS | chaos duplicate-delivery test |
| 19 | Stolen web session floods paid tasks | Bounded damage | Queue cap 20, prompt cap 4000, restart kills sessions | — | PASS | taskService.ts; code review |
| 20 | Approval answered from web and Telegram simultaneously | Single winner, other told "not pending" | Waiter deleted before resolve | — | PASS | approval/service.ts; web approval test |
| 21 | Disk nearly full when task starts | Refuse before touching anything | Preflight insufficientDiskSpace gate | — | PASS | taskRunner.ts; chaos disk suite |
| 22 | Log growth unbounded | Bounded | 8 MB rotation + 30-day prune | — | PASS | logger.ts |
| 23 | Machine sleep/wake | Both interfaces recover | Health probe + outbox + SSE client resync; not experimentally verified | — | REASONED | bot.ts evaluateHealth; web/app.js resync |
| 24 | Tailscale adapter bounce mid-run (same IP) | Listener resumes serving | Windows keeps IP-bound listeners across address flap; unverified | — | NOT-EXECUTED (would sever live tailnet) | R-02 in audit report |
| 25 | Real cold reboot end-to-end | Full chain: logon → wrapper → bind wait → online | Components each verified; full chain needs a reboot | — | NOT-EXECUTED (live session) | Env-B notes |
| 26 | CPU/RAM/FD exhaustion | Graceful degradation | Untested | — | NOT-EXECUTED | R-03 |
| 27 | Orders/payments/inventory workflows | — | No such subsystem in this repository | — | N/A | audit brief mismatch |
| 28 | WEB_HOST NEVER becomes available (typo or VPN never up) | Stay alive, retry quietly, notify once, no resource creep | Verified: 115 s soak alive, 5 log lines, 0.33 s CPU, ≈63 MB flat; doctor flags the address (C5) | — | PASS | labs C1 + C5 |
| 29 | Oversized API body (>64 KB) | Upload destroyed, server keeps serving | Verified; was an untested path | P3 (coverage) | FIXED | new web.test.ts oversize test (P3-01) |
| 30 | Forward wall-clock jump vs lock staleness | Live lock not stolen | 5-min margin + 30-s heartbeat re-touch bound the window; worst case dueling pollers visible as 409 | LOW | REASONED (accepted, P3-02) | audit report Phase 3 |
| 31 | Heartbeat touch silently failing >10 min (AV/read-only) | Live lock not stolen | Steal possible → dueling instances, visible via 409; accepted vs. pre-fix permanent lockout | LOW | REASONED (accepted, P3-03) | audit report Phase 3 |
| 32 | Web-only install + permanently wrong WEB_HOST | Operator learns about the zombie | No reachable interface; detection = doctor warn + throttled log warns; prod is dual-interface | LOW | REASONED (accepted, P3-04) | lab C5 |
| 33 | Telegram 429 / 5xx while reporting a result | Task state untouched; message survives | Classified transient → durable outbox → replay on reconnect; poisoned message dropped after bounded attempts | — | PASS | bot.ts isTransient; chaos outbox tests |
| 34 | Task submitted while repo is mid-merge/rebase | Refuse or gate, never auto-resolve | Conflicted → refused; dirty → approval gate; broken git → refused; checkpoint mandatory when commits exist | — | PASS | preflight.ts; chaos/git tests |
| 35 | Copilot CLI uninstalled/updated mid-life (spawn fails) | Task fails with message; agent survives | Sync throw + child 'error' both → stopReason spawn-error | — | PASS | executor.ts:262-272,432-434 |
| 36 | Two tasks target the same repository concurrently | Serialized per project | claimNextQueued excludes busy projects atomically | — | PASS | queue.ts; queue.test.ts same-project test |
