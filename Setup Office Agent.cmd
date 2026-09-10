@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto prerequisites
where npm >nul 2>&1
if errorlevel 1 goto prerequisites
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto failed
node tools\setup-native.cjs
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
echo Office Agent is ready. Open Start Office Agent.cmd.
pause
exit /b 0
:prerequisites
echo Setup requires Node.js with npm on PATH. Install it from https://nodejs.org/
echo Then close this window and run Setup Office Agent.cmd again.
echo An already built app can open with Start Office Agent.cmd without Node.js on PATH.
pause
exit /b 1
:failed
echo Setup did not finish. See the error above.
pause
exit /b 1
