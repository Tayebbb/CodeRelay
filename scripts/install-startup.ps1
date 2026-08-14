# Registers the agent to start automatically when you log on to Windows.
# Run in a normal (non-elevated) PowerShell window:
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
#
# Uses a per-user Scheduled Task. No admin rights, no service install, no cost.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$taskName = 'RemotePersonalCodingAgent'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $root 'dist\src\main.js'

if (-not (Test-Path $entry)) {
    Write-Error "Not built yet. Run `npm install` and `npm run build` in $root first."
}

if (-not (Test-Path (Join-Path $root '.env'))) {
    Write-Warning "No .env found in $root — the agent will refuse to start until you create one."
}

$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument "--no-warnings=ExperimentalWarning `"$entry`"" `
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
    -Description 'Remote Personal Coding Agent — receives tasks from Telegram and runs GitHub Copilot CLI locally.' | Out-Null

Write-Host ""
Write-Host "Registered scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  Runs at logon as $env:USERNAME (not elevated)."
Write-Host "  Restarts automatically every minute if it stops."
Write-Host ""
Write-Host "Start it now with:   Start-ScheduledTask -TaskName $taskName"
Write-Host "Check status with:   npm run agent -- status"
Write-Host "Remove it with:      powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1"
Write-Host ""
Write-Host "NOTE: a logon trigger means the agent starts after you sign in." -ForegroundColor Yellow
Write-Host "      If the PC reboots while you are away, sign-in is required (or enable"
Write-Host "      Windows automatic sign-in) before tasks can run."
