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
$launcher = Join-Path $root 'scripts\start-agent.cmd'
# Renders:  /d /s /c ""<launcher>" "<node>""  — with /s, cmd strips exactly the
# outer quote pair, leaving both inner paths safely quoted.
$action = New-ScheduledTaskAction `
    -Execute $env:ComSpec `
    -Argument "/d /s /c """"$launcher"" ""$nodeExe""""" `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

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
    -Trigger     $trigger `
    -Settings    $settings `
    -Principal   $principal `
    -Description 'Remote Personal Coding Agent - receives tasks from Telegram and runs GitHub Copilot CLI locally.' | Out-Null

Write-Host ""
Write-Host "Registered scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  Runs at logon as $env:USERNAME (not elevated)."
Write-Host "  Restarts automatically if it exits unexpectedly."
Write-Host ""
Write-Host "Start it now with:   Start-ScheduledTask -TaskName $taskName"
Write-Host "Check status with:   npm run agent -- status"
Write-Host "Remove it with:      powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1"
Write-Host ""
Write-Host "NOTE: a logon trigger means the agent starts after you sign in." -ForegroundColor Yellow
Write-Host "      If the PC reboots while you are away, sign-in is required (or enable"
Write-Host "      Windows automatic sign-in) before tasks can run."
