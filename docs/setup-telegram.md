# Telegram interface setup

The Telegram bot is a messaging client for the same agent core the web
interface uses. **The web interface is not required.**

Telegram uses long polling — an outbound connection only. No open ports, no
public endpoint, no fee.

## Setup

**1. Create the bot.** In Telegram, message **@BotFather**:

```
/newbot
```

Give it a display name, then a username ending in `bot`. BotFather replies
with a token like `8123456789:AAH...` — copy it.

**2. Get your numeric user id.** Message **@userinfobot**; it replies
immediately with your `Id`.

**3. Configure** `.env`:

```env
TELEGRAM_BOT_TOKEN=8123456789:AAH...
AUTHORIZED_TELEGRAM_USER_ID=123456789
```

Telegram switches on automatically when a token is present. To be explicit —
or to switch it off later without deleting credentials — use
`TELEGRAM_ENABLED=true|false`.

**4. Start the agent, then message your bot.** Find it by the username you
chose and tap **Start** (Telegram will not let a bot message you first). You
will receive the online banner with the model, projects and any recovery
notes.

## Commands

| Command                          | What it does                                            |
| -------------------------------- | ------------------------------------------------------- |
| `myproject: fix the bug`         | Queue a task (project prefix optional with one project) |
| `/status`                        | Connection, model, queue, credits                       |
| `/tasks` · `/logs <id>`          | History and per-task detail                             |
| `/cancel <id>` · `/retry <id>`   | Stop or re-run                                          |
| `/approve <id>` · `/reject <id>` | Answer an approval by text                              |

Approvals also arrive as inline **APPROVE / REJECT** buttons.

Tasks sent from Telegram run on the default agent CLI (`AGENT_PROVIDER`).
Picking a different provider or model per task is a web-interface feature.

## Security model

- Authorisation is a numeric user-id allow-list checked on every update.
  Everyone else gets `This bot is private.` and nothing more.
- Direct messages only — the bot refuses group chats, because it reports file
  contents and diffs.
- The bot token and all project `.env` values are redacted from every message.
- If the token ever leaks, send `/revoke` to @BotFather and update `.env`.

## Troubleshooting

| Symptom                                                    | Fix                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Bot ignores you                                            | Your id is not in `AUTHORIZED_TELEGRAM_USER_ID` — check with @userinfobot              |
| `401 Unauthorized` at startup                              | Wrong token, or a second copy of the agent is polling with it                          |
| `TELEGRAM_ENABLED is on but TELEGRAM_BOT_TOKEN is not set` | Fill in the token, or set `TELEGRAM_ENABLED=false`                                     |
| No online banner after reboot                              | Telegram may be unreachable; the agent retries and the web UI (if enabled) still works |
