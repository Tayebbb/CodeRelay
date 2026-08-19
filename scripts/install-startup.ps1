# Registers the agent to start automatically when you log on to Windows.
# Run in a normal (non-elevated) PowerShell window:
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
#
# Uses a per-user Scheduled Task. No admin rights, no service install, no cost.

param(
    # Node executable to run the agent with; defaults to the one on PATH.
    # `remote-agent startup install` passes its own node so the task never
    # depends on what PATH looks like at logon.
    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$taskName = 'RemotePersonalCodingAgent'
$nodeExe = if ($NodeExe -and (Test-Path $NodeExe)) { $NodeExe } else { (Get-Command node -ErrorAction Stop).Source }
$entry = Join-Path $root 'dist\src\main.js'

if (-not (Test-Path $entry)) {
    # Backtick is the PowerShell escape character, so a markdown-style quoted
    # command inside a double-quoted string breaks the parse. Keep this single.
    Write-Error 'Not built yet. Run "npm install" and "npm run build" first.'
}

if (-not (Test-Path (Join-Path $root '.env'))) {
    Write-Warning "No .env found in $root - the agent will refuse to start until you create one."
}

# start-agent.cmd is the real supervisor: Task Scheduler's restart-on-failure
# does NOT fire on a nonzero exit code (only on a failure to launch), so a
# fatal startup error — e.g. binding the web UI before the VPN adapter is up —
# used to kill the agent for good. The wrapper loop restarts it; RestartCount
# below only covers the wrapper itself dying.
#
# The action goes through start-agent-hidden.ps1 so no console window appears:
# an interactive-token task otherwise pops one, and closing that window sends
# CTRL_CLOSE to the whole console — killing supervisor and agent in one click
# with nothing in the log (observed 2026-08-18).
$hiddenLauncher = Join-Path $root 'scripts\start-agent-hidden.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction `
    -Execute $powershell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$hiddenLauncher"" -NodeExe ""$nodeExe""" `
    -WorkingDirectory $root

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Watchdog tick: logon alone is not enough. "PC is on" usually means "resumed
# from sleep" — no logon event — so an agent that died mid-session (killed
# console, End Task, crash loop exhausted) stayed dead for days until the next
# real sign-in. This trigger re-fires every 5 minutes forever; IgnoreNew makes
# it a no-op while the agent is running, and StartWhenAvailable replays a tick
# missed during sleep as soon as the machine wakes.
$tickTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Minutes 5)
# An empty Duration means "repeat indefinitely". [TimeSpan]::MaxValue is NOT
# accepted by Register-ScheduledTask (out-of-range XML), so clear it instead.
$tickTrigger.Repetition.Duration = $null
$tickTrigger.Repetition.StopAtDurationEnd = $false

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

# Interactive token: the task runs as you, with access to your Copilot login and
# your git credentials. It is NOT elevated.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName    $taskName `
    -Action      $action `
    -Trigger     @($logonTrigger, $tickTrigger) `
    -Settings    $settings `
    -Principal   $principal `
    -Description 'Remote Personal Coding Agent - receives tasks from Telegram and runs GitHub Copilot CLI locally.' | Out-Null

Write-Host ""
Write-Host "Registered scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  Runs at logon as $env:USERNAME (not elevated)."
Write-Host "  Restarts automatically if it exits unexpectedly."
Write-Host "  Watchdog: re-launches within 5 minutes if it is ever found dead (e.g. after waking from sleep)."
Write-Host ""
Write-Host "Start it now with:   Start-ScheduledTask -TaskName $taskName"
Write-Host "Check status with:   npm run agent -- status"
Write-Host "Remove it with:      powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1"
Write-Host ""
Write-Host "NOTE: the agent runs in your session, so it starts after you sign in." -ForegroundColor Yellow
Write-Host "      If the PC reboots while you are away, sign-in is required (or enable"
Write-Host "      Windows automatic sign-in) before tasks can run. While you stay"
Write-Host "      signed in (including across sleep/wake) the watchdog keeps it alive."
