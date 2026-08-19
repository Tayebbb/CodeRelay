# Runs start-agent.cmd with no visible console window.
#
# The startup task uses the interactive token, so a plain cmd.exe action opens
# a console window in the user's session. That window is load-bearing: closing
# it delivers CTRL_CLOSE to every process on the console, killing the
# supervisor loop AND the agent in one click (observed 2026-08-18). Start-
# Process gives cmd its own console and hides it, so nothing appears on screen.
param(
    # Node executable start-agent.cmd should use; empty means "node on PATH".
    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-agent.cmd'
# Same proven /s /c quoting as the task action used directly: with /s, cmd
# strips exactly the outer quote pair, leaving both inner paths safely quoted.
$cmdArgs = "/d /s /c """"$launcher"" ""$NodeExe"""""
$proc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArgs -WindowStyle Hidden -PassThru -Wait
exit $proc.ExitCode
