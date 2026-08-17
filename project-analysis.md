# CodeRelay — Project Analysis

This document is a complete architectural tour of CodeRelay, written so a
person (or another AI) can understand the whole system without reading the
source first. It states what exists, why it is shaped that way, and where the
known weaknesses are.

---

## 1. What this project is

CodeRelay is a **self-hosted remote coding agent**. The owner sends a natural-
language coding task from their phone; their home PC runs an AI coding CLI
(GitHub Copilot CLI today, Claude Code as a second provider) against a local
repository, runs the project's own tests, commits when they pass, and reports
back — with diffs, test output and cost.

Design constraints that shaped everything:

| Constraint                                     | Consequence                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero recurring cost**                        | No servers, no cloud, no paid APIs. One runtime dependency (`grammy` for Telegram). SQLite via Node's built-in `node:sqlite`. Web UI has zero frontend dependencies and no build step. |
| **The AI comes from an existing subscription** | The Copilot CLI is the execution engine; this project never bills anything itself and enforces credit budgets locally.                                                                 |
| **Unattended operation on a personal machine** | Everything is designed for the owner being far away: crash recovery, budget ceilings, approval gates over Telegram/web, startup failure notifications.                                 |
| **Target repositories are treated as hostile** | A cloned repo can carry hooks, filter drivers, planted binaries, agent-instruction files and MCP configs. All are detected or neutralised (see §7).                                    |
| **Never trust the AI's claims**                | Verification runs the project's own test command; advisory (read-only) agent roles are checked against git state, not trusted to obey their prompt.                                    |

Runtime: Node.js ≥ 22.5 (needs `node:sqlite`), TypeScript compiled with `tsc`,
ESM with `NodeNext` resolution (all relative imports use `.js` extensions).
Windows-first (startup automation via Scheduled Task), macOS/Linux code paths
exist.

---

## 2. Top-level architecture

```
  ┌────────────┐   ┌────────────┐
  │ Telegram   │   │ Web UI     │      interfaces — thin clients,
  │ (grammy)   │   │ (PWA, SSE) │      individually optional
  └─────┬──────┘   └─────┬──────┘
        │  submit/cancel/retry/approve ONLY through ↓
        ▼                ▼
  ┌──────────────────────────────┐
  │ TaskService  (core/taskService.ts)   queue cap, risk gate,
  │ ApprovalService (approval/)          approval flow, retry rules
  └───────┬──────────────────────┘
          ▼
  ┌──────────────┐   claims via atomic CAS   ┌──────────────┐
  │ TaskQueue    │ ────────────────────────► │ TaskRunner   │
  │ (runner/)    │   FIFO, 1 per project     │ (runner/)    │
  └──────────────┘                           └──────┬───────┘
          ▲                                         ▼
  ┌───────┴──────────────┐            ┌──────────────────────────┐
  │ TaskRepository       │            │ AgentProvider            │
  │ (db/, SQLite)        │            │ (providers/): Copilot,   │
  │ tasks, events,       │            │ Claude Code — argv build,│
  │ usage ledger, outbox │            │ event parse, capabilities│
  └───────┬──────────────┘            └──────────┬───────────────┘
          │ publishes                            ▼
          ▼                            agent CLI child process
  ┌──────────────┐                     (hardened env, deny-lists)
  │ EventBus     │ ──► Telegram messages, web SSE stream
  └──────────────┘
```

**The one rule that keeps two interfaces honest:** neither Telegram nor the web
implements any business logic. Both submit through `TaskService` and observe
through `TaskRepository` + `EventBus`. A check that exists in only one
interface is treated as a bug even if it works.

---

## 3. Module map

