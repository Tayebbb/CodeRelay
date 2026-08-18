@echo off
REM Start the remote coding agent and keep it running. Used by the Windows
REM startup task and for manual runs.
REM
REM Optional argument 1: full path to node.exe. The startup task passes it so
REM the agent never depends on what PATH looks like at logon.
REM
REM This loop is the real supervisor. Task Scheduler's restart-on-failure does
REM NOT fire when a process exits with a nonzero code (only when the action
REM fails to launch), so without the loop any fatal startup error left the
REM agent dead until someone restarted it at the PC. Restart on everything
REM except a clean shutdown (0) and "another instance holds the lock" (5).
setlocal
cd /d "%~dp0.."
set "NODE_EXE=%~1"
if "%NODE_EXE%"=="" set "NODE_EXE=node"

if not exist "dist\src\main.js" (
  echo Building for the first time...
  call npm install --no-fund --no-audit || exit /b 1
  call npm run build || exit /b 1
)

:run
REM `call` matters: if NODE_EXE resolves to a version-manager shim (.cmd),
REM plain invocation would transfer control and never return to this loop.
call "%NODE_EXE%" --no-warnings=ExperimentalWarning "dist\src\main.js"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" exit /b 0
if "%EXIT_CODE%"=="5" exit /b 5
echo Agent exited with code %EXIT_CODE%; restarting in 30 seconds...
REM ping as sleep: timeout.exe refuses to run without console stdin.
ping -n 31 127.0.0.1 >nul
goto run
