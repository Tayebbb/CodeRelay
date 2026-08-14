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

### Orchestration

One "agent" here is one Copilot CLI session, and one session costs real credits.
The CLI already explores, edits and runs tools inside a single session, so a
literal seven-agent pipeline would multiply the bill for the same change. The
design therefore keeps **decisions free and only work paid**.

```
        request ──▶ classify (free, plain TypeScript)
                        │
        simple ─────────┼───────── medium ───────── complex
          │             │             │                │
     implementer   implementer   implementer   explorer ─▶ implementer
          │             │             │                │
          └──────── tests / build (free) ──────────────┘
                        │
              confidence score (free)
                        │
              ≥ threshold ──▶ done
                        │
              < threshold ──▶ reviewer (read-only) ──▶ fix ──▶ tests again
```

- **Classification is deterministic and costs nothing.** Nothing asks a model
  how much model to buy.
- **Free gates run before paid ones.** Tests, build, manifest-integrity, the
  repository-config scan and the git-surface check all run first; most defects
  are caught for zero credits.
- **Roles are prompt profiles plus a tool policy, not processes.** The explorer
  and reviewer run with `--deny-tool=write`. That flag covers file-editing tools
  but, by the CLI's own documentation, **not shell invocations** — and a live run
  was observed writing a file through PowerShell after its edit tool was denied.
  So the read-only promise is not delegated: the runner records the repository's
  changed-file set before and after each advisory pass and **fails the task** if
  one of them wrote anything. Verified by test, not assumed.
- **The survey is handed over, not repeated.** The explorer's notes are injected
  into the implementer's prompt so the repository is not explored twice.
- **Escalation is evidence-based.** Security *keywords* never buy a session on
  their own — "fix the typo on the login page" must not pay for an audit. A
  change that actually touches `auth/`, `session/`, a workflow file or a
  Dockerfile does escalate, and that check is free.
- **A review costs two sessions, not one**, because there is no point being told
  about a defect with no budget left to fix it. Plans that do not fit
  `MAX_AGENT_CALLS_PER_TASK` are trimmed, not promised.

| Request | Sessions |
|---|---|
| "Rename `getUser` to `fetchUser`" | 1 |
| "Fix the API bug where /users returns 500" | 1 (+1 retry only if tests fail) |
| "Redesign authentication" | up to 4: survey → implement → review → fix |

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
  orchestrator/ free task classification, agent budget, confidence scoring
  runner/     preflight, agent loop, stop-reason decisions, publish, queue
  telegram/   bot, auth, NL parsing, message formatting
  health/     doctor diagnostics
  notify/     transport-agnostic notifier + progress aggregation
tests/        306 automated tests, incl. an end-to-end suite with a mock CLI
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

> **Verified on this machine (Copilot CLI 1.0.79): `claude-opus-5` exists and is
> the default.** It did not exist in 1.0.63, and the catalogue changes between
> CLI versions — the CLI auto-updates, so **re-run `remote-agent models` after
> an update** rather than assuming. `COPILOT_MODEL_FALLBACK` defaults to
> `claude-opus-4.8`.

At startup and on every `/status`, the agent validates `COPILOT_MODEL` against
the CLI's real catalogue. If the model is missing it either uses
`COPILOT_MODEL_FALLBACK` (telling you it did) or refuses to run the task and
explains why. It never silently substitutes a model.

**The catalogue is not an entitlement.** A model can be listed by the CLI and
still be refused by the API at run time:

```
Error: Model "claude-opus-5" from --model flag is not available.
```

