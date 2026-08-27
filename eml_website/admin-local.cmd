@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [EML] Node.js 20 or newer is required.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

echo [EML] Starting the local content editor...
echo [EML] Close this window or press Ctrl+C when you are finished.
call npm run admin -- --open

if errorlevel 1 (
  echo.
  echo [EML] The local editor stopped because of an error.
  pause
  exit /b 1
)
