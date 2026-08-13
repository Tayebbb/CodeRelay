@echo off
REM Start the remote coding agent. Used by the Windows startup task and for manual runs.
setlocal
cd /d "%~dp0.."
if not exist "dist\src\main.js" (
  echo Building for the first time...
  call npm install --no-fund --no-audit || exit /b 1
  call npm run build || exit /b 1
)
node --no-warnings=ExperimentalWarning "dist\src\main.js"