| Path                                        | Responsibility                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                               | Composition root: config → DB → bus → repository → approvals → runner → queue → service → optional Telegram bot → optional web server. Graceful shutdown that persists terminal task states before exit.                                                                      |
| `src/cli.ts`, `bin/remote-agent.js`         | Operator CLI: `start stop status doctor models projects tasks logs test web setup install-agent`. `bin/` is the only executable entry.                                                                                                                                        |
| `src/core/config.ts`                        | All configuration from `.env` (via `process.loadEnvFile`). Interface flags (`TELEGRAM_ENABLED`, `WEB_ENABLED`), budgets, git policy, safety toggles. Unknown/invalid values stop startup.                                                                                     |
| `src/core/taskService.ts`                   | The only place tasks are submitted, cancelled, retried, promoted. Owns the queue cap (20), prompt length cap, risk-gate → approval flow, retry duplicate guard.                                                                                                               |
| `src/core/events.ts`                        | `EventBus`: monotonic-seq pub/sub with a 500-event replay buffer (SSE `Last-Event-ID`).                                                                                                                                                                                       |
| `src/core/redact.ts`                        | Secret redaction. The bot token and every value from project `.env` files are registered and stripped from ALL outbound text, logs and stored rows.                                                                                                                           |
| `src/core/lock.ts`, `logger.ts`             | Single-instance pid lock; JSONL file logging (redacted).                                                                                                                                                                                                                      |
| `src/domain/task.ts`                        | Task state machine: `QUEUED → RUNNING → TESTING → COMPLETED/FAILED/CANCELLED/TIMED_OUT`, plus `WAITING_APPROVAL`; transitions validated; terminal states immutable (except retry → new task).                                                                                 |
| `src/db/database.ts`                        | SQLite open + migrations (4). Corrupt DB is quarantined, never deleted.                                                                                                                                                                                                       |
| `src/db/taskRepository.ts`                  | All SQL. Atomic claim (`UPDATE … WHERE status='QUEUED'` CAS with per-project barrier in SQL), crash recovery (`recoverOrphans`), usage ledger (append-only deltas), queue ordering (`priority DESC, id ASC`), event log. Publishes to the bus on every write.                 |
| `src/runner/queue.ts`                       | Single-process scheduler: drain loop, per-project busy set, bounded graceful stop.                                                                                                                                                                                            |
| `src/runner/taskRunner.ts`                  | The task lifecycle: preflight → optional read-only explorer pass → agent session(s) with bounded retries → verification (tests/build) → optional read-only review pass → publish (commit/push with approvals). Credit/turn/time budgets enforced between and during sessions. |
| `src/runner/preflight.ts`                   | Refuses to start on: merge conflicts, broken git, low disk, executable git config (filter/diff drivers), repo-supplied agent/hook/MCP config; asks approval for dirty trees; writes a checkpoint.                                                                             |
| `src/runner/publish.ts`                     | Stage (agent-changed files only, sensitive files excluded) → commit → optional push, each behind approvals where configured.                                                                                                                                                  |
| `src/runner/stopReason.ts`                  | Pure decision function mapping an agent session outcome to proceed/retry/switch-model/halt — includes the "run reported no cost" fraud guard.                                                                                                                                 |
| `src/runner/promptBuilder.ts`               | Prompts for implementer/explorer/reviewer roles; read-only rules; recovery context on retries.                                                                                                                                                                                |
| `src/orchestrator/plan.ts`, `confidence.ts` | **Deterministic** (no AI calls) task classification → role plan and budget; post-run confidence scoring deciding whether a paid review is worth it.                                                                                                                           |
| `src/providers/`                            | `AgentProvider` interface + registry. `copilot.ts` delegates to the live-proven `src/copilot/*`; `claude.ts` maps the shared deny-list into Claude Code flags. `REQUIRED_CAPABILITIES` fail closed: a provider that cannot express a mandatory protection is refused.         |
| `src/copilot/`                              | Copilot CLI specifics: detection/launcher resolution (absolute paths, shell-free), argv building, JSONL event stream parsing, permission policy (deny-lists), child environment allow-list, custom agent install.                                                             |
| `src/git/git.ts`                            | Every git invocation. Absolute git path (repo-planted `git.exe` defence), hardened env (`GIT_HARDENING`, random per-process `hooksPath`), non-destructive checkpoints via temporary `GIT_INDEX_FILE`, `detectExecutableGitConfig`.                                            |
| `src/security/repoScan.ts`                  | Scans the target repo for capability files (agents, skills, hooks, plugins, MCP/LSP config); anything naming a command is blocking; unparseable config fails closed.                                                                                                          |
| `src/approval/`                             | `ApprovalService` (in-memory waiters over persisted state; timeout; owner check) and the deterministic risk classifier.                                                                                                                                                       |
| `src/telegram/`                             | grammY bot: auth allow-list middleware, commands, approval buttons, outbox with retry, private-chat-only. Implements `Notifier`.                                                                                                                                              |
| `src/web/`                                  | `server.ts`: `node:http` REST + SSE + static; `auth.ts`: scrypt password file, in-memory sessions, login throttle.                                                                                                                                                            |
| `web/`                                      | Dependency-free static frontend (HTML/CSS/JS, strict CSP, `textContent`-only DOM) + PWA (manifest, service worker, generated PNG icons).                                                                                                                                      |
| `scripts/`                                  | Windows Scheduled Task install/uninstall, live acceptance test, PWA icon generator (hand-rolled PNG encoder).                                                                                                                                                                 |
| `tests/`                                    | 378 tests, `node:test`, no framework. See §9.                                                                                                                                                                                                                                 |

