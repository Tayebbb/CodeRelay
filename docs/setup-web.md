# Web interface setup

The web interface is a browser client for the same agent core the Telegram bot
uses — same tasks, same approvals, same budgets. **Telegram is not required.**

It runs on your PC, serves plain HTML/CSS/JS with zero frontend dependencies,
and binds to `127.0.0.1` unless you explicitly say otherwise.

## Setup

**1. Create your password** (stored as a scrypt hash, never in `.env`):

```powershell
npm run agent -- web setup
```

**2. Enable it** in `.env`:

```env
WEB_ENABLED=true
```

That is the whole configuration. `WEB_PORT` defaults to `8787`.

**3. Start the agent and open the browser:**

```powershell
npm start
# → Web interface: http://127.0.0.1:8787
```

Sign in with the password you created. You can now select a project, pick a
model, choose a mode (Code / Plan / Review / Debug / Ask), send a task, watch
it stream live, review the diff, and answer approval cards — from any device
that can reach the page, including your phone.

## What the web UI can and cannot do

| Can | Cannot |
| --- | ------ |
| Create, watch, cancel, retry tasks | Register or remove projects (CLI only, by design) |
| Pick the model per task (from the installed CLI's real catalogue) | Switch the agent provider per task (`AGENT_PROVIDER` is a server setting) |
| Answer approval requests | Bypass any approval — it calls the same gate Telegram does |
| View diffs, timelines, usage | Browse your filesystem — only registered project metadata is exposed |

## Install it like an app (PWA)

The web interface is a Progressive Web App: installable, standalone, with the
application shell cached for instant launches. **No task data, git information
or session material is ever cached** — the service worker refuses to touch
`/api/` entirely, and going offline never affects the task running on the PC.

| Platform | How |
| -------- | --- |
| iPhone / iPad | Open in Safari → Share → **Add to Home Screen** |
| Android | Chrome → menu → **Install app** (or accept the in-app prompt) |
| Desktop | Chromium browsers show an install icon in the address bar |

Installation requires a *secure context*: `http://127.0.0.1` and
`http://localhost` qualify, plain HTTP over the LAN does not. From a phone,
reach the PC through a private tunnel (WireGuard/Tailscale, which can provide
HTTPS) or an SSH tunnel to localhost — the same approaches recommended under
Remote access below.

The status line distinguishes three states rather than one “offline”:
**Ready** (everything reachable), **Home PC unreachable** (this device has
internet but the agent doesn't answer — it reconnects and resyncs
automatically, and running tasks continue on the PC), and **No internet
connection** (this device is offline; history stays readable).

*Testing honesty:* the service worker, cache contents, offline shell and
Android-style install criteria were verified in a real desktop Chromium.
iOS-specific behaviour (Add to Home Screen, status-bar rendering, safe areas
on a notched device) follows Apple's documented metadata but has **not** been
verified on physical Apple hardware. Web push notifications are deliberately
not implemented — doing them reliably requires per-platform push services and
subscription plumbing that this project defers as an optional future feature.

## Security model

- **One operator, one password.** There is no signup route. The password hash
  lives in `data/web-auth.json` (scrypt, N=16384).
- **Sessions** are random 256-bit tokens in HttpOnly, `SameSite=Strict`
  cookies. They live in memory: restarting the agent signs everyone out.
- **Login is throttled** (5 attempts / 15 minutes per address).
- **Every mutation** requires a custom header and a same-origin `Origin`,
  which — combined with `SameSite=Strict` — closes classic CSRF.
- **All rendering** goes through `textContent`; the CSP forbids inline script,
  external sources and framing. Agent output cannot script the page.
- **Diffs and events are redacted** with the same machinery as Telegram
  messages before they leave the process.

## Remote access — read before exposing anything

The web server itself does **not** provide TLS or defence against the open
Internet, and no port-forwarding instruction will appear here. Reasonable
options, in order of recommendation:

1. **Private network (recommended):** a WireGuard or Tailscale-style tunnel
   into your home network. The agent stays bound to a private address; your
   phone joins the network. Zero exposed ports, works from anywhere.
2. **SSH tunnel:** `ssh -L 8787:127.0.0.1:8787 you@home-pc` from the machine
   you are on, then browse `localhost:8787`.
3. **LAN only:** set `WEB_HOST` to your LAN address for use at home.

If a reverse proxy with TLS is ever placed in front, remember the session
cookie is not marked `Secure` (the agent itself serves HTTP); terminate TLS on
the same machine and keep the hop on loopback.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `The web interface is enabled but has no password yet` | `npm run agent -- web setup` |
| Signed out unexpectedly | The agent restarted — sessions are memory-only, sign in again |
| `Too many attempts` | Wait 15 minutes; the login throttle has closed |
| Page loads, data never appears | You are opening a different host/port than the one printed at startup |
| Live updates stop after a network change | The page reconnects automatically; give it a few seconds or reload |
