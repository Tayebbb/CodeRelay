# Remote Personal Coding Agent

Send a coding task from your phone. Your home PC does the work with GitHub Copilot, runs your tests, and reports back.

```
Phone (Telegram)  →  your PC  →  GitHub Copilot CLI  →  your local repo
       ↑                                                        │
       └──────────── result, diff, test output ─────────────────┘
```

**No server. No hosting. No monthly bill.** It uses the Copilot subscription you already have, connects out to Telegram (so no open ports), and keeps everything in a local SQLite file.

---

## Contents

- [What it actually does](#what-it-actually-does)
- [Is this safe? Read this first](#is-this-safe-read-this-first)
- [Requirements](#requirements)
- [Install](#install)
- [Add your projects](#add-your-projects)
- [Run it](#run-it)
- [Using it from your phone](#using-it-from-your-phone)
- [Safety features](#safety-features)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Cost](#cost)
- [Known limitations](#known-limitations)
- [Development](#development)

---

## What it actually does

You text your bot:

```
myapp: the /users endpoint returns 500 when the id is missing
```

Then, on your PC:

1. **Takes a snapshot** of the repo so nothing you have in progress can be lost
2. **Scans the repo** for anything that could hijack the agent
3. **Runs GitHub Copilot CLI** on the task
4. **Runs your tests** (`npm test`, `pytest`, `go test` — whatever it detects)
5. **Asks your permission** before anything risky: committing to `main`, pushing, or changing what your test command runs
6. **Commits** and sends you a report with the files changed, test results and what it cost

If the tests fail it tries again, a bounded number of times, then stops and tells you what happened.

---

## Is this safe? Read this first

Be honest with yourself about what this is: **an AI agent running unattended on your computer with your user account's permissions.**

The design takes that seriously. Every property below is enforced in code and covered by tests:

- **Only you can command it.** Authorisation is a numeric Telegram user-ID allow-list. Everyone else gets `This bot is private.` and nothing else. Direct messages only — it refuses to operate in group chats.
- **Your work is never destroyed.** Before touching anything it writes a git checkpoint that includes your _uncommitted_ changes. There is always a way back.
- **It stops rather than guessing.** Merge conflicts, broken git, a full disk, or a repo shipping its own Copilot config — it refuses to start and tells you why.
- **Secrets never leave.** Your bot token and your projects' `.env` values are stripped from every message, log and stored record.
- **Nothing is pushed without you.** `AUTO_PUSH` is off by default. Commits stay on your machine until you decide otherwise.

**Now the honest part.** With `COPILOT_SANDBOX=false` (the default), shell commands run with your full user rights. The command deny-list is defence in depth, **not a security boundary**. And verifying a change means running your project's own test command — which is the entire point, and also means executing code the agent just influenced.

> **Only point this at repositories you would already be willing to `git clone` and `npm test` yourself.**

Start with a throwaway repo. Watch a few tasks. Then decide how far to trust it.

---

## Requirements

|                                 |                                                                  |
| ------------------------------- | ---------------------------------------------------------------- |
| **Windows 10/11**               | macOS/Linux code paths exist; startup automation is Windows-only |
| **Node.js 22.5+**               | Needs the built-in `node:sqlite`. Node 24 recommended            |
| **Git**                         | Any recent version                                               |
| **GitHub Copilot subscription** | The AI comes from here. There is no other API key                |
| **Telegram account**            | Free                                                             |

---

## Install

### 1. Get the code

```powershell
git clone https://github.com/Tayebbb/Mobile-agent-controller.git
cd Mobile-agent-controller
npm install
npm run build
```

### 2. Install and sign in to the Copilot CLI

```powershell
npm install -g @github/copilot
copilot login
```

### 3. Create your Telegram bot

In Telegram, message **@BotFather** and send:

```
/newbot
```

Give it a display name, then a username ending in `bot`. BotFather replies with a token like `8123456789:AAH...` — copy it.

### 4. Get your user ID

In Telegram, message **@userinfobot**. It replies immediately with your numeric `Id`.

### 5. Configure

```powershell
copy .env.example .env
```

Open `.env` and fill in exactly two values:

```env
TELEGRAM_BOT_TOKEN=8123456789:AAH...
AUTHORIZED_TELEGRAM_USER_ID=123456789
```

> `.env` is gitignored — never commit it. If the token ever leaks, send `/revoke` to BotFather and generate a new one.

### 6. Check everything

```powershell
npm run doctor
```

Verifies Node, git, the Copilot CLI, your login, the model catalogue, your Telegram token, file permissions and every registered project. Fix whatever it flags before going further.

### 7. Say hello to your bot

Find your bot in Telegram by the username you chose and tap **Start**. Telegram won't let a bot message you until you've messaged it first.

---

## Add your projects

```powershell
npm run agent -- projects add <Name> "<absolute path>" --test "<command>"
```

Examples:

```powershell
npm run agent -- projects add MyApp "C:\code\myapp" --test "npm test"
npm run agent -- projects add Scraper "D:\code\scraper" --test "pytest -q"
npm run agent -- projects add Api "C:\src\api" --test "dotnet test" --build "dotnet build"
npm run agent -- projects add "Long Project Name" "D:\work\thing" --id thing
```

Manage them:

```powershell
npm run agent -- projects list
npm run agent -- projects remove <id>
```

**Each project should be a git repository.** Without git there is no checkpoint and no undo — you will be warned loudly.

If you omit `--test`, it auto-detects from `package.json`, `pytest.ini`, `Cargo.toml`, `pom.xml`, `Makefile` and similar. Confirm what it found with `projects list`.

New projects are picked up immediately — no restart needed.

---

## Run it

### While you're testing

```powershell
npm start
```

Runs in the foreground; `Ctrl+C` stops it.

### Permanently (recommended)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
Start-ScheduledTask -TaskName RemotePersonalCodingAgent
```

Registers a per-user Scheduled Task — no admin rights, no Windows service. It starts at logon, restarts within a minute if it crashes, and keeps running after you close your terminal.

```powershell
Stop-ScheduledTask -TaskName RemotePersonalCodingAgent
npm run agent -- status
powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1
```

**Two things that will otherwise bite you.**

Stop the machine sleeping:

```powershell
powercfg /change standby-timeout-ac 0
```

The task triggers **at logon**. If Windows reboots while you are away and stops at the lock screen, nothing runs until someone signs in. For long absences, enable Windows automatic sign-in.

---

## Using it from your phone

Send a task:

```
myapp: fix the failing date parser tests
```

The part before the `:` is the project id. With a single project registered you can leave it out.

### Commands

| Command                          | What it does                           |
| -------------------------------- | -------------------------------------- |
| `/help`                          | Command list                           |
| `/status`                        | Connection, model, queue, credits used |
| `/projects`                      | Registered projects                    |
| `/tasks`                         | Recent tasks and their state           |
| `/logs <id>`                     | Detailed log for one task              |
| `/cancel <id>`                   | Stop a running task                    |
| `/retry <id>`                    | Re-run a failed task                   |
| `/usage`                         | AI credits used                        |
| `/approve <id>` · `/reject <id>` | Answer an approval by text             |

### What a run looks like

```
▶️ Task #4 started · claude-opus-5
🧭 MEDIUM — implementer
🔒 Checkpoint created (a1b2c3d4) — your work is recoverable
🔍 Copilot is inspecting the repository…
🛠 edit  src/routes/users.ts
🧪 Running tests: npm test
✅ Verification passed
⚠️ Branch "main" is protected — approve to commit?   [APPROVE] [REJECT]
📦 Creating commit…
✅ TASK COMPLETED (#4)
```

Approvals arrive as buttons. Tap **REJECT** and the change stays in your working tree, uncommitted — you keep control.

### Checking the work

```powershell
cd C:\code\myapp
git log --oneline        # what happened
git show HEAD            # the exact diff
npm test                 # confirm it really passes
```

---

## Safety features

**Checkpoints.** Before each task a git commit object is written to `refs/remote-agent/checkpoint-<id>`, capturing the tree _including_ your uncommitted work. It never touches your index or working tree.

```powershell
git for-each-ref refs/remote-agent                 # list snapshots
git checkout refs/remote-agent/checkpoint-4 -- .   # restore everything
```

**Approval gates.** You are asked before: committing to a protected branch, pushing, running with uncommitted changes present, resuming an interrupted task, and when the agent has modified the files that decide what your test command executes.

**Repository hardening.** The target repo is treated as hostile. It refuses to run if the repo defines git filter or diff drivers — which make git execute commands merely by reading files — and it detects repository-supplied Copilot agent, hook and MCP configuration both before _and_ during a run.

**Budget limits.** Per-task and per-day AI-credit ceilings, a task time limit, and a bounded retry count. Spend is recorded durably, so a task interrupted by a crash or power cut cannot be silently re-billed.

**Redaction.** The bot token and every value found in your project's `.env` are stripped from all output.

---

## Configuration

Everything lives in `.env`. Only the first two are required.

| Setting                       | Default                          | Meaning                                      |
| ----------------------------- | -------------------------------- | -------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`          | —                                | From @BotFather                              |
| `AUTHORIZED_TELEGRAM_USER_ID` | —                                | Your numeric id; comma-separated for several |
| `COPILOT_MODEL`               | `claude-opus-5`                  | List them with `npm run agent -- models`     |
| `COPILOT_MODEL_FALLBACK`      | `claude-opus-4.8`                | Used if the first is refused at run time     |
| `COPILOT_SANDBOX`             | `false`                          | `true` gives real containment (experimental) |
| `MAX_AI_CREDITS_PER_TASK`     | `10`                             | Per-task ceiling                             |
| `MAX_AI_CREDITS_PER_DAY`      | `50`                             | Daily ceiling                                |
| `MAX_TASK_DURATION_MINUTES`   | `30`                             | Hard time limit                              |
| `MAX_RETRIES`                 | `2`                              | Recovery attempts after failing tests        |
| `AUTO_COMMIT`                 | `true`                           | Commit once tests pass                       |
| `AUTO_PUSH`                   | `false`                          | Push (also always needs approval)            |
| `PROTECTED_BRANCHES`          | `main,master,production,release` | Committing here needs approval               |
| `ORCHESTRATION`               | `true`                           | Allow survey/review passes on complex work   |
| `MAX_AGENT_CALLS_PER_TASK`    | `4`                              | Hard ceiling on paid sessions per task       |

`.env.example` documents every option.

---

## Troubleshooting

**Run `npm run doctor` first.** It diagnoses nearly everything.

| Symptom                                     | Fix                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Bot ignores you                             | Your id isn't in `AUTHORIZED_TELEGRAM_USER_ID` — check with @userinfobot                                         |
| `TELEGRAM_BOT_TOKEN is not set`             | Fill it into `.env`                                                                                              |
| `401 Unauthorized` at startup               | Wrong token, or another copy of the bot is already polling                                                       |
| `no account is signed in`                   | Run `copilot login`                                                                                              |
| `Model "X" is not available`                | Usually your Copilot allowance is temporarily spent. It switches model once automatically; otherwise retry later |
| Task refused: merge conflicts               | Resolve them yourself first                                                                                      |
| Task refused: filter/diff driver            | The repo makes git run commands when reading files. Inspect it before trusting it                                |
| `Tests: not run`                            | No test command detected — register with `--test "..."`                                                          |
| Stuck in `WAITING_APPROVAL`                 | Tap the button, or `/approve <id>`. Expires per `APPROVAL_TIMEOUT_MINUTES`                                       |
| `Another agent instance is already running` | `npm run agent -- stop`                                                                                          |

Logs: `data/logs/agent-YYYY-MM-DD.log` (JSON lines, redacted).
Per-task detail: `npm run agent -- logs <id>`.

---

## Cost

**This application adds no recurring cost.**

|                        |                                           |
| ---------------------- | ----------------------------------------- |
| Telegram Bot API       | Free                                      |
| SQLite (`node:sqlite`) | Built into Node                           |
| Hosting                | None — it runs on your PC                 |
| AI                     | Billed against your existing Copilot plan |

A simple bug fix costs roughly **1 AI credit**. Daily and per-task ceilings are enforced locally, and it never enables paid overage.

---

## Known limitations

1. **The deny-list is not a sandbox.** With `COPILOT_SANDBOX=false`, shell commands run with your rights. It denies `curl`, `wget` and the interpreters, but **not** `npm`, `pip`, `cargo`, `go`, `make`, `mvn` or `gradle` — each of which can reach the network and execute arbitrary code. Denying them would stop the agent doing its job. Do not read the deny-list as a network policy.
2. **Verification runs your project's code.** Unavoidable — that is what running tests means.
3. **Read-only review passes are verified, not guaranteed.** The survey and review roles are checked before and after against git's changed-file set and git's control surface. That does not see writes to gitignored paths, writes outside the repository, or a file modified and restored within one session.
4. **The PC must be on, awake and signed in.**
5. **The model catalogue changes.** The Copilot CLI auto-updates; re-run `npm run agent -- models` afterwards.
6. **Windows-first.** Startup automation ships for Windows only.

---

## Development

```powershell
npm test          # lint + build + full suite. No AI calls, no credits
npm run typecheck
npm run lint
npm run build
```

The suite drives the real task runner against a **mock** Copilot CLI in temporary git repositories. It includes red-team regressions for attacks verified to work against earlier builds: repository-planted `git.exe` and `npm.cmd` hijacks, git filter-driver execution, hostile git hooks and config, prompt injection, and credential theft through the verification command.

```powershell
node scripts/live-acceptance.mjs   # spends ~1 AI credit, manual only
```

Drives the **real** Copilot CLI against a throwaway repo containing a real bug and asserts nine end-to-end properties, including that the bot token never reaches Telegram. The mocked suite deliberately cannot catch environment or shell-quoting faults; this can.

---

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and pull requests welcome. Anything touching permissions, redaction, git safety, the state machine or the approval flow must come with a test.