---

## 4. Data model (SQLite)

```
tasks(id, user_id, chat_id, project_id, prompt, status, created_at,
      started_at, completed_at, result_json, error, commit_hash, branch,
      retry_count, approval_required, approval_status, approval_reason,
      usage_json, runner_pid, origin, model, priority)

task_events(id, task_id, ts, kind, message, meta)     -- audit trail
usage_ledger(id, task_id, ts, credits, model)         -- append-only spend
processed_updates(update_id, ts)                      -- Telegram idempotency
outbox(id, chat_id, body, ts, attempts)               -- undeliverable messages
```

Key semantics:

- `origin` = `telegram | web` — which interface created it (display only).
- `model` — per-task model override, honoured only if the installed CLI lists it.
- `priority` — queue precedence; the only mutation is "move to front".
- `result_json` holds `filesChanged, linesAdded/Removed, verifications[]
(command, exit, output tail), summary` — where `summary` is the agent's own
  final message **verbatim** (post-redaction).
- The usage ledger stores _deltas_, so recovery/restart cannot re-bill or lose
  spend; daily budget = `SUM(credits) WHERE ts >= now-24h`.

---

## 5. The task lifecycle (what actually happens)

1. **Submit** (either interface → `TaskService.submit`): length/queue caps,
   deterministic risk assessment (`approval/risk.ts`). Elevated risk parks the
   task in `WAITING_APPROVAL`; the approval request is delivered to every
   enabled interface (Telegram buttons + web card via SSE).
2. **Claim** (`TaskQueue.drain` → `claimNextQueued`): atomic CAS, FIFO by
   `priority DESC, id ASC`, skipping any task whose project has an OLDER task
   running/testing/awaiting approval — the single-worker-per-project rule lives
   in SQL.
3. **Preflight** (`prepareRepository`): disk space, git health, executable git
   config detection FIRST, repo capability scan, dirty-tree approval,
   **checkpoint** — a commit object at `refs/remote-agent/checkpoint-<id>`
   capturing the tree _including uncommitted work_, written through a temp
   index so the user's index/tree are untouched.
4. **Plan** (`orchestrator/plan.ts`, deterministic): simple → implementer only;
   complex → explorer (read-only survey) + implementer; security-evidence →
   review required. Hard ceiling on paid sessions per task.
5. **Agent session(s)** (`runCopilot` via the selected provider): child process
   with allow-list environment (`buildChildEnv` — the bot token cannot reach
   it), deny-list argv, JSONL event stream parsed into progress (tagged
   `agent` vs `system`), credit/turn/time ceilings enforced locally, model
   fallback on runtime refusal, quota/auth/model failures classified.
6. **Read-only roles verified**: explorer/reviewer run with write tools denied
   AND their promise is checked afterwards against git's changed-file list and
   git's control surface; a violation fails the task with restore instructions.
7. **Verification**: the project's own test/build commands, executed with a
   clean environment, output captured verbatim. Tampering with the manifest
   that decides what the test command runs (e.g. `package.json` scripts)
   triggers an approval.
8. **Review gate** (complex/security tasks or low confidence): a read-only
   agent review; `changes-required` findings loop back to the implementer
   within budget.
9. **Publish**: stage only agent-changed files (never `.env`-like paths),
   approval for protected branches, commit; push only if `AUTO_PUSH=true` AND
   approved. The commit hash lands on the task row.
10. **Report**: full result to Telegram and/or web; every step in
    `task_events`; spend in the ledger.

**Crash recovery:** on startup, `RUNNING/TESTING` rows are re-queued with
`retry_count+1` and spend preserved; after 3 interruptions the task is marked
FAILED ("Abandoned") instead of being re-billed forever. Tasks stranded in
`WAITING_APPROVAL` are cancelled (waiters are memory-only). An expired login
or dead CLI at startup notifies the operator directly over the Telegram HTTP
API — the failure mode "restart loop the owner never hears about" is designed
away.

---

## 6. Interfaces

### Telegram (`src/telegram/`)

- Long polling (outbound-only; no open ports). Numeric user-id allow-list;
  everyone else gets one line. Private chats only. Update idempotency via
  `processed_updates`. Outbox queue for undeliverable messages (bounded).
