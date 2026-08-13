# Remote Personal Coding Agent

Send a coding task from your phone. Your home PC does the work with GitHub
Copilot CLI and reports back.

```
📱 Telegram  ──▶  🖥 Home PC agent  ──▶  🤖 Copilot CLI  ──▶  📁 your local repo
     ▲                                                              │
     └──────────────  progress + result  ◀──────────────────────────┘
```

**The application itself has no recurring infrastructure cost.** No VPS, no
cloud, no database service, no tunnel, no paid API. The only ongoing paid
service is the GitHub Copilot subscription you already have.

---

## Table of contents

1. [What this does](#1-what-this-does)
2. [Architecture](#2-architecture)
3. [Requirements](#3-requirements)
4. [Installation](#4-installation)
5. [GitHub Copilot setup](#5-github-copilot-setup)
6. [Telegram bot setup](#6-telegram-bot-setup)
7. [Authentication](#7-authentication)
8. [Registering projects](#8-registering-projects)
9. [Running the agent](#9-running-the-agent)
10. [Windows startup](#10-windows-startup)
11. [Configuration](#11-configuration)
12. [Security model](#12-security-model)
13. [Cost](#13-cost)
14. [Usage limits](#14-usage-limits)
15. [Troubleshooting](#15-troubleshooting)
16. [Updating](#16-updating)
17. [Recovery](#17-recovery)
18. [Uninstalling](#18-uninstalling)
19. [Known limitations](#19-known-limitations)

---

## 1. What this does

You are away from home. You message your private Telegram bot:

> Fix the login bug in MediLink. Inspect the repository, implement the smallest
> correct fix, add a regression test, run the relevant tests and build, and
> commit the changes if everything passes.

Your PC — already on, already signed in — receives the task, identifies the
MediLink project, snapshots your uncommitted work, launches GitHub Copilot CLI
inside that directory only, lets it work, runs your project's own tests and
build, commits if everything passes, and sends you a report.

You never open VS Code. Nothing is remote-controlled with a mouse or keyboard
simulator. No inbound port is opened on your network.

### Telegram commands

| Command | Description |
|---|---|
| `/help` | Command reference |
| `/status` | Agent, queue, model and usage status |
| `/projects` | List registered projects |
| `/task <project> <what to do>` | Queue a task (`/task 1 …` or `/task medilink …`) |
| `/tasks [n]` | Recent tasks |
| `/logs <id>` | Event log for a task |
| `/cancel <id>` | Cancel a queued or running task |
| `/retry <id>` | Re-queue a finished task |
| `/approve <id>` / `/reject <id>` | Answer an approval request |
| `/usage` | AI credit usage and budgets |

Plain messages work too: *"Fix the authentication bug in MediLink"* — the
project is matched locally against your registry by name. No model call is made
just to pick a project.

---

## 2. Architecture

```
                         ┌──────────────────────────┐
      your phone ───────▶│   Telegram Bot API       │   (free, no fee)
                         └────────────┬─────────────┘
                                      │  outbound long polling
                                      │  (PC dials out — no inbound port,
                                      │   no public IP, no tunnel)
                         ┌────────────▼─────────────┐
                         │      HOME PC AGENT       │
                         │  ┌────────────────────┐  │
                         │  │ Telegram bot       │  │  auth · commands · approvals
                         │  ├────────────────────┤  │
                         │  │ Task queue (SQLite)│  │  atomic claim · crash recovery
                         │  ├────────────────────┤  │
                         │  │ Task runner        │  │  state machine · retries · timeouts
                         │  ├────────────────────┤  │
                         │  │ Project registry   │  │  only registered paths
                         │  ├────────────────────┤  │
                         │  │ Git safety         │  │  checkpoint · diff · commit
                         │  ├────────────────────┤  │
                         │  │ Copilot executor   │  │  narrow permissions · budgets
                         │  └─────────┬──────────┘  │
                         └────────────┼─────────────┘
                                      ▼
                         ┌──────────────────────────┐
                         │   GitHub Copilot CLI     │  cwd = the project directory
                         └────────────┬─────────────┘
                                      ▼
                              your local repository
```

### Why long polling

The home PC opens an **outbound** HTTPS connection to Telegram and asks for
updates. Nothing listens for inbound connections, so there is no port to
forward, no public endpoint to secure, no tunnel to pay for, and no dynamic-DNS
setup. If the PC is offline, Telegram holds updates server-side (up to 24 h) and
the agent picks them up on reconnect. Duplicate delivery is de-duplicated by
`update_id`.

### Task lifecycle

```
QUEUED ──▶ RUNNING ──▶ TESTING ──▶ COMPLETED
   │          │           │
   │          │           └──▶ RUNNING (bounded recovery retry)
   │          └──▶ WAITING_APPROVAL ──▶ RUNNING | CANCELLED
   └──▶ CANCELLED | FAILED | TIMED_OUT
```

Transitions are validated; illegal jumps throw. Every transition is written to
an append-only event log.

### Source layout

```
src/
  core/       config, structured logging, secret redaction
  db/         SQLite schema + task repository
  domain/     task model and state machine
  projects/   project registry and path containment
  copilot/    CLI detection, permissions, JSONL parsing, executor, agent install
  git/        git wrapper and non-destructive checkpointing
  verify/     test/build command detection
  approval/   risk classification + human-in-the-loop gate
  runner/     task runner, prompt builder, queue
  telegram/   bot, auth, NL parsing, message formatting
  health/     doctor diagnostics
  notify/     transport-agnostic notifier + progress aggregation
tests/        113 automated tests, incl. an end-to-end suite with a mock CLI
```

---

## 3. Requirements

| Requirement | Why |
|---|---|
| **Node.js 22.5+** (tested on 24.11) | Uses the built-in `node:sqlite` — no native modules to compile |
| **Git** | Checkpoints, diffs, commits |
| **GitHub Copilot CLI** (`npm i -g @github/copilot`) | The coding engine |
| **An active GitHub Copilot plan** | Provides the AI usage |
| **A Telegram account** | The phone interface |
| Windows / macOS / Linux | Developed and verified on Windows 11 |

No Docker. No database server. No message broker.

---

## 4. Installation

```powershell
git clone <this repo> Mobile-agent-controller
cd Mobile-agent-controller

npm install
npm run build

copy .env.example .env      # macOS/Linux: cp .env.example .env
```

Edit `.env` (see [Configuration](#11-configuration)), then verify everything:

```powershell
npm run doctor
```

`doctor` checks Node, Git, the Copilot CLI and its version, Copilot sign-in,
whether your configured model actually exists in your CLI build, Telegram
connectivity, authorized users, filesystem permissions, the database, every
registered project (git state + detected test/build commands) and Internet
access.

---

## 5. GitHub Copilot setup

```powershell
npm install -g @github/copilot
copilot login          # opens a browser device-flow login
copilot --version
```

Then check which models *your* CLI build offers:

```powershell
npm run agent -- models
```

### About the model

Set `COPILOT_MODEL` in `.env` to a model your CLI actually lists.

> **Important, verified on this machine (Copilot CLI 1.0.79):**
> there is **no `claude-opus-5`** in the CLI's model catalogue. The strongest
> Claude model exposed is **`claude-opus-4.8`**, which is what `.env.example`
> uses. This project does **not** fake it and does **not** fall back to a paid
> Anthropic API. If Opus 5 becomes available to your Copilot account, change one
> line in `.env` and restart — nothing else needs to change.

At startup and on every `/status`, the agent validates `COPILOT_MODEL` against
the CLI's real catalogue. If the model is missing it either uses
`COPILOT_MODEL_FALLBACK` (telling you it did) or refuses to run the task and
explains why. It never silently substitutes a model.

### Custom agent

`.github/agents/remote-engineer.md` defines a Copilot custom agent specialised
for unattended work: inspect before modifying, minimal correct change, preserve
existing work, never touch secrets, never push, explain failures.

Because the CLI resolves custom agents relative to its working directory (which
is *your project*), the agent is installed **user-level** to
`~/.copilot/agents/` automatically on startup. That makes it apply to every
registered project **without modifying any of your repositories**.

```powershell
npm run agent -- install-agent     # done automatically on start
npm run agent -- uninstall-agent
```

---

## 6. Telegram bot setup

1. In Telegram, message **@BotFather** → `/newbot` → choose a name and username.
2. Copy the token into `TELEGRAM_BOT_TOKEN` in `.env`.
3. Message **@userinfobot** to get your **numeric user id**.
4. Put that number in `AUTHORIZED_TELEGRAM_USER_ID`.
5. Recommended: in BotFather → *Bot Settings → Group Privacy → Enable*, and do
   not add the bot to any group.

There is no webhook and no public URL. The bot token is the only credential, and
it is registered with the redaction layer so it can never appear in a log or
message.

---

## 7. Authentication

Two independent layers:

1. **Telegram identity** — every update is checked against
   `AUTHORIZED_TELEGRAM_USER_ID` before anything else runs. An **empty
   allow-list means nobody**, never everybody; the agent refuses to start
   without one. Unknown users get a single `This bot is private.` reply
   (throttled to once per hour per user) and are logged. They learn nothing:
   no project names, no status, no hint that this controls a real machine.

2. **GitHub Copilot** — handled by `copilot login` and stored in your OS
   credential store. This application never reads, stores, or transmits your
   GitHub token, and cannot change your billing settings.

Replayed Telegram updates are de-duplicated by `update_id`, so a redelivery can
never enqueue the same task twice.

---

## 8. Registering projects

**Filesystem paths are never accepted from chat.** You may only run tasks
against projects registered locally on the PC.

```powershell
npm run agent -- projects add MediLink "C:\Users\Me\Projects\MediLink"
npm run agent -- projects add AUSThir  "C:\Users\Me\Projects\AUSThir" --test "npm run test:ci"
npm run agent -- projects add Resume   "C:\Users\Me\Projects\ResumeWebsite"

npm run agent -- projects            # list
npm run agent -- projects check medilink
npm run agent -- projects remove resume
```

Stored in `config/projects.json` (git-ignored, written with restrictive
permissions). See `config/projects.example.json`.

Registration is validated: filesystem roots, your home directory, `~/.ssh`,
`~/.aws`, `~/.copilot`, `C:\Windows`, `/etc` and similar are **rejected**.

From Telegram:

```
/projects
1. MediLink
2. AUSThir
3. Resume

/task 1 Fix the dashboard API and run the tests
```

---

## 9. Running the agent

```powershell
npm start                       # foreground
npm run agent -- status         # is it running? what is queued?
npm run agent -- stop
npm run agent -- tasks 20
npm run agent -- logs 42
npm run agent -- doctor
npm run agent -- test           # self-test; makes no AI calls
```

On start the agent messages you *"🟢 Home PC agent is online"* with the Copilot
version, the resolved model and the project count.

---

## 10. Windows startup

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
```

Registers a per-user Scheduled Task that:

- runs at logon as you, **not elevated**,
- restarts automatically every minute if it exits,
- has no execution time limit,
- refuses to start a second copy.

```powershell
Start-ScheduledTask -TaskName RemotePersonalCodingAgent
powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1
```

> A logon trigger means the agent starts after you sign in. If the PC reboots
> while you are away, it will not run until someone signs in — unless you enable
> Windows automatic sign-in. Also check *Settings → System → Power* so the
> machine does not sleep.

**macOS**: wrap `scripts/start-agent.cmd`'s equivalent in a `launchd` plist.
**Linux**: a `systemd --user` unit with `Restart=always`.

---

## 11. Configuration

All settings live in `.env`. `.env.example` documents every key. Highlights:

| Key | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | From @BotFather (required) |
| `AUTHORIZED_TELEGRAM_USER_ID` | — | Your numeric id (required) |
| `COPILOT_MODEL` | `claude-opus-4.8` | Must exist in your CLI build |
| `COPILOT_MODEL_FALLBACK` | `claude-sonnet-4.6` | Used if the above is missing |
| `COPILOT_CUSTOM_AGENT` | `remote-engineer` | `none` to disable |
| `MAX_AI_CREDITS_PER_TASK` | `10` | Stop a task at this many credits |
| `MAX_AI_CREDITS_PER_DAY` | `50` | Rolling 24 h budget |
| `MAX_TASK_DURATION_MINUTES` | `30` | Wall-clock ceiling |
| `MAX_RETRIES` | `2` | Recovery attempts after failing verification |
| `MAX_CONCURRENT_TASKS` | `1` | Keep at 1 |
| `MAX_AUTOPILOT_CONTINUES` | `5` | The CLI's own runaway guard |
| `AUTO_COMMIT` | `true` | Commit after verification passes |
| `AUTO_PUSH` | `false` | **Off**; even when on, every push needs approval |
| `GIT_CHECKPOINT` | `true` | Snapshot uncommitted work first |
| `REQUIRE_APPROVAL_WHEN_DIRTY` | `true` | Ask before working in a dirty repo |
| `REQUIRE_APPROVAL_FOR_DANGEROUS_ACTIONS` | `true` | Risk-gated approvals |
| `PROTECTED_BRANCHES` | `main,master,production,release` | Commit needs approval here |
| `ALLOWED_URLS` | github/npm/pypi | Everything else is denied |
| `EXTRA_DENIED_COMMANDS` | — | Added to the built-in deny-list |

> `COPILOT_CUSTOM_AGENT` is deliberately **not** named `COPILOT_AGENT`: VS Code's
> integrated terminal injects `COPILOT_AGENT` with an unrelated value, which
> would otherwise be passed straight to `--agent` and break every task. (This was
> found by the live acceptance test, not by guessing.)

Never commit `.env` or `config/projects.json` — both are git-ignored.

---

## 12. Security model

This is a remote-control channel into your computer, so it is defended in depth.

**1 — Only you can talk to it.** Allow-listed Telegram id, checked before any
handler runs. Empty list = nobody. Strangers get one generic reply and learn
nothing.

**2 — No arbitrary paths.** Telegram can only select from projects registered on
the PC. Selectors are matched against the registry; a path-shaped selector never
resolves to a path. Sensitive locations are rejected at registration time.

**3 — No arbitrary shell.** There is no "run this command" feature. The only
text that reaches Copilot is the task description, and it is passed as a single
`argv` element with `shell: false`, so shell metacharacters are inert. The
Copilot CLI is launched via its JS entry point (`node …/npm-loader.js`)
specifically to avoid a `.cmd` shim that would require a shell. If only a shell
shim can be found, `doctor` warns you.

**4 — Narrow Copilot permissions.** The agent **never** passes `--yolo`,
`--allow-all`, `--allow-all-paths` or `--allow-all-urls`. It passes
`--allow-all-tools` (required for non-interactive use) **combined with an
explicit deny-list**, and deny always beats allow in the CLI's permission model:

- *Denied shell commands*: `rm`, `del`, `format`, `dd`, `shutdown`, `sudo`,
  `runas`, `icacls`, `reg`, `netsh`, `iptables`, `cmdkey`, `security`, `gpg`,
  `ssh`, `scp`, `nc`, `docker`, `kubectl`, `terraform`, `aws`, `az`, `gcloud`,
  `gh`, `apt`, `brew`, `choco`, `winget`, … (plus anything in
  `EXTRA_DENIED_COMMANDS`)
- *Denied git*: `push`, `reset`, `clean`, `rebase`, `filter-branch`, `config`,
  `remote`, `submodule`, `gc`, `reflog`
- *Paths*: because `--allow-all-paths` is never passed, file access is confined
  to the working directory — the selected project — plus the temp dir
- *Network*: only `ALLOWED_URLS` domains; this covers the shell tool too, so
  `curl https://evil.example` is blocked by the same rule
- *Autonomy*: `--no-ask-user` (never blocks on a prompt), `--no-remote` (the
  session cannot be driven from anywhere else), `--no-auto-update`

**5 — Secrets never leave.** A redaction layer scrubs GitHub tokens, PATs,
Telegram tokens, `sk-`/`AIza`/`AKIA` keys, JWTs, private-key blocks,
`*_SECRET=`/`*_TOKEN=`/`*_PASSWORD=` assignments and credentials embedded in
connection strings — from **every** Telegram message, log line, stored prompt
and event. Files like `.env`, `id_rsa`, `*.pem`, `.npmrc`, `secrets.yaml` are
excluded from commits and from result reports. The Copilot child process is
launched with the bot token stripped from its environment and additionally
declared via `--secret-env-vars`. The custom agent is instructed never to read
or print secrets.

**6 — Approvals for risky work.** A local rule-based classifier flags requests
involving bulk deletion, database migrations, system packages, paths outside the
project, firewall/network config, credentials, deployment, pushing, destructive
git or privilege escalation. Those tasks park in `WAITING_APPROVAL` and send you
an inline **APPROVE / REJECT** keyboard. Ordinary coding — read, edit, test,
build, `git status`, `git diff` — runs without nagging you.

**7 — Your uncommitted work is never destroyed.** See below.

**8 — Nothing listens.** No inbound port, no webhook, no public endpoint. The
optional dashboard binds to `127.0.0.1` only.

### Git safety in detail

Before any task touches a repository:

- `git status` is inspected. If there are uncommitted changes and
  `REQUIRE_APPROVAL_WHEN_DIRTY=true`, you are asked first, with the file list.
  Reject and nothing runs — Copilot is never even launched.
- A **checkpoint** is created at `refs/remote-agent/checkpoint-<taskId>`. This
  is a real commit object containing your tracked *and untracked* changes,
  written through a temporary `GIT_INDEX_FILE` so your working tree and your
  staged index are **not touched at all**.

Recover from a checkpoint at any time:

```powershell
git show refs/remote-agent/checkpoint-42            # inspect it
git diff HEAD refs/remote-agent/checkpoint-42       # what was different
git checkout refs/remote-agent/checkpoint-42 -- .   # restore everything
```

After the agent finishes, tests and build run, then a commit is made only if
everything passed. Commits exclude sensitive files. Pushing is off by default,
and even with `AUTO_PUSH=true` every push requires an explicit approval tap.

---

## 13. Cost

There are two separate things, and the project keeps them separate on purpose.

**A — Running this application: free, forever.**

| Component | Choice | Cost |
|---|---|---|
| Phone interface | Telegram Bot API | Free |
| Connectivity | Outbound long polling | Free — no tunnel, no VPS, no public IP |
| Persistence | SQLite via Node's built-in `node:sqlite` | Free, no server, no native build |
| Queue/scheduler | In-process, SQLite-backed | Free — no Redis/RabbitMQ/Kafka |
| Hosting | Your PC | Free |
| Notifications | Telegram | Free |
| Monitoring | Local structured logs + `doctor` | Free |
| Dependencies | `grammy` (MIT) + TypeScript | Free |

There is exactly **one** runtime dependency. No OpenAI/Anthropic/Gemini key, no
AWS/Azure/GCP, no Supabase/Firebase, no paid ngrok or Cloudflare, no Twilio.

**B — Copilot AI usage: billed to the plan you already pay for.**

Tasks consume AI credits (premium requests) from your existing Copilot
allowance. Copilot AI usage is **not unlimited** — this project does not claim
otherwise. The application:

- **never** purchases credits,
- **never** changes billing settings (it has no code path that can),
- **never** enables paid overage,
- stops and tells you when Copilot reports quota exhaustion or rate limiting.

---

## 14. Usage limits

The installed Copilot CLI has **no flag for a per-session credit cap** — only
`--max-autopilot-continues`. So the caps are enforced by this application:

| Guard | Mechanism | When it acts |
|---|---|---|
| `MAX_AI_CREDITS_PER_DAY` | Rolling 24 h ledger in SQLite | **Before** launching Copilot; the task fails fast with no AI call |
| `MAX_AI_CREDITS_PER_TASK` | Cumulative usage from the CLI's `result` payload | Between invocations — blocks the next attempt/retry |
| `MAX_TASK_DURATION_MINUTES` | Wall clock | Kills the process tree (`taskkill /T /F` on Windows) |
| Turn ceiling | Counts `assistant.turn_start` events | Kills a runaway loop mid-session |
| `MAX_AUTOPILOT_CONTINUES` | Passed to the CLI | The CLI's own runaway guard |
| `MAX_RETRIES` | Bounded recovery loop | Stops after N failed verifications — never loops forever |
| `MAX_CONCURRENT_TASKS` | Queue | Caps parallel spend |
| Quota exhaustion | Detected in CLI stderr/exit | Stops immediately, no retry, notifies you |

**Honest limitation:** the CLI reports `usage.premiumRequests` only in its final
`result` event, so the per-task credit cap is enforced *between* Copilot
invocations, not mid-invocation. A single invocation is instead bounded by the
duration limit, the turn ceiling and `--max-autopilot-continues`. With
`MAX_AI_CREDITS_PER_TASK=10` and `MAX_RETRIES=2`, worst-case spend for one task
is roughly one invocation's overshoot beyond the cap — not unbounded.

Check anytime with `/usage`, `/status`, or `npm run agent -- status`.

---

## 15. Troubleshooting

**Run `npm run doctor` first.** It diagnoses almost everything.

| Symptom | Fix |
|---|---|
| `Configuration error: TELEGRAM_BOT_TOKEN is not set` | Copy `.env.example` → `.env` and fill it in |
| `AUTHORIZED_TELEGRAM_USER_ID is not set` | Get your id from @userinfobot. The agent refuses to start without it — by design |
| Bot ignores you | Your id is not in the allow-list. Check `data/logs/agent-*.log` for `Rejected unauthorized Telegram request` |
| `Copilot CLI unavailable` | `npm install -g @github/copilot` |
| `no account is signed in` | `copilot login` |
| `Model … is not offered by this CLI build` | `npm run agent -- models`, then set a listed id |
| Task fails with `No such agent` | Run `npm run agent -- install-agent`, or set `COPILOT_CUSTOM_AGENT=none` |
| `Tests: not run (no test command detected)` | The project declares none. Add `--test "…"` when registering |
| Tests pass locally but fail for the agent | The agent runs the command from the project root with `CI=1` |
| Task stuck in `WAITING_APPROVAL` | Tap APPROVE/REJECT, or `/approve <id>`. Expires per `APPROVAL_TIMEOUT_MINUTES` |
| `Another agent instance is already running` | `npm run agent -- stop`, or delete `data/agent.pid` if the process is gone |
| Nothing happens while travelling | The PC slept or signed out. Check power settings and the scheduled task |
| Telegram network errors in the log | Normal transient drops; grammY reconnects automatically |

Logs: `data/logs/agent-YYYY-MM-DD.log` (JSON lines, redacted).
Per-task detail: `npm run agent -- logs <id>` or `/logs <id>`.

---

## 16. Updating

```powershell
git pull
npm install
npm run build
npm test
npm run agent -- install-agent
npm run doctor
```

Update the Copilot CLI itself with `copilot update` (or
`npm i -g @github/copilot`). After a CLI update, re-run
`npm run agent -- models` — the model catalogue can change between versions.
The database migrates itself on start.

---

## 17. Recovery

**A task was interrupted (crash, reboot, power cut).** On restart the agent
finds tasks left in `RUNNING`/`TESTING`, re-queues them and logs
`Runner restarted while task was in flight`. Because a task can only be picked
up through a single atomic claim, it can never be executed twice.

**The agent damaged something / you want your work back.** Every task creates a
checkpoint:

```powershell
git for-each-ref refs/remote-agent          # list checkpoints
git diff HEAD refs/remote-agent/checkpoint-42
git checkout refs/remote-agent/checkpoint-42 -- .
```

**An unwanted commit was made.**

```powershell
git revert <hash>       # safe, keeps history
git reset --hard HEAD~1 # only if it is not pushed and you are sure
```

The agent never pushes without an approval tap, so an unwanted commit is always
still local.

**Start clean.** Stop the agent and delete `data/` (task history and logs only;
your projects are untouched).

---

## 18. Uninstalling

```powershell
npm run agent -- stop
powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1
npm run agent -- uninstall-agent
```

Then delete the repository folder. Optionally revoke the bot with @BotFather
(`/deletebot`) and run `copilot logout` if you no longer want the CLI signed in.

Nothing is installed outside the repository except:
`~/.copilot/agents/remote-engineer.md` (removed by `uninstall-agent`) and the
Windows scheduled task (removed by the script). Your projects are never
modified by uninstalling.

---

## 19. Known limitations

1. **`claude-opus-5` does not exist** in Copilot CLI 1.0.79's model catalogue.
   The strongest available Claude model is `claude-opus-4.8`. The system is
   built so switching is a one-line `.env` change if that changes.
2. **Per-task credit caps act between Copilot invocations**, not mid-invocation,
   because the CLI only reports usage in its final `result` event. Duration and
   turn limits bound a single invocation. See [Usage limits](#14-usage-limits).
3. **Approval is at the task boundary**, not per tool call. The Copilot CLI's
   permission model is declared up front, so an individual mid-run tool call
   cannot be interactively approved. Risky *requests* are gated before they
   start, and the deny-list is the hard enforcement layer throughout.
4. **The PC must be on and signed in.** A logon-triggered task cannot run at a
   locked login screen after a reboot.
5. **Verification only runs commands your project declares** (`package.json`
   scripts, `pom.xml`, `build.gradle`, `Cargo.toml`, `go.mod`, `*.csproj`,
   `pyproject.toml`, `Makefile`) or that you configure per project. It never
   guesses.
6. **Natural-language routing is rule-based.** If a message does not clearly name
   one registered project, you are asked rather than guessed at.
7. **Single user, single machine** by design. No multi-tenancy, no SaaS.
8. **Web dashboard is not implemented** (config keys are reserved). The CLI and
   Telegram cover observability; a dashboard would be local-only and free.
9. **Windows-first.** macOS/Linux code paths are implemented but the startup
   automation ships only for Windows.

---

## Testing

```powershell
npm test
```

113 automated tests, all passing. No real Copilot session is started, so the
suite consumes **zero AI credits**.

Coverage includes: authorization and unauthorized-user rejection, unauthorized
throttling, secret redaction, sensitive-file detection, project registry
containment and path-traversal rejection, task creation, state machine, atomic
claiming, crash recovery, update de-duplication, usage ledger, permission-flag
construction, Copilot argv construction, JSONL stream parsing, model
discovery/selection, git status/checkpoint/staging, risk classification,
approval approve/reject/expire, test-command detection across ecosystems,
natural-language parsing, prompt construction and configuration validation.

The end-to-end suite drives the real `TaskRunner` against a **mock Copilot CLI**
in a real temporary git repository and asserts the whole pipeline: edit →
verify → commit → report, retry-then-stop on failing tests, quota stop, daily
budget refusal, dirty-repo approval and abort, checkpoint recoverability, `.env`
exclusion from commits, cancellation, timeout, no-op tasks, protected-branch
approval, and single-execution guarantees under the queue.

A separate live acceptance check was run against the **real** Copilot CLI
(v1.0.79): it fixed a genuine bug in a scratch repository, the project's tests
passed, and the change was committed — 0.33 AI credits.

---

## Design principles

Security over convenience · simplicity over architecture · local over cloud ·
zero recurring cost · official CLI capabilities only · never GUI-automate an
editor · never expose arbitrary shell · never expose secrets · never destroy
your work · never silently spend · never invent an unsupported flag.
