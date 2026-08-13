# Removes the Windows startup task created by install-startup.ps1
$ErrorActionPreference = 'Stop'
$taskName = 'RemotePersonalCodingAgent'

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Task '$taskName' is not registered."
    return
}

Stop-ScheduledTask  -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Green