- Commands: task submission (`project: prompt` or `/task`), `/status` (shows
  `Current:` and `Queue:` in claim order), `/tasks`, `/logs`, `/cancel`,
  `/retry`, `/approve`, `/reject`, `/usage`, `/projects`.
- Never blocks a handler on an approval (grammY is strictly sequential — an
  await there would deadlock the bot; flows are detached and drained on
  shutdown).

### Web (`src/web/` + `web/`)

- `node:http` only. REST + **SSE** (`/api/events`, `Last-Event-ID` replay) —
  deliberately no WebSocket dependency.
- Auth: one operator, scrypt-hashed password file created by
  `remote-agent web setup`; 256-bit in-memory session cookies (HttpOnly,
  SameSite=Strict) — restart signs everyone out; login throttle 5/15min.
- CSRF: custom `X-CodeRelay` header + same-origin `Origin` + Host header
  pinned to the bind address (421 otherwise — DNS-rebinding defence).
- Static serving: extension allow-list + path-prefix check (Windows backslash
  traversal covered by tests). CSP: `default-src 'self'`, no inline script.
- Frontend: no framework, no build. All DOM via `textContent` (agent output
  cannot script the page). Dual themes. **The agent's exact output** (final
  message, tool activity, terminal output) is rendered verbatim and visually
  separated from CodeRelay's system events.
- PWA: manifest (standalone), service worker caching ONLY the public shell
  (never `/api/`), generated PNG icons, install prompts (Chromium native +
  iOS hint), three connection states (ready / home-PC unreachable / no
  internet), full state resync on every SSE reconnect.
- Binds `127.0.0.1` by default. Remote access is documented as
  WireGuard/Tailscale or SSH tunnel — never an open port.

---

## 7. Security model (threats actually defended)

The target repository is hostile input. Verified-by-exploit defences (each was
demonstrated against an earlier build, then fixed, with regression tests in
`tests/redteam.test.ts` / `tests/hardening.test.ts`):