This was observed live, minutes after the same model completed a task, so it is
usually **transient rate limiting** rather than a permanent problem. When it
happens the agent switches to `COPILOT_MODEL_FALLBACK` once (or, if that is the
model that was just refused, to any other model the CLI advertises), tells you
on Telegram, and does not count the switch as a recovery attempt. If every
candidate is refused it stops and asks you to set a usable
`COPILOT_MODEL_FALLBACK` — it never treats this as a fatal startup error and
never spends more to work around it.

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
remote-agent status             # is it running? what is queued?
remote-agent stop
remote-agent tasks 20
remote-agent logs 42
remote-agent doctor
remote-agent models             # models this CLI build supports
remote-agent install-agent      # (re)install the custom Copilot agent
remote-agent test               # self-test; makes no AI calls
```

(Use `npm run agent -- <command>` if you have not linked the `remote-agent` bin.)

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
| `COPILOT_MODEL` | `claude-opus-5` | Must exist in your CLI build |
| `COPILOT_MODEL_FALLBACK` | `claude-opus-4.8` | Used if the above is missing |
| `COPILOT_CUSTOM_AGENT` | `remote-engineer` | `none` to disable |
| `COPILOT_SANDBOX` | `false` | **The only real shell containment.** Experimental; see Security |
| `COPILOT_REPO_INSTRUCTIONS` | `false` | Load the target repo's AGENTS.md as instructions |
| `COPILOT_GITHUB_MCP` | `false` | Keep the GitHub MCP server (bypasses `ALLOWED_URLS`) |
| `COPILOT_ENV_PASSTHROUGH` | — | Extra env vars to forward to the agent (default: none) |
| `MAX_AI_CREDITS_PER_TASK` | `10` | App-enforced; also passed to the CLI when ≥ 30 |
| `MAX_AI_CREDITS_PER_DAY` | `50` | Rolling 24 h budget |
| `MAX_TASK_DURATION_MINUTES` | `30` | Wall-clock ceiling |
| `MAX_RETRIES` | `2` | Recovery attempts after failing verification |
| `MAX_CONCURRENT_TASKS` | `1` | Tasks in the same project are always serialised |
| `MAX_AUTOPILOT_CONTINUES` | `5` | The CLI's own runaway guard |
| `AUTO_COMMIT` | `true` | Commit after verification passes |
| `AUTO_PUSH` | `false` | **Off**; even when on, every push needs approval |
| `ALLOW_COMMIT_WITHOUT_VERIFICATION` | `false` | Commit when no test/build command exists |
| `GIT_CHECKPOINT` | `true` | Snapshot uncommitted work first |
| `REQUIRE_APPROVAL_WHEN_DIRTY` | `true` | Ask before working in a dirty repo |
| `REQUIRE_APPROVAL_FOR_DANGEROUS_ACTIONS` | `true` | Risk-gated approvals |
| `PROTECTED_BRANCHES` | `main,master,production,release` | Commit needs approval here |
| `ALLOWED_URLS` | npm/pypi/github | Everything else is denied |
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

- *Denied interpreters* — `node`, `python`, `bash`, `sh`, `pwsh`, `powershell`,
  `cmd`, `perl`, `ruby`, `npx`, `xargs`, `env`, … Without these the rest of the
  list is decorative, because `node -e "fs.rmSync(...)"` performs any denied
  action without ever naming a denied command.
- *Denied shell commands* — `rm`, `del`, `format`, `dd`, `shutdown`, `sudo`,
  `runas`, `icacls`, `reg`, `netsh`, `cmdkey`, `security`, `gpg`, `ssh`, `scp`,
  `curl`, `wget`, `docker`, `kubectl`, `terraform`, `aws`, `az`, `gcloud`, `gh`,
  `apt`, `brew`, `choco`, `winget`, plus PowerShell write aliases
  (`Remove-Item`, `Set-Content`, `Out-File`, `Move-Item`, …)
- *Denied git* — `push`, `reset`, `clean`, `rebase`, `filter-branch`, `config`,
  `remote`, `submodule`, `gc`, `reflog`
- *Denied writes* — `.env`, `.npmrc`, `.netrc`, `id_rsa`, `credentials.json`, …
- *Network* — only `ALLOWED_URLS` domains, **and** writable GitHub endpoints
  (`api.github.com`, `gist.github.com`, `uploads.github.com`) are explicitly
  denied, because an authenticated machine could otherwise exfiltrate to a gist
- *Autonomy* — `--no-ask-user`, `--no-remote`, `--no-auto-update`

> ### Read this: what the deny-list is and is not
>
> `copilot help sandbox` states that with sandboxing **disabled (the default)**,
> *"shell commands run directly on your machine with the same access your user
> account has."* So:
>
> - The path restriction constrains the CLI's built-in **file tools**, not shell
>   commands.
> - A command deny-list **cannot** be a sound boundary. We deny the interpreters
>   too, but an exhaustive blocklist over a Turing-complete surface is
>   impossible, and shell redirection (`echo x > .env`) has no command name to
>   deny at all.
>
> **The real containment boundary is `COPILOT_SANDBOX=true`**, which runs shell
> commands inside the CLI's OS-level MXC sandbox (Windows 11 / macOS /
> Linux+`bwrap`). It is experimental and can break some builds, so it is
> opt-in — but if you run tasks against code you did not write, turn it on.
> `remote-agent doctor` warns you when it is off.

**5 — The agent gets a built-from-scratch environment.** The child process
receives an **allow-list** of toolchain variables only. Credentials
(`GITHUB_TOKEN`, `AWS_*`, `NPM_TOKEN`, anything matching `*TOKEN*`/`*SECRET*`/
`*AUTH*`…) are withheld, and so are code-injection variables that would
otherwise slip through a toolchain prefix — `NODE_OPTIONS`, `PYTHONSTARTUP`,
`JAVA_TOOL_OPTIONS`, `MAVEN_OPTS`, `GRADLE_OPTS`, `LD_PRELOAD`, `BASH_ENV`.
Withheld credential values are registered with the redactor so they can never be
echoed by another route. Use `COPILOT_ENV_PASSTHROUGH` if a build truly needs one.

**6 — Secrets never leave.** A redaction layer scrubs GitHub tokens, PATs,
Telegram tokens, `sk-`/`AIza`/`AKIA` keys, JWTs, private-key blocks,
`*_SECRET=`/`*_TOKEN=`/`*_PASSWORD=` assignments and credentials embedded in
connection strings — from **every** Telegram message, log line, stored prompt
and event. The project's own `.env`/`.npmrc` values are additionally read at task
start *purely to register them as forbidden strings*, so even an arbitrary value
like `DB_PASSWORD=correct-horse` is stripped if the agent ever echoes it. Files
like `.env`, `id_rsa`, `*.pem`, `.npmrc`, `secrets.yaml` are excluded from
commits and from result reports.

**7 — Prompt injection and repository-controlled configuration are treated as
real threats.** Repository content is declared untrusted **data** in both the
task prompt and the custom agent. Beyond wording, the following are enforced:

- **Repository-supplied Copilot config is blocked.** The CLI resolves agents,
  skills, hooks, plugins, MCP servers and language servers *relative to the
  working directory* — which is your project. A repo shipping
  `.github/agents/remote-engineer.md` would **replace the safety rules this whole
  design depends on**; `.github/hooks/*.json`, `.mcp.json`, `.github/skills/`,
  `plugin.json` and `.github/lsp.json` all name commands or auto-approve tools.
  Every one of these is detected before Copilot is launched and requires
  approval. (Verified present in the installed CLI bundle.)
- **A repository cannot supply the programs we run.** Windows resolves a bare
  program name from the **current directory before PATH**, and the current
  directory is the target repository. Both halves were verified on this machine:
  a planted `git.exe` was executed by our own git wrapper (with the full parent
  environment, including the bot token, during preflight and before any
  approval), and a planted `npm.cmd` was executed by the verification step —
  neither needs the agent to do anything. `git` is now resolved to an absolute
  path from PATH, and every child gets
  `NoDefaultCurrentDirectoryInExePath=1`, which removes the current directory
  from shell lookups. Both attacks have regression tests.
- **Repo instruction files are not loaded.** `--no-custom-instructions` is passed
  by default, so `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` in
  the *target* repository cannot act as instructions. Opt in with
  `COPILOT_REPO_INSTRUCTIONS=true` for repositories you trust.
- **The GitHub MCP server is disabled.** It speaks HTTP with your GitHub identity
  and is therefore *not* covered by `ALLOWED_URLS` — a ready-made exfiltration
  channel. Re-enable with `COPILOT_GITHUB_MCP=true`.
- **Git hooks and git config cannot execute.** `.git/hooks/` and `.git/config`
  live inside the project, so the agent can write them, and git then runs what
  they name **as you**. Two verified attacks: a `post-commit` hook (which
  `--no-verify` does *not* stop) and `core.fsmonitor` (which runs on
  `git status`). Every git invocation now pins `core.hooksPath`, `core.fsmonitor`,
  `gpg.program`, `credential.helper`, `core.sshCommand`, `diff.external`,
  `protocol.ext.allow` and the editors. In addition the whole git control surface
  — config, every `*hooks*` directory (including the CLI's own
  `.git/copilot-hooks`), submodule configs, `.gitattributes` — is fingerprinted
  before the agent runs and re-checked on **every** exit path. Any change stops
  the task: nothing is tested, committed or pushed.
- **Verification runs with a filtered environment.** `npm test` is
  project-supplied code, so it gets the same allow-listed environment as the
  agent — not the operator's shell. Without this a hostile `"test"` script would
  read `TELEGRAM_BOT_TOKEN` out of `process.env` and take over the control
  channel on the very first task.
- **What the test command executes is fingerprinted**, including the files named
  inside `package.json` lifecycle scripts (`"test": "node evil.js"`) and the
  build-control files that silently redirect a build — `.cargo/config.toml`,
  `.mvn/jvm.config`, `gradle.properties`, `Directory.Build.props`, runner
  configs. A change means the command is not run until you approve it.
- **The agent cannot re-launch itself.** `copilot`, `claude`, `aider`, `code`
  and friends are denied: `copilot -p "…" --yolo` would start a second session
  with none of our flags.

**8 — Approvals for risky work.** A local rule-based classifier flags requests
involving bulk deletion, database migrations, system packages, paths outside the
project, firewall/network config, credentials, deployment, pushing, destructive
git or privilege escalation. Those tasks park in `WAITING_APPROVAL` and send you
an inline **APPROVE / REJECT** keyboard. Only the operator who created a task can
answer its approval, and `/retry` re-runs the risk assessment so a rejected task
cannot be laundered through it. Ordinary coding — read, edit, test, build,
`git status`, `git diff` — runs without nagging you.

**9 — Your uncommitted work is never destroyed.** See below.

**10 — Nothing listens.** No inbound port, no webhook, no public endpoint.

### Git safety in detail

Before any task touches a repository:

- **A conflicted repository is refused outright.** If `git status` reports
  unmerged paths the task stops immediately — an autonomous agent must never
  "resolve" a merge for you, and staging a conflicted tree would commit conflict
  markers.
- `git status` is inspected. If there are uncommitted changes and
  `REQUIRE_APPROVAL_WHEN_DIRTY=true`, you are asked first, with the file list.
  Reject and nothing runs — Copilot is never even launched.
- A **checkpoint** is created at `refs/remote-agent/checkpoint-<taskId>`. This
  is a real commit object containing your tracked *and untracked* changes,
  written through a temporary `GIT_INDEX_FILE` so your working tree and your
  staged index are **not touched at all**. A re-run after a crash never
  overwrites an existing checkpoint — your original recovery point survives.

Recover from a checkpoint at any time:

```powershell
git for-each-ref refs/remote-agent                   # list checkpoints
git show refs/remote-agent/checkpoint-42             # inspect it
git diff HEAD refs/remote-agent/checkpoint-42        # what was different
git checkout refs/remote-agent/checkpoint-42 -- .    # restore everything
```

Checkpoints older than 30 days are pruned automatically (the newest 10 per
repository are always kept), so the agent cannot grow your repositories forever.

After the agent finishes, tests and build run, then a commit is made only if
everything passed. **Only files the agent actually changed are staged** — the
diff is taken against the checkpoint, so your own pre-existing edits are never
swept into an automated commit. Commits exclude sensitive files and use
`--no-verify` so repository hooks cannot execute. Pushing is off by default, and
even with `AUTO_PUSH=true` every push requires an explicit approval tap.

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

Copilot CLI 1.0.79 added `--max-ai-credits`, which this agent passes through
when your budget meets the CLI's documented 30-credit minimum. Below that, and
for everything else, the caps are enforced by this application:

| Guard | Mechanism | When it acts |
|---|---|---|
| `MAX_AI_CREDITS_PER_DAY` | Rolling 24 h ledger in SQLite | **Before** launching Copilot; the task fails fast with no AI call |
| `MAX_AI_CREDITS_PER_TASK` ≥ 30 | Passed to the CLI as `--max-ai-credits` | In-process: the CLI blocks the next model call |
| `MAX_AI_CREDITS_PER_TASK` < 30 | Cumulative usage from the CLI's result payload | Between invocations — blocks the next attempt/retry |
| Usage not reported | Two consecutive runs with no usage figure | Task stops rather than spending blind |
| `MAX_TASK_DURATION_MINUTES` | Wall clock, incl. verification | Kills the process tree; a watchdog resolves even if a child survives |
| Turn ceiling | Counts `assistant.turn_start` events | Kills a runaway loop mid-session |
| `MAX_AUTOPILOT_CONTINUES` | Passed to the CLI | The CLI's own runaway guard |
| `MAX_RETRIES` | Bounded recovery loop | Stops after N failed verifications — never loops forever |
| Crash re-runs | `retry_count` carried across restarts | A task interrupted 3 times is abandoned, not re-billed forever |
| Quota exhaustion | Detected in CLI stderr **and** a non-zero exit | Stops immediately, no retry, notifies you |

Spend already incurred is **preserved across a crash**: a recovered task
remembers what it cost before the interruption, and the restart banner tells you.

**Honest limitation:** below 30 credits the CLI cannot enforce a ceiling itself,
so the per-task cap is applied *between* Copilot invocations. A single
invocation is instead bounded by the duration limit, the turn ceiling and
`--max-autopilot-continues`.

Check anytime with `/usage`, `/status`, or `remote-agent status`.

---

## 15. Troubleshooting

**Run `npm run doctor` first.** It diagnoses almost everything.

| Symptom | Fix |
|---|---|
| `Configuration error: TELEGRAM_BOT_TOKEN is not set` | Copy `.env.example` → `.env` and fill it in |
| `AUTHORIZED_TELEGRAM_USER_ID is not set` | Get your id from @userinfobot. The agent refuses to start without it — by design |
| Bot ignores you | Your id is not in the allow-list. Check `data/logs/agent-*.log` |
| `Copilot CLI unavailable` | `npm install -g @github/copilot` |
| `no account is signed in` | `copilot login` |
| `Model … is not offered by this CLI build` | `remote-agent models`, then set a listed id. The CLI auto-updates and the catalogue changes |
| `Model "X" from --model flag is not available` | The model is listed but refused right now — usually temporary rate limiting. The agent switches to `COPILOT_MODEL_FALLBACK` automatically; set that to a model you can actually use |
| Copilot could not authenticate | Run `copilot login` on the PC, then `/retry`. The agent reports this as an auth failure and does not burn a retry on it |
| Verification fails but the same command passes in a terminal | Fixed in this build: quoting a bare program name broke `%~dp0` inside `.cmd` shims (npm/yarn/pnpm/gradlew). If you see `node_modules\npm\bin\npm-prefix.js` in a log, you are on an older build |
| Task fails with `No such agent` | `remote-agent install-agent`, or set `COPILOT_CUSTOM_AGENT=none` |
| “Build/test definition changed” approval you did not expect | The agent edited `package.json`/a runner config. Inspect the diff before approving — that command runs as you |
| Task refused: “unresolved merge conflict(s)” | Resolve the merge yourself; the agent will not touch a conflicted tree |
| `Tests: not run (no test command detected)` | The project declares none. Add `--test "…"` when registering |
| Build fails only under the agent | The child gets an allow-listed environment. If it needs a specific variable, add it to `COPILOT_ENV_PASSTHROUGH` |
| Tasks stopped after “no usage figure” | The CLI changed its output format. Run `remote-agent doctor` and update |
| Task stuck in `WAITING_APPROVAL` | Tap APPROVE/REJECT, or `/approve <id>`. Expires per `APPROVAL_TIMEOUT_MINUTES`; a restart cancels stranded ones |
| `Another agent instance is already running` | `remote-agent stop`. A stale lock from a power cut is detected and reclaimed automatically |
| Nothing happens while travelling | Check `/status` — it reports the real connection state and how long Telegram has been quiet |
| Telegram network errors in the log | Normal transient drops; grammY reconnects and `/status` shows `RECONNECTING` |

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
finds tasks left in `RUNNING`/`TESTING`, re-queues them, and tells you on
Telegram how many credits each had already spent and the exact command to
restore your pre-task snapshot. A task interrupted more than three times is
**abandoned rather than re-run**, so a boot loop cannot silently re-bill it.
Because a task can only be picked up through a single atomic claim, it can never
be executed twice concurrently. Tasks left awaiting approval by a restart are
cancelled (the waiter only lives in memory) and you are told.

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

1. **The model catalogue changes between CLI versions, and the CLI auto-updates.**
   `claude-opus-5` exists in 1.0.79 and is the default; it did not exist in
   1.0.63. Re-run `remote-agent models` after an update.
2. **The deny-list is not a sandbox.** With `COPILOT_SANDBOX=false` (the
   default) shell commands run with your full user rights; the deny-list and
   path scoping are defence in depth only. Turn the sandbox on for real
   containment — it is experimental and may break some builds. Concretely: the
   list denies `curl`, `wget` and the interpreters, but **not** `npm`, `pip`,
   `cargo`, `go`, `make`, `mvn` or `gradle`, which are each capable of fetching
   from the network and running arbitrary code. Denying them would stop the
   agent doing its job. Do not read the deny-list as a network policy.
3. **The read-only guarantee for advisory passes is verified, but not total.**
   The explorer and reviewer are checked before and after against git's changed
   -file set, and against git's control surface. That catches edits to tracked
   and untracked files and to `.git/`. It does **not** see writes to
   **gitignored** paths (e.g. inside `node_modules/`), writes **outside** the
   repository, or a file modified and restored within the same session.
3. **Verification executes project code.** Running your project's own tests
   after an agent edited your project inherently runs agent-influenced code —
   that is the feature. The manifest gate catches the test/build *entry point*
   being redirected; it cannot fingerprint the transitive closure of everything
   a test suite touches. The sandbox is what contains the rest.
4. **Per-task credit caps below 30 act between Copilot invocations**, not
   mid-invocation. Duration and turn limits bound a single invocation.
5. **Approval is at the task boundary**, not per tool call — the Copilot CLI's
   permission model is declared up front.
6. **The PC must be on and signed in.** A logon-triggered task cannot run at a
   locked login screen after a reboot.
7. **Verification only runs commands your project declares** (`package.json`
   scripts, `pom.xml`, `build.gradle`, `Cargo.toml`, `go.mod`, `*.csproj`,
   `pyproject.toml`, `Makefile`) or that you configure per project.
8. **Natural-language routing is rule-based.** If a message does not clearly name
   one registered project, you are asked rather than guessed at.
9. **A conflicted repository is refused**, not resolved. That is deliberate.
10. **Single user, single machine** by design. No multi-tenancy, no SaaS.
11. **Web dashboard is not implemented** (config keys are reserved). The CLI and
    Telegram cover observability.
12. **Windows-first.** macOS/Linux code paths are implemented but the startup
    automation ships only for Windows.

---

## Testing

```powershell
npm test
```

**306 automated tests, all passing** (lint + build + tests). No real Copilot
session is started, so the suite consumes **zero AI credits**.

Coverage includes: authorization and unauthorized-user rejection, secret
redaction, sensitive-file detection, project-registry containment, path
traversal, UNC/8.3/junction rejection, shell-metacharacter rejection in
operator-configured commands, cmd.exe quoting (injection attempts), the child
environment allow-list and code-injection variable denial, the Copilot
permission policy (interpreters, write denies, URL denies), argv construction
including `--max-ai-credits` and `--sandbox`, JSONL stream parsing, usage
fallback via `session.shutdown`, model discovery/selection, build-manifest
integrity, the single-instance lock (including recycled PIDs), database
retention, per-project serialisation, crash-recovery re-run caps, approval
approve/reject/expire/abort/ownership, git status parsing (renames, non-ASCII
filenames, 600-file staging, checkpoint preservation), test-command detection
across ecosystems, natural-language parsing and configuration validation.

The end-to-end suite drives the real `TaskRunner` against a **mock Copilot CLI**
in a real temporary git repository and asserts: edit → verify → commit → report,
retry-then-stop on failing tests, quota stop, daily-budget refusal, dirty-repo
approval and abort, checkpoint recoverability, `.env` exclusion, cancellation,
timeout, no-op tasks, protected-branch approval, **refusal to touch a repository
with merge conflicts**, **refusal to run a test command the agent rewrote**,
**authentication failure reported as itself rather than as a billing problem**,
**automatic model fallback when the API refuses a catalogued model**, and
single-execution guarantees under the queue.

### Live acceptance (spends real credits)

```powershell
node scripts/live-acceptance.mjs   # ~1-2 AI credits, manual only
```

This is the only test that starts a real Copilot session. It creates a
throwaway git repository containing a genuinely broken `slugify()`, runs the
real `TaskRunner`, and asserts nine properties: the task completed, a commit was
created, **the tests really pass afterwards**, the intended file was fixed, the
test file was *not* edited, the bot token never appeared in any Telegram
message, credits were accounted for, no git hook was installed, and a checkpoint
ref exists.

Most recent run: **9/9 passed**, 1.00 AI credit, 92 s, Copilot CLI 1.0.79.

Run it after touching the runner, permissions, git handling or `execCommand`.
The mocked suite deliberately cannot catch environment or shell-quoting faults
— a bug that made *every* npm/yarn/pnpm/gradlew verification fail was invisible
to 247 passing unit tests and was caught here.

---

## Design principles

Security over convenience · simplicity over architecture · local over cloud ·
zero recurring cost · official CLI capabilities only · never GUI-automate an
editor · never expose arbitrary shell · never expose secrets · never destroy
your work · never silently spend · never invent an unsupported flag.
