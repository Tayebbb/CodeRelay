# Changelog

All notable changes to CodeRelay. Format: [Keep a Changelog](https://keepachangelog.com),
versioning: [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Recurring popup window.** When Windows Terminal is the default terminal it
  ignores `-WindowStyle Hidden`, so the startup task's "hidden" wrapper was a
  visible window — and closing it made the 5-minute watchdog respawn it, over
  and over. The task action now launches through `conhost.exe --headless`,
  which bypasses terminal delegation: no window at logon, on watchdog ticks,
  or in standby. Re-run `npm run agent -- startup install` to apply.

## [1.1.0] — 2026-08-19

### Added
- **Self-healing startup.** A 5-minute watchdog trigger revives the agent if it
  is ever found dead — including waking from sleep, where no logon event fires.
- **Hidden launcher.** The agent runs with no visible console window, so a
  stray click can no longer kill it (`scripts/start-agent-hidden.ps1`).
- **Standby adoption.** A second instance no longer exits when the lock is
  held; it stands by and takes over within a minute if the running agent stops.
- **Daily heartbeat.** One Telegram message per day proving the agent is alive
  (`DAILY_HEARTBEAT`, `DAILY_HEARTBEAT_HOUR`). Its absence is the alarm. Zero
  AI credits.
- **Doctor: startup-chain check.** One line diagnoses a missing task, a missing
  watchdog trigger, an orphaned (unsupervised) agent, or a dead agent.
- **Doctor: sleep-settings check.** Warns when the PC will sleep on AC power
  and stall remote tasks.
- SIGHUP handling: closing the agent's console is now logged and shut down
  cleanly instead of dying silently.

### Changed
- Startup acquires the single-instance lock **before** provider detection, so
  duplicate starts cost milliseconds instead of seconds of CLI probing.
- Idle footprint reduced: task-queue backstop poll 1.5 s → 15 s (user actions
  are event-driven and unaffected), lock heartbeat 30 s → 120 s, web SSE
  keepalive timer now exists only while a page is connected.

## [1.0.0] — 2026-08-18

Initial public release: Telegram bot + installable web app driving GitHub
Copilot CLI or Claude Code against local repositories, with git checkpointing,
verification, approval gates, budgets, redaction and a red-team regression
suite.