| Attack                                                                                    | Defence                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo-planted `git.exe` / `npm.cmd` shadowing the real binary (Windows searches CWD first) | git resolved to an absolute path via PATH-only search; `NoDefaultCurrentDirectoryInExePath=1` for shell lookups                                    |
| Git filter/diff drivers executing on _read_ (checkout/diff)                               | `detectExecutableGitConfig` runs before any git command; presence is a hard refusal                                                                |
| Hostile git hooks                                                                         | Random per-process `core.hooksPath` override; hook changes during a run are detected as tamper                                                     |
| Repo-supplied agent instructions (`AGENTS.md`, `.github/agents`, skills, MCP/LSP config)  | `--no-custom-instructions`, `--disable-builtin-mcps`, plus `repoScan` before AND re-check after every session (the CLI reloads config per session) |
| Credential theft via verification command                                                 | `execCommand` env REPLACES the parent env from an allow-list; the bot token never enters any child                                                 |
| Secrets in output                                                                         | Central `redact()` over every message, log line, stored row, diff                                                                                  |
| cmd.exe quoting (`%~dp0` corruption breaking npm)                                         | `cmdExeInvocation` quotes only tokens that need it — never bare program names                                                                      |
| Web: CSRF/XSS/rebinding/traversal                                                         | See §6; all covered by tests over real HTTP                                                                                                        |
| Provider downgrade (a CLI that can't express "deny shell(curl)")                          | Capability declaration + fail-closed `selectProvider()`                                                                                            |

What is _not_ claimed: the shell deny-list is defence in depth, not a sandbox
(`npm`/`pip`/`make` can run arbitrary code — that's inherent to running
tests); read-only roles are verified via git, which cannot see writes outside
the repo or gitignored paths. `COPILOT_SANDBOX=true` exists for real OS-level
containment (experimental upstream).

---

## 8. Cost control

- Per-task (`MAX_AI_CREDITS_PER_TASK`) and per-day (`MAX_AI_CREDITS_PER_DAY`)
  ceilings enforced locally between and during sessions; also passed to the
  CLI as a native ceiling where supported.
- Hard cap on paid agent sessions per task (`MAX_AGENT_CALLS_PER_TASK`,
  retries and reviews included).
- Orchestration decisions (classify, escalate, review-or-not) are plain
  TypeScript — **never an AI call to decide whether to make an AI call**.
- A session that finishes without reporting its cost is flagged; a second
  unreported run fails the task (a schema change upstream cannot silently
  make runs "free").
- Quota exhaustion halts cleanly with an explicit "no paid usage was enabled"
  message. The model catalogue is treated as _not_ an entitlement: runtime
  refusals trigger one model switch, then an actionable failure.

---

## 9. Testing strategy

`npm test` = strict-config `tsc` lint + build + 378 tests (`node:test`,
`node:assert/strict`, zero test dependencies, **zero AI calls**).

| File                                              | What it proves                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e.test.ts`                                     | The real runner against a **mock Copilot CLI** in temp git repos: happy path, retries, quota, cancellation, dirty-tree approval, checkpoints, orchestration roles (survey read-only, implementer writes).                                                      |
| `redteam.test.ts`                                 | Regressions for attacks that _worked_ against earlier builds (planted binaries, filter drivers, hook injection, prompt-injected shell text, nested-CLI denial). Never weakened to make a change pass.                                                          |
| `chaos.test.ts`                                   | Power-cut recovery, broken git, config written mid-run, model refusal fallback, daily-budget refusal.                                                                                                                                                          |
| `queue.test.ts`                                   | Deterministic five-task FIFO with per-transition state checks, exactly-once execution, approval barrier, per-project parallelism rules, promotion, restart persistence, abandonment.                                                                           |
| `web.test.ts`                                     | The real HTTP server: auth, CSRF, forged cookies, traversal (incl. Windows separators), Host pinning (421), cross-interface task visibility, approval resolution, SSE delivery + replay, PWA manifest/icons/SW contract.                                       |
| `providers.test.ts`                               | Capability gate refusals; Copilot argv byte-compat; Claude deny-list sharing; malformed stream safety.                                                                                                                                                         |
| `hardening/orchestration/stopReason/approval/...` | Unit-level invariants for each safety subsystem.                                                                                                                                                                                                               |
| `scripts/live-acceptance.mjs`                     | **Manual, spends ~1 credit**: drives the real Copilot CLI end to end against a throwaway repo with a real bug; asserts checkpoint → fix → tests → commit and that the bot token never reached Telegram. The only test that catches environment/quoting faults. |

---

## 10. Configuration surface (`.env`)

Required: `TELEGRAM_BOT_TOKEN` + `AUTHORIZED_TELEGRAM_USER_ID` (Telegram) _or_
`WEB_ENABLED=true` + `remote-agent web setup` (web). Everything else has safe
defaults: auto-push off, approvals on, checkpoints on, 10 credits/task,
50/day, 30-min task limit, 1 concurrent task, protected branches
`main,master,production,release`. `AGENT_PROVIDER=copilot|claude` selects the
agent CLI (validated, fail-closed). See `.env.example` for every option.

---

## 11. Known issues and open items

1. **Copilot CLI write-deny scope (re-probed on 1.0.80).** The 1.0.79
   regression — any per-path `--deny-tool=write(x)` rule denying **all** file
   writes — is gone: an A/B probe on 1.0.80 created files normally with the
   deny rules present. The durable limitation remains: `write(path)` rules
   bind the CLI's **file tools only**. In the same probe the agent wrote the
   denied `.env` through a shell command. The deny-list is defence in depth;
   the checkpoint, the sensitive-file commit screen and redaction are the
   layers that actually protect those files.
2. **iOS PWA behaviour** follows Apple's documented metadata but has not been
   verified on physical Apple hardware.
3. **Web push notifications** deliberately deferred (needs per-platform push
   service plumbing; must stay free and optional).
4. **Claude Code provider** is implemented and capability-gated but has not
   passed a live acceptance run; not documented as "supported" until it does.
5. **Single web operator** by design (one password, one implicit user); fits
   the personal-tool threat model, not multi-tenant use.

---

## 12. Conventions for contributors (and AIs)

- TypeScript, ESM, `NodeNext`: **always** `.js` extensions in relative imports.
- Comments explain _why_, never _what_.
- Anything touching permissions, redaction, git safety, the state machine or
  approvals **must come with a test**; red-team tests are never weakened.
- Untrusted text is argv with `shell:false`; on Windows, anything through
  `cmd.exe` uses the quoting helper; never quote a bare program name.
- Anything executing project-supplied code gets `buildChildEnv()`, never
  `process.env`; all git through `Git.run()`.
- Interfaces stay thin; capability claims about agent CLIs must correspond to
  verified flags on the _installed_ binary — never assumed, never invented.
- The full ground rules live in `AGENTS.md`.
