@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Office Agent is not set up yet. Run Setup Office Agent.cmd first.
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=1
"node_modules\electron\dist\electron.exe" tools\launch-office.cjs
if errorlevel 1 pause
